import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createGenericSender } from "../../src/send.js";
import { createOutbox } from "../../src/outbox.js";
import { createCipherFiles, readHomeState, updateHomeState } from "../../src/home-state.js";
import fs from "node:fs";
import { diskFailure, syncTrace } from "../support/thin-home.js";
import { createRelayClient } from "../../src/relay-client.js";
import { uuidv7 } from "../../src/ids.js";
import { maintainResponseWaits } from "../../src/response-waits.js";
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

test('response correlations stay beside ciphertext, activate only after success, and duplicates retain the first command deadline', async t => {
  const { home, transport } = setup(t); let at = now().getTime(), attempts = 0;
  const commands = { v: 1, type: 'commands', commands: [{ command_id: 'one', version: 1, op: 'write', value: 123 }, { command_id: 'one', version: 2 }, { command_id: 'two', version: 1 }] };
  const send = () => createGenericSender({ home, transport, self, now: () => new Date(at) })({ type: 'commands', innerText: JSON.stringify(commands) });
  await send();
  const queue = createCipherFiles(home, 'outbox'), queued = queue.list()[0];
  assert.equal(queued.response_waits.length, 3);
  assert.ok(!JSON.stringify(queued.response_waits).includes('value'));
  const relay = { postMessage: async () => { if (++attempts === 1) throw { status: 429, retryAfterS: 400 }; return { seq: 5 }; } };
  const flush = () => createOutbox({ home, relay, now: () => new Date(at) }).flush();
  await flush(); assert.equal(Object.keys(readHomeState(home).transport.response_waits ?? {}).length, 0);
  at += 400000; await flush();
  const waits = Object.values(readHomeState(home).transport.response_waits);
  assert.equal(waits.length, 3); assert.ok(waits.every(w => w.expires_at === at + 900000));
  at += 100000; await send(); await flush();
  assert.deepEqual(Object.values(readHomeState(home).transport.response_waits), waits);
  assert.equal(queue.list()[0].body, queued.body);
});

test('sent correlation recovery survives a failed wait commit without another POST', async t => {
  const { home, transport } = setup(t); let posts = 0;
  await createGenericSender({ home, transport, self, now })({ type: 'commands', innerText: JSON.stringify({ v: 1, type: 'commands', commands: [{ command_id: 'recover', version: 1 }] }) });
  const relay = { postMessage: async () => { posts++; return { seq: 1 }; } };
  await assert.rejects(createOutbox({ home, relay, now, fs: diskFailure('renameSync', 1, /\.state\.json\./) }).flush());
  await createOutbox({ home, relay, now }).flush();
  assert.equal(posts, 1); assert.equal(Object.keys(readHomeState(home).transport.response_waits).length, 1);
});

test('concurrent pruning preserves an old delayed send until its response wait is durable', async t => {
  const { home, transport } = setup(t), queue = createCipherFiles(home, 'outbox');
  await createGenericSender({ home, transport: { ...transport, sealMessage: options => transport.sealMessage({ ...options, msgId: messageId(1) }) }, self, now })({
    type: 'commands', innerText: JSON.stringify({ v: 1, type: 'commands', commands: [{ command_id: 'delayed', version: 1 }] }),
  });
  for (let n = 2; n <= 102; n++) queue.put({ msg_id: messageId(n), kind: 'control', body: '{"kind":"control"}', state: 'sent' });
  let releaseSend, started, posts = 0;
  const reached = new Promise(resolve => { started = resolve; });
  const relay = { postMessage: async () => { posts++; started(); await new Promise(resolve => { releaseSend = resolve; }); return { seq: 1 }; } };
  const sending = assert.rejects(createOutbox({ home, relay, now, fs: diskFailure('renameSync', 1, /\.state\.json\./) }).flush(), { code: 'ENOSPC' });
  await reached;
  let released = false;
  const io = new Proxy(fs, { get(target, key) {
    if (key !== 'readdirSync') return target[key];
    return (path, ...args) => {
      const entries = target.readdirSync(path, ...args);
      if (path === `${home}/outbox` && !released) { released = true; releaseSend(); }
      return entries;
    };
  } });
  await createOutbox({ home, relay, now, fs: io }).flush();
  await sending;
  await createOutbox({ home, relay, now }).flush();
  assert.equal(posts, 1); assert.equal(queue.list().length, 100);
  const waits = Object.values(readHomeState(home).transport.response_waits ?? {});
  assert.equal(waits.length, 1); assert.equal(waits[0].command_id, 'delayed');
  assert.equal(waits[0].expires_at, now().getTime() + 900000);
});

