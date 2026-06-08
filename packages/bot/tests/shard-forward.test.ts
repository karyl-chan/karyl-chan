/**
 * Cross-shard forwarding (PR-3.3).
 *
 *  - parseShardUrls: SHARD_URLS env parse contract.
 *  - decideForward: the routing decision matrix (single-shard / mine /
 *    forward / no-target / no-secret).
 *  - forwardToShard: signs + POSTs via signedJsonPost (fetch-mocked).
 *  - replay route: HMAC verify + server.inject re-dispatch, exercised on
 *    a bare Fastify instance with a stub /api/plugin/echo handler.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { parseShardUrls } from "../src/config.js";
import {
  decideForward,
  forwardToShard,
} from "../src/utils/shard-forward.js";
import {
  registerShardForwardRoutes,
  SHARD_REPLAY_PATH,
  SHARD_REPLAYED_HEADER,
} from "../src/modules/plugin-system/shard-forward-routes.js";
import { buildOutboundSignatureHeaders } from "../src/utils/hmac.js";

describe("parseShardUrls", () => {
  it("returns {} for unset / empty", () => {
    expect(parseShardUrls(undefined)).toEqual({});
    expect(parseShardUrls("")).toEqual({});
    expect(parseShardUrls("   ")).toEqual({});
  });

  it("parses shardId=baseUrl pairs and strips trailing slashes", () => {
    expect(
      parseShardUrls("0=http://bot-0:3000,1=http://bot-1:3000/"),
    ).toEqual({ 0: "http://bot-0:3000", 1: "http://bot-1:3000" });
  });

  it("throws on a missing '='", () => {
    expect(() => parseShardUrls("http://bot-0:3000")).toThrow(/SHARD_URLS/);
  });

  it("throws on a non-integer shardId", () => {
    expect(() => parseShardUrls("x=http://bot-0:3000")).toThrow(/shardId/);
  });

  it("throws on a non-http(s) url", () => {
    expect(() => parseShardUrls("0=ftp://bot-0")).toThrow(/http/);
  });
});

describe("decideForward", () => {
  const urls = { 0: "http://bot-0:3000", 1: "http://bot-1:3000" };
  // Guild ids whose owning shard (for totalShards=2) is known:
  //   (id >> 22) % 2.  We pick two with opposite parity.
  const guildOnShard0 = "750000000000000000"; // (>>22)%2 === 0
  const guildOnShard1 = "750000000004194304"; // +2^22 → %2 === 1

  it("does not forward in single-shard mode", () => {
    const d = decideForward(guildOnShard1, {
      shardId: 0,
      totalShards: 1,
      urls,
      hmacSecret: "s",
    });
    expect(d).toEqual({ forward: false, reason: "single-shard" });
  });

  it("does not forward when this shard owns the guild", () => {
    const d = decideForward(guildOnShard0, {
      shardId: 0,
      totalShards: 2,
      urls,
      hmacSecret: "s",
    });
    expect(d).toEqual({ forward: false, reason: "mine" });
  });

  it("forwards to the owning shard's base url", () => {
    const d = decideForward(guildOnShard1, {
      shardId: 0,
      totalShards: 2,
      urls,
      hmacSecret: "s",
    });
    expect(d).toEqual({
      forward: true,
      shardId: 1,
      baseUrl: "http://bot-1:3000",
    });
  });

  it("does not forward when the owning shard has no SHARD_URLS entry", () => {
    const d = decideForward(guildOnShard1, {
      shardId: 0,
      totalShards: 2,
      urls: { 0: "http://bot-0:3000" },
      hmacSecret: "s",
    });
    expect(d).toEqual({ forward: false, reason: "no-target", shardId: 1 });
  });

  it("does not forward when no shared secret is configured", () => {
    const d = decideForward(guildOnShard1, {
      shardId: 0,
      totalShards: 2,
      urls,
      hmacSecret: null,
    });
    expect(d).toEqual({ forward: false, reason: "no-secret", shardId: 1 });
  });
});

describe("forwardToShard", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = originalFetch;
  });

  it("signs + POSTs the body and returns the owning shard's status+body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seenUrl = String(input);
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await forwardToShard(
      { forward: true, shardId: 1, baseUrl: "http://bot-1:3000" },
      "shared-secret",
      SHARD_REPLAY_PATH,
      { path: "/api/plugin/members.get", body: {}, authorization: "Bearer t" },
    );
    expect(seenUrl).toBe(`http://bot-1:3000${SHARD_REPLAY_PATH}`);
    expect(seenHeaders["x-karyl-signature"]).toBeTruthy();
    expect(seenHeaders["x-karyl-timestamp"]).toBeTruthy();
    expect(result).toEqual({ status: 200, body: { members: [] } });
  });
});

describe("shard replay route", () => {
  let server: FastifyInstance;
  const SECRET = "test-shard-secret";

  afterEach(async () => {
    if (server) await server.close();
  });

  async function buildServer(secret: string | null) {
    const s = Fastify();
    // Stub the RPC handler the replay re-injects into.
    s.post("/api/plugin/echo", async (request) => {
      return {
        ok: true,
        replayed: request.headers[SHARD_REPLAYED_HEADER] ?? null,
        auth: request.headers.authorization ?? null,
        body: request.body ?? null,
      };
    });
    await registerShardForwardRoutes(s, {
      secrets: () => (secret ? [secret] : []),
    });
    await s.ready();
    return s;
  }

  function sign(path: string, body: string) {
    return buildOutboundSignatureHeaders(SECRET, "POST", path, body);
  }

  it("503s when no shared secret is configured", async () => {
    server = await buildServer(null);
    const res = await server.inject({
      method: "POST",
      url: SHARD_REPLAY_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(503);
  });

  it("401s on a bad signature", async () => {
    server = await buildServer(SECRET);
    const res = await server.inject({
      method: "POST",
      url: SHARD_REPLAY_PATH,
      headers: {
        "content-type": "application/json",
        "x-karyl-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-karyl-signature": "deadbeef",
      },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
  });

  it("verifies the signature, re-injects the original RPC, relays its response", async () => {
    server = await buildServer(SECRET);
    const envelope = JSON.stringify({
      path: "/api/plugin/echo",
      body: { hello: "world" },
      authorization: "Bearer plugin-token",
    });
    const res = await server.inject({
      method: "POST",
      url: SHARD_REPLAY_PATH,
      headers: { "content-type": "application/json", ...sign(SHARD_REPLAY_PATH, envelope) },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
    const parsed = res.json();
    expect(parsed.ok).toBe(true);
    // The replayed handler saw the original auth + body and the loop-guard header.
    expect(parsed.auth).toBe("Bearer plugin-token");
    expect(parsed.replayed).toBe("1");
    expect(parsed.body).toEqual({ hello: "world" });
  });

  it("rejects a replay envelope whose path is not /api/plugin/*", async () => {
    server = await buildServer(SECRET);
    const envelope = JSON.stringify({
      path: "/api/admin/secrets",
      body: {},
      authorization: "Bearer x",
    });
    const res = await server.inject({
      method: "POST",
      url: SHARD_REPLAY_PATH,
      headers: { "content-type": "application/json", ...sign(SHARD_REPLAY_PATH, envelope) },
      payload: envelope,
    });
    expect(res.statusCode).toBe(400);
  });
});
