import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { fsyncSync, fdatasyncSync, fsync, fdatasync } from "node:fs";
import { test } from "node:test";

test("unit subprocesses inherit the preload without extra command flags", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import fs, { fsyncSync } from "node:fs";
    const fd = fs.openSync(new URL(process.argv[1]), "r"), stat = fs.fstatSync;
    let calls = 0;
    fs.fstatSync = (...args) => { calls++; return stat(...args); };
    try { fsyncSync(fd); assert.equal(calls, 1); } finally { fs.closeSync(fd); }
  `, import.meta.url], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("unit sync validates files, directories and closed descriptors without flushing", t => {
  const stat = t.mock.method(fs, "fstatSync");
  for (const path of [new URL(import.meta.url), new URL("./", import.meta.url)]) {
    const fd = fs.openSync(path, "r");
    for (const sync of [fsyncSync, fdatasyncSync]) assert.equal(sync(fd), undefined);
    fs.closeSync(fd);
    for (const sync of [fsyncSync, fdatasyncSync]) assert.throws(() => sync(fd), { code: "EBADF" });
  }
  assert.equal(stat.mock.callCount(), 8);
  assert.equal(fs.fsyncSync, fsyncSync);
  assert.equal(fs.fdatasyncSync, fdatasyncSync);
});

test("callback sync validates descriptors and reports errors asynchronously", async t => {
  const stat = t.mock.method(fs, "fstat");
  const fd = fs.openSync(new URL(import.meta.url), "r");
  const run = sync => new Promise((resolve, reject) => {
    let returned = false;
    assert.equal(sync(fd, error => {
      try { assert.equal(returned, true); resolve(error); } catch (error) { reject(error); }
    }), undefined);
    returned = true;
  });
  try {
    for (const sync of [fsync, fdatasync]) assert.equal(await run(sync), null);
  } finally { fs.closeSync(fd); }
  for (const sync of [fsync, fdatasync]) assert.equal((await run(sync)).code, "EBADF");
  assert.equal(stat.mock.callCount(), 4);
  assert.equal(fs.fsync, fsync);
  assert.equal(fs.fdatasync, fdatasync);
});

test("FileHandle sync validates an existing handle and rejects a closed handle", async t => {
  const handle = await fs.promises.open(new URL(import.meta.url), "r");
  const stat = t.mock.method(handle, "stat");
  try {
    assert.equal(await handle.sync(), undefined);
    assert.equal(await handle.datasync(), undefined);
  } finally { await handle.close(); }
  await assert.rejects(handle.sync(), { code: "EBADF" });
  await assert.rejects(handle.datasync(), { code: "EBADF" });
  assert.equal(stat.mock.callCount(), 4);
});
