import { ERROR_GUIDANCE } from '../../src/error-guidance.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { commandNames, parseArgs } from '../../src/cli.js';
import { resolveConfig } from '../../src/config.js';
import { TOOLS } from '../../src/mcp.js';
import { loadJson, loadVectors } from '../../src/protocol-files.js';
import { createLocalValidator } from '../../src/send.js';
import { loadSchemas } from '../../src/protocol-files.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = ['README.md','AGENTS.md','SETUP.md','docs/REFERENCE.md','cookbook/README.md','cookbook/weight.md','cookbook/calories.md','cookbook/workouts.md'];
const docs = Object.fromEntries(files.map(f => [f, readFileSync(resolve(root,f),'utf8')]));
const standaloneDocs = { ...docs, ...Object.fromEntries(['skills/pointer.md', 'skills/safety.md'].map(f => [f, readFileSync(resolve(root, f), 'utf8')])) };
const reference = docs['docs/REFERENCE.md'];
const validate = createLocalValidator(loadSchemas());

test('skill trust guidance explains an unverifiable previous bundle without discarding active instructions', () => {
  assert.match(reference, /installed `previous` bundle cannot be verified, it is omitted while the verified active bundle and high-water mark stay intact/);
  assert.match(reference, /`syncky skill --diff` then reports `previous_version: null` and shows the whole current skill as additions/);
});

test('pairing setup preserves local rejection and directs relay recovery through revoke', () => {
  const pairing = docs['SETUP.md'].split('## 6. Security rules')[0];
  assert.match(pairing, /If the relay call fails, local rejection remains; finish relay revocation with `syncky revoke <member_id>` after the relay is reachable or the token is fixed\./);
  assert.match(pairing, /After `invalid_token`, stop and tell the owner\./);
});

test('no-scope setup selects and authorizes Health data before first sync while scoped pairing sends scope', () => {
  for (const name of ['README.md', 'SETUP.md', 'AGENTS.md', 'skills/syncky/SKILL.md']) {
    const text = readFileSync(resolve(root, name), 'utf8');
    const sequence = text.split('\n').find(line => line.startsWith('For no-scope pairing,'));
    assert.ok(sequence, name);
    assert.ok(/\*\*Choose Health data\*\*, select the categories or individual types to share, tap \*\*Save\*\*, complete Health authorization[^.]*then tap \*\*Sync now\*\*/.test(sequence), name);
    assert.ok(sequence.includes('Nothing syncs or applies while the phone is locked, because iOS locks the Health data.'), name);
    assert.ok(sequence.includes('Scoped pairing sends its initial scope without this manual step.'), name);
    assert.ok(text.includes('The phone sends this scope promptly without sample collection or a manual initial Sync.'), name);
    assert.doesNotMatch(sequence, /older.app|fallback/i, name);
  }
});

