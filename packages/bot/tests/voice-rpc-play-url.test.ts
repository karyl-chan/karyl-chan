/**
 * #162 — the plugin `voice.play` RPC hands the voice backend (ffmpeg)
 * the URL it vetted: the WHATWG-normalized href, never the raw body
 * string, which ffmpeg would parse differently (`\@` smuggling). Bare
 * Fastify with the plugin's auth injected; the host policy is the real
 * one, DNS, the plugin lookup and the voice backend are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { lookup } from "dns/promises";
import { findPluginById } from "../src/modules/plugin-system/models/plugin.model.js";
import { registerVoiceRpcRoutes } from "../src/modules/voice/voice-rpc.js";

vi.mock("dns/promises", () => ({ lookup: vi.fn() }));

vi.mock("../src/modules/plugin-system/models/plugin.model.js", () => ({
  findPluginById: vi.fn(),
}));

const play = vi.fn();
vi.mock("../src/modules/voice/voice-backend.js", () => ({
  getVoiceBackend: () => ({ play }),
  VoiceCapacityError: class VoiceCapacityError extends Error {},
}));

const PLUGIN_URL = "http://plugin-radio:3000";
const BACKSLASH = "\\";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify();
  server.addHook("onRequest", async (request) => {
    request.pluginAuth = {
      pluginId: 7,
      pluginKey: "radio",
      scopes: new Set(["voice.play"]),
      expiresAt: Date.now() + 60_000,
    } as never;
  });
  await registerVoiceRpcRoutes(server, {});
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  play.mockReset();
  play.mockResolvedValue({ playing: true });
  vi.mocked(lookup).mockReset();
  vi.mocked(findPluginById).mockResolvedValue({
    id: 7,
    enabled: true,
    status: "active",
    url: PLUGIN_URL,
  } as never);
});

function postPlay(url: string) {
  return server.inject({
    method: "POST",
    url: "/api/plugin/voice.play",
    payload: { guild_id: "g1", url },
  });
}

describe("voice.play RPC media URL", () => {
  it("hands playback the normalized URL, not a backslash-smuggled raw string", async () => {
    const res = await postPlay(`http://8.8.8.8${BACKSLASH}@127.0.0.1/`);
    expect(res.statusCode).toBe(200);
    expect(play).toHaveBeenCalledWith("g1", "http://8.8.8.8/@127.0.0.1/", {
      trustedOrigin: undefined,
    });
  });

  it("refuses a backslash-smuggled loopback target", async () => {
    const res = await postPlay(`http://127.0.0.1${BACKSLASH}@8.8.8.8/`);
    expect(res.statusCode).toBe(403);
    expect(play).not.toHaveBeenCalled();
  });

  it("hands playback the normalized URL on the plugin's own origin too, trusting only that origin", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "172.18.0.5", family: 4 },
    ] as never);
    const res = await postPlay(`${PLUGIN_URL}/internal/audio/a\tb.mp3`);
    expect(res.statusCode).toBe(200);
    expect(play).toHaveBeenCalledWith(
      "g1",
      `${PLUGIN_URL}/internal/audio/ab.mp3`,
      { trustedOrigin: PLUGIN_URL },
    );
  });
});
