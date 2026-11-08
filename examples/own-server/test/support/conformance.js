import { createUploadCredentials, random } from "../../src/crypto.js";
import { check } from "./runtime.js";

const authHeaders = (auth, token) => auth.kind === "header" ? { [auth.header_name]: token } : { Authorization: auth.kind === "basic" ? "Basic " + btoa(auth.user + ":" + token) : "Bearer " + token };
async function configure(runtime, auth, token, hmac) {
  const credentials = await createUploadCredentials({ auth, token, hmac });
  await runtime.run("INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", "upload_credentials", JSON.stringify(credentials));
}

export async function conformance(runtime, vectors) {
  for (const c of vectors.requests) {
    for (const table of ["samples", "summaries", "upload_targets"]) await runtime.run("DELETE FROM " + table);
    let auth = c.destination.auth;
    const token = c.secrets.token ?? c.secrets.header_value ?? random();
    if (auth.kind === "none") {
      let rejected = false;
      try { await createUploadCredentials({ auth, token }); } catch { rejected = true; }
      check(rejected, "runtime insecure vector configuration refused");
      auth = { kind: "bearer" };
    }
    await configure(runtime, auth, token, c.destination.signing ? c.secrets.hmac : null);
    runtime.setNow(Number(c.timestamp));
    const samples = new Map(), summaries = new Map();
    const ordered = [...c.requests].reverse();
    for (const r of [...ordered, ...c.requests]) {
      const headers = { ...r.headers, ...authHeaders(auth, token) };
      const response = await runtime.send(new Request(runtime.origin + "/server", { method: "POST", headers, body: r.body }));
      check(response.status === (c.format === "native" ? 200 : 415), "runtime request vector: " + c.name);
      if (c.format !== "native") { check((await response.json()).code === "unsupported_format", "runtime native-only vector"); continue; }
      check(await response.text() === "", "runtime vector empty reply");
      const m = JSON.parse(r.body);
      for (const s of m.samples) samples.set(m.device + "|" + s.uuid + "|" + (s.part ?? -1), s);
      for (const s of m.deleted) for (const key of samples.keys()) if (key.startsWith(m.device + "|" + s.uuid + "|")) samples.delete(key);
      for (const s of m.summaries ?? []) summaries.set(JSON.stringify([m.device, s.type, s.unit, s.start, s.end, s.stat]), s);
    }
    const stored = await runtime.all("SELECT * FROM samples");
    check(stored.length === samples.size, "runtime vector deduplication");
    for (const row of stored) check(row.payload_json === JSON.stringify(samples.get(row.device + "|" + row.uuid + "|" + row.part)), "runtime vector native payload preserved");
    const totals = await runtime.all("SELECT * FROM summaries");
    check(totals.length === summaries.size, "runtime vector summary keys");
    for (const row of totals) check(row.value === summaries.get(JSON.stringify([row.device, row.type, row.unit, row.start, row.end, row.stat])).value, "runtime vector summary replacement");
  }
  for (const c of vectors.signatures) {
    const token = random();
    await configure(runtime, { kind: "bearer" }, token, c.secret);
    runtime.setNow(c.now);
    const response = await runtime.send(new Request(runtime.origin + "/server", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Syncky-Format": "native", "X-Syncky-Timestamp": c.timestamp, "X-Syncky-Signature": c.signature }, body: c.body }));
    check(response.status === (c.expect === "valid" ? 400 : 401), "runtime signature vector: " + c.name);
    if (c.expect !== "valid") check((await response.json()).code === c.expect, "runtime vector signature verdict");
  }
  for (const c of vectors.exchanges.filter(c => c.kind !== "reply")) {
    const auth = c.destination.auth.kind === "none" ? { kind: "bearer" } : c.destination.auth;
    const token = c.secrets.token ?? c.secrets.header_value ?? random();
    await configure(runtime, auth, token, c.destination.signing ? c.secrets.hmac : null);
    runtime.setNow(Number(c.timestamp));
    const response = await runtime.send(new Request(runtime.origin + "/server", { method: "POST", headers: { ...c.headers, ...authHeaders(auth, token) }, body: c.body }));
    check(response.status === (c.kind === "results_request" || c.format === "native" ? 200 : 415), "runtime exchange vector: " + c.name);
    if (response.status === 200) check(await response.text() === "", "runtime exchange cannot deliver commands");
  }
}
