export const SCHEMA_VERSION = 1;

const statements = [
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
  "CREATE TABLE IF NOT EXISTS crypto_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    session_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects_json TEXT NOT NULL,
    auth_method TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    read_types_json TEXT NOT NULL, write_types_json TEXT NOT NULL, purpose TEXT NOT NULL,
    revision INTEGER NOT NULL, consented INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS consent_requests (
    state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, request_json TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_codes (
    code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL,
    issuer TEXT NOT NULL, grant_id TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL, issuer TEXT NOT NULL, grant_id TEXT NOT NULL, family TEXT NOT NULL,
    family_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS consumed_codes (
    code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL, issuer TEXT NOT NULL, challenge TEXT NOT NULL,
    family TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family)",
  `CREATE TABLE IF NOT EXISTS commands (
    destination TEXT NOT NULL, command_id TEXT NOT NULL, version INTEGER NOT NULL, device TEXT NOT NULL,
    client_id TEXT NOT NULL, grant_id TEXT NOT NULL, type TEXT NOT NULL, op TEXT NOT NULL,
    payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(destination, command_id, version)
  )`,
  "CREATE INDEX IF NOT EXISTS commands_pending ON commands(state, created_at)",
  `CREATE TABLE IF NOT EXISTS samples (
    device TEXT NOT NULL, uuid TEXT NOT NULL, part INTEGER NOT NULL,
    type TEXT NOT NULL, start TEXT, end TEXT, received_at INTEGER NOT NULL, payload_json TEXT NOT NULL, date TEXT,
    PRIMARY KEY (device, uuid, part)
  )`,
  "CREATE INDEX IF NOT EXISTS samples_type_start_device ON samples(type, start, device)",
  `CREATE TABLE IF NOT EXISTS summaries (
    device TEXT NOT NULL, type TEXT NOT NULL, unit TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    stat TEXT NOT NULL, value REAL NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (device, type, unit, start, end, stat)
  )`,
  `CREATE TABLE IF NOT EXISTS upload_targets (
    destination TEXT NOT NULL, device TEXT NOT NULL, received_at INTEGER NOT NULL,
    PRIMARY KEY (destination, device)
  )`,
  `CREATE TABLE IF NOT EXISTS results (
    destination TEXT NOT NULL, command_id TEXT NOT NULL, version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')), reason TEXT, received_at INTEGER NOT NULL,
    PRIMARY KEY (destination, command_id, version)
  )`,
];

export function applySchema(sql) {
  sql.transaction(() => {
    for (const statement of statements) sql.run(statement);
    const versions = sql.all("SELECT version FROM schema_version");
    if (versions.some(row => row.version !== SCHEMA_VERSION)) throw new Error("unsupported_schema");
    sql.run("INSERT OR IGNORE INTO schema_version(version) VALUES (?)", SCHEMA_VERSION);
  });
}
