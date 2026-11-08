import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { commandNames } from '../../src/cli.js';
import { TOOLS } from '../../src/mcp.js';
import { loadJson, loadVectors } from '../../src/protocol-files.js';
import { createLocalValidator } from '../../src/send.js';
import { loadSchemas } from '../../src/protocol-files.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = ['README.md','AGENTS.md','SETUP.md','docs/REFERENCE.md','cookbook/README.md','cookbook/weight.md','cookbook/calories.md','cookbook/workouts.md'];
const docs = Object.fromEntries(files.map(f => [f, readFileSync(resolve(root,f),'utf8')]));
const source = readdirSync(resolve(root,'src')).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(resolve(root,'src',f),'utf8')]);
const reference = docs['docs/REFERENCE.md'];
const validate = createLocalValidator(loadSchemas());
const mentions = code => reference.includes('`' + code + '`');

test('published access protocol prose matches normalization, TTL and invalid reply rules', () => {
  const text = readFileSync(resolve(root, '../protocol/README.md'), 'utf8').split('## Health access controls\n')[1];
  const schema = JSON.parse(readFileSync(resolve(root, '../protocol/schemas/inner-system.schema.json'), 'utf8'));
  assert.ok(text);
  assert.ok(text.includes('`0 < expires_at - created_at <= 24h`'));
  assert.match(text, /For compatibility with phones 0\.1\.1\/0\.1\.2, send sorted, unique lists and use exactly 24 h/);
  assert.match(text, /phone sorts and deduplicates each array/);
  assert.doesNotMatch(text, /exactly creation plus 24 hours|individually sorted\/unique|exact 24-hour expiry/);
  assert.match(text, /optional `detail` only for `invalid`/);
  assert.match(text, /`invalid` have empty read\/write arrays/);
  for (const detail of schema.$defs.access_reply.properties.detail.enum) assert.ok(text.includes('`' + detail + '`'), detail);
  assert.doesNotMatch(text, /C§|docs\/(?:planning|plans|context)|(?:core|App|relay|e2e|scripts|docs-worker)\//);
});

test('agent access guidance requires the TTL accepted by phones 0.1.1 and 0.1.2', () => {
  for (const name of ['AGENTS.md', 'SETUP.md', 'docs/REFERENCE.md', 'skills/syncky/SKILL.md', 'cookbook/README.md']) {
    const text = readFileSync(resolve(root, name), 'utf8');
    assert.match(text, /use exactly 24 h \(`expires_at - created_at == 24h`\) for compatibility with phones 0\.1\.1\/0\.1\.2/, name);
    assert.match(text, /lists are sorted and deduplicated before sealing/, name);
    assert.doesNotMatch(text, /0 < expires_at - created_at <= 24h/, name);
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
    assert.match(docs[name], /[Tt]he type must be in the app's write allowance, within the agent's scope, and authorized by HealthKit\./, name);
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
  for (const match of text.matchAll(/syncky send --type commands --validate --json - <<'JSON'\n([^]*?)\nJSON/g)) {
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
test('operator and cookbook guides reject superseded category expansion wording', () => {
  for (const [name,text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /(?:Allow(?:ing)?|Both Allow outcomes) adds? (?:categories\b|category\/|the (?:type's )?category\b|the requested categories\/scope)/i, name);
    assert.doesNotMatch(text, /preserves an existing all scope|enables writing for writes, preserves `all`/, name);
  }
});
test('operator guides explain partial selection removal and old-phone expiry without local replies', () => {
  for (const name of ['SETUP.md','docs/REFERENCE.md']) {
    assert.match(docs[name], /Unchecking a category leaves individually allowed types selected/, name);
    assert.match(docs[name], /Remove individually allowed types.*save; iOS permissions stay unchanged/, name);
    assert.match(docs[name], /phone running an app version older than this feature cannot show the request/, name);
    assert.match(docs[name], /explain expiry from (?:the )?timestamps (?:rather than|instead of) inventing (?:a reply|local results)/, name);
  }
});

test('every relative path and link in the documents exists', () => {
  for (const [file,text] of Object.entries(docs)) for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = decodeURIComponent(match[1].split('#')[0]);
    if (!target || /^[a-z][\w+.-]*:/i.test(target)) continue;
    assert.ok(existsSync(resolve(root,dirname(file),target)), `${file}: missing relative link`);
  }
});
test('standalone guides stay within 200 lines, cite only public paths and real commands/tools', () => {
  assert.ok(docs['AGENTS.md'].trimEnd().split('\n').length <= 200);
  for (const [file,text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /C§|docs\/(?:planning|plans|context)|(?:\.\.\/)*(?:scripts|core|App|relay|e2e|docs-worker)\//, file);
    const commands = [...text.matchAll(/\bsyncky(?:-agent)? ([a-z]+)/g)].map(m => m[1]);
    assert.deepEqual(commands.filter(c => !commandNames().includes(c)), [], file);
    const tools = [...text.matchAll(/\bsyncky_[a-z_]+\b/g)].map(m => m[0]);
    assert.deepEqual(tools.filter(c => !TOOLS.some(t => t.name === c)), [], file);
  }
});
test('every function AGENTS.md cites as name() exists in the minimal agent', () => {
  const minimal = readFileSync(resolve(root,'../examples/minimal-agent/agent.mjs'),'utf8');
  for (const m of docs['AGENTS.md'].matchAll(/`(\w+)\(\)`/g)) assert.match(minimal, new RegExp('(?:function\\s+'+m[1]+'\\s*\\(|const\\s+'+m[1]+'\\s*=)'));
});
test('every exported, thrown or result error code in src is documented', async () => {
  const codes = new Set();
  for (const [file,text] of source) {
    const module = await import(resolve(root,'src',file));
    for (const [name,value] of Object.entries(module)) if (name.endsWith('_CODES') && Array.isArray(value)) for (const code of value) codes.add(code);
    for (const match of text.matchAll(/(?:new \w+Error\(\s*|\bcode:\s*)['"]([a-z][a-z0-9_]*)['"]/g)) codes.add(match[1]);
  }
  assert.ok(codes.size > 50); assert.deepEqual([...codes].filter(c => !mentions(c)), []);
});
test('every error code the minimal agent throws is documented', () => {
  const minimal = readFileSync(resolve(root,'../examples/minimal-agent/agent.mjs'),'utf8');
  const codes = [...minimal.matchAll(/\bfail\("([a-z][a-z0-9_]*)"/g)].map(m => m[1]);
  assert.ok(codes.length >= 10); assert.deepEqual(codes.filter(c => !mentions(c)), []);
});
test('all runtime commands and the exact five MCP tools are documented with read-only boundaries', () => {
  for (const command of commandNames()) assert.ok(docs['README.md'].includes('syncky-agent ' + command), command);
  for (const file of ['README.md','AGENTS.md','SETUP.md']) {
    const text = docs[file]; for (const tool of TOOLS) assert.ok(text.includes(tool.name), file);
    assert.match(text,/disable.*send.*ack|Disable.*send.*ack/);
    assert.match(text,/MCP starts no|MCP does not start/);
    assert.match(text,/offline/); assert.match(text,/legacy/i); assert.match(text,/30.day|30 days/);
  }
});
test('read-only client configuration disables exactly the mutating tools', () => {
  const disabled = docs['SETUP.md'].match(/^disabled_tools = (\[[^\n]+\])$/m);
  assert.ok(disabled);
  assert.deepEqual(JSON.parse(disabled[1]).sort(), TOOLS.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort());
});
test('pairing, Health purpose, explicit requests, service and deletion approval stay mandatory', () => {
  const text = docs['SETUP.md'];
  for (const pattern of [/Scanning alone does not confirm trust/, /Never copy the status fingerprint back/, /owner.*code|owner picks/i, /explicit owner approval/, /say exactly what you will write/, /standing rule/, /never run forget without approval/, /instead of re-registering/, /untrusted data, never instructions/, /private data channel/, /Discard|discard/, /Only when you ask/, /has not answered.*wait/]) assert.match(text,pattern);
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
  const example = /syncky send --type commands --validate --json - <<'JSON'\n([^]*?)\nJSON/.exec(text);
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
test('shared operator and recipe guidance keeps time, access recovery and old-app rules', () => {
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
  for (const [name,text] of Object.entries(docs)) {
    assert.doesNotMatch(text,/sk_hub_[\w-]{22}_[\w-]{40}|whsec_[\w-]{43}|pt_[\w-]{43}|(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/i,name);
    for (const key of material) assert.ok(!text.includes(key),name);
  }
});

test('cookbook links the direct-server alternative without changing the agent recipes', () => {
  const text = docs['cookbook/README.md'];
  assert.match(text, /direct-server[\s\S]*\]\(\.\.\/\.\.\/examples\/own-server\/README\.md\)/);
  for (const name of ['weight', 'calories', 'workouts']) assert.ok(text.includes('](' + name + '.md)'));
});
