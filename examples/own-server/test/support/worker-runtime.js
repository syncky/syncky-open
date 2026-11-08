import { env } from "cloudflare:workers";
import { SELF, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { vi } from "vitest";

export const ownStub = () => env.OWN_SERVER.getByName("own-server");
export function workerRuntime() {
  return {
    origin: "https://receiver.example", password: env.ADMIN_PASSWORD, now: () => Math.floor(Date.now() / 1000),
    send: request => SELF.fetch(request),
    restart: () => abortAllDurableObjects(),
    all: (statement, ...bindings) => runInDurableObject(ownStub(), instance => instance.sql.all(statement, ...bindings)),
    run: (statement, ...bindings) => runInDurableObject(ownStub(), instance => instance.sql.run(statement, ...bindings)),
    setNow: seconds => { vi.spyOn(Date, "now").mockReturnValue(seconds * 1000); },
  };
}
