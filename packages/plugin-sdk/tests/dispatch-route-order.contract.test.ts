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
});
