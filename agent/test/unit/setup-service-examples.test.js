import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP = readFileSync(new URL("../../SETUP.md", import.meta.url), "utf8");
const CONTINUOUS = SETUP.match(/^## 4\. Run continuously\n([\s\S]*?)(?=^## 5\.)/m)?.[1];

function plistExample() {
  const xml = CONTINUOUS.match(/```xml\n([\s\S]*?)\n```/)?.[1];
  assert.ok(xml, "missing LaunchAgent plist example");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/);
  const tokens = xml.replace(/<\?xml[^?]*\?>|<!DOCTYPE[^>]*>/g, "").match(/<[^>]+>|[^<]+/g).map((token) => token.trim()).filter(Boolean);
  let at = 0;
  const take = (expected) => assert.equal(tokens[at++], expected, `expected ${expected} at token ${at - 1}`);
  const text = (tag) => {
    take(`<${tag}>`);
    const value = tokens[at++];
    assert.ok(value && !/[<>&]/.test(value), `invalid ${tag} text`);
    take(`</${tag}>`);
    return value;
  };
  const value = () => {
    if (tokens[at] === "<dict>") {
      take("<dict>");
      const dict = {};
      while (tokens[at] !== "</dict>") {
        const key = text("key");
        assert.ok(!Object.hasOwn(dict, key), `duplicate plist key ${key}`);
        dict[key] = value();
      }
      take("</dict>");
      return dict;
    }
    if (tokens[at] === "<array>") {
      take("<array>");
      const array = [];
      while (tokens[at] !== "</array>") array.push(value());
      take("</array>");
      return array;
    }
    if (tokens[at] === "<string>") return text("string");
    if (tokens[at] === "<true/>") { take("<true/>"); return true; }
    if (tokens[at] === "<false/>") { take("<false/>"); return false; }
    assert.fail(`unexpected plist token ${tokens[at]}`);
  };
  take('<plist version="1.0">');
  assert.equal(tokens[at], "<dict>");
  const plist = value();
  take("</plist>");
  assert.equal(at, tokens.length, "unexpected content after plist");
  return { xml, plist };
}

