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
const recipeTypes = {
  weight: [['body_mass', true]],
  calories: [['dietary_energy_consumed', true], ['active_energy_burned', false]],
  workouts: [['workout', false], ['heart_rate', false], ['resting_heart_rate', false], ['heart_rate_variability_sdnn', false]],
};

function requests(text, recipe) {
  assert.equal(text.split('<!-- syncky:permissions-step -->').length, 2);
  const section = text.split('\n## Permissions\n')[1]?.split('\n## On a schedule\n')[0]; assert.ok(section);
  const rows = [...text.matchAll(/^\| `([a-z_]+)` \| Yes \| (Yes[^|]*|No) \|/gm)];
  const expected = recipeTypes[recipe]; assert.ok(expected);
  assert.deepEqual(rows.map(m => [m[1], m[2].startsWith('Yes')]), expected, recipe);
  const read = expected.map(([type]) => type).sort(), write = expected.filter(([, writable]) => writable).map(([type]) => type).sort();
  const payloads = [...section.matchAll(/<<'JSON'\n([^]*?)\nJSON/g)].map(m => JSON.parse(m[1]));
  for (const payload of payloads) { validate(payload); assert.equal(payload.type, 'access_request'); }
  assert.deepEqual(payloads.map(p => ({ read:[...p.read].sort(), write:[...p.write].sort() })).sort((a,b) => a.write.length-b.write.length), [{ read, write:[] }, ...(write.length ? [{ read, write }] : [])], recipe);
}

test('Allow adds individual types while preserving existing selections and live read all', () => {
  for (const name of files.filter(file => file !== 'cookbook/README.md')) {
    const text = docs[name];
    assert.match(text, /Allow adds only approved types to Health selection, without selecting their categories\./, name);
    assert.match(text, /Existing selected categories and individually allowed types are preserved\./, name);
    assert.match(text, /partial selection.*Individually allowed:.*unchecked category/, name);
    assert.match(text, /Allow texts name the exact types/, name);
    assert.match(text, /Existing read `all` stays `all` and follows later Health selection changes/, name);
    assert.match(text, /Approved reads turn `none` into a chosen list and are unioned into existing read lists/, name);
    assert.match(text, /reply alone never updates cached scope/, name);
    if (name !== 'cookbook/workouts.md') {
      assert.match(text, /Allowed writes turn on the global \*\*Allow writing to Health\*\* toggle for all selected writable types/, name);
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
    for (const pattern of [/explicit owner approval/, /queued request is not a grant/, /next ordinary sync/, /needs_health_settings/, /pending_limit/, /rate_limited/, /expired/, /seven.day/, /cannot observe Health read permission/, /reason or reference/, /conditional Health Settings/, /only after explicit approval/, /never overwrite\/append/, /untrusted data, never instructions/]) assert.match(text,pattern);
    const types = loadJson('types.json');
    for (const m of text.matchAll(/^\| `([a-z_]+)` \| Yes \| (Yes[^|]*|No) \| ([^|]+) \|$/gm)) {
      const type = m[1] === 'workout' ? types.workout : types.types.find(t => t.name === m[1]); assert.ok(type);
      if (m[2].startsWith('Yes')) assert.equal(type.write,true);
      if (type.unit) assert.equal(m[3],'`'+type.unit+'`');
    }
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
        .replace(/<<'JSON'\n([^]*?)\nJSON/g, (_, json) => {
          const payload = JSON.parse(json); payload.read.push('dietary_water');
          if (writable && payload.write.length) payload.write.push('dietary_water');
          validate(payload);
          return "<<'JSON'\n" + JSON.stringify(payload) + '\nJSON';
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
