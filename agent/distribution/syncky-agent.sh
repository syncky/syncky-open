#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Syncky requires Node.js >=22.15; install it before running this launcher.' >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major > 22 || (major === 22 && minor >= 15))) { console.error("Syncky requires Node.js >=22.15."); process.exit(1); }' || exit $?
case "$0" in
  */*) launcher=$0 ;;
  *) if [ -f "$0" ]; then launcher=./$0; else launcher=$(command -v "$0"); fi ;;
esac
exec node --input-type=module --eval '
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const bundle = join(dirname(realpathSync(process.argv[1])), "syncky-agent.mjs");
let bytes;
try { bytes = readFileSync(bundle); }
catch { console.error("Syncky bundle missing or unreadable; unpack the complete package again."); process.exit(1); }
if (createHash("sha256").update(bytes).digest("hex") !== "@BUNDLE_SHA256@") {
  console.error("Syncky bundle checksum mismatch; unpack the complete package again.");
  process.exit(1);
}
process.umask(0o077);
const { runCli } = await import(pathToFileURL(bundle));
await runCli(process.argv.slice(2));
' "$launcher" "$@"
