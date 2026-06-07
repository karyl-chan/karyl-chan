/**
 * VoiceBackend seam (PR-2.3 segment 1).
 *
 * Verifies the backend-selection registry: in-process by default (single
 * machine unchanged), fail-loud when VOICE_SERVICE_URL points at the
 * not-yet-built remote backend, and the in-process backend's "no client"
 * guard. Real voice (VoiceConnection/ffmpeg) is not exercised — that needs
 * a live Discord voice channel and is out of scope for a unit test.
 */

import { beforeEach, describe, expect, it } from "vitest";

// config (transitively imported by voice-manager) requires BOT_TOKEN.
process.env.BOT_TOKEN ??= "test-token";

const load = () => import("../src/modules/voice/voice-backend.js");

describe("VoiceBackend registry", () => {
  beforeEach(async () => {
    delete process.env.VOICE_SERVICE_URL;
    (await load()).resetVoiceBackendForTest();
  });

  it("defaults to the in-process backend", async () => {
    const { getVoiceBackend, InProcessVoiceBackend } = await load();
    expect(getVoiceBackend()).toBeInstanceOf(InProcessVoiceBackend);
  });

  it("memoises the backend instance", async () => {
    const { getVoiceBackend } = await load();
    expect(getVoiceBackend()).toBe(getVoiceBackend());
  });

  it("fails loud when VOICE_SERVICE_URL is set (remote backend not yet built)", async () => {
    const { getVoiceBackend, resetVoiceBackendForTest } = await load();
    resetVoiceBackendForTest();
    process.env.VOICE_SERVICE_URL = "http://voice:4000";
    expect(() => getVoiceBackend()).toThrow(/not yet implemented/i);
  });

  it("in-process join rejects when no bot client is wired", async () => {
    const { InProcessVoiceBackend } = await load();
    const backend = new InProcessVoiceBackend(() => null);
    await expect(
      backend.join({ guildId: "1", channelId: "2" }),
    ).rejects.toThrow(/bot client unavailable/i);
  });
});
