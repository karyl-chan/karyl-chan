/**
 * The `bot` Client is a module-level singleton reused across
 * resetBot() → run() restarts, and discord.js Client.destroy() does NOT
 * remove listeners. So the per-run bootstrap functions must be idempotent —
 * a restart (after a transient startup failure) must not stack a second copy
 * of every handler (which would fire each Discord event twice).
 */
import { vi, describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.VOICE_SERVICE_URL = "http://voice.test:4000";
  process.env.VOICE_HMAC_SECRET = "x".repeat(32);
});

import type { Client } from "discord.js";
import { bootstrapEventHandlers } from "../src/bootstrap-events.js";
import { installVoiceGatewayRelay } from "../src/modules/voice/voice-gateway-relay.js";

describe("bootstrap idempotency (resetBot → run restart safety)", () => {
  it("bootstrapEventHandlers registers handlers once across repeated calls", () => {
    const on = vi.fn();
    const once = vi.fn();
    const client = { on, once } as unknown as Client;

    bootstrapEventHandlers(client);
    const afterFirst = on.mock.calls.length + once.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0); // sanity: it registered something

    bootstrapEventHandlers(client);
    const afterSecond = on.mock.calls.length + once.mock.calls.length;
    // The second call must be a no-op — on main it doubled the listeners.
    expect(afterSecond).toBe(afterFirst);
  });

  it("installVoiceGatewayRelay adds the raw listener once across repeated calls", () => {
    const on = vi.fn();
    const bot = { on, user: { id: "1" } } as unknown as Client;

    installVoiceGatewayRelay(bot);
    installVoiceGatewayRelay(bot);

    const rawListeners = on.mock.calls.filter((c) => c[0] === "raw").length;
    // On main, the second install stacked a second "raw" listener →
    // every VOICE_STATE/SERVER_UPDATE relayed twice.
    expect(rawListeners).toBe(1);
  });
});
