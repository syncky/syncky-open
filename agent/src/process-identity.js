import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function parseBootId(output) {
  const id = output.trim();
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : null;
}

export function parseLinuxStartTime(output) {
  const end = output.lastIndexOf(")");
  if (!/^[1-9]\d* \(/.test(output) || end < 0) return null;
  const value = output.slice(end + 1).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(value)) return null;
  const ticks = Number(value);
  return Number.isSafeInteger(ticks) && Number.isSafeInteger(ticks * 10) ? ticks * 10 : null;
}

export function parseLinuxBootTime(output) {
  const match = /^btime (\d+)$/m.exec(output);
  const value = match ? Number(match[1]) * 1000 : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseMacStartTime(output) {
  const match = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(output.trim());
  if (!match) return null;
  const month = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(match[1]) / 3;
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return date.getTime();
}

function readable(fn) {
  try { return fn(); } catch { return null; }
}

export function createProcessIdentity({ platform = process.platform, fs: io = fs, execFileSync: exec = execFileSync } = {}) {
  let bootId, self;
  const command = (path, args) => exec(path, args, {
    encoding: "utf8", timeout: 500, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
  });
  return pid => {
    if (!["linux", "darwin"].includes(platform)) return {};
    if (pid === process.pid && self) return self;
    if (!bootId) bootId = readable(() => parseBootId(platform === "linux"
      ? io.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      : command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])));
    let startTime, startedAtMs;
    if (platform === "linux") {
      // Linux exposes USER_HZ (100) ticks; compare boot-relative time despite wall-clock changes.
      startTime = readable(() => parseLinuxStartTime(io.readFileSync(`/proc/${pid}/stat`, "utf8")));
      const bootTime = readable(() => parseLinuxBootTime(io.readFileSync("/proc/stat", "utf8")));
      startedAtMs = startTime !== null && bootTime !== null ? bootTime + startTime : null;
    } else {
      startTime = readable(() => parseMacStartTime(command("/bin/ps", ["-o", "lstart=", "-p", String(pid)])));
      startedAtMs = startTime;
    }
    const identity = { bootId, startTime, startedAtMs, startTimeSource: platform === "linux" ? "linux-proc" : "macos-ps" };
    if (pid === process.pid && bootId !== null && startTime !== null && startedAtMs !== null) self = identity;
    return identity;
  };
}

export const processIdentity = createProcessIdentity();
