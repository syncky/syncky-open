import { DurableObject } from "cloudflare:workers";
import { handle } from "../src/handler.js";
import { createStore } from "../src/store.js";
import { durableSql } from "./sql.js";
import { readBody } from "../src/upload.js";

const failure = status => Response.json({ ok: false, code: status === 503 ? "invalid_configuration" : "internal" }, { status, headers: { "Cache-Control": "no-store" } });

export class OwnServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = durableSql(ctx.storage);
    this.store = createStore(this.sql);
  }

  fetch(request) {
    return handle(request, { store: this.store, adminPassword: this.env.ADMIN_PASSWORD });
  }
}

export default {
  async fetch(request, env) {
    const jurisdiction = env.DO_JURISDICTION ?? "eu";
    if (jurisdiction !== "eu" && jurisdiction !== "") return failure(503);
    try {
      if (request.body) {
        const path = new URL(request.url).pathname;
        const cap = path === "/server" ? 1_000_000 : path === "/mcp" ? 65_536 : 16_384;
        request = new Request(request, { body: await readBody(request, cap) });
      }
      const namespace = jurisdiction ? env.OWN_SERVER.jurisdiction(jurisdiction) : env.OWN_SERVER;
      return await namespace.getByName("own-server").fetch(request);
    } catch (error) {
      if (["payload_too_large", "invalid_content_length", "invalid_body"].includes(error?.code)) return Response.json({ ok: false, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
      return failure(500);
    }
  },
};
