export function durableSql(storage) {
  return {
    all(statement, ...bindings) { return storage.sql.exec(statement, ...bindings).toArray(); },
    run(statement, ...bindings) {
      const cursor = storage.sql.exec(statement, ...bindings);
      return { changes: cursor.rowsWritten };
    },
    transaction(fn) {
      return storage.transactionSync(() => {
        const value = fn();
        if (value && typeof value.then === "function") throw new Error("async_transaction");
        return value;
      });
    },
  };
}
