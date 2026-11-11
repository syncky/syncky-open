export const globalFlags = { home: 'string', relay: 'string', 'url-scheme': 'string', 'log-level': 'string', help: 'boolean' };
export const commands = {
  init: { usage: 'init --name <name> [--invite <secret>]', flags: { name: 'string', invite: 'string' } },
  pair: { usage: 'pair [--read <comma-separated-types>] [--write <comma-separated-types>] [--v1] [--wait] [--timeout <seconds>] [--no-qr]', flags: { read: 'string', write: 'string', v1: 'boolean', wait: 'boolean', timeout: 'string', 'no-qr': 'boolean' } },
  wait: { usage: 'wait [--timeout <seconds>]', flags: { timeout: 'string' } },
  confirm: { usage: 'confirm <member_id> <fingerprint>', max: 8 },
  reject: { usage: 'reject <member_id>', max: 1 },
  revoke: { usage: 'revoke <member_id>', max: 1, details: 'Revoke a known phone on the relay, then stop trusting it locally. History stays until forget.' },
  forget: { usage: 'forget <member_id> [--yes]', max: 1, flags: { yes: 'boolean' } },
  status: { usage: 'status' },
  send: { usage: 'send --type <type> --json <file|-> [--to <member_id>] [--validate]', flags: { type: 'string', to: 'string', validate: 'boolean' } },
  inbox: { usage: 'inbox [--type <type>] [--member <member_id>] [--after-seq <seq>] [--since <date>] [--until <date>] [--limit <n>]', flags: { type: 'string', member: 'string', 'after-seq': 'string', since: 'string', until: 'string', limit: 'string' } },
  receive: { usage: 'receive [--once] [--poll-interval <seconds>] [--emit-records]', flags: { once: 'boolean', 'poll-interval': 'string', 'emit-records': 'boolean' } },
  ack: { usage: 'ack --up-to-seq <seq>', flags: { 'up-to-seq': 'string' } },
  skill: { usage: 'skill [--diff]', flags: { diff: 'boolean' } },
  mcp: { usage: 'mcp' },
  selftest: { usage: 'selftest' },
  help: { usage: 'help [command]', max: 1 },
};
export const commandNames = () => Object.keys(commands);
