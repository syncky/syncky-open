import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createGenericSender } from "../../src/send.js";
import { createOutbox } from "../../src/outbox.js";
import { createCipherFiles, updateHomeState } from "../../src/home-state.js";
import fs from "node:fs";
import { diskFailure, syncTrace } from "../support/thin-home.js";
import { createRelayClient } from "../../src/relay-client.js";
import { setup, self, now, messageId } from "../support/thin-transport.js";

test("flush retains only the newest 100 completed receipts across restart and never prunes pending sends", async t => {
  const { home } = setup(t), queue = createCipherFiles(home, "outbox");
  for (let n = 1; n <= 105; n++) queue.put({ msg_id: messageId(n), body: '{"kind":"control"}', kind: "control",
    state: n === 1 ? "pending" : n % 2 ? "sent" : "failed", next_attempt_at: Number.MAX_SAFE_INTEGER });
  const options = { home, now, relay: { postMessage: async () => assert.fail("pending retry is not due") } };
  let interrupted = false;
  const dir = `${home}/outbox`, lastRemoval = `${dir}/${messageId(5)}.json`;
  const failing = syncTrace(path => {
    if (path === dir && !fs.existsSync(lastRemoval) && !interrupted) {
      interrupted = true; throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
    }
  });
  await assert.rejects(createOutbox({ ...options, ...failing }).flush(), { code: "ENOSPC" });
  assert.equal(interrupted, true);
  const retry = syncTrace();
  await createOutbox({ ...options, ...retry }).flush();
  assert.ok(retry.synced.includes(dir));
  assert.deepEqual(queue.list().map(e => e.msg_id), [messageId(1), ...Array.from({ length: 100 }, (_, n) => messageId(n + 6))]);
  const restarted = createOutbox(options);
  await restarted.flush();
  assert.equal(restarted.receipts().filter(e => ["sent", "failed"].includes(e.state)).length, 100);
  assert.equal(restarted.receipts().find(e => e.msg_id === messageId(1)).state, "pending");
});

test("pruning finishes an interrupted deletion when receipts shrink before the lock", async t => {
  const { home } = setup(t), queue = createCipherFiles(home, "outbox"), dir = `${home}/outbox`;
  for (let n = 1; n <= 101; n++) queue.put({ msg_id: messageId(n), body: '{"kind":"control"}', kind: "control", state: "sent" });
  const trace = syncTrace(); let interrupted = false;
  const io = new Proxy(trace.fs, { get(target, key) {
    if (key !== "mkdirSync") return target[key];
    return (path, ...args) => {
      if (path === `${home}/.state.lock` && !interrupted) {
        interrupted = true;
        assert.throws(() => createCipherFiles(home, "outbox", { fs: diskFailure("fsyncSync", 1, /\/outbox$/) }).remove(messageId(1)), { code: "ENOSPC" });
      }
      return target.mkdirSync(path, ...args);
    };
  } });
  await createOutbox({ home, now, fs: io, relay: { postMessage: () => assert.fail("completed receipts") } }).flush();
  assert.equal(interrupted, true);
  assert.ok(trace.synced.includes(dir));
  assert.deepEqual(queue.list().map(e => e.msg_id), Array.from({ length: 100 }, (_, n) => messageId(n + 2)));
});

test("send response extensions do not prevent a durable metadata receipt", async t => {
  const { home, transport } = setup(t);
  await createGenericSender({ home, transport, self, now })({ type: "future", innerText: '{"type":"future","extra":true}' });
  await createOutbox({ home, now, relay: { postMessage: async () => ({ seq: 9, future: { extra: true } }) } }).flush();
  const receipts = createOutbox({ home, now }).receipts();
  assert.equal(receipts[0].state, "sent"); assert.equal(receipts[0].seq, 9);
  assert.equal(Object.hasOwn(receipts[0], "future"), false);
});