describe("setup background service examples", () => {
  it("has a balanced XML LaunchAgent plist with a supervised receiver and private log paths", () => {
    const { xml, plist } = plistExample();
    assert.equal(plist.Label, "app.syncky.agent");
    assert.equal(plist.ProgramArguments.length, 3);
    assert.match(plist.ProgramArguments[0], /^\/[^\s]*\/node$/);
    assert.match(plist.ProgramArguments[1], /^\/.*\/bin\/syncky-agent\.js$/);
    assert.deepEqual(plist.ProgramArguments.slice(2), ["receive"]);
    const home = plist.EnvironmentVariables.SYNCKY_AGENT_HOME;
    assert.match(home, /^\/Users\/[^/]+\/\.syncky-agent$/);
    assert.equal(plist.EnvironmentVariables.NODE_NO_WARNINGS, "1");
    assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.StandardOutPath, "/dev/null");
    for (const key of ["StandardErrorPath"]) {
      assert.ok(plist[key].startsWith(`${home}/`), `${key} is outside the agent home`);
      assert.ok(!plist[key].slice(home.length + 1).includes("/"), `${key} is not a log directly in the home`);
    }
    assert.notEqual(plist.StandardOutPath, plist.StandardErrorPath);
    assert.doesNotMatch(xml, /~|\$HOME/);
    if (process.platform === "darwin" && existsSync("/usr/bin/plutil")) {
      const dir = mkdtempSync(join(tmpdir(), "syncky-plist-"));
      try {
        const path = join(dir, "app.syncky.agent.plist");
        writeFileSync(path, xml);
        execFileSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("documents launchd lifecycle, absolute paths and carried launchers", () => {
    assert.match(CONTINUOUS, /~\/Library\/LaunchAgents\/app\.syncky\.agent\.plist/);
    for (const command of [
      'launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/app.syncky.agent.plist"',
      "launchctl print gui/$(id -u)/app.syncky.agent",
      "launchctl bootout gui/$(id -u)/app.syncky.agent",
    ]) assert.ok(CONTINUOUS.includes(command), command);
    assert.match(CONTINUOUS, /launchd does not expand `~` or `\$HOME`/);
    assert.match(CONTINUOUS, /carried package[^\n]*ProgramArguments[^\n]*absolute launcher path/);
    assert.match(CONTINUOUS, /EnvironmentVariables\.PATH/);
  });

  it("runs Windows Task Scheduler at logon with restart on failure and task-local environment", () => {
    const windows = CONTINUOUS.match(/^### Windows: Task Scheduler\n([\s\S]*?)(?=^### )/m)?.[1];
    assert.ok(windows);
    assert.match(windows, /New-ScheduledTaskTrigger\b[^\n]*-AtLogOn\b[^\n]*-User \$user/);
    const settings = windows.match(/New-ScheduledTaskSettingsSet\b([^\n]*)/)?.[1];
    assert.ok(settings, "missing Task Scheduler settings");
    assert.ok(Number(settings.match(/-RestartCount\s+(\d+)\b/)?.[1]) > 0);
    assert.match(settings, /-RestartInterval\b/);
    assert.match(settings, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    const loop = windows.match(/```powershell\n([\s\S]*?)\n```/)?.[1];
    assert.ok(loop, "missing PowerShell restart loop");
    assert.match(loop, /^\$env:SYNCKY_AGENT_HOME\s*=\s*'[A-Za-z]:\\[^'\n]+'/m);
    assert.match(loop, /^\$env:NODE_NO_WARNINGS\s*=\s*'1'/m);
    assert.match(loop, /while\s*\(\$true\)\s*\{\s*&\s*'[A-Za-z]:\\[^'\n]*\\node\.exe'\s*'[A-Za-z]:\\[^'\n]+\.js'\s+receive\s+1>\$null\s*\n\s*if\s*\(\$LASTEXITCODE\s+-in\s+1\s*,\s*3\)\s*\{\s*break\s*\}\s*\n\s*Start-Sleep\s+-Seconds\s+[1-9]\d*\s*\n\}/);
    const action = windows.match(/New-ScheduledTaskAction\b[^\n]*/)?.[0];
    assert.ok(action, "missing Task Scheduler action");
    assert.match(action, /-Execute\s+"[^"\n]*\\powershell\.exe"/i);
    const args = action.match(/-Argument\s+'([^'\n]*)'/)?.[1];
    assert.ok(args, "missing PowerShell arguments");
    assert.match(args, /(?:^|\s)-NoProfile\b/);
    assert.match(args, /(?:^|\s)-WindowStyle\s+Hidden\b/i);
    assert.match(args, /(?:^|\s)-File\s+"[A-Za-z]:\\[^"\n]+\.ps1"/i);
    for (const command of ["Register", "Start", "Get", "Stop", "Unregister"]) {
      assert.match(windows, new RegExp(`\\b${command}-ScheduledTask\\b[^\\n]*-TaskName\\s+['"][^'"\\n]+['"]`), command);
    }
    assert.match(windows, /Stop-ScheduledTask\b[^\n]*\nGet-CimInstance Win32_Process/);
    assert.match(windows, /Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine/);
    assert.match(windows, /Stop-Process\s+-Id\s+<ProcessId>\s+-Force\b/);
    assert.match(windows, /carried package[^\n]*absolute shell path and absolute launcher path/);
  });

  it("keeps the systemd unit, one receiver per home and status checks", () => {
    const unit = CONTINUOUS.match(/```ini\n([\s\S]*?)\n```/)?.[1];
    assert.ok(unit, "missing systemd unit");
    assert.match(unit, /^\[Service\]$/m);
    assert.match(unit, /^ExecStart=[^\n]*\breceive$/m);
    assert.match(unit, /^StandardOutput=null$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.deepEqual(unit.match(/^RestartPreventExitStatus=(.*)$/m)?.[1].trim().split(/\s+/).sort(), ["1", "3"]);
    assert.match(CONTINUOUS, /systemctl --user status syncky-agent/);
    assert.match(CONTINUOUS, /carried package[^\n]*ExecStart[^\n]*absolute launcher path/);
    assert.match(CONTINUOUS, /one `receive` per home/);
    assert.match(CONTINUOUS, /receiver lease refuses a second loop/);
    assert.match(CONTINUOUS, /`syncky status`[^\n]*transport metadata[^\n]*last poll[^\n]*30-minute interval/);
  });

  it("asks the owner after pairing, explains stalls and acts only on the answer", () => {
    const pairing = SETUP.match(/^## 5\.[\s\S]*?(?=^## 6\.)/m)?.[0];
    assert.ok(pairing);
    assert.match(pairing, /After pairing, ask the owner:[^\n]*\*\*Should[^\n]*continuously in the background[^\n]*recommended[^\n]*`receive`[^\n]*only when you ask[^\n]*on-demand `receive --once`[^\n]*\?/);
    for (const phrase of ["missed its expected check-in", "Needs attention", "uploads wait"]) assert.ok(pairing.includes(phrase), phrase);
    assert.match(pairing, /\*\*continuous\*\* is the explicit request to install and start/);
    assert.match(pairing, /\*\*Only when you ask\*\* means run `syncky receive --once`[^\n]*do not install a service or schedule/);
    assert.match(pairing, /has not answered[^\n]*wait before installing anything/);
  });
});