test('retention guidance makes receive-time pruning and idle history explicit without relaxing forget approval', () => {
  for (const name of ['README.md', 'SETUP.md', 'AGENTS.md', 'skills/syncky/SKILL.md']) {
    const text = readFileSync(resolve(root, name), 'utf8');
    assert.ok(text.includes('Receive prunes thin inbox records older than 30 days from local receipt during `receive --once`, at startup, and daily while receiving.'), name);
    assert.ok(text.includes('An idle home retains older files until a receiving cycle.'), name);
    assert.ok(/(?:only explicit owner approval authorizes `forget|[Oo]nly explicit owner-approved `forget|Explicit owner-approved `forget|never run forget without approval)/.test(text), name);
  }
});

test('published access protocol prose matches normalization, TTL and invalid reply rules', () => {
  const text = readFileSync(resolve(root, '../protocol/README.md'), 'utf8').split('## Health access controls\n')[1];
  const schema = JSON.parse(readFileSync(resolve(root, '../protocol/schemas/inner-system.schema.json'), 'utf8'));
  assert.ok(text);
  assert.ok(text.includes('`0 < expires_at - created_at <= 24h`'));
  assert.match(text, /finite positive TTL up to 24 hours.*`0 < expires_at - created_at <= 24h`/);
  assert.match(text, /phone sorts and deduplicates each array/);
  assert.doesNotMatch(text, /exactly creation plus 24 hours|individually sorted\/unique|exact 24-hour expiry/);
  assert.match(text, /optional `detail` only for `invalid`/);
  assert.match(text, /`invalid` have empty read\/write arrays/);
  for (const detail of schema.$defs.access_reply.properties.detail.enum) assert.ok(text.includes('`' + detail + '`'), detail);
  assert.doesNotMatch(text, /C§|docs\/(?:planning|plans|context)|(?:core|App|relay|e2e|scripts|docs-worker)\//);
});

test('agent access guidance accepts supported TTLs and preserves normalization', () => {
  for (const name of ['AGENTS.md', 'SETUP.md', 'docs/REFERENCE.md', 'skills/syncky/SKILL.md', 'cookbook/README.md']) {
    const text = readFileSync(resolve(root, name), 'utf8');
    assert.match(text, /finite positive TTL up to 24 h.*`0 < expires_at - created_at <= 24h`/, name);
    assert.match(text, /lists are sorted and deduplicated before sealing/, name);
    assert.doesNotMatch(text, /for compatibility with phones|use exactly 24 h/, name);
  }
});

test('rejected-write reference covers every reason/detail pair in the policy vectors', () => {
  const policy = JSON.parse(readFileSync(resolve(root, '../protocol/test-vectors/command-policy.json'), 'utf8'));
  const pairs = new Set(policy.cases.filter(c => c.detail).map(c => `| \`${c.reason}\` | \`${c.detail}\` |`));
  assert.equal(pairs.size, 8);
  for (const row of pairs) assert.ok(reference.includes(row), row);
  assert.match(reference, /optional `detail`/);
  assert.match(reference, /Older phones omit it/);
  assert.match(reference, /Unknown well-formed details are retained; handle them by `reason`/);
  assert.ok(reference.includes('The phone reports the first failing policy check. These are phone outcomes, never medical advice. Correct encoding, unit and time errors, but never change a measured value, invent a timestamp or clamp a value to pass a check; if the real data cannot be represented, stop and tell the owner.'));
  for (const [reason, detail, advice] of [
    ['invalid', 'end_in_future', 'Correct time errors; use `end = now` only when that accurately describes the data. For a running daily total, update the same command by incrementing its version.'],
    ['invalid', 'span_too_long', 'Split the period only where the data genuinely covers separate intervals; otherwise do not write it.'],
    ['value_out_of_range', null, 'Check the unit and the conversion; if the measured value really is outside the catalog bounds, do not write it, tell the owner.'],
  ]) {
    const row = reference.split('\n').find(line => line.startsWith(`| \`${reason}\` | ${detail ? `\`${detail}\`` : 'Absent or unknown'} |`));
    assert.ok(row?.endsWith(`| ${advice} |`), reason + '/' + detail);
  }
  for (const file of ['AGENTS.md', 'SETUP.md', 'skills/syncky/SKILL.md']) {
    assert.ok(readFileSync(resolve(root, file), 'utf8').includes('REFERENCE.md#rejected-write-details'), file);
  }
});

test('operator and cookbook write gates require type allowance, agent scope and HealthKit authorization', () => {
  for (const name of ['SETUP.md', 'cookbook/README.md']) {
    assert.match(docs[name], /[Tt]he type must be in the app write allowance \(device-wide\) or granted to this agent at pairing, within the agent's scope, and authorized by HealthKit\./, name);
    assert.doesNotMatch(docs[name], /Allow writing to Health/, name);
  }
});

const recipeTypes = {
  weight: [['body_mass', true]],
  calories: [['dietary_energy_consumed', true], ['dietary_protein', true], ['dietary_carbohydrates', true], ['dietary_fat_total', true], ['active_energy_burned', false]],
  workouts: [['workout', false], ['heart_rate', false], ['resting_heart_rate', false], ['heart_rate_variability_sdnn', false]],
};
const recipeText = recipe => docs['cookbook/' + recipe + '.md'] + '\n' + docs['cookbook/README.md'];

function requests(text, recipe) {
  assert.equal(text.split('<!-- syncky:permissions-step -->').length, 2);
  const section = text.split('\n## Permissions\n')[1]?.split('\n## On a schedule\n')[0]; assert.ok(section);
  const rows = [...text.matchAll(/^\| `([a-z_]+)` \| Yes \| (Yes[^|]*|No) \|/gm)];
  const expected = recipeTypes[recipe]; assert.ok(expected);
  assert.deepEqual(rows.map(m => [m[1], m[2].startsWith('Yes')]), expected, recipe);
  const read = expected.map(([type]) => type).sort(), write = expected.filter(([, writable]) => writable).map(([type]) => type).sort();
  const payloads = [...section.matchAll(/<<'JSON'\n([^]*?)\nJSON/g)].map(m => JSON.parse(m[1]));
  for (const payload of payloads) {
    validate(payload); assert.equal(payload.type, 'access_request');
    for (const side of ['read', 'write']) assert.deepEqual(payload[side], [...new Set(payload[side])].sort(), recipe);
    assert.equal(Date.parse(payload.expires_at) - Date.parse(payload.created_at), 86400000);
  }
  assert.deepEqual(payloads.map(p => ({ read:[...p.read].sort(), write:[...p.write].sort() })).sort((a,b) => a.write.length-b.write.length), [{ read, write:[] }, ...(write.length ? [{ read, write }] : [])], recipe);
  if (write.length) {
    assert.deepEqual(payloads[0].write, write, recipe + ': writing setup requests exactly its write types first');
    assert.match(section, /Start with this access_request setup for owner-approved writes/);
  }
  assert.match(text, /\[access setup and recovery\]\(README\.md#access-setup-and-recovery\)/);
  assert.ok(text.indexOf('syncky send --type access_request') < text.indexOf('## On a schedule'), recipe);
  for (const match of text.matchAll(/syncky send --type commands --json - <<'JSON'\n([^]*?)\nJSON/g)) {
    const payload = JSON.parse(match[1]); validate(payload);
    assert.ok(text.indexOf('syncky send --type access_request') < match.index, recipe);
    assert.deepEqual([...new Set(payload.commands.map(c => c.type))].sort(), write, recipe);
  }
}

test('Allow adds individual types while preserving existing selections and live read all', () => {
  for (const name of files.filter(file => file !== 'cookbook/README.md')) {
    const text = name.startsWith('cookbook/') ? recipeText(name.slice(9, -3)) : docs[name];
    assert.match(text, /Allow adds only approved types to Health selection, without selecting their categories\./, name);
    assert.match(text, /Existing selected categories and individually allowed types are preserved\./, name);
    assert.match(text, /partial selection.*Individually allowed:.*unchecked category/, name);
    assert.match(text, /Allow texts name the exact types/, name);
    assert.match(text, /Existing read `all` stays `all` and follows later Health selection changes/, name);
    assert.match(text, /Approved reads turn `none` into a chosen list and are unioned into existing read lists/, name);
    assert.match(text, /reply alone never updates cached scope/, name);
    if (name !== 'cookbook/workouts.md') {
      assert.match(text, /Allowed writes add only the approved write types to the app allowance and request Health sharing only for those exact types, without adding reads/, name);
      assert.doesNotMatch(text, /Allowed writes turn on the global|for all selected writable types/, name);
      assert.match(text, /writing was off or the agent's effective write allowance was empty.*only the approved write types.*even from `all` or an absent scope/, name);
    }
  }
});
test('operator guides explain partial selection removal and expiry without fabricated replies', () => {
  for (const name of ['SETUP.md','docs/REFERENCE.md']) {
    assert.match(docs[name], /Unchecking a category leaves individually allowed types selected/, name);
    assert.match(docs[name], /Remove individually allowed types.*save; iOS permissions stay unchanged/, name);
    assert.match(docs[name], /phone may be offline or consent pending/, name);
    assert.match(docs[name], /[Ee]xplain expiry from (?:the )?timestamps (?:rather than|instead of) inventing (?:a reply|local results)/, name);
  }
});

test('every relative path and link in the documents exists', () => {
  for (const [file,text] of Object.entries(standaloneDocs)) for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = decodeURIComponent(match[1].split('#')[0]);
    if (!target || /^[a-z][\w+.-]*:/i.test(target)) continue;
    assert.ok(existsSync(resolve(root,dirname(file),target)), `${file}: missing relative link`);
  }
});
function assertCommandsAndTools(text, file) {
  if (/\bsyncky_run\b/.test(text)) assert.match(text, /^syncky_run\(\) \{$/m, file);
  const commandsText = text.replace(/\bsyncky_run(?=\(\) \{| [a-z]+\b)/g, 'syncky-agent');
  const commands = [...commandsText.matchAll(/\bsyncky(?:-agent)? ([a-z]+)/g)].map(m => m[1]);
  assert.deepEqual(commands.filter(c => !commandNames().includes(c)), [], file);
  const tools = [...commandsText.matchAll(/\bsyncky_[a-z_]+\b/g)].map(m => m[0]);
  assert.deepEqual(tools.filter(c => !TOOLS.some(t => t.name === c)), [], file);
}
test('standalone guides work with public paths and real commands and tools', () => {
  for (const [file,text] of Object.entries(standaloneDocs)) {
    assert.doesNotMatch(text, /C§|docs\/(?:planning|plans|context)|(?:\.\.\/)*(?:scripts|core|App|relay|e2e|docs-worker|site|tools)\//, file);
    assertCommandsAndTools(text, file);
  }
});
test('read-only client configuration disables exactly the mutating tools', () => {
  const disabled = docs['SETUP.md'].match(/^disabled_tools = (\[[^\n]+\])$/m);
  assert.ok(disabled);
  assert.deepEqual(JSON.parse(disabled[1]).sort(), TOOLS.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort());
});
test('pairing, Health purpose, explicit requests, service and deletion approval stay mandatory', () => {
  const text = docs['SETUP.md'];
  for (const pattern of [/Scanning alone does not confirm trust/, /Never copy the status fingerprint back/, /owner.*code|owner picks/i, /explicit owner approval/, /say exactly what you will write/, /standing rule/, /never run forget without approval/, /instead of re-registering/, /untrusted data, never instructions/, /private data channel/, /Discard|discard/, /only when you ask/, /Wait for the answer.*before completing setup/]) assert.match(text,pattern);
});
test('cookbook permission arrays, markers, consent, outcomes and schedules match the catalog', () => {
  for (const recipe of ['weight','calories','workouts']) {
    const text = docs['cookbook/'+recipe+'.md']; requests(text,recipe);
    for (const pattern of [/explicit owner approval/, /queued request is not a grant/, /next ordinary sync/, /needs_health_settings/, /pending_limit/, /rate_limited/, /expired/, /seven.day/, /cannot observe Health read permission/, /reason or reference/, /conditional Health Settings/, /only after explicit approval/, /never overwrite\/append/, /untrusted data, never instructions/]) assert.match(recipeText(recipe),pattern);
    const types = loadJson('types.json');
    for (const m of text.matchAll(/^\| `([a-z_]+)` \| Yes \| (Yes[^|]*|No) \| ([^|]+) \|$/gm)) {
      const type = m[1] === 'workout' ? types.workout : types.types.find(t => t.name === m[1]); assert.ok(type);
      if (m[2].startsWith('Yes')) assert.equal(type.write,true);
      if (type.unit) assert.equal(m[3],'`'+type.unit+'`');
    }
  }
});
test('calories recipe batches schema-valid Vienna daily totals within the stated now', () => {
  const text = docs['cookbook/calories.md'];
  const example = /syncky send --type commands --json - <<'JSON'\n([^]*?)\nJSON/.exec(text);
  assert.ok(example);
  const payload = JSON.parse(example[1]);
  validate(payload);
  assert.equal(payload.type, 'commands');
  assert.ok(payload.commands.length > 1);
  assert.equal(new Set(payload.commands.map(c => c.command_id)).size, payload.commands.length);
  const expected = recipeTypes.calories.filter(([, write]) => write).map(([type]) => type).sort();
  assert.deepEqual(payload.commands.map(c => c.type).sort(), expected);
  const now = /Example now: `([^`]+)` in Europe\/Vienna/.exec(text)?.[1];
  const bounds = /Local day bounds: `([^`]+)` to `([^`]+)` \(exclusive\)/.exec(text);
  assert.ok(now && bounds);
  const nowMs = Date.parse(now), dayStart = Date.parse(bounds[1]), dayEnd = Date.parse(bounds[2]);
  assert.match(now, /^2026-11-\d{2}T.*\+01:00$/);
  assert.ok(Number.isFinite(nowMs) && dayStart <= nowMs && nowMs < dayEnd);
  assert.equal(dayEnd - dayStart, 86400000);
  assert.match(bounds[1], /T00:00:00\+01:00$/);
  assert.match(bounds[2], /T00:00:00\+01:00$/);
  const catalog = loadJson('types.json').types;
  const diaryEnd = /last diary entry was at `([^`]+)`/.exec(text)?.[1];
  assert.ok(diaryEnd);
  for (const command of payload.commands) {
    assert.equal(command.op, 'write'); assert.equal(command.version, 1);
    assert.equal(Date.parse(command.start), dayStart);
    assert.equal(Date.parse(command.end), Date.parse(diaryEnd));
    assert.match(command.start, /Z$/); assert.match(command.end, /Z$/);
    const end = Date.parse(command.end), type = catalog.find(t => t.name === command.type);
    assert.ok(Number.isFinite(end) && dayStart <= end && end <= nowMs + 3600000);
    assert.ok(end <= nowMs && end < dayEnd - 1000, 'daily total must not end at day end or in the future');
    assert.equal(type.write, true); assert.equal(command.unit, type.unit);
    assert.ok(command.value >= type.min && command.value <= type.max);
    assert.ok(end - dayStart <= type.max_span_s * 1000);
  }
  assert.match(text, /same `command_id` with `version` \+ 1/);
  assert.match(text, /The CLI's `--validate` schema requires upper-case `T` and `Z`, with no fraction or exactly three fractional digits \.001–\.999, although the phone accepts offsets\./);
});
test('shared operator and recipe guidance keeps time, access recovery and consent rules', () => {
  for (const name of ['AGENTS.md', 'docs/REFERENCE.md', 'cookbook/README.md']) {
    const text = docs[name];
    for (const pattern of [
      /`end` must not be later than now \+ 1 h.*`invalid`/,
      /all nutrients of one day in one `send` with several `commands`/,
      /`access_request` is an optional ask-ahead, not a required step before writes/,
      /`type_not_in_scope`, `type_not_allowed` or `healthkit_denied`/,
      /Resend only after the next ordinary sync shows the effective write scope/,
      /On an `invalid` ack, check the command format first \(`--validate`\): fix timestamps, units or JSON\./,
      /Schema validation does not cover phone policy; check interval bounds and units, then report an unexplained rejection without looping\./,
      /Never ask for access on `invalid`\./,
      /After a phone rejection, keep the same `command_id` and increment `version` before retrying; the phone caches completed rejections\./,
      /No phone app version or access-request capability is exposed in sync or status/,
      /If no matching `access_reply` arrives after an `access_request`, have the owner open Syncky and sync; if it remains missing, check whether consent is still pending on the phone and whether the request expired, then suggest the owner check for an app update without looping\./,
    ]) assert.match(text, pattern, name);
  }
  const workouts = docs['cookbook/workouts.md'];
  assert.match(workouts, /Workouts are read-only/);
  assert.match(workouts, /wait for the next ordinary sync to confirm the effective read scope\./);
  assert.doesNotMatch(workouts, /For owner-requested writes|send --type commands/);
  assert.match(docs['docs/REFERENCE.md'], /\| `rate_limited` \| HTTP 429: for queued outbox sends, the outbox retries automatically after Retry-After when the receiver runs; the caller does not resend\./);
});
test('operator and cookbook guides explain batching and limits, and recipes link from their write step', () => {
  for (const name of ['AGENTS.md', 'docs/REFERENCE.md', 'cookbook/README.md']) {
    const text = docs[name];
    for (const pattern of [/ONE `send` with a `commands` array/, /burst of up to 60 data envelopes/, /one a minute.*60 data envelopes per hour per agent sustained/, /per-token limit of 60 requests a minute.*polling, ACKs and heartbeats/, /complete serialized UTF-8 JSON.*base64 ciphertext and recipient metadata/, /inner `commands` JSON.*roughly 191 KiB for one recipient, less with more recipients/, /429 `rate_limited` from either limit.*retried automatically.*Retry-After/, /caller does not resend/, /status --json.*send_lanes.*pending/]) assert.match(text, pattern, name);
  }
  for (const recipe of ['weight', 'calories']) {
    const text = docs['cookbook/' + recipe + '.md'];
    assert.match(text, /^3\. For owner-requested writes.*\[cookbook batching, size and retry guidance\]\(README\.md\)/m, recipe);
    assert.doesNotMatch(text, /The relay allows a burst|One envelope holds up to/, recipe);
  }
});
test('cookbook checker rejects missing, duplicate, widened and incorrect write variants', () => {
  for (const recipe of ['weight','calories','workouts']) {
    const text = docs['cookbook/'+recipe+'.md'];
    const example = /<<'JSON'\n([^]*?)\nJSON/.exec(text)[1];
    for (const mutate of [s => s.replace(example,''), s => s.replace(example,example+'\nJSON\n'+"syncky send --type access_request --json - <<'JSON'\n"+example), s => s.replace(example,JSON.stringify({...JSON.parse(example),write:['dietary_water']})), s => s.replace('<!-- syncky:permissions-step -->','')]) assert.throws(() => requests(mutate(text),recipe));
  }
});
test('cookbook checker rejects coordinated widening of tables and JSON permission arrays', () => {
  for (const recipe of ['weight','calories','workouts']) {
    const text = docs['cookbook/'+recipe+'.md'];
    for (const writable of recipe === 'workouts' ? [false] : [false, true]) {
      const widened = text.replace('\n\nCatalog names', `\n| \`dietary_water\` | Yes | ${writable ? 'Yes, for approved hydration' : 'No'} | \`mL\` |\n\nCatalog names`)
        .replace(/(syncky send --type access_request[^\n]*<<'JSON'\n)([^]*?)\nJSON/g, (_, command, json) => {
          const payload = JSON.parse(json); payload.read.push('dietary_water');
          if (writable && payload.write.length) payload.write.push('dietary_water');
          validate(payload);
          return command + JSON.stringify(payload) + '\nJSON';
        });
      assert.notEqual(widened, text, recipe);
      assert.throws(() => requests(widened, recipe), { code: 'ERR_ASSERTION' }, recipe);
    }
  }
});
test('documents never contain credentials or vector private keys', () => {
  const material = Object.values(loadVectors('keys')).flatMap(v => [v?.sk,v?.ikm]).filter(v => typeof v === 'string');
  assert.ok(material.length >= 4);
  for (const [name,text] of Object.entries(standaloneDocs)) {
    assert.doesNotMatch(text,/sk_hub_[\w-]{22}_[\w-]{40}|whsec_[\w-]{43}|pt_[\w-]{43}|(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/i,name);
    for (const key of material) assert.ok(!text.includes(key),name);
  }
});

test('cookbook links the direct-server alternative without changing the agent recipes', () => {
  const text = docs['cookbook/README.md'];
  assert.match(text, /direct-server[\s\S]*\]\(\.\.\/\.\.\/examples\/own-server\/README\.md\)/);
  for (const name of ['weight', 'calories', 'workouts']) assert.ok(text.includes('](' + name + '.md)'));
});

