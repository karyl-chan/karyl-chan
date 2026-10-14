/**
 * Route-order contract for the bot's dispatch probe (PM-7.9.4).
 *
 * The bot's signed probe POSTs a user-less payload to
 * /commands/:commandName and reads the verdict off the response:
 *
 *   401                      → signature rejected (scheme mismatch)
 *   400 "missing user.id"    → signature gate PASSED, handler lookup
 *                              never reached
 *
 * That inference is only sound while every 400 in this route sits
 * AFTER verifyDispatchAuth and while the post-auth 400 bodies keep
 * their marker strings (the bot matches "missing user.id" /
 * "command_name mismatch" — see the bot's isSdkPostAuth400). These
 * tests pin both properties; if you reorder validation or reword the
 * bodies, the bot's probe classifier must move in lockstep.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginServer } from "../src/server.js";
import {
  sign,
  generateNonce,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from "../src/hmac.js";

const KEY = "k".repeat(64);
const PROBE_PATH = "/commands/kc-dispatch-probe";
const PROBE_BODY = JSON.stringify({
  command_name: "kc-dispatch-probe",
  probe: true,
});

function makeServer() {
  return createPluginServer({
    pluginKey: "probe-contract",
    botUrl: "http://bot.invalid",
    getToken: () => null,
    getDispatchHmacKey: () => KEY,
    // Zero commands on purpose: the route must exist (and the
    // signature gate must run) even for a plugin with no handlers.
    pluginCommands: [],
  });
}

function signedHeaders(path: string, body: string, secret = KEY) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();
  return {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: sign(secret, "POST", path, ts, nonce, body),
    [TIMESTAMP_HEADER]: ts,
    [NONCE_HEADER]: nonce,
  };
}

describe("dispatch probe route-order contract", () => {
  it("correctly signed user-less payload → 400 'missing user.id' (post-auth marker)", async () => {
    const server = makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY),
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /missing user\.id/);
    } finally {
      await server.close();
    }
  });

  it("bad signature with the same payload → 401 (auth gate fires FIRST)", async () => {
    const server = makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY, "x".repeat(64)),
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await server.close();
    }
  });

  it("command_name mismatch 400 also sits after the gate and keeps its marker", async () => {
    const server = makeServer();
    try {
      const body = JSON.stringify({ command_name: "other-name" });
      const res = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: body,
        headers: signedHeaders(PROBE_PATH, body),
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /command_name mismatch/);
    } finally {
      await server.close();
    }
  });

  it("unregistered (no dispatch key) → 503 with the awaiting-register marker", async () => {
    const server = createPluginServer({
      pluginKey: "probe-contract",
      botUrl: "http://bot.invalid",
      getToken: () => null,
      getDispatchHmacKey: () => null,
      pluginCommands: [],
    });
    try {
      const res = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY),
      });
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /dispatch HMAC key/);
    } finally {
      await server.close();
    }
  });

  it("authenticates first, then refuses a valid dispatch until ready", async () => {
    let state: "initializing" | "ready" = "initializing";
    const server = createPluginServer({
      pluginKey: "probe-contract",
      botUrl: "http://bot.invalid",
      getToken: () => "token",
      getDispatchHmacKey: () => KEY,
      getLifecycleState: () => state,
      pluginCommands: [],
    });
    try {
      const bad = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY, "x".repeat(64)),
      });
      assert.equal(bad.statusCode, 401, "bad HMAC must fail before readiness");

      const initializing = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY),
      });
      assert.equal(initializing.statusCode, 503);
      assert.deepEqual(initializing.json(), {
        error: "plugin is not ready for dispatch",
        state: "initializing",
      });

      state = "ready";
      const ready = await server.inject({
        method: "POST",
        url: PROBE_PATH,
        payload: PROBE_BODY,
        headers: signedHeaders(PROBE_PATH, PROBE_BODY),
      });
      assert.equal(ready.statusCode, 400);
      assert.match(ready.body, /missing user\.id/);
    } finally {
      await server.close();
    }
  });

  it("keeps liveness green while readiness and detail expose lifecycle state", async () => {
    let state: "failed" | "ready" | "serving_dark" = "failed";
    const server = createPluginServer({
      pluginKey: "probe-contract",
      botUrl: "http://bot.invalid",
      getToken: () => "token",
      getDispatchHmacKey: () => KEY,
      getLifecycleState: () => state,
      pluginCommands: [],
    });
    try {
      const live = await server.inject({ method: "GET", url: "/health" });
      assert.equal(live.statusCode, 200);

      const notReady = await server.inject({
        method: "GET",
        url: "/health/ready",
      });
      assert.equal(notReady.statusCode, 503);
      assert.equal(notReady.json().state, "failed");

      const detail = await server.inject({
        method: "GET",
        url: "/health/detail",
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().status, "unhealthy");
      assert.equal(detail.json().lifecycleState, "failed");

      state = "serving_dark";
      const dark = await server.inject({
        method: "GET",
        url: "/health/detail",
      });
      assert.equal(dark.statusCode, 200);
      assert.equal(dark.json().status, "degraded");
      assert.equal(dark.json().lifecycleState, "serving_dark");
      assert.match(dark.json().message, /setup secret is not configured/);

      state = "ready";
      const ready = await server.inject({
        method: "GET",
        url: "/health/ready",
      });
      assert.equal(ready.statusCode, 200);
      assert.equal(ready.json().state, "ready");
    } finally {
      await server.close();
    }
  });
});
