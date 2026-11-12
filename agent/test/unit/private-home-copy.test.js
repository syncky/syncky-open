import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateStat } from '../../src/protected-files.js';
import { copyPrivateHome, tempHome } from '../support/helpers.js';

function privateTree(home) {
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(join(home, 'state'), 0o700);
  writeFileSync(join(home, 'secrets.json'), 'secret', { mode: 0o600 });
  writeFileSync(join(home, 'state', 'frozen'), 'frozen', { mode: 0o400 });
  chmodSync(join(home, 'state', 'frozen'), 0o400);
}

test('copyPrivateHome keeps every directory 0700 and every file mode so privateStat accepts the copy', t => {
  const source = tempHome(), target = tempHome();
  t.after(() => { source.cleanup(); target.cleanup(); });
  privateTree(source.home);
  copyPrivateHome(source.home, target.home);
  for (const dir of ['', 'state']) privateStat(join(target.home, dir), { directory: true });
  for (const [file, mode, text] of [['secrets.json', 0o600, 'secret'], ['state/frozen', 0o400, 'frozen']]) {
    assert.equal(privateStat(join(target.home, file)).mode & 0o7777, mode);
    assert.equal(readFileSync(join(target.home, file), 'utf8'), text);
  }
});

test('copyPrivateHome refuses entries a home must not contain', t => {
  const source = tempHome(), target = tempHome();
  t.after(() => { source.cleanup(); target.cleanup(); });
  privateTree(source.home);
  symlinkSync(join(source.home, 'secrets.json'), join(source.home, 'link'));
  assert.throws(() => copyPrivateHome(source.home, target.home), /unexpected entry in home/);
});
