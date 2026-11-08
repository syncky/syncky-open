import { random } from "../../src/crypto.js";
import { client, check, callback } from "./runtime.js";

export async function loginAvailability(runtime) {
  const time = runtime.now();
  runtime.setNow(time);
  const b = client(runtime), csrf = random();
  const wrong = () => b.post("/admin/login", { csrf, password: random() }, { Cookie: "__Host-syncky-login=" + csrf });
  for (let n = 0; n < 10; n++) check((await wrong()).status === 401, "failed login counted");
  check((await wrong()).status === 429, "failed login limited");
  check(Boolean(await b.login()), "correct bootstrap password survives login flood");
  check((await wrong()).status === 429, "successful login does not reset failed attempts");
  await runtime.restart();
  check(!await b.login(), "correct password survives restart and spent bucket");
  check((await runtime.all("SELECT attempts FROM rate_limits WHERE key = 'login'"))[0].attempts === 10, "only failed logins consume capacity");
  runtime.setNow(time + 60);
  check((await wrong()).status === 401, "failed login window resets");
  await b.login();
}

export async function registrationAvailability(runtime) {
  const b = client(runtime); await b.login();
  const time = runtime.now();
  const dynamic = () => b.send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Local AI", redirect_uris: [callback] }) });
  const manual = () => b.post("/admin/clients", { client_name: "Local AI", redirect_uri: callback });
  for (let hour = 0; hour < 4; hour++) {
    runtime.setNow(time + hour * 3600);
    for (let n = 0; n < (hour === 3 ? 2 : 10); n++) await b.register();
  }
  for (let n = 0; n < 8; n++) {
    const full = await dynamic();
    check(full.status === 429 && (await full.json()).code === "client_limit", "DCR cannot consume reserved capacity");
  }
  const limited = await dynamic();
  check(limited.status === 429 && (await limited.json()).code === "rate_limited", "DCR bucket exhausted");
  await b.login();
  const registered = await b.register(true, true);
  const tokens = await b.access(registered);
  check((await b.rpc(tokens.access_token)).status === 200, "manual consent and MCP survive DCR exhaustion");
  for (let n = 1; n < 8; n++) await b.register(true);
  const full = await manual();
  check(full.status === 429 && (await full.json()).code === "client_limit", "manual registrations remain bounded");
  check((await runtime.all("SELECT COUNT(*) AS n FROM clients"))[0].n === 40, "eight reserved manual slots");
  await runtime.restart();
  check((await b.rpc(tokens.access_token)).status === 200, "reserved manual client survives restart");
}

export async function codeReplay(runtime) {
  const b = client(runtime); await b.login();
  const time = runtime.now(); runtime.setNow(time);
  const registered = await b.register(), other = await b.register();
  const unaffected = await b.access(other);
  const tokens = await b.access(registered, "read:steps", async exchange => {
    await runtime.run("CREATE TRIGGER reject_consumed_code BEFORE INSERT ON consumed_codes BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
    check((await b.post("/oauth/token", exchange)).status === 500, "failed replay-record storage rejects token issuance");
    check((await runtime.all("SELECT * FROM auth_codes WHERE client_id = ?", registered.client_id)).length === 1, "failed exchange preserves authorization code");
    check((await runtime.all("SELECT * FROM oauth_tokens WHERE client_id = ?", registered.client_id)).length === 0, "failed exchange issues no tokens");
    await runtime.run("DROP TRIGGER reject_consumed_code");
  });
  const refresh = token => b.post("/oauth/token", { grant_type: "refresh_token", client_id: registered.client_id, refresh_token: token, resource: b.origin + "/mcp" });
  const rotated = await refresh(tokens.refresh_token);
  check(rotated.status === 200, "code family refresh succeeds");
  const next = await rotated.json();
  for (const extra of [{ client_id: other.client_id }, { code_verifier: random() }, { redirect_uri: callback + "/wrong" }, { resource: b.origin + "/wrong" }]) {
    check((await b.post("/oauth/token", { ...tokens.exchange, ...extra })).status === 400, "misbound replay denied");
    check((await b.rpc(next.access_token)).status === 200, "misbound replay cannot revoke another family");
  }
  const stored = JSON.stringify(await runtime.all("SELECT * FROM consumed_codes"));
  check(!stored.includes(tokens.code) && !stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), "consumed code stores no raw credentials");
  check((await runtime.all("SELECT * FROM auth_codes")).length === 0, "consumed codes leave no usable authorization code");
  await runtime.restart();
  runtime.setNow(time + 61);
  const replay = await b.post("/oauth/token", tokens.exchange);
  check(replay.status === 400 && (await replay.json()).error === "invalid_grant", "consumed code replay denied after original expiry and restart");
  for (const token of [tokens.access_token, next.access_token]) check((await b.rpc(token)).status === 401, "code replay revokes original and rotated access tokens");
  check((await refresh(next.refresh_token)).status === 400, "code replay revokes rotated refresh token");
  check((await b.rpc(unaffected.access_token)).status === 200, "unrelated client family stays active");
  const fresh = await b.access(registered);
  check((await b.rpc(fresh.access_token)).status === 200, "fresh consent can issue a new family");
  runtime.setNow(time + 300);
  await b.get("/.well-known/oauth-authorization-server");
  check((await runtime.all("SELECT COUNT(*) AS n FROM consumed_codes"))[0].n === 1, "expired replay records pruned while recent record remains");
  check((await b.post("/admin/erase", { confirm: "erase" })).status === 200, "admin erasure succeeds");
  check((await runtime.all("SELECT * FROM consumed_codes")).length === 0, "erasure removes replay records");
}
