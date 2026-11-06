import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildLink } from "../server.mjs";
import { lines, queue, run, tempDir, water } from "./helpers.js";

const mode = (path) => statSync(path).mode & 0o777;
const secretOf = (dir, name) => readFileSync(join(dir, name), "utf8").trim();

describe("argument errors exit 2", () => {
  const cases = [
    [[], /missing command/],
    [["frobnicate"], /unknown command: frobnicate/],
    [["serve", "--token", "abc"], /Unknown option '--token'/],
    [["serve", "--hmac=whsec_x"], /Unknown option '--hmac'/],
    [["serve", "--port", "70000"], /--port must be 0 to 65535/],
    [["serve", "--port", "http"], /--port must be 0 to 65535/],
    [["serve", "--auth", "magic"], /--auth must be none, bearer, basic or header/],
    [["link", "--auth", "basic"], /--auth basic needs --user/],
    [["link", "--auth", "basic", "--user", "a:b"], /--auth basic needs --user/],
    [["link", "--auth", "header"], /--auth header needs --header/],
    [["link", "--auth", "none", "--format", "xml"], /--format must be native, hae, csv or influx/],
    [["init", "extra"], /init takes 0 arguments/],
    [["write", "dietary_water", "0.25"], /write takes 3 arguments/],
    [["write", "Water", "0.25", "L"], /<type> must be/],
    [["write", "dietary_water", "1e3", "L"], /<value> must be a decimal number/],
    [["write", "dietary_water", "0.25", "liters of water"], /<unit> must be a unit/],
    [["write", "dietary_water", "0.25", "L", "extra"], /write takes 3 arguments/],
    [["write", "dietary_water", "0.25", "L", "--at", "yesterday"], /--at must be an RFC 3339 UTC time/],
    [["write", "dietary_water", "0.25", "L", "--at", "2026-13-45T07:00:00Z"], /--at must be an RFC 3339 UTC time/],
    [["delete"], /delete takes 1 argument/],
    [["delete", "c_9"], /no command c_9 in the outbox/],
  ];
  for (const [args, message] of cases) {
    it(JSON.stringify(args), (t) => {
      const dir = tempDir(t);
      const r = run([...args, "--data", dir]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.match(r.stderr, /usage: server\.mjs/);
    });
  }
});

describe("init", () => {
  it("writes a token and an hmac secret with mode 600 in a 700 directory, and keeps them", (t) => {
    const dir = join(tempDir(t), "data");
    const first = run(["init", "--data", dir]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(mode(dir), 0o700);
    for (const name of ["token", "hmac"]) assert.equal(mode(join(dir, name)), 0o600);
    assert.match(secretOf(dir, "token"), /^srv_[A-Za-z0-9_-]{43}$/);
    assert.match(secretOf(dir, "hmac"), /^whsec_[A-Za-z0-9_-]{43}$/);
    const before = [secretOf(dir, "token"), secretOf(dir, "hmac")];
    assert.equal(run(["init", "--data", dir]).status, 0);
    assert.deepEqual([secretOf(dir, "token"), secretOf(dir, "hmac")], before);
    assert.doesNotMatch(first.stdout + first.stderr, /srv_|whsec_/);
  });
});

describe("link", () => {
  it("prints the setup link for bearer auth with the files' secrets", (t) => {
    const dir = tempDir(t);
    run(["init", "--data", dir]);
    const r = run(["link", "--data", dir, "--host", "box.local", "--port", "3001"]);
    assert.equal(r.status, 0, r.stderr);
    const expected = buildLink(
      { name: "Minimal server", url: "http://box.local:3001/syncky", format: "native", auth: { kind: "bearer" }, signing: true, types: null },
      { token: secretOf(dir, "token"), hmac: secretOf(dir, "hmac") },
    );
    assert.equal(r.stdout, `${expected}\n`);
    assert.match(r.stdout, /^syncky:\/\/webhook\?v=1&name=Minimal%20server&url=http%3A%2F%2Fbox\.local%3A3001%2Fsyncky&format=native&auth=bearer&token=srv_[A-Za-z0-9_-]+&hmac=whsec_[A-Za-z0-9_-]{43}\n$/);
    assert.match(r.stderr, /QR/);
  });

  it("prints header and basic links, with the environment's secrets before the files'", (t) => {
    const dir = tempDir(t);
    run(["init", "--data", dir]);
    const env = { SYNCKY_SERVER_TOKEN: "env-token", SYNCKY_SERVER_HMAC: "whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c" };
    const header = run(["link", "--data", dir, "--host", "box.local", "--auth", "header", "--header", "X-Api-Key", "--format", "hae", "--name", "Домашний сервер"], { env });
    assert.equal(header.stdout, `${buildLink({ name: "Домашний сервер", url: "http://box.local:3000/syncky", format: "hae", auth: { kind: "header", header_name: "X-Api-Key" }, signing: true, types: null }, { header_value: "env-token", hmac: env.SYNCKY_SERVER_HMAC })}\n`);
    const basic = run(["link", "--data", dir, "--host", "box.local", "--auth", "basic", "--user", "phone", "--format", "csv"], { env });
    assert.match(basic.stdout, /&format=csv&auth=basic&user=phone&token=env-token&hmac=whsec_/);
  });

  it("a link without auth and without an hmac file carries no secret", (t) => {
    const dir = tempDir(t);
    const r = run(["link", "--data", dir, "--host", "box.local", "--auth", "none", "--format", "influx"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "syncky://webhook?v=1&name=Minimal%20server&url=http%3A%2F%2Fbox.local%3A3000%2Fsyncky&format=influx&auth=none\n");
  });

  it("exits 1 when a token is needed but neither the environment nor the data dir has one", (t) => {
    const dir = tempDir(t);
    for (const command of ["link", "serve"]) {
      const r = run([command, "--data", dir, "--port", "0"]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /no token: run init or set SYNCKY_SERVER_TOKEN/);
    }
  });
});

describe("write, delete and status", () => {
  it("queues writes and deletes in outbox.jsonl and counts them", (t) => {
    const dir = tempDir(t);
    const first = run(["write", "dietary_water", "0.25", "L", "--at", "2026-10-14T07:00:00Z", "--data", dir]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "queued c_1 version 1\n");
    assert.equal(run(["write", "apple_exercise_time", "30", "min", "--data", dir]).stdout, "queued c_2 version 1\n");
    const deleted = run(["delete", "c_1", "--data", dir]);
    assert.equal(deleted.stdout, "queued c_1 version 2\n");
    const outbox = lines(join(dir, "outbox.jsonl")).map((l) => JSON.parse(l));
    assert.deepEqual(outbox[0], water(1));
    assert.equal(outbox[1].type, "apple_exercise_time");
    assert.match(outbox[1].start, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    assert.equal(outbox[1].start, outbox[1].end);
    assert.deepEqual(outbox[2], { command_id: "c_1", version: 2, op: "delete", type: "dietary_water" });
    assert.equal(mode(join(dir, "outbox.jsonl")), 0o600);

    const again = run(["delete", "c_1", "--data", dir]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /c_1 is already deleted/);

    const status = run(["status", "--data", dir]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, "samples 0\ndeleted 0\ninbox 0\ncommands 2 (2 waiting for a result)\nresults 0\n");
  });

  it("status on a fresh directory counts zero and creates nothing", (t) => {
    const dir = join(tempDir(t), "none");
    const r = run(["status", "--data", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "samples 0\ndeleted 0\ninbox 0\ncommands 0 (0 waiting for a result)\nresults 0\n");
    assert.equal(existsSync(dir), false);
  });

  it("numbers new writes after the ones already queued", (t) => {
    const dir = tempDir(t);
    queue(dir, [water(1), water(2), water(4)]);
    assert.equal(run(["write", "dietary_water", "1", "L", "--data", dir]).stdout, "queued c_5 version 1\n");
  });

  it("queues a negative value given after --", (t) => {
    const dir = tempDir(t);
    const r = run(["write", "--data", dir, "--", "water_temperature", "-1.5", "degC"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(lines(join(dir, "outbox.jsonl"))[0]).value, -1.5);
  });

  it("a corrupt data file exits 1 without printing its content", (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "samples.jsonl"), 'x72.5,"unit":"count/min"}\n');
    const r = run(["status", "--data", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON lines/);
    assert.ok(!r.stderr.includes("72.5"), "stderr shows the record");
  });
});
