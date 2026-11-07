/**
 * #162 — `/voice play` runs the public-media host policy on the URL
 * before handing it to the voice backend (ffmpeg), the same policy the
 * plugin `voice.play` RPC applies. The host policy is the real one; DNS
 * (`dns/promises.lookup`) and the voice backend are stubbed, and the
 * in-process registry is stubbed only to capture the command handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

vi.mock("dns/promises", () => ({ lookup: vi.fn() }));

const play = vi.fn();
vi.mock("../src/modules/voice/voice-backend.js", () => ({
  getVoiceBackend: () => ({ play }),
  VoiceCapacityError: class VoiceCapacityError extends Error {},
}));

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;
const registered: { handler?: Handler } = {};
vi.mock(
  "../src/modules/builtin-features/in-process-command-registry.service.js",
  () => ({
    registerInProcessCommand: (spec: { handler: Handler }) => {
      registered.handler = spec.handler;
    },
  }),
);

const { lookup } = await import("dns/promises");
const { registerVoiceCommands } = await import(
  "../src/modules/builtin-features/voice/voice.commands.js"
);
const { FAILED_COLOR, SUCCEEDED_COLOR } = await import(
  "../src/utils/constant.js"
);

registerVoiceCommands();

interface Reply {
  embeds: Array<{ description: string; color: number }>;
}

function playCommand(url: string) {
  const reply = vi.fn<(r: Reply) => Promise<void>>(async () => {});
  const interaction = {
    guildId: "g1",
    locale: "en-US",
    guildLocale: null,
    options: {
      getSubcommand: () => "play",
      getString: () => url,
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

async function runPlay(url: string): Promise<Reply> {
  const { interaction, reply } = playCommand(url);
  await registered.handler!(interaction);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0][0];
}

const REFUSED = "This URL can't be played: its host is not on the public internet or could not be resolved.";

beforeEach(() => {
  play.mockReset();
  play.mockResolvedValue({ playerStatus: "playing" });
  vi.mocked(lookup).mockReset();
});

describe("/voice play host policy", () => {
  it("refuses the cloud metadata address without invoking playback", async () => {
    const r = await runPlay("http://169.254.169.254/latest/meta-data/");
    expect(play).not.toHaveBeenCalled();
    expect(r.embeds[0]).toEqual({ description: REFUSED, color: FAILED_COLOR });
  });

  it.each([
    ["RFC1918", "http://10.0.0.5/a.mp3"],
    ["loopback", "http://127.0.0.1:8080/a.mp3"],
    ["IPv6 link-local", "http://[fe80::1]/a.mp3"],
    ["metadata hostname", "http://metadata.google.internal/computeMetadata/v1/"],
  ])("refuses a %s target without invoking playback", async (_label, url) => {
    const r = await runPlay(url);
    expect(play).not.toHaveBeenCalled();
    expect(r.embeds[0]).toEqual({ description: REFUSED, color: FAILED_COLOR });
  });

  it("refuses a hostname that resolves to a private address", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "192.168.1.10", family: 4 },
    ] as never);
    const r = await runPlay("https://sneaky.example.com/a.mp3");
    expect(play).not.toHaveBeenCalled();
    expect(r.embeds[0]).toEqual({ description: REFUSED, color: FAILED_COLOR });
  });

  it("refuses a hostname that does not resolve", async () => {
    vi.mocked(lookup).mockRejectedValue(new Error("ENOTFOUND"));
    const r = await runPlay("https://nowhere.example/a.mp3");
    expect(play).not.toHaveBeenCalled();
    expect(r.embeds[0]).toEqual({ description: REFUSED, color: FAILED_COLOR });
  });

  it("plays a public URL", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const url = "https://cdn.example.com/a.mp3";
    const r = await runPlay(url);
    expect(play).toHaveBeenCalledWith("g1", url);
    expect(r.embeds[0].color).toBe(SUCCEEDED_COLOR);
    expect(r.embeds[0].description).toContain(url);
  });
});
