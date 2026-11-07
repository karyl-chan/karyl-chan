/**
 * #162 — `/voice play` runs the public-media host policy on the URL
 * before handing it to the voice backend (ffmpeg), the same policy the
 * plugin `voice.play` RPC applies. The host policy is the real one; DNS
 * (`dns/promises.lookup`) and the voice backend are stubbed, and the
 * in-process registry is stubbed only to capture the command handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { lookup } from "dns/promises";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { FAILED_COLOR, SUCCEEDED_COLOR } from "../src/utils/constant.js";

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

// The command module must load after the mocks above apply.
const { registerVoiceCommands } = await import(
  "../src/modules/builtin-features/voice/voice.commands.js"
);

registerVoiceCommands();

interface Reply {
  embeds: Array<{ description: string; color: number }>;
}

/**
 * Run `/voice play <url>` and return the one message the user ends up
 * seeing: the deferred reply's edit. The reply is deferred (ephemeral)
 * before any network work, so the 3-second interaction deadline holds.
 */
async function runPlay(url: string): Promise<Reply> {
  const reply = vi.fn(async () => {});
  const deferReply = vi.fn(async () => {});
  const editReply = vi.fn<(r: Reply) => Promise<void>>(async () => {});
  const interaction = {
    guildId: "g1",
    locale: "en-US",
    guildLocale: null,
    options: {
      getSubcommand: () => "play",
      getString: () => url,
    },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  await registered.handler!(interaction);
  expect(reply).not.toHaveBeenCalled();
  expect(deferReply).toHaveBeenCalledWith({ flags: "Ephemeral" });
  expect(editReply).toHaveBeenCalledTimes(1);
  return editReply.mock.calls[0][0];
}

const REFUSED = en.voice["url-not-allowed"];

/** Refused with the localized embed, and playback never reached. */
function expectRefused(r: Reply): void {
  expect(play).not.toHaveBeenCalled();
  expect(r.embeds[0]).toEqual({ description: REFUSED, color: FAILED_COLOR });
}

const BACKSLASH = "\\";

beforeEach(() => {
  play.mockReset();
  play.mockResolvedValue({ playerStatus: "playing" });
  vi.mocked(lookup).mockReset();
});

describe("/voice play host policy", () => {
  it.each([
    ["cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["RFC1918", "http://10.0.0.5/a.mp3"],
    ["loopback", "http://127.0.0.1:8080/a.mp3"],
    ["IPv6 link-local", "http://[fe80::1]/a.mp3"],
    ["metadata hostname", "http://metadata.google.internal/computeMetadata/v1/"],
    ["backslash-smuggled loopback", `http://127.0.0.1${BACKSLASH}@8.8.8.8/`],
    ["tab-split loopback", "http://127.0.\t0.1/a.mp3"],
  ])("refuses a %s target without invoking playback", async (_label, url) => {
    expectRefused(await runPlay(url));
  });

  it("refuses a hostname that resolves to a private address", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "192.168.1.10", family: 4 },
    ] as never);
    expectRefused(await runPlay("https://sneaky.example.com/a.mp3"));
  });

  it("refuses a hostname that does not resolve", async () => {
    vi.mocked(lookup).mockRejectedValue(new Error("ENOTFOUND"));
    expectRefused(await runPlay("https://nowhere.example/a.mp3"));
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

  // ffmpeg splits the authority on `/?#` only, so a raw `\@` would make
  // it connect to the host after the `@` — not the one that was vetted.
  // The vetted, WHATWG-normalized href is what reaches playback.
  it("hands playback the normalized URL, not a backslash-smuggled raw string", async () => {
    const r = await runPlay(`http://8.8.8.8${BACKSLASH}@127.0.0.1/`);
    expect(play).toHaveBeenCalledWith("g1", "http://8.8.8.8/@127.0.0.1/");
    expect(r.embeds[0].description).toContain("http://8.8.8.8/@127.0.0.1/");
  });

  it("hands playback the normalized URL with inner tabs stripped", async () => {
    await runPlay("http://8.8.8.8/a\tb.mp3");
    expect(play).toHaveBeenCalledWith("g1", "http://8.8.8.8/ab.mp3");
  });

  it("does not defer for a URL refused before any network work", async () => {
    const reply = vi.fn<(r: Reply) => Promise<void>>(async () => {});
    const deferReply = vi.fn(async () => {});
    const interaction = {
      guildId: "g1",
      locale: "en-US",
      guildLocale: null,
      options: { getSubcommand: () => "play", getString: () => "ftp://x/a" },
      reply,
      deferReply,
    } as unknown as ChatInputCommandInteraction;
    await registered.handler!(interaction);
    expect(deferReply).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].embeds[0].description).toBe(
      en.voice["http-only"],
    );
  });
});
