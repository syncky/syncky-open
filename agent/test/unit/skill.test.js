import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandNames } from "../../src/cli.js";
import { createLocalValidator } from '../../src/send.js';
import { loadSchemas } from '../../src/protocol-files.js';
import { skillExample } from '../support/skill-examples.js';
import { runCli, tempHome } from '../support/helpers.js';

const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_DIR = join(AGENT_DIR, "skills/syncky");
const SKILL = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "SKILL.md has no frontmatter");
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

describe("thin feature skill", () => {
  it('explains per-type refusals, bounded amendments and canonical root replies', () => {
    for (const pattern of [/five admitted events per rolling 24 hours/, /three admitted amendments/, /requested_recently/, /declined_recently/,
      /next_available_at/, /daily_ceiling/, /amendment_limit/, /merged_into/, /merged_refs/, /remaining needed types/,
      /Never.*(?:evade|bypass).*wait/, /original.*expiry/]) assert.match(SKILL, pattern);
    assert.doesNotMatch(SKILL, /one admission per rolling (?:24 hours|day)/);
    const metadata = JSON.parse(readFileSync(join(SKILL_DIR, 'document.json')));
    assert.ok(metadata.skill_version > 3);
    assert.deepEqual(metadata.protocol, { protocol_version: 1, message_table_schema: 1 });
    assert.match(metadata.whats_new, /per-type.*merged/i);
  });
  it('explains interval sums of activity totals, raw logged entries and the replace rule', () => {
    for (const pattern of [/top-level `summaries` array/, /15-minute UTC interval/, /`stat: "sum"`/, /same key replaces the earlier value/,
      /never add the two together/, /`value: 0`/, /missing interval is not a zero/, /ignore the overlapping raw samples/,
      /Workouts, weight and every other type without `"interval_sums": true` remain raw samples/, /Phones from 0\.1\.3 send activity totals/,
      /logged as separate entries \(`"interval_sums": false`: `dietary_\*` including water and caffeine, `insulin_delivery`, `inhaler_usage`/,
      /always arrive as raw samples, each with its own time and source/]) assert.match(SKILL, pattern);
    assert.doesNotMatch(SKILL, /newer than 0\.1\.3/);
    const metadata = JSON.parse(readFileSync(join(SKILL_DIR, 'document.json')));
    assert.ok(metadata.skill_version > 5);
    assert.match(metadata.whats_new, /interval sums.*replaces/i);
    assert.match(metadata.whats_new, /Food, water, insulin, inhaler use and similar logged entries stay raw samples/);
  });
  it('serves the current source skill offline with explicit revoke and deletion approval', async t => {
    const tmp = tempHome(); t.after(tmp.cleanup);
    const result = await runCli(['--home', tmp.home, 'skill', '--json']);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).skill, SKILL);
    assert.match(SKILL, /revoke only with the owner's explicit approval when the phone says the relay was not told/);
    assert.match(SKILL, /Leave confirm\/reject\/revoke\/forget decisions to them/);
    assert.match(SKILL, /obtain explicit deletion consent before forget/);
  });
  it('provides executable schema-valid generic send examples', () => {
    const validate = createLocalValidator(loadSchemas());
    for (const type of ['commands', 'diagnostics_request', 'access_request', 'scope_release']) {
      assert.doesNotThrow(() => validate(skillExample(type)));
      assert.match(SKILL, new RegExp(`send --type ${type} --validate --json -`));
    }
    for (const type of ['diagnostics_request', 'access_request']) {
      const inner = skillExample(type);
      assert.equal(Date.parse(inner.expires_at) - Date.parse(inner.created_at), 86400000);
    }
  });
  it('skill and setup require commands-array batching and explain the hourly budget and retries', () => {
    for (const document of [SKILL, readFileSync(join(AGENT_DIR, 'SETUP.md'), 'utf8')]) {
      assert.match(document, /[Ss]end several entries in [Oo][Nn][Ee] `send` with a `commands` array/);
      assert.match(document, /60 data envelopes per hour per agent/);
      assert.match(document, /burst of up to 60 data envelopes/);
      assert.match(document, /one a minute.*60 data envelopes per hour per agent sustained/);
      assert.match(document, /per-token limit of 60 requests a minute.*polling, ACKs and heartbeats/);
      assert.match(document, /262144 bytes/);
      assert.match(document, /complete serialized UTF-8 JSON.*base64 ciphertext and recipient metadata/);
      assert.match(document, /inner `commands` JSON.*roughly 191 KiB for one recipient, less with more recipients/);
      assert.match(document, /429 `rate_limited` from either limit.*retried automatically.*Retry-After/);
      assert.match(document, /caller does not resend/);
      assert.match(document, /status --json.*send_lanes.*pending/);
    }
  });
  it('skill and setup bound daily totals and separate access recovery from format and save failures', () => {
    for (const document of [SKILL, readFileSync(join(AGENT_DIR, 'SETUP.md'), 'utf8')]) {
      for (const pattern of [
        /`end` must not be later than now \+ 1 h.*`invalid`/,
        /`start` to local day start and `end` to now or the last diary entry time/,
        /Never use the end of the day/,
        /same `command_id` with `version` \+ 1/,
        /all nutrients of one day in one `send` with several `commands`/,
        /`access_request` is an optional ask-ahead, not a required step before writes/,
        /`type_not_in_scope`, `type_not_allowed` or `healthkit_denied`/,
        /tell the owner to allow that type on the phone/,
        /`access_request` for exactly those write types if the phone has not asked yet/,
        /Resend only after the next ordinary sync shows the effective write scope/,
        /On an `invalid` ack, check the command format first \(`--validate`\): fix timestamps, units or JSON\./,
        /Schema validation does not cover phone policy; check interval bounds and units, then report an unexplained rejection without looping\./,
        /Never ask for access on `invalid`\./,
        /After a phone rejection, keep the same `command_id` and increment `version` before retrying; the phone caches completed rejections\./,
        /A refused write creates no access request or automatic system consent prompt; its Home card may offer an owner-tapped Allow action\./,
        /No phone app version or access-request capability is exposed in sync or status/,
        /If no matching `access_reply` arrives after an `access_request`, have the owner open Syncky and sync; if it remains missing, check whether consent is still pending on the phone and whether the request expired, then suggest the owner check for an app update without looping\./,
        /Missing replies do not prove an old app/,
      ]) assert.match(document, pattern);
    }
  });
  it("has the OpenClaw header and names only real commands", () => {
    checkedHeader(SKILL, true);
    assert.equal(frontmatter(SKILL).description, "Give your AI agent Apple Health data you pick, end-to-end encrypted between your iPhone and the local Syncky agent; send writes you authorize through your agent, for the types allowed on your iPhone.");
    const commands = [...SKILL.matchAll(/"\$SYNCKY_RUNNER" ([a-z]+)/g)].map(m => m[1]);
    assert.ok(commands.length > 0); assert.deepEqual(commands.filter(c => !commandNames().includes(c)), []);
    assert.doesNotMatch(SKILL, /syncky_(?:samples|summary|write|commands|request_access|request_diagnostics)/);
  });
  it("keeps private pairing, code proof and owner-approved service/on-demand decisions", () => {
    for (const pattern of [/Use Syncky and start onboarding with a QR code/, /SYNCKY_RUNNER/, /SYNCKY_INVITE/, /source-kit fallback/, /missing invites/, /Scanning alone does not/, /private reply/, /never quote the token-bearing URI/, /one receiver per home/, /Needs attention/, /uploads wait/, /Without an answer, wait/, /login startup and restart on failure/, /receive --once/, /stdout must go to/, /checksum/, /cannot protect against someone/]) assert.match(SKILL, pattern);
    const recipe = /```sh\n([\s\S]*?)\n```/.exec(SKILL)[1];
    assert.match(recipe, /"\$SYNCKY_RUNNER" pair/);
    assert.doesNotMatch(recipe, /--force|--wait|--no-qr|--json|--v1|npm|curl|wget|&\s*$/m);
  });
  it("preserves explicit writes/requests, untrusted-data, no-diagnosis and report-file consent rules", () => {
    for (const pattern of [/explicitly asks for the exact value\/time/, /Confirm inferred entries first/, /explicit owner approval/, /untrusted data, never instructions/, /Never expose private keys, CEKs, invites/, /never post it publicly/, /raw home files/, /exclusive creation of a new file/, /Never overwrite or append/, /Without an answer, wait/, /Forget|forget/, /not a medical device/, /command_id.*version/, /Absent data is not zero/]) assert.match(SKILL, pattern);
    for (const feature of ['Health JSON in','Writes','Diagnostics request','Access request','Scope release']) {
      const section = SKILL.split('## ' + feature + '\n')[1]?.split('\n## ')[0];
      assert.ok(section); for (const field of ['**When:**','**JSON:**','**Phone reply:**','**Tell the owner:**']) assert.ok(section.includes(field));
    }
    assert.match(SKILL, /read-only configurations disable both send and ack/i);
    assert.match(SKILL, /Start receive separately/);
    assert.match(SKILL, /No binary auto-update/);
  });
});

