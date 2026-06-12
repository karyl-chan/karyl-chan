/**
 * Provider-side (bot) contract test against the canonical wire-contract
 * fixtures.
 *
 * SINGLE SOURCE OF TRUTH: the fixtures JSON lives in the plugin-sdk
 * package (`packages/plugin-sdk/tests/contract/contract-fixtures.json`).
 * This test reads THAT file at runtime — there is no second copy — so
 * the bot (provider) and the SDK (consumer) assert against byte-identical
 * literals. If either side's implementation drifts from the agreed
 * contract, that side's test goes red:
 *
 *   - bot HMAC scheme drift  → `signBody` no longer reproduces golden hex
 *   - bot stream-key drift   → producer XADD key no longer matches
 *   - bot RPC route renamed  → the SDK-called path is no longer served
 *   - bot stops emitting an event the SDK declares canonical
 *   - register/dispatch envelope field renamed
 *
 * Pure: no live Discord, no Redis, no network.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  signBody,
  verifyInboundSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  REPLAY_WINDOW_SECONDS,
} from "../src/utils/hmac.js";
import { RedisStreamsPluginEventBus } from "../src/adapters/redis/plugin-event-bus.js";
import type { RedisLike } from "../src/adapters/redis/client.js";

// ─── Load the canonical cross-package fixtures ──────────────────────────────
// The bot test file lives at packages/bot/tests/; the SDK fixtures at
// packages/plugin-sdk/tests/contract/. Resolve relative to THIS file so
// cwd doesn't matter. vitest runs the TS directly (no compile-dir indirection).
interface ContractFixtures {
  hmac: {
    signatureHeader: string;
    timestampHeader: string;
    nonceHeader: string;
    replayWindowSeconds: number;
    golden: Array<{
      name: string;
      secret: string;
      method: string;
      path: string;
      ts: string;
      body: string;
      nonce: string;
      expectedHex: string;
    }>;
  };
  streams: {
    streamPrefix: string;
    dlqSuffix: string;
    fields: string[];
    samples: Array<{ pluginKey: string; streamKey: string; dlqKey: string }>;
  };
  events: { canonical: string[] };
  dispatchEnvelope: { httpBodyKeys: string[] };
  rpc: { pathsCalledBySdk: string[] };
  register: {
    requiredResponseFields: string[];
    optionalResponseFields: string[];
    heartbeatEndpoint: string;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(
  here,
  "../../plugin-sdk/tests/contract/contract-fixtures.json",
);
const fixtures = JSON.parse(
  readFileSync(FIXTURES_PATH, "utf8"),
) as ContractFixtures;

// Bot route source — scanned for path literals so a renamed/removed
// provider route is caught without spinning Fastify + a live Discord
// client. Reading source is intentional: it pins the registered path
// strings, which is exactly the contract surface.
const RPC_ROUTES_SRC = readFileSync(
  resolve(here, "../src/modules/plugin-system/plugin-rpc-routes.ts"),
  "utf8",
);
const VOICE_RPC_SRC = readFileSync(
  resolve(here, "../src/modules/voice/voice-rpc.ts"),
  "utf8",
);
const PROVIDER_SRC = RPC_ROUTES_SRC + "\n" + VOICE_RPC_SRC;

// Bot's outbound-event dispatch source — emits the canonical event
// strings via dispatchEventToPlugins("…", …). These live in the runtime
// gateway-event module (split out of main.ts).
const BOT_MAIN_SRC = readFileSync(
  resolve(here, "../src/runtime/discord-runtime-events.ts"),
  "utf8",
);

// Bot's register route — response field names the SDK client consumes.
const REGISTER_SRC = readFileSync(
  resolve(here, "../src/modules/plugin-system/plugin-routes.ts"),
  "utf8",
);

describe("contract: hmac headers + window (bot side)", () => {
  it("bot signature header matches the contract", () => {
    expect(SIGNATURE_HEADER).toBe(fixtures.hmac.signatureHeader);
  });
  it("bot timestamp header matches the contract", () => {
    expect(TIMESTAMP_HEADER).toBe(fixtures.hmac.timestampHeader);
  });
  it("bot replay window matches the contract", () => {
    expect(REPLAY_WINDOW_SECONDS).toBe(fixtures.hmac.replayWindowSeconds);
  });
});

describe("contract: bot signBody reproduces golden hex", () => {
  for (const g of fixtures.hmac.golden) {
    it(`signBody() matches golden for '${g.name}'`, () => {
      expect(signBody(g.secret, g.method, g.path, g.ts, g.nonce, g.body)).toBe(
        g.expectedHex,
      );
    });

    it(`verifyInboundSignature accepts the golden signature for '${g.name}'`, () => {
      const headers = new Headers({
        [fixtures.hmac.timestampHeader]: g.ts,
        [fixtures.hmac.nonceHeader]: g.nonce,
        [fixtures.hmac.signatureHeader]: g.expectedHex,
      });
      const result = verifyInboundSignature(
        g.secret,
        headers,
        g.body,
        Number(g.ts), // now == ts so the timestamp is fresh
        g.method,
        g.path,
      );
      expect(result.ok).toBe(true);
    });

    it(`verifyInboundSignature rejects a tampered body for '${g.name}'`, () => {
      const headers = new Headers({
        [fixtures.hmac.timestampHeader]: g.ts,
        [fixtures.hmac.nonceHeader]: g.nonce,
        [fixtures.hmac.signatureHeader]: g.expectedHex,
      });
      const result = verifyInboundSignature(
        g.secret,
        headers,
        g.body + "X",
        Number(g.ts),
        g.method,
        g.path,
      );
      expect(result.ok).toBe(false);
    });
  }
});

// ─── Streams producer key convention ────────────────────────────────────────
interface XaddCall {
  key: string;
  args: Array<string | number>;
}
function makeXaddStub(): { client: RedisLike; calls: XaddCall[] } {
  const calls: XaddCall[] = [];
  const client = {
    async get() {
      return null;
    },
    async set() {
      return "OK";
    },
    async del() {
      return 0;
    },
    async xadd(
      this: void,
      key: string,
      ...args: Array<string | number>
    ): Promise<unknown> {
      calls.push({ key, args });
      return "0-1";
    },
  } as unknown as RedisLike;
  return { client, calls };
}

describe("contract: streams producer key convention (bot side)", () => {
  for (const s of fixtures.streams.samples) {
    it(`producer XADDs to '${s.pluginKey}'s mailbox per the contract`, async () => {
      const { client, calls } = makeXaddStub();
      new RedisStreamsPluginEventBus(client).dispatchToPlugin(
        1,
        s.pluginKey,
        "guild.message_create",
        { a: 1 },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(calls.length).toBe(1);
      expect(calls[0].key).toBe(s.streamKey);
      // The DLQ key is the SDK-consumer's derivation off this same
      // stream key + suffix; assert the contract's dlqKey is consistent
      // with what the producer wrote so the two halves agree.
      expect(s.dlqKey).toBe(s.streamKey + fixtures.streams.dlqSuffix);
    });
  }

  it("producer fields include every contract field name", async () => {
    const { client, calls } = makeXaddStub();
    new RedisStreamsPluginEventBus(client).dispatchToPlugin(
      1,
      "my-plugin",
      "guild.message_create",
      { x: 1 },
    );
    await new Promise((r) => setTimeout(r, 5));
    const args = calls[0].args;
    const fieldNames = new Set<string>();
    // Fields start after MAXLEN ~ N *  (index 4), as name/value pairs.
    for (let i = 4; i < args.length; i += 2) fieldNames.add(String(args[i]));
    for (const f of fixtures.streams.fields) {
      expect(fieldNames.has(f)).toBe(true);
    }
  });
});

describe("contract: bot serves every RPC path the SDK calls", () => {
  for (const path of fixtures.rpc.pathsCalledBySdk) {
    it(`provider registers a route for '${path}'`, () => {
      // The path appears as a string literal in the route registration
      // (server.post("<path>", …)). A rename/removal fails this.
      expect(PROVIDER_SRC.includes(`"${path}"`)).toBe(true);
    });
  }
});

describe("contract: bot emits every canonical event the SDK declares", () => {
  for (const evt of fixtures.events.canonical) {
    it(`bot dispatch path references '${evt}'`, () => {
      expect(BOT_MAIN_SRC.includes(`"${evt}"`)).toBe(true);
    });
  }
});

describe("contract: register response envelope", () => {
  it("register route is the contract endpoint", () => {
    expect(REGISTER_SRC.includes('"/api/plugins/register"')).toBe(true);
  });
  for (const field of [
    ...fixtures.register.requiredResponseFields,
    ...fixtures.register.optionalResponseFields,
  ]) {
    it(`register response includes '${field}'`, () => {
      // Fields are written as object keys (`token:`, `dispatchHmacKey:`)
      // or shorthand in the register handler's return literal.
      const re = new RegExp(`\\b${field}\\b\\s*[:,}]`);
      expect(re.test(REGISTER_SRC)).toBe(true);
    });
  }
  it("heartbeat endpoint matches the contract", () => {
    expect(REGISTER_SRC.includes(fixtures.register.heartbeatEndpoint)).toBe(
      true,
    );
  });
});

describe("contract: dispatch envelope shape", () => {
  it("bot HTTP event dispatch carries the contract body keys", () => {
    // plugin-event-bridge.service.ts builds JSON.stringify({ type, data }).
    const bridge = readFileSync(
      resolve(
        here,
        "../src/modules/plugin-system/plugin-event-bridge.service.ts",
      ),
      "utf8",
    );
    expect(bridge.includes("{ type: eventType, data }")).toBe(true);
    expect(fixtures.dispatchEnvelope.httpBodyKeys).toContain("type");
    expect(fixtures.dispatchEnvelope.httpBodyKeys).toContain("data");
  });
});
