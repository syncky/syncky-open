#!/usr/bin/env node
process.umask(0o077);

const { main } = await import("../src/cli.js");
const code = await main(process.argv.slice(2));
const flushed = (stream) => new Promise((resolve) => stream.write("", resolve));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