test('pairing and polling guides distinguish outcomes, scope, owner intent and bounded waits', () => {
  for (const name of ['README.md', 'SETUP.md', 'AGENTS.md', 'docs/REFERENCE.md', 'skills/syncky/SKILL.md', 'cookbook/README.md']) {
    const text = readFileSync(resolve(root, name), 'utf8');
    for (const pattern of [/--read/, /--write/, /request_ref/, /needs_health_settings/, /sync\.scope/, /no_reply/, /15.minute/, /300.second/, /poll_floor/, /retry_after/, /next_poll_at/, /send --type access_request/, /no quota; a type declined at pairing starts the same seven-day wait/]) assert.match(text, pattern, name);
    assert.match(text, /(?:no flags|without.*flags|no.scope).*legacy|legacy.*(?:no.scope|without.*flags)/i, name);
    assert.match(text, /From agent 0\.1\.4, with explicit owner approval for the exact types/, name);
    assert.ok(text.includes('Allow all submits your choices and continues pairing; iOS asks only about listed types it has not decided yet.'), name);
    assert.ok(text.includes('Choices made at pairing have no quota; a type declined at pairing starts the same seven-day wait.'), name);
    assert.match(text, /renewed explicit owner intent and phone availability/, name);
    assert.match(text, /No automatic fallback is sent/, name);
    assert.doesNotMatch(text, /An old app ignores the requested scope|older-phone compatibility/, name);
    assert.match(text, /Later explicit `wait` uses the link in `pairing.json`/, name);
    assert.ok(text.includes('expired or pending-past-grace link returns `pairing_expired`'), name);
    assert.match(text, /after link or reply expiry.*joined phone returns its fingerprint and still requires owner confirmation/, name);
    assert.match(text, /Revoked, rejected, forgotten or unpaired bindings are excluded/, name);
    assert.match(text, /no expired-link lookup; the detached waiter remains bounded/, name);
    assert.ok(text.includes('The link contains credentials and the requested Health type names; anyone who sees its full text can read them.'), name);
    assert.ok(text.includes('Pairing grants stay with this agent and do not change the app-wide Health selection or write allowance.'), name);
    assert.doesNotMatch(text, /opens Health authorization for exactly|pair without a grant|neither scope nor credentials enter an HTTPS query or server request/, name);
  }
});

