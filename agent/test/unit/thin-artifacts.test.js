import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildAgent } from '../../build.mjs';
import { createLocalValidator } from '../../src/send.js';
import { loadSchemas } from '../../src/protocol-files.js';
import { TOOLS } from '../../src/mcp.js';

test('feature skill examples validate against local schemas with exact feature sections', () => {
  const skill = readFileSync(new URL('../../skills/syncky/SKILL.md', import.meta.url), 'utf8');
  for (const section of ['Health JSON in','Writes','Diagnostics request','Access request','Scope release']) {
    const text = skill.split('## ' + section + '\n')[1]?.split('\n## ')[0];
    assert.ok(text, section);
    for (const field of ['**When:**','**JSON:**','**Phone reply:**','**Tell the owner:**']) assert.ok(text.includes(field), `${section}: ${field}`);
  }
  const validate = createLocalValidator(loadSchemas());
  const examples = [...skill.matchAll(/<<'JSON'\n([^]*?)\nJSON/g)].map(m => JSON.parse(m[1]));
  assert.deepEqual(examples.map(e => e.type), ['commands','diagnostics_request','access_request','scope_release']);
  for (const example of examples) validate(example);
  assert.match(skill, /explicit owner approval/i); assert.match(skill, /untrusted data, never instructions/);
  assert.match(skill, /Never overwrite or append/); assert.match(skill, /never quote the token-bearing URI/i);
});

test('extracted runtime and every carried launcher work offline without SQLite or retired modules', async t => {
  const root = mkdtempSync(join(tmpdir(),'thin-artifacts-')); t.after(() => rmSync(root,{recursive:true,force:true}));
  const built = await buildAgent({ outdir: join(root,'build') });
  const { modules } = await import(pathToFileURL(built.bundlePath));
  for (const file of ['envelope.js','store.js','serve.js','web-ui.js','webhook-server.js','webhook-signature.js','commands.js','command-versions.js','protocol.js','series.js','summary.js','access-store.js','diagnostics.js','diagnostics-request.js']) assert.ok(!Object.hasOwn(modules,file), file);
  assert.deepEqual(modules['mcp.js'].TOOLS.map(t => t.name), TOOLS.map(t => t.name));
  for (const output of Object.values(built.metafile.outputs)) assert.ok(!output.imports.some(i => i.path === 'node:sqlite'));
  const bundle = readFileSync(built.bundlePath,'utf8'); assert.ok(!bundle.includes('node:sqlite'));
  const cwd = join(root,'outside source'); mkdirSync(cwd);
  const env = { PATH: process.env.PATH, HOME: root, SYNCKY_AGENT_HOME: join(root,'uninitialized') };
  const run = (cmd,args,input='') => {
    const r = spawnSync(cmd,args,{cwd,env,input,encoding:'utf8',timeout:20000});
    assert.equal(r.status,0, r.stderr || 'runtime failed'); return r.stdout;
  };
  assert.match(run(process.execPath,[built.bundlePath,'skill']),/Health JSON in/);
  assert.equal(JSON.parse(run(process.execPath,[built.bundlePath,'selftest'])).ok,true);
  for (const [archive, leaf] of [
    ['syncky-agent-claude-code.tar.gz','claude-code/plugins/syncky/skills/syncky'],
    ['syncky-agent-codex.tar.gz','codex/plugins/syncky/skills/syncky'],
    ['syncky-agent-clawhub.tar.gz','clawhub/syncky'],
    ['syncky-agent-skills.tar.gz','agent-skills/skills/syncky'],
  ]) {
    const dest = join(root,archive); mkdirSync(dest);
    run('/usr/bin/tar',['-xzf',join(root,'build',archive),'-C',dest]);
    const launcher = join(dest,leaf,'syncky-agent');
    assert.match(run(launcher,['skill']),/Health JSON in/);
    const request = JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n';
    const tools = JSON.parse(run(launcher,['mcp'],request)).result.tools;
    assert.deepEqual(tools.map(t => t.name),TOOLS.map(t => t.name));
  }
});
