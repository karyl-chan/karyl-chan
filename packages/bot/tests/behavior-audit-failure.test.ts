/**
 * #98 / #136 — the audit trail observes behavior writes, it never vetoes
 * one: a write is committed before its audit entry is recorded, so an
 * audit failure must not turn the committed write into a 500. It is logged
 * as an error instead.
 */
import { vi, describe, it, expect, beforeAll } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

const record = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record },
}));
vi.mock("../src/modules/admin/admin-audit.service.js", () => ({
  recordAudit: vi.fn(async () => {
    throw new Error("audit table locked");
  }),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { seedMessageTrigger } from "./behavior-fixtures.js";

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await seedMessageTrigger({ audienceKind: "group", audienceGroupName: "ops" });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

describe("a failing audit write", () => {
  it("does not fail the committed write, and is logged", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/behavior-groups/ops/members",
      payload: { userIds: ["123456789012345678"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual(["123456789012345678"]);
    expect(record).toHaveBeenCalledWith(
      "error",
      "error",
      expect.stringContaining("audit table locked"),
      expect.objectContaining({ action: "behavior.group_members.replace" }),
    );
  });
});
