/**
 * PM-1 — lock the gateway event wiring after the main.ts → src/runtime/*
 * split. registerRuntimeEvents() must attach exactly the same set of
 * Discord client listeners that used to be registered inline in main.ts.
 * A behaviour-preserving refactor that silently drops one of these (e.g.
 * the `raw` DM-rehydrate fallback, or a reaction handler) would otherwise
 * pass build + typecheck but break at runtime — which this sandbox can't
 * smoke-test against a live gateway.
 */
import { vi, describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

import { createBotClient } from "../src/runtime/discord-client.js";
import { registerRuntimeEvents } from "../src/runtime/discord-runtime-events.js";
import type { RuntimeContext } from "../src/runtime/context.js";

/** Build a ctx with a real (un-logged-in) client; the singletons are
 *  only touched inside handler bodies, which this test never fires. */
function makeCtx(): RuntimeContext {
  const bot = createBotClient();
  return {
    bot,
    webhookForwarder: {},
    interactionDispatcher: {},
    commandReconciler: {},
    messageMatcher: {},
    shuttingDown: false,
    dbReady: false,
    webServer: null,
    sessionStore: null,
  } as unknown as RuntimeContext;
}

describe("registerRuntimeEvents", () => {
  it("attaches exactly the expected gateway listeners", () => {
    const ctx = makeCtx();
    // Nothing wired before the call.
    for (const evt of ["ready", "messageCreate", "raw"] as const) {
      expect(ctx.bot.listenerCount(evt)).toBe(0);
    }

    registerRuntimeEvents(ctx);

    // Every handler main.ts used to register, now once via the runtime.
    const expected = [
      "ready",
      "guildCreate",
      "guildDelete",
      "interactionCreate",
      "messageCreate",
      "messageReactionAdd",
      "messageReactionRemove",
      "raw",
    ] as const;
    for (const evt of expected) {
      expect(ctx.bot.listenerCount(evt)).toBe(1);
    }
  });
});
