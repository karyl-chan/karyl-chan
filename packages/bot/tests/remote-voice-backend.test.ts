/**
 * RemoteVoiceBackend (PR-2.3d) — control-plane HTTP client to the voice
 * service. Verifies the signed POST shape, the 429 → VoiceCapacityError
 * mapping, and that non-2xx surfaces as a generic error. fetch is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RemoteVoiceBackend } from "../src/modules/voice/remote-voice-backend.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/utils/hmac.js";
import { VoiceCapacityError } from "@karyl-chan/voice";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(status: number, json: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as typeof fetch;
  return calls;
}

describe("RemoteVoiceBackend", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("signs the request and posts to the join endpoint", async () => {
    const calls = stubFetch(200, { connected: true, channelId: "c1" });
    const backend = new RemoteVoiceBackend({
      serviceUrl: "http://voice:4000/",
      secret: "s",
    });
    const status = await backend.join({ guildId: "g1", channelId: "c1" });
    expect(status.connected).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://voice:4000/internal/voice/join");
    expect(calls[0].headers[SIGNATURE_HEADER]).toBeTruthy();
    expect(calls[0].headers[TIMESTAMP_HEADER]).toBeTruthy();
    expect(JSON.parse(calls[0].body)).toEqual({
      guildId: "g1",
      channelId: "c1",
    });
  });

  it("maps 429 to VoiceCapacityError", async () => {
    stubFetch(429, { error: "voice capacity reached" });
    const backend = new RemoteVoiceBackend({
      serviceUrl: "http://voice:4000",
      secret: "s",
    });
    await expect(
      backend.join({ guildId: "g1", channelId: "c1" }),
    ).rejects.toBeInstanceOf(VoiceCapacityError);
  });

  it("surfaces other non-2xx as a generic error", async () => {
    stubFetch(409, { error: "not joined" });
    const backend = new RemoteVoiceBackend({
      serviceUrl: "http://voice:4000",
      secret: "s",
    });
    await expect(backend.play("g1", "http://x/a.mp3")).rejects.toThrow(/409/);
  });

  it("status round-trips the service body", async () => {
    stubFetch(200, { connected: false, channelId: null, playing: false });
    const backend = new RemoteVoiceBackend({
      serviceUrl: "http://voice:4000",
      secret: "s",
    });
    const s = await backend.status("g1");
    expect(s.connected).toBe(false);
  });
});
