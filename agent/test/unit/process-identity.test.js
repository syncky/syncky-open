import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessIdentity, parseBootId, parseLinuxBootTime, parseLinuxStartTime, parseMacStartTime } from "../../src/process-identity.js";

const bootId = "01234567-89ab-cdef-0123-456789abcdef";
const ps = "Mon Nov  9 06:31:35 2026\n";
const startedAtMs = Date.UTC(2026, 10, 9, 6, 31, 35);
const stat = (ticks = "12345") => `1130 (a ) ( process with spaces) S ${Array(18).fill("0").join(" ")} ${ticks} 999 0\n`;

test("Linux stat parses field 22 after the last closing parenthesis", () => {
  assert.equal(parseLinuxStartTime(stat()), 123450);
  assert.equal(parseLinuxStartTime(stat("0")), 0);
  for (const output of ["", "1130 (missing end", "bad (name) S", "0 (name) S", stat("-1"), stat("1.5"), stat("NaN"), stat("9007199254740992"), stat("900719925474100")]) {
    assert.equal(parseLinuxStartTime(output), null);
  }
});

test("Linux boot time parsing fails closed on missing or invalid fields", () => {
  assert.equal(parseLinuxBootTime("cpu 123\nbtime 1800000000\nprocesses 10\n"), 1800000000000);
  for (const output of ["", "btime -1\n", "btime 0\n", "btime 1.5\n", "btime 9007199254741\n"]) assert.equal(parseLinuxBootTime(output), null);
});

test("sysctl and Linux boot ids accept only a complete UUID", () => {
  assert.equal(parseBootId(` ${bootId.toUpperCase()}\n`), bootId);
  for (const output of ["", "not a uuid", `${bootId}\nextra`, bootId.slice(1)]) assert.equal(parseBootId(output), null);
});

test("macOS ps parses UTC English lstart with one-second precision", () => {
  assert.equal(parseMacStartTime(ps), startedAtMs);
  assert.equal(parseMacStartTime("Tue Nov 10 06:31:35 2026"), Date.UTC(2026, 10, 10, 6, 31, 35));
  for (const output of ["", "Mon Nov  9 06:31:35 2026\nextra", "Mo Nov  9 06:31:35 2026", "Mon Xxx  9 06:31:35 2026", "Mon Nov 31 06:31:35 2026", "Mon Nov  9 24:31:35 2026", "Mon Nov  9 06:61:35 2026", "Mon Nov  9 06:31:61 2026", "Mon Nov  9 06:31:35 0099"]) {
    assert.equal(parseMacStartTime(output), null);
  }
});