test("429 and ambiguous timeout retries retain exact envelope and restart deadlines", async t => {
  const { home, transport } = setup(t);
  await createGenericSender({ home, transport, self, now })({ type: "commands", innerText: '{"type":"commands","caller_owned":true}' });
  let at = now().getTime(), attempts = 0; const bodies = [];
  const relay = { postMessage: async (body, options) => {
    assert.equal(options.attempts, 1); bodies.push(body);
    if (++attempts === 1) throw { status: 429, code: "rate_limited", retryAfterS: 120 };
    if (attempts === 2) throw { status: 0, code: "timeout" };
    return { seq: 9 };
  } };
  const outbox = () => createOutbox({ home, relay, now: () => new Date(at) });
  await outbox().flush(); at += 119000; await outbox().flush(); assert.equal(attempts, 1);
  at += 1000; await outbox().flush(); at += 60000; await outbox().flush();
  assert.equal(attempts, 3); assert.equal(new Set(bodies).size, 1);
  assert.equal(outbox().receipts()[0].state, "sent"); assert.equal(outbox().receipts()[0].seq, 9);
  assert.ok(!JSON.stringify(outbox().receipts()).includes("ciphertext"));
});
test("a stalled data lane does not block independent control and marker lanes", async t => {
  const { home, transport } = setup(t), send = createGenericSender({ home, transport, self, now });
  for (const type of ["commands", "future", "access_request", "diagnostics_request"]) await send({ type, innerText: JSON.stringify({ type }) });
  let release; const stalled = new Promise(r => { release = r; }), sent = [];
  const outbox = createOutbox({ home, now, relay: { postMessage: async body => { const e = JSON.parse(body); if (e.kind === "data") await stalled; sent.push(e.kind === "data" ? "data" : e.access ?? e.diagnostics ?? "control"); return { seq: 1 }; } } });
  const pending = outbox.flush();
  await new Promise(r => setTimeout(r, 30)); assert.equal(sent.length, 3);
  release(); await pending;
});
test("ordinary errors are bounded; revoked targets fail without posting", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), calls = 0;
  await createGenericSender({ home, transport, self, now })({ type: "future", innerText: '{"type":"future"}' });
  const outbox = createOutbox({ home, maxAttempts: 3, now: () => new Date(at), relay: { postMessage: async () => { calls++; throw { status: 500 }; } } });
  for (let i = 0; i < 6; i++) { await outbox.flush(); at += 600000; }
  assert.equal(calls, 3); assert.equal(outbox.receipts()[0].state, "failed");
});
test("concurrent CLI processes queue distinct immutable envelopes", async t => {
  const { home } = setup(t);
  const code = `import { createGenericSender } from './agent/src/send.js'; import { createThinTransport } from './agent/src/thin-transport.js'; import { self, tablePath } from './agent/test/support/thin-transport.js'; try { await createGenericSender({home:process.argv[1],self,transport:createThinTransport({tablePath})})({type:'future',innerText:'{"type":"future"}'}); } catch(error) { process.stderr.write(String(error.code) + '\\n' + error.stack.split('\\n').slice(1).join('\\n')); process.exitCode = 1; }`;
  const run = () => new Promise((resolve, reject) => { let diagnostic = ""; const child = spawn(process.execPath, ["--input-type=module", "-e", code, home], { stdio: ["ignore", "ignore", "pipe"], cwd: new URL("../../../", import.meta.url) }); child.stderr.on("data", chunk => { diagnostic += chunk; }); child.on("error", reject); child.on("exit", status => status === 0 ? resolve() : reject(new Error(`queue child exit ${status}: ${diagnostic}`))); });
  await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(createCipherFiles(home, "outbox").list().length, 8);
});

test("timeout and a failed receipt commit both leave exact sealed bytes retryable", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), posts = 0; const bodies = [];
  await createGenericSender({ home, transport, self, now })({ type: "future", innerText: '{"type":"future"}' });
  const relay = { postMessage: async body => { bodies.push(body); if (++posts === 1) return new Promise(() => {}); return { seq: 7 }; } };
  await createOutbox({ home, relay, timeoutMs: 5, now: () => new Date(at) }).flush();
  at += 3000;
  await assert.rejects(createOutbox({ home, relay, now: () => new Date(at), fs: diskFailure("renameSync", 2, /\/outbox\/\./) }).flush());
  assert.equal(createCipherFiles(home, "outbox").list()[0].state, "pending");
  at += 31000; await createOutbox({ home, relay, now: () => new Date(at) }).flush();
  assert.equal(posts, 3); assert.equal(new Set(bodies).size, 1); assert.equal(createCipherFiles(home, "outbox").list()[0].state, "sent");
});

