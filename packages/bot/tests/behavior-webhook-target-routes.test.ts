/**
 * #100 — a webhook target the policy would refuse is refused on save
 * (`isValidWebhookUrl`, the check the S4 write routes apply) and on
 * test-fire, with the readable reason and the machine code. Literal-IP
 * URLs only, so no DNS is involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { isValidWebhookUrl } from "../src/modules/behavior/behavior-helpers.js";
import { encryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedMessageTrigger } from "./behavior-fixtures.js";

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "test";
    request.authCapabilities = new Set(["admin"]);
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await clearBehaviors();
});

describe("behavior webhook target refusals", () => {
  it("refuses a non-allowlisted LAN target with a readable reason", async () => {
    const res = await isValidWebhookUrl("http://192.168.2.40/hook");
    expect(res).toMatchObject({ ok: false, code: "private_not_allowlisted" });
    const reason = (res as { reason: string }).reason;
    expect(reason).toContain("192.168.2.40");
    expect(reason).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });

  it("refuses plain http to a public address", async () => {
    expect(await isValidWebhookUrl("http://203.0.113.10/hook")).toMatchObject({
      ok: false,
      code: "https_required",
    });
  });

  it("refuses a loopback target", async () => {
    expect(await isValidWebhookUrl("http://127.0.0.1:8080/hook")).toMatchObject({
      ok: false,
      code: "blocked_loopback",
    });
  });

  it("test-fire reports the refusal and its code instead of sending", async () => {
    // A row saved before the policy tightened (or with the env changed
    // since) is re-checked at send time.
    const id = await seedMessageTrigger({}, {
      url: encryptSecret("http://192.168.2.40/hook"),
    });
    const res = await server.inject({
      method: "POST",
      url: `/api/behaviors/${id}/test`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; error: string; errorCode: string };
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe("private_not_allowlisted");
    expect(body.error).toContain("WEBHOOK_PRIVATE_ALLOWLIST");
  });
});