test('expired command waits never change wire command validity or reopen from a duplicate receipt', async t => {
  const { home, transport } = setup(t); let at = now().getTime();
  const inner = { v: 1, type: 'commands', commands: [{ command_id: 'one', version: 1 }] };
  const send = () => createGenericSender({ home, transport, self, now: () => new Date(at) })({ type: 'commands', innerText: JSON.stringify(inner) });
  const flush = () => createOutbox({ home, now: () => new Date(at), relay: { postMessage: async () => ({ seq: 1 }) } }).flush();
  await send(); await flush(); const first = Object.values(readHomeState(home).transport.response_waits)[0];
  at = first.expires_at; await flush(); await send(); await flush();
  assert.equal(Object.keys(readHomeState(home).transport.response_waits).length, 0);
  assert.equal(inner.commands[0].expires_at, undefined);
});

test('command deadlines survive receipt pruning, wait expiry and a duplicate send after restart', async t => {
  const { home, transport } = setup(t); let at = now().getTime();
  const send = version => createGenericSender({ home, transport, self, now: () => new Date(at) })({ type: 'commands',
    innerText: JSON.stringify({ v: 1, type: 'commands', commands: [{ command_id: 'one', version }] }) });
  const flush = () => createOutbox({ home, now: () => new Date(at), relay: { postMessage: async () => ({ seq: 1 }) } }).flush();
  const first = await send(1); await flush();
  const deadline = Object.values(readHomeState(home).transport.response_waits)[0].expires_at;
  const queue = createCipherFiles(home, 'outbox');
  for (let n = 0; n < 101; n++) queue.put({ msg_id: uuidv7(), kind: 'control', body: '{"kind":"control"}', state: 'sent' });
  await flush();
  assert.equal(queue.list().length, 100); assert.ok(!queue.list().some(e => e.msg_id === first.msg_id));
  at = deadline;
  updateHomeState(home, s => { maintainResponseWaits(s, at); });
  assert.equal(Object.keys(readHomeState(home).transport.response_waits).length, 0);
  at += 1000; await send(1); await flush();
  assert.equal(Object.keys(readHomeState(home).transport.response_waits).length, 0);
  await send(2); await flush();
  const waits = Object.values(readHomeState(home).transport.response_waits);
  assert.equal(waits.length, 1); assert.equal(waits[0].version, 2); assert.equal(waits[0].expires_at, at + 900000);
});

test('malformed persisted wait metadata fails closed and ciphertext correlation is immutable', async t => {
  const { home, transport } = setup(t);
  await createGenericSender({ home, transport, self, now })({ type: 'commands', innerText: JSON.stringify({ v: 1, type: 'commands', commands: [{ command_id: 'one', version: 1 }] }) });
  await createOutbox({ home, now, relay: { postMessage: async () => ({ seq: 1 }) } }).flush();
  const queue = createCipherFiles(home, 'outbox'), entry = queue.list()[0];
  assert.throws(() => queue.update(entry.msg_id, { response_waits: [] }), { code: 'invalid_input' });
  const state = readHomeState(home), original = Object.values(state.transport.response_waits)[0];
  for (const patch of [{ expires_at: -1 }, { version: 0 }, { public_key: 'invalid' }, { state: 'invalid' }, { body: 'forbidden' }]) {
    assert.throws(() => updateHomeState(home, s => { s.transport.response_waits[Object.keys(state.transport.response_waits)[0]] = { ...original, ...patch }; }), { code: 'corrupt_state' });
  }
  assert.throws(() => updateHomeState(home, s => { s.transport.response_waits = []; }), { code: 'corrupt_state' });
  const deadline = Object.values(state.transport.command_wait_deadlines)[0], key = Object.keys(state.transport.command_wait_deadlines)[0];
  for (const patch of [{ expires_at: -1 }, { opened_at: -1 }, { expires_at: deadline.expires_at + 1 }, { version: 0 }, { public_key: 'invalid' }, { body: 'forbidden' }]) {
    assert.throws(() => updateHomeState(home, s => { s.transport.command_wait_deadlines[key] = { ...deadline, ...patch }; }), { code: 'corrupt_state' });
  }
  assert.throws(() => updateHomeState(home, s => { s.transport.command_wait_deadlines = []; }), { code: 'corrupt_state' });
  assert.throws(() => updateHomeState(home, s => { s.transport.command_wait_deadlines = { invalid: deadline }; }), { code: 'corrupt_state' });
});
