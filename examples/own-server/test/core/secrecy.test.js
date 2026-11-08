import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

it("stdout, stderr and error responses never expose credentials, bodies or Health values", () => {
  const code = `
    import { fixture, native, sample, secret } from './test/support/helpers.js';
    const cleanups = [];
    const f = await fixture({ after(fn) { cleanups.push(fn); } }, { hmac: secret() });
    const marker = secret();
    const values = [f.config.token, f.config.hmac, marker];
    const outputs = [];
    for (const name of ['log', 'error', 'warn', 'info', 'debug', 'trace']) console[name] = (...args) => outputs.push(args.join(' '));
    const request = native(f, { samples: [sample({ note: marker })] });
    values.push(request.headers.get('X-Syncky-Signature'), await request.clone().text(), request.url);
    if ((await f.send(request)).status !== 200) throw new Error('ingest_failed');
    f.deps.store = { credentials() { throw new Error(values.join('|')); } };
    const reply = await f.send(native(f));
    const text = await reply.text();
    if (reply.status !== 500 || text !== '{"ok":false,"code":"internal"}') throw new Error('unsafe_error');
    if (outputs.length || values.some(v => text.includes(v))) throw new Error('disclosure');
    for (const fn of cleanups.reverse()) fn();
  `;
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.ok(child.status === 0, "secrecy scenario passed");
  assert.ok(child.stdout === "" && child.stderr === "", "no output on normal/error paths");
});

it("bootstrap, metadata, login and OAuth failures never print secrets, codes, URLs or exception contents", () => {
  const code = `
    import { browser, origin } from './test/support/browser.js';
    import { secret } from './test/support/helpers.js';
    const cleanups = [], outputs = [];
    for (const name of ['log', 'error', 'warn', 'info', 'debug', 'trace']) console[name] = (...args) => outputs.push(args.join(' '));
    const b = await browser({ after(fn) { cleanups.push(fn); } });
    const initial = await b.login();
    if (initial.response.status !== 200) throw new Error('bootstrap_failed');
    const client = await b.register({ token_endpoint_auth_method: 'client_secret_basic' }, true);
    const auth = await b.authorize(client);
    const basic = 'Basic ' + Buffer.from(client.client_id + ':' + client.client_secret).toString('base64');
    const exchanged = await b.token(client, auth.code, auth.verifier, {}, { Authorization: basic });
    if (exchanged.status !== 200) throw new Error('exchange_failed');
    const tokens = await exchanged.json();
    const url = new URL(initial.link);
    const values = [b.password, b.cookie.split('=')[1], url.searchParams.get('token'), url.searchParams.get('hmac'), client.client_secret, auth.code, tokens.access_token, tokens.refresh_token, initial.link, origin + '/oauth/token', secret()];
    const invalid = await b.send(new Request(origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: values.at(-1), redirect_uris: [values.at(-1)] }) }));
    if (invalid.status !== 400) throw new Error('metadata_failed');
    const failed = await b.login(secret());
    if (failed.response.status !== 401) throw new Error('login_failed');
    const replies = [await invalid.text(), failed.html];
    await b.login();
    const realStore = b.deps.store;
    for (const [path, statement, body] of [
      ['/admin', 'SELECT * FROM admin_sessions', null],
      ['/oauth/register', 'INSERT INTO clients', { client_name: 'AI', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }],
      ['/oauth/token', 'SELECT * FROM clients', { grant_type: 'authorization_code', client_id: client.client_id }],
    ]) {
      b.deps.store = { ...realStore, sql: { ...b.sql,
        all(sql, ...bindings) { if (sql.startsWith(statement)) throw new Error(values.join('|')); return b.sql.all(sql, ...bindings); },
        run(sql, ...bindings) { if (sql.startsWith(statement)) throw new Error(values.join('|')); return b.sql.run(sql, ...bindings); },
      } };
      const response = await b.send(new Request(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: b.cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      if (response.status !== 500) throw new Error('deep_error_status');
      replies.push(await response.text());
    }
    for (const path of ['/admin/login', '/admin', '/oauth/register', '/oauth/token', '/oauth/authorize', '/mcp']) {
      b.deps.store = { setting() { throw new Error(values.join('|')); } };
      const response = await b.send(new Request(origin + path, { method: path === '/admin' ? 'GET' : 'POST' }));
      if (response.status !== 500) throw new Error('error_status');
      replies.push(await response.text());
    }
    if (outputs.length || replies.some(reply => values.some(value => reply.includes(value)))) throw new Error('disclosure');
    for (const fn of cleanups.reverse()) fn();
  `;
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.ok(child.status === 0, "admin/OAuth secrecy scenario passed");
  assert.ok(child.stdout === "" && child.stderr === "", "no output on admin/OAuth normal/error paths");
});

it("MCP reads, writes, reply signatures, results and deep failures never log bodies, Health values or secrets", () => {
  const code = `
    import { connected, command, write, tool, rpc } from './test/support/mcp.js';
    import { sample, secret } from './test/support/helpers.js';
    const cleanups = [], outputs = [];
    for (const name of ['log', 'error', 'warn', 'info', 'debug', 'trace']) console[name] = (...args) => outputs.push(args.join(' '));
    const b = await connected({ after(fn) { cleanups.push(fn); } }, { write: true });
    const marker = secret();
    await b.deliver({ samples: [sample({ note: marker })] });
    const values = [marker, b.config.token, b.config.hmac, b.accessToken, b.tokens.refresh_token, b.cookie, b.password, 'https://receiver.example/mcp'];
    if ((await tool(b, b.accessToken, 'syncky_query', { type: 'steps' })).rows.length !== 1) throw new Error('read_failed');
    if ((await tool(b, b.accessToken, 'syncky_status')).targets.length !== 1) throw new Error('status_failed');
    const c = command(b, { note: marker });
    if ((await write(b, c)).state !== 'queued') throw new Error('queue_failed');
    const delivered = await b.deliver();
    values.push(delivered.headers.get('x-syncky-signature'), await delivered.text());
    if ((await b.results([{ command_id: c.command_id, version: 1, status: 'rejected', reason: 'healthkit_denied' }])).status !== 200) throw new Error('result_failed');
    const realStore = b.deps.store;
    for (const [statement, name, args] of [
      ['SELECT rowid AS page_id, * FROM samples', 'syncky_query', { type: 'steps' }],
      ['SELECT rowid AS page_id, destination', 'syncky_status', {}],
      ['INSERT INTO commands', 'syncky_write', command(b)],
    ]) {
      b.deps.store = { ...realStore, sql: { ...b.sql,
        all(sql, ...bindings) { if (sql.startsWith(statement)) throw new Error(values.join('|')); return b.sql.all(sql, ...bindings); },
        run(sql, ...bindings) { if (sql.startsWith(statement)) throw new Error(values.join('|')); return b.sql.run(sql, ...bindings); },
      } };
      const reply = await rpc(b, b.accessToken, 'tools/call', { name, arguments: args }, {}, { id: name });
      const text = await reply.text();
      const expected = JSON.stringify({ jsonrpc: '2.0', id: name, error: { code: -32603, message: 'Internal error' } });
      if (reply.status !== 200 || text !== expected || values.some(v => text.includes(v))) throw new Error('unsafe_error');
    }
    if (outputs.length) throw new Error('disclosure');
    for (const fn of cleanups.reverse()) fn();
  `;
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.ok(child.status === 0, "MCP secrecy scenario passed");
  assert.ok(child.stdout === "" && child.stderr === "", "no output on MCP normal/error paths");
});
