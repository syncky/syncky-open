import { DatabaseSync } from "node:sqlite";

export function openSqlite(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  let closed = false;
  return {
    all(statement, ...bindings) { return db.prepare(statement).all(...bindings); },
    run(statement, ...bindings) { return db.prepare(statement).run(...bindings); },
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        if (value && typeof value.then === "function") throw new Error("async_transaction");
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      if (!closed) db.close();
      closed = true;
    },
  };
}
