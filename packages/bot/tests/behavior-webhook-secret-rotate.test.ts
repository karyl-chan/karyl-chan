/**
 * #99 — POST /api/behaviors/:id/webhook-secret/rotate: the bot generates a
 * new webhook secret, shows it once, and keeps the old one valid for 24 h
 * (see webhook-forwarder-secret-rotation.test.ts for what "valid" means on
 * the wire). Reads only ever report secretSet and when the grace ends.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { decryptSecret } from "../src/utils/crypto.js";
import { clearBehaviors, seedSystemLogin } from "./behavior-fixtures.js";

const HOOK = "https://203.0.113.10/hook";
const DAY = 24 * 3600_000;

const forward = vi.fn(async () => ({ ok: true, reply: {}, notes: [] }));
let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, { forwarder: { forward } as never });
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
  forward.mockClear();
});

async function createTrigger(authMode: "token" | "hmac" | null) {
  const res = await server.inject({
    method: "POST",
    url: "/api/behaviors",
    payload: {
      title: "hook",
      surface: "bot_dm",
      patternKind: "startswith",
      patternValue: "!hook",
      webhook: { url: HOOK, authMode },
    },
  });
  return res.json() as { behavior: { id: number }; secret?: string };
}

function rotate(id: number) {
  return server.inject({ method: "POST", url: `/api/behaviors/${id}/webhook-secret/rotate` });
}

async function webhookView(id: number): Promise<Record<string, unknown>> {
  const res = await server.inject({ method: "GET", url: "/api/behaviors" });
  const trigger = (res.json().messageTriggers as Array<{ id: number; webhook: Record<string, unknown> }>)
    .find((t) => t.id === id)!;
  return trigger.webhook;
}

describe("POST /api/behaviors/:id/webhook-secret/rotate", () => {
  it("issues a new secret once and keeps the old one for 24 h", async () => {
    const { behavior, secret: old } = await createTrigger("hmac");
    const before = Date.now();
    const res = await rotate(behavior.id);
    expect(res.statusCode).toBe(200);
    const { secret, previousSecretExpiresAt } = res.json();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(old);
    const graceEnd = Date.parse(previousSecretExpiresAt);
    expect(graceEnd).toBeGreaterThanOrEqual(before + DAY);
    expect(graceEnd).toBeLessThanOrEqual(Date.now() + DAY);

    expect(await webhookView(behavior.id)).toEqual({
      url: HOOK,
      authMode: "hmac",
      secretSet: true,
      previousSecretExpiresAt,
    });

    // what the forwarder gets: the new secret, the old one as previous
    await server.inject({ method: "POST", url: `/api/behaviors/${behavior.id}/test` });
    const [action] = forward.mock.calls[0] as unknown as [
      { secret: string; previousSecret: string },
    ];
    expect(decryptSecret(action.secret)).toBe(secret);
    expect(decryptSecret(action.previousSecret)).toBe(old);

    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain(old!);
  });

  it("a second rotation keeps only the secret it replaced", async () => {
    const { behavior } = await createTrigger("token");
    const first = (await rotate(behavior.id)).json().secret as string;
    const second = (await rotate(behavior.id)).json().secret as string;
    await server.inject({ method: "POST", url: `/api/behaviors/${behavior.id}/test` });
    const [action] = forward.mock.calls[0] as unknown as [
      { secret: string; previousSecret: string },
    ];
    expect(decryptSecret(action.secret)).toBe(second);
    expect(decryptSecret(action.previousSecret)).toBe(first);
  });

  it("turning authentication off ends the grace period too", async () => {
    const { behavior } = await createTrigger("hmac");
    await rotate(behavior.id);
    await server.inject({
      method: "PATCH",
      url: `/api/behaviors/${behavior.id}`,
      payload: { webhook: { url: HOOK, authMode: null } },
    });
    expect(await webhookView(behavior.id)).toEqual({
      url: HOOK,
      authMode: null,
      secretSet: false,
      previousSecretExpiresAt: null,
    });
  });

  it("refuses a behavior without webhook authentication", async () => {
    const { behavior } = await createTrigger(null);
    const res = await rotate(behavior.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "webhook.authMode" });
  });

  it("refuses the system behavior and unknown ids", async () => {
    const login = await seedSystemLogin();
    const sys = await rotate(login);
    expect(sys.statusCode).toBe(409);
    expect(sys.json().error.code).toBe("system_immutable");
    const missing = await rotate(9999);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  it("is audited without the secret", async () => {
    const { behavior } = await createTrigger("hmac");
    const { secret } = (await rotate(behavior.id)).json();
    const [entry] = await listAudit({ limit: 1 });
    expect(entry).toMatchObject({
      action: "behavior.webhook_secret.rotate",
      target: `behavior:${behavior.id}`,
    });
    expect(JSON.stringify(entry)).not.toContain(secret);
  });
});
