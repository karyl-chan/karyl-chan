/**
 * #126 — triggering a Service Behavior logs the triggerer in to its service:
 * a DM of `!login-<audience>` gets an embed and a link button to the
 * redirect URL with `token`; that token verifies against the JWKS (typ,
 * kid, signature, aud = the service's audience, iss, exp) and vouches for
 * the triggerer. The login keeps answering `!login`, and the trigger's
 * audience decides who gets a link.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
vi.mock("../src/modules/admin/admin-login.service.js", () => ({
  mintLoginLink: vi.fn(async () => ({
    ok: true,
    url: "https://admin.example/admin/auth?token=t",
    minutesUntilExpiry: 5,
    role: "owner",
  })),
}));

import { createPublicKey, verify as cryptoVerify } from "crypto";
import { ChannelType } from "discord.js";
import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { mintLoginLink } from "../src/modules/admin/admin-login.service.js";
import { MessageTriggerMatcher } from "../src/modules/command-system/message-trigger-matcher.service.js";
import type { WebhookForwarder } from "../src/modules/command-system/webhook-forwarder.service.js";
import { getJwks, initJwtSigningAuthority, type Jwks } from "../src/modules/web-core/jwt.service.js";
import { publicBaseUrl } from "../src/modules/web-core/public-base-url.js";
import { __resetBehaviorRateLimitsForTests } from "../src/modules/command-system/behavior-rate-limits.js";
import { clearBehaviors, seedSystemLogin } from "./behavior-fixtures.js";

const matcher = new MessageTriggerMatcher({ forward: vi.fn() } as unknown as WebhookForwarder);
let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await initJwtSigningAuthority();
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server);
  await server.ready();
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetBehaviorRateLimitsForTests();
  await clearBehaviors();
  await seedSystemLogin();
  const res = await server.inject({
    method: "POST",
    url: "/api/services",
    payload: { name: "NAS", audience: "nas", redirectUrl: "https://nas.example/auth/karyl?from=bot" },
  });
  expect(res.statusCode).toBe(201);
});

function dm(content: string, userId = "222222222222222222") {
  const send = vi.fn(async () => ({}));
  const message = {
    id: "M1",
    content,
    guildId: null,
    author: {
      id: userId,
      bot: false,
      username: "karyl",
      globalName: "Karyl",
      discriminator: "0",
      avatar: "abc",
      avatarURL: () => `https://cdn.discordapp.com/avatars/${userId}/abc.png`,
      displayAvatarURL: () => "",
    },
    client: { user: { id: "BOT" } },
    channel: { id: `DM-${userId}`, type: ChannelType.DM, send },
  };
  return { message: message as never, send };
}

function segment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf-8"));
}

/** What a service does with the token: the checks the author docs require. */
function verifyAsService(token: string, jwks: Jwks, aud: string): Record<string, unknown> | null {
  const [h, b, s] = token.split(".");
  const header = segment(h);
  if (header.alg !== "EdDSA" || header.typ !== "karyl-service+jwt") return null;
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
  if (!cryptoVerify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url"))) return null;
  const claims = segment(b);
  if (claims.aud !== aud || claims.iss !== publicBaseUrl()) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

function sentLink(send: ReturnType<typeof vi.fn>): URL {
  const sent = send.mock.calls[0][0] as {
    content?: string;
    embeds: Array<{ title: string; description: string }>;
    components: Array<{ components: Array<{ url: string; style: number }> }>;
  };
  // the token is only the button's target, never in the text
  expect(JSON.stringify(sent.embeds)).not.toContain("token");
  expect(sent.content ?? "").toBe("");
  expect(sent.embeds[0].title).toBe("登入 NAS");
  return new URL(sent.components[0].components[0].url);
}

describe("a Service Behavior's trigger", () => {
  it("DMs a link whose token verifies against the JWKS for the service's audience", async () => {
    const { message, send } = dm("!login-nas");
    expect(await matcher.onMessage(message)).toMatchObject({ handled: true });

    const link = sentLink(send);
    expect(`${link.origin}${link.pathname}`).toBe("https://nas.example/auth/karyl");
    expect(link.searchParams.get("from")).toBe("bot");
    const token = link.searchParams.get("token")!;
    const claims = verifyAsService(token, await getJwks(), "nas");
    expect(claims).toMatchObject({
      sub: "222222222222222222",
      name: "Karyl",
      avatar: "https://cdn.discordapp.com/avatars/222222222222222222/abc.png",
      aud: "nas",
      jti: expect.any(String),
    });
    expect((claims!.exp as number) - (claims!.iat as number)).toBe(120);
    // the login never ran
    expect(mintLoginLink).not.toHaveBeenCalled();
  });

  it("mints a fresh jti on every trigger", async () => {
    const first = dm("!login-nas");
    const second = dm("!login-nas");
    await matcher.onMessage(first.message);
    await matcher.onMessage(second.message);
    const jti = (send: ReturnType<typeof vi.fn>) =>
      segment(sentLink(send).searchParams.get("token")!.split(".")[1]).jti;
    expect(jti(first.send)).not.toBe(jti(second.send));
  });

  it("leaves !login to the login", async () => {
    const { message, send } = dm("!login");
    expect((await matcher.onMessage(message)).handled).toBe(true);
    expect(mintLoginLink).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as { components: Array<{ components: Array<{ url: string }> }> };
    expect(sent.components[0].components[0].url).toBe("https://admin.example/admin/auth?token=t");
  });

  it("answers only its audience", async () => {
    const view = (await server.inject({ method: "GET", url: "/api/behaviors" })).json();
    await server.inject({
      method: "PATCH",
      url: `/api/behaviors/${view.services[0].id}`,
      payload: { audienceKind: "user", audienceUserId: "333333333333333333" },
    });
    // someone else's `!login-nas` walks on to the login (startswith `!login`),
    // which answers only authorised admins — never with a service link
    const stranger = dm("!login-nas");
    await matcher.onMessage(stranger.message);
    expect(JSON.stringify(stranger.send.mock.calls)).not.toContain("nas.example");
    const allowed = dm("!login-nas", "333333333333333333");
    expect((await matcher.onMessage(allowed.message)).handled).toBe(true);
    expect(verifyAsService(sentLink(allowed.send).searchParams.get("token")!, await getJwks(), "nas")).toMatchObject({
      sub: "333333333333333333",
    });
  });

  it("is gone with its service", async () => {
    const { services } = (await server.inject({ method: "GET", url: "/api/services" })).json();
    await server.inject({ method: "DELETE", url: `/api/services/${services[0].id}` });
    const { message, send } = dm("!login-nas");
    await matcher.onMessage(message);
    // `!login-nas` starts with `!login`: with the service gone the login answers it
    expect(mintLoginLink).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain("nas.example");
  });
});