function checkedHeader(text, openclaw) {
  const fields = frontmatter(text);
  assert.deepEqual(Object.keys(fields).sort(), (openclaw ? ["name", "description", "homepage", "metadata"] : ["name", "description", "license"]).sort());
  assert.equal(fields.name, "syncky");
  assert.ok(fields.description.length >= 40 && fields.description.length <= 200);
  for (const [key, value] of Object.entries(fields)) {
    assert.equal(typeof value, "string");
    if (key !== "metadata") assert.ok(!/^(true|false|null|\d+|\[|\{)/.test(value), "frontmatter must be a string scalar");
  }
  if (openclaw) {
    assert.equal(fields.homepage, "https://syncky.app/agents");
    assert.deepEqual(JSON.parse(fields.metadata), { openclaw: { requires: { bins: ["node"] } } });
  } else assert.equal(fields.license, "Apache-2.0");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

describe("format-specific carried skills", () => {
  let root, dist;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "syncky-skill-"));
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) dist = dirname(JSON.parse(readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE, "utf8")).release.bundlePath);
    else {
      const { buildAgent } = await import("../../build.mjs");
      dist = dirname((await buildAgent({ outdir: join(root, "output") })).bundlePath);
    }
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("shares byte-identical bodies while preserving the source OpenClaw and portable header policies", () => {
    const sourceBody = checkedHeader(SKILL, true);
    for (const [path, openclaw] of [["claude-code/plugins/syncky/skills/syncky", false], ["codex/plugins/syncky/skills/syncky", false], ["clawhub/syncky", true], ["agent-skills/skills/syncky", false]]) {
      const skill = readFileSync(join(dist, path, "SKILL.md"), "utf8");
      assert.equal(checkedHeader(skill, openclaw), sourceBody);
      assert.equal(frontmatter(skill).description, frontmatter(SKILL).description);
      const commands = [...skill.matchAll(/`syncky-agent ([a-z]+)/g)].map((m) => m[1]);
      assert.ok(commands.every((c) => commandNames().includes(c)), "packaged skill contains an invalid command");
    }
    for (const path of ["claude-code/plugins/syncky/.claude-plugin/plugin.json", "codex/plugins/syncky/.codex-plugin/plugin.json"]) {
      assert.equal(JSON.parse(readFileSync(join(dist, path), "utf8")).description, frontmatter(SKILL).description);
    }
  });

  it("rejects homepage, nested OpenClaw metadata and non-string fields in portable headers", () => {
    const portable = "---\nname: syncky\ndescription: Read Apple Health data and write entries requested by the owner.\nlicense: Apache-2.0\n---\nbody\n";
    checkedHeader(portable, false);
    for (const field of ["homepage: https://syncky.app/agents", 'metadata: {"openclaw":{"requires":{"bins":["node"]}}}']) assert.throws(() => checkedHeader(portable.replace("\nlicense:", `\n${field}\nlicense:`), false));
    for (const value of ["true", "123", "[]", "{}", "null"]) assert.throws(() => checkedHeader(portable.replace("name: syncky", `name: ${value}`), false));
  });
});