test("two retry workers claim one pending envelope before POST", async t => {
  const { home, transport } = setup(t); let posts = 0;
  await createGenericSender({ home, transport, self, now })({ type: "future", innerText: '{"type":"future"}' });
  const relay = { postMessage: async () => { posts++; await new Promise(r => setTimeout(r, 20)); return { seq: 1 }; } };
  await Promise.all([createOutbox({ home, relay, now }).flush(), createOutbox({ home, relay, now }).flush()]);
  assert.equal(posts, 1);
});

test("relay client exposes single-attempt independent transport without changing legacy defaults", async () => {
  const calls = [], pollGate = { runCycle: () => { throw new Error("legacy gate used"); }, owns: () => false };
  const relay = createRelayClient({ baseUrl: "https://relay.invalid", token: "fixture", pollGate, sleep: () => { throw new Error("transport retry slept"); }, fetch: async (url, options) => {
    calls.push({ path: new URL(url).pathname, cadence: new URL(url).searchParams.get("poll_interval_s") });
    if (options.method === "GET") return Response.json({ messages: [] });
    if (url.endsWith("/acks")) return new Response(null, { status: 204 });
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "2" } });
  } });
  await assert.rejects(relay.postMessage("sealed fixture", { attempts: 1 }), { status: 429, retryAfterS: 2 });
  await relay.getMessages({ after: 0 }, { independent: true, pollIntervalS: 25 });
  await relay.ack(0, { independent: true });
  assert.equal(calls.length, 3); assert.equal(calls[1].cadence, "25");
});

test("data Retry-After survives a new enqueue and restart while control still posts", async t => {
  const { home, transport } = setup(t), send = createGenericSender({ home, transport, self, now });
  await send({ type: "commands", innerText: '{"type":"commands"}' });
  let at = now().getTime(), calls = [];
  const relay = { postMessage: async body => {
    const envelope = JSON.parse(body); calls.push(envelope.kind);
    if (envelope.kind === "data") throw { status: 429, retryAfterS: 120 };
    return { seq: 1 };
  } };
  await createOutbox({ home, relay, now: () => new Date(at) }).flush();
  await send({ type: "commands", innerText: '{"type":"commands"}' });
  await send({ type: "future", innerText: '{"type":"future"}' });
  at += 1000; await createOutbox({ home, relay, now: () => new Date(at) }).flush();
  assert.deepEqual(calls, ["data", "control"]);
});

test("migrated commands Retry-After gates new data across restart while control lanes progress", async t => {
  const { home, transport } = setup(t), send = createGenericSender({ home, transport, self, now });
  let at = now().getTime(); const due = at + 120000, calls = [];
  updateHomeState(home, s => {
    s.transport.commands_retry_at = String(due);
    s.transport.send_lanes = { data: due + 1000 };
  });
  for (const type of ["commands", "future", "access_request", "diagnostics_request"]) await send({ type, innerText: JSON.stringify({ type }) });
  const create = () => createOutbox({ home, now: () => new Date(at), relay: { postMessage: async body => {
    const e = JSON.parse(body); calls.push(e.kind === "data" ? "data" : e.access ?? e.diagnostics ?? "control"); return { seq: 1 };
  } } });
  await create().flush();
  assert.equal(calls.length, 3); assert.ok(!calls.includes("data"));
  at = due; await create().flush(); assert.equal(calls.length, 3);
  updateHomeState(home, s => { s.transport.send_lanes.data = due - 1000; });
  at = due - 1; await create().flush(); assert.equal(calls.length, 3);
  at = due; await create().flush(); assert.equal(calls.at(-1), "data");
  await send({ type: "commands", innerText: '{"type":"commands"}' });
  await create().flush(); assert.equal(calls.filter(c => c === "data").length, 2);
  assert.ok(create().receipts().every(e => e.state === "sent"));
});

test("an empty outbox flush creates no files or durable locks", async t => {
  const { home } = setup(t), trace = syncTrace();
  await createOutbox({ home, now, ...trace, relay: { postMessage: () => assert.fail("empty outbox") } }).flush();
  assert.equal(fs.existsSync(`${home}/outbox`), false);
  assert.deepEqual(trace.synced, []);
});
