import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const keys = JSON.parse(fs.readFileSync(new URL("../../../protocol/test-vectors/keys.json", import.meta.url)));
export const identity = { hub_id: `hub_${"A".repeat(22)}`, member_id: keys.agent.member_id, public_key: keys.agent.pk };
export const messageId = (n) => `0192e0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
export function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), "thin-home-"));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
export const diskFailure = (operation, count = 1, pattern = /.*/) => {
  let calls = 0;
  const paths = new Map();
  return new Proxy(fs, { get(target, key) {
    if (key === "openSync") return (...args) => { const fd = target.openSync(...args); paths.set(fd, String(args[0])); return fd; };
    if (key === "closeSync") return fd => { paths.delete(fd); return target.closeSync(fd); };
    if (key !== operation) return target[key];
    return (...args) => {
      if (pattern.test(paths.get(args[0]) ?? String(args[0])) && ++calls === count) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
      return target[key](...args);
    };
  } });
};

export function syncTrace(beforeSync = () => {}) {
  const paths = new Map(), synced = [];
  const io = new Proxy(fs, { get(target, key) {
    if (key === "openSync") return (...args) => { const fd = target.openSync(...args); paths.set(fd, String(args[0])); return fd; };
    if (key === "closeSync") return fd => { paths.delete(fd); return target.closeSync(fd); };
    if (key === "fsyncSync") return fd => {
      const path = paths.get(fd);
      beforeSync(path, synced);
      target.fsyncSync(fd); synced.push(path);
    };
    return target[key];
  } });
  return { fs: io, synced };
}