test("macOS UTC start parsing ignores inherited TZ including DST gaps and overlaps", () => {
  const previous = process.env.TZ;
  try {
    for (const tz of ["UTC", "Europe/Vienna", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      assert.equal(parseMacStartTime(ps), startedAtMs);
      assert.equal(parseMacStartTime("Sun Mar 29 02:30:00 2026"), Date.UTC(2026, 2, 29, 2, 30));
      assert.equal(parseMacStartTime("Sun Oct 25 02:30:00 2026"), Date.UTC(2026, 9, 25, 2, 30));
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("Linux identities use proc without commands, cache the boot id and preserve boot-relative starts", () => {
  const calls = [];
  let bootTime = 1800000000;
  const read = createProcessIdentity({ platform: "linux", fs: { readFileSync(path, encoding) {
    calls.push(path); assert.equal(encoding, "utf8");
    if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
    if (path === "/proc/stat") return `btime ${bootTime}\n`;
    assert.match(path, /^\/proc\/\d+\/stat$/); return stat();
  } }, execFileSync() { assert.fail("Linux must not execute commands"); } });
  assert.deepEqual(read(1130), { bootId, startTime: 123450, startedAtMs: 1800000123450, startTimeSource: "linux-proc" });
  bootTime += 60;
  assert.deepEqual(read(1131), { bootId, startTime: 123450, startedAtMs: 1800000183450, startTimeSource: "linux-proc" });
  assert.equal(calls.filter(path => path === "/proc/sys/kernel/random/boot_id").length, 1);
  const first = read(process.pid), count = calls.length;
  assert.equal(read(process.pid), first); assert.equal(calls.length, count);
});

test("macOS identities bound absolute-path commands, force UTC and C locale and cache boot and self identities", () => {
  const calls = [];
  const read = createProcessIdentity({ platform: "darwin", execFileSync(path, args, options) {
    calls.push({ path, args });
    assert.equal(options.encoding, "utf8"); assert.equal(options.timeout, 500);
    assert.equal(options.env.LC_ALL, "C"); assert.equal(options.env.TZ, "UTC"); assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
    return path === "/usr/sbin/sysctl" ? `${bootId.toUpperCase()}\n` : ps;
  } });
  assert.deepEqual(read(1130), { bootId, startTime: startedAtMs, startedAtMs, startTimeSource: "macos-ps" });
  assert.deepEqual(read(1131), { bootId, startTime: startedAtMs, startedAtMs, startTimeSource: "macos-ps" });
  assert.deepEqual(calls, [
    { path: "/usr/sbin/sysctl", args: ["-n", "kern.bootsessionuuid"] },
    { path: "/bin/ps", args: ["-o", "lstart=", "-p", "1130"] },
    { path: "/bin/ps", args: ["-o", "lstart=", "-p", "1131"] },
  ]);
  const first = read(process.pid), count = calls.length;
  assert.equal(read(process.pid), first); assert.equal(calls.length, count);
});

for (const platform of ["linux", "darwin"]) for (const failure of ["io", "parse"]) test(`${platform} ${failure} failures leave identity unknown and retry boot reads`, () => {
  let bootReads = 0;
  const read = createProcessIdentity({ platform,
    fs: { readFileSync(path) {
      if (path === "/proc/sys/kernel/random/boot_id") bootReads++;
      if (failure === "io") throw new Error("unreadable");
      return "invalid";
    } },
    execFileSync(path) {
      if (path === "/usr/sbin/sysctl") bootReads++;
      if (failure === "io") throw Object.assign(new Error("command failed"), { status: 1, stdout: "" });
      return "";
    },
  });
  for (const pid of [1130, 1131, process.pid, process.pid]) assert.deepEqual(read(pid), { bootId: null, startTime: null, startedAtMs: null, startTimeSource: platform === "linux" ? "linux-proc" : "macos-ps" });
  assert.equal(bootReads, 4);
});

for (const platform of ["linux", "darwin"]) for (const failure of ["io", "parse"]) {
  for (const missing of platform === "linux" ? ["boot", "start", "epoch"] : ["boot", "start"]) test(`${platform} own identity recovers after ${missing} ${failure} failure`, () => {
    let failed = true, calls = 0, bootReads = 0;
    function lookup(path) {
      calls++;
      const field = ["/proc/sys/kernel/random/boot_id", "/usr/sbin/sysctl"].includes(path) ? "boot" : path === "/proc/stat" ? "epoch" : "start";
      if (field === "boot") bootReads++;
      if (failed && field === missing) {
        if (failure === "io") throw new Error("unavailable");
        return "invalid";
      }
      return field === "boot" ? bootId : field === "epoch" ? "btime 1800000000\n" : platform === "linux" ? stat() : ps;
    }
    const read = createProcessIdentity({ platform, fs: { readFileSync: lookup }, execFileSync: lookup });
    const first = read(process.pid);
    assert.equal(first[missing === "boot" ? "bootId" : missing === "start" ? "startTime" : "startedAtMs"], null);
    failed = false;
    const recovered = read(process.pid), count = calls;
    assert.deepEqual(recovered, { bootId, startTime: platform === "linux" ? 123450 : startedAtMs,
      startedAtMs: platform === "linux" ? 1800000123450 : startedAtMs, startTimeSource: platform === "linux" ? "linux-proc" : "macos-ps" });
    assert.equal(bootReads, missing === "boot" ? 2 : 1);
    assert.equal(read(process.pid), recovered);
    assert.equal(calls, count);
  });
}

test("partial Linux identity keeps boot and start evidence when epoch conversion is unavailable", () => {
  for (const missing of ["/proc/stat", "/proc/1130/stat"]) {
    const read = createProcessIdentity({ platform: "linux", fs: { readFileSync(path) {
      if (path === "/proc/sys/kernel/random/boot_id") return bootId;
      if (path === missing) throw new Error("unavailable");
      return path === "/proc/stat" ? "btime 1800000000\n" : stat();
    } } });
    assert.deepEqual(read(1130), { bootId, startTime: missing === "/proc/stat" ? 123450 : null, startedAtMs: null, startTimeSource: "linux-proc" });
  }
});

for (const platform of ["win32", "freebsd"]) test(`${platform} has no identity IO or shell-out`, () => {
  const read = createProcessIdentity({ platform, fs: { readFileSync() { assert.fail("unsupported platform must not read files"); } },
    execFileSync() { assert.fail("unsupported platform must not execute commands"); } });
  assert.deepEqual(read(1130), {});
});

test("real process identity has boot and start evidence", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const identity = createProcessIdentity()(process.pid);
  assert.match(identity.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(Number.isSafeInteger(identity.startTime) && identity.startTime >= 0);
});