test('reference names the local not_writable refusal of an access request', () => {
  const row = reference.split('\n').find(line => line.startsWith('| `schema_invalid` |'));
  for (const text of ['`detail`', '`not_writable`', '`types`', 'Nothing was sent']) assert.ok(row.includes(text), text);
  assert.match(reference, /fails locally with `schema_invalid`, `detail` `not_writable` and the offending `types`, while the same type under `read` passes/);
});

test('setup and reference pin recovery to the same relay despite a conflicting environment and preserve history and hosted limits', () => {
  const sections = [];
  for (const name of ['SETUP.md', 'docs/REFERENCE.md']) {
    const text = docs[name];
    const section = text.match(/^### Recover when `invalid_token` arrives before any phone joined\n[\s\S]*?(?=^## )/m)?.[0];
    assert.ok(section, name); sections.push(section);
    for (const pattern of [/does not prove why/, /explicit owner intent/, /known service identity or known PID/, /Stop its supervisor/,
      /Retain the old private home and its history/, /fresh, unused absolute `--home`/, /\*\*same relay\*\*/,
      /syncky --home '<fresh-absolute-home>' --relay '<same-relay-url>' init --name 'My agent'/,
      /first reply.*terminal QR.*HTTPS link.*pairing code.*expiry.*chat where the owner asked/, /Repoint the chosen receiver and MCP together/,
      /SYNCKY_AGENT_HOME/, /SYNCKY_RELAY_URL/, /does not inherit old trust or history/, /'<old-absolute-home>' inbox/]) assert.match(section, pattern, name);
    const commands = [...section.matchAll(/syncky --home '<fresh-absolute-home>'[^`\n]*/g)].map(([example]) => {
      const argv = example.match(/'[^']*'|\S+/g).slice(1).map(arg => arg.startsWith("'") ? arg.slice(1, -1) : arg);
      const { command, flags } = parseArgs(argv);
      const relay = 'https://relay.example';
      const config = resolveConfig({ flags: { relay_url: flags.relay?.replace('<same-relay-url>', relay) },
        env: { SYNCKY_RELAY_URL: 'https://conflicting-relay.example' }, file: { relay_url: relay } });
      assert.equal(flags.home, '<fresh-absolute-home>', `${name}: ${command}`);
      assert.equal(config.relay_url, relay, `${name}: ${command}`);
      if (command === 'pair') assert.ok(!flags['no-qr'] && !flags.wait, `${name}: pair must print the QR and return before the phone joins`);
      return command;
    });
    assert.deepEqual(commands, ['init', 'pair', 'receive', 'mcp'], name);
    assert.doesNotMatch(text, /init --force/, name);
    for (const pattern of [/Hosted defaults:.*10 minutes/, /`expires_at` is authoritative/, /24 hours from registration/,
      /creating another link does not restart that clock/, /`limits` metadata/, /pairing_link_ttl_s: 600/, /unjoined_hub_ttl_s: 86400/]) assert.match(text, pattern, name);
  }
  assert.equal(sections[0], sections[1]);
});


test('all fixed error hints have real reference causes and actions, with receipt semantics documented', () => {
  for (const [code, hint] of Object.entries(ERROR_GUIDANCE)) {
    const row = reference.split('\n').find(line => line.startsWith('| `' + code + '` |'));
    assert.ok(row, code); assert.ok(row.length > code.length + 45, code);
    assert.ok(hint.length > 40, code);
    assert.doesNotMatch(hint, /C§|docs\/(?:planning|plans|context)|(?:scripts|core|App|relay|e2e|docs-worker)\//, code);
  }
  assert.ok(!reference.includes('Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying.'));
  for (const text of ['`relay_code`', '`relay_status`', '`hint`', 'Retry-After', 'queue admission', '`failed` is terminal', 'CLI exit 0', '`isError: false`', '`isError: true`', 'not phone application', 'success clears', 'fixed safe fallback']) assert.ok(reference.includes(text), text);
});


test('inbox replay documentation explains binding, mint-time eviction floor, durable admission and old-row boundaries', () => {
  for (const name of ['README.md', 'docs/REFERENCE.md', 'AGENTS.md', 'skills/syncky/SKILL.md']) {
    const text = readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
    for (const fragment of ['`msg_id`', '`public_key`', '31 days plus five minutes of clock skew', 'Relay keeps undelivered messages for at most 7 days', 'owner-approved forget', 'receiver clock regression',
      '10,000 IDs', 'oldest mint times', 'monotonic floor', 'same state write as admission', 'at or below that floor', 'timestamp ties',
      'unseen first delivery', 'unACKed', 'uncommitted row', '0.1.4 rows without IDs', 'beyond this age window',
      'per sender/key binding', 'protected 24 hours plus ten minutes', '90,000', 'before append', 'Other senders in that page', 'inbox_seen_limit']) assert.ok(text.includes(fragment), name);
    assert.doesNotMatch(text, /10,000 IDs are retained across all sender\/key bindings/, name);
  }
});

test('relay origin and inbox budget documentation stays standalone and actionable', async () => {
  for (const name of ['README.md', 'docs/REFERENCE.md', 'AGENTS.md']) {
    const text = readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
    for (const fragment of ['HTTPS', 'loopback HTTP', 'config.json', 'canonical', '64 MiB', '10,000', 'inbox_scan_limit']) assert.ok(text.includes(fragment), name + ': ' + fragment);
  }
  const { errorHint } = await import('../../src/error-guidance.js');
  assert.match(errorHint('inbox_scan_limit'), /narrower date range/);
  const { main } = await import('../../src/cli.js');
  let output = '';
  await main(['help', 'init'], { stdout: { write: s => { output += s; } } });
  assert.ok(output.includes('canonical origin')); assert.ok(output.includes('loopback HTTP'));
  assert.ok(output.includes('non-loopback HTTP warns once per process and host'));
  output = '';
  await main(['help', 'inbox'], { stdout: { write: s => { output += s; } } });
  assert.ok(output.includes('last scanned cursor')); assert.ok(output.includes('even for an empty page'));
});

test('access request skill allows a positive TTL at most 24 hours', () => {
  const text = readFileSync(new URL('../../skills/syncky/SKILL.md', import.meta.url), 'utf8');
  assert.match(text, /at most 24 hours apart/);
  assert.doesNotMatch(text, /exactly 24 hours apart/);
});
