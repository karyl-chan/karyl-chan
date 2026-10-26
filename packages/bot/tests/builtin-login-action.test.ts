/**
 * The system login never speaks in a guild channel (#140, defence in
 * depth). Its message trigger can only be a bot DM (the model refuses
 * anything else) and its command reply is ephemeral; were it ever run on a
 * guild message, nothing - the link, a refusal or a failure - may show in
 * the channel, or onlookers would learn who is an admin.
 */
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
vi.mock("../src/modules/admin/admin-login.service.js", () => ({
  mintLoginLink: vi.fn(),
}));

import { ChannelType } from "discord.js";
import { mintLoginLink } from "../src/modules/admin/admin-login.service.js";
import { runLoginAction } from "../src/modules/command-system/builtin-login-action.js";

const LINK = {
  ok: true,
  url: "https://admin.example/admin/auth?token=t",
  minutesUntilExpiry: 5,
  role: "owner",
};

function guildMessage() {
  const channelSend = vi.fn(async () => {});
  const authorSend = vi.fn(async () => {});
  const message = {
    id: "M1",
    guildId: "G1",
    guild: { preferredLocale: "en-US" },
    channel: { id: "C1", type: ChannelType.GuildText, send: channelSend },
    author: { id: "U1", send: authorSend },
  };
  return { target: { kind: "message" as const, message: message as never }, channelSend, authorSend };
}

beforeEach(() => {
  vi.mocked(mintLoginLink).mockReset();
});

describe("runLoginAction on a guild message", () => {
  it("sends the link to the author's DMs only", async () => {
    vi.mocked(mintLoginLink).mockResolvedValue(LINK as never);
    const { target, channelSend, authorSend } = guildMessage();
    await runLoginAction(target);
    expect(channelSend).not.toHaveBeenCalled();
    const sent = (authorSend as Mock).mock.calls[0][0] as {
      components: Array<{ components: Array<{ url: string }> }>;
    };
    expect(sent.components[0].components[0].url).toBe(LINK.url);
  });

  it("says nothing anywhere when that DM fails", async () => {
    vi.mocked(mintLoginLink).mockResolvedValue(LINK as never);
    const { target, channelSend, authorSend } = guildMessage();
    authorSend.mockRejectedValue(new Error("Cannot send messages to this user"));
    await runLoginAction(target);
    expect(channelSend).not.toHaveBeenCalled();
    expect(authorSend).toHaveBeenCalledTimes(1);
  });

  it("tells only the author, privately, when minting the link fails", async () => {
    vi.mocked(mintLoginLink).mockRejectedValue(new Error("jwt not ready"));
    const { target, channelSend, authorSend } = guildMessage();
    await runLoginAction(target);
    expect(channelSend).not.toHaveBeenCalled();
    expect(((authorSend as Mock).mock.calls[0][0] as { content: string }).content).toMatch(/couldn't be completed/);
  });

  it("says nothing at all to someone who is not authorised", async () => {
    vi.mocked(mintLoginLink).mockResolvedValue({ ok: false, reason: "not authorized" });
    const { target, channelSend, authorSend } = guildMessage();
    await runLoginAction(target);
    expect(channelSend).not.toHaveBeenCalled();
    expect(authorSend).not.toHaveBeenCalled();
  });
});
