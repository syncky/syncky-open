import { applySchema } from "./schema.js";
import { initializedCredentials } from "./crypto.js";

export function createStore(sql) {
  applySchema(sql);
  return {
    sql,
    setting(key) {
      const row = sql.all("SELECT value_json FROM settings WHERE key = ?", key)[0];
      return row ? JSON.parse(row.value_json) : null;
    },
    setSetting(key, value) {
      sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", key, JSON.stringify(value));
    },
    key(name) { return sql.all("SELECT value FROM crypto_secrets WHERE name = ?", name)[0]?.value; },
    rate(key, limit, window, now) {
      return sql.transaction(() => {
        const row = sql.all("SELECT * FROM rate_limits WHERE key = ?", key)[0];
        if (!row || now >= row.started_at + window) {
          sql.run("INSERT INTO rate_limits(key, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at, attempts = 1", key, now);
          return true;
        }
        if (row.attempts >= limit) return false;
        sql.run("UPDATE rate_limits SET attempts = attempts + 1 WHERE key = ?", key);
        return true;
      });
    },
    revokeGrant(id, now) {
      sql.run("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now, id);
      sql.run("DELETE FROM auth_codes WHERE grant_id = ?", id);
      sql.run("UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?", id);
      sql.run("UPDATE commands SET state = 'cancelled' WHERE grant_id = ? AND state NOT IN ('applied', 'rejected')", id);
    },
    prune(now) {
      sql.transaction(() => {
        for (const table of ["admin_sessions", "consent_requests", "auth_codes", "consumed_codes"]) sql.run(`DELETE FROM ${table} WHERE expires_at <= ?`, now);
        sql.run("DELETE FROM oauth_tokens WHERE family_expires_at <= ? OR (kind = 'access' AND expires_at <= ?) OR (kind = 'refresh' AND used = 0 AND expires_at <= ?)", now, now, now);
        sql.run("DELETE FROM consent_requests WHERE json_extract(request_json, '$.client_id') IN (SELECT id FROM clients WHERE created_at <= ? AND NOT EXISTS (SELECT 1 FROM grants WHERE grants.client_id = clients.id))", now - 86400);
        sql.run("DELETE FROM clients WHERE created_at <= ? AND NOT EXISTS (SELECT 1 FROM grants WHERE grants.client_id = clients.id)", now - 86400);
        sql.run("DELETE FROM rate_limits WHERE started_at + 3600 <= ?", now);
      });
    },
    credentials() {
      const row = sql.all("SELECT value_json FROM settings WHERE key = ?", "upload_credentials")[0];
      return row ? JSON.parse(row.value_json) : null;
    },
    initializeCredentials(credentials) {
      return sql.transaction(() => {
        if (sql.all("SELECT key FROM settings WHERE key = ?", "upload_credentials").length) return false;
        if (!initializedCredentials(credentials)) throw new Error("invalid_configuration");
        sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?)", "upload_credentials", JSON.stringify(credentials));
        return true;
      });
    },
    ingest(message, receivedAt) {
      sql.transaction(() => {
        sql.run(`INSERT INTO upload_targets(destination, device, received_at) VALUES (?, ?, ?)
          ON CONFLICT(destination, device) DO UPDATE SET received_at = excluded.received_at`, message.delivery.destination, message.device, receivedAt);
        for (const s of message.samples) {
          const replacement = s.type === "characteristic" || s.type === "activity_summary";
          sql.run(`INSERT INTO samples(device, uuid, part, type, start, end, received_at, payload_json, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device, uuid, part) DO ${replacement ? "UPDATE SET type = excluded.type, start = excluded.start, end = excluded.end, received_at = excluded.received_at, payload_json = excluded.payload_json, date = excluded.date" : "NOTHING"}`,
          message.device, s.uuid, s.part ?? -1, s.type, s.start ?? null, s.end ?? null, receivedAt, JSON.stringify(s), s.type === "activity_summary" ? s.date ?? null : null);
        }
        for (const d of message.deleted) sql.run("DELETE FROM samples WHERE device = ? AND uuid = ?", message.device, d.uuid);
        for (const s of message.summaries ?? []) {
          sql.run(`INSERT INTO summaries(device, type, unit, start, end, stat, value, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device, type, unit, start, end, stat) DO UPDATE SET value = excluded.value, received_at = excluded.received_at`,
          message.device, s.type, s.unit, s.start, s.end, s.stat, s.value, receivedAt);
        }
      });
    },
    acceptResults(destination, results, receivedAt) {
      sql.transaction(() => {
        for (const result of results) {
          sql.run("INSERT OR IGNORE INTO results(destination, command_id, version, status, reason, received_at) VALUES (?, ?, ?, ?, ?, ?)",
            destination, result.command_id, result.version, result.status, result.reason ?? null, receivedAt);
          sql.run(`UPDATE commands SET state = (SELECT status FROM results WHERE destination = ? AND command_id = ? AND version = ?)
            WHERE destination = ? AND command_id = ? AND version = ? AND state = 'pending'
            AND version = (SELECT MAX(c.version) FROM commands c WHERE c.destination = ? AND c.command_id = ?)`,
          destination, result.command_id, result.version, destination, result.command_id, result.version, destination, result.command_id);
        }
      });
    },
  };
}
