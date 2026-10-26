/**
 * ReplyRenderer (#140): one renderReply(reply, target) for both targets a
 * behavior answers.
 *
 *   interaction — a command: only the invoker sees it unless the reply says
 *     `ephemeral: false`; a deferred (ephemeral) reply that should be
 *     public goes through the plugin defer table: follow up publicly, then
 *     delete the placeholder
 *   message — a message trigger: in a DM with the bot `ephemeral` is
 *     ignored; in a guild channel the default is public and
 *     `ephemeral: true` DMs the author instead of posting in the channel
 */
import { describe, expect, it, vi } from "vitest";
import { ChannelType, MessageFlags } from "discord.js";
import { renderReply } from "../src/modules/command-system/reply-renderer.js";

function fakeInteraction(opts: { deferred?: boolean; ephemeral?: boolean } = {}) {
  return {
    deferred: opts.deferred ?? false,
    replied: false,
    ephemeral: opts.ephemeral ?? null,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => {}),
  };
}

function fakeMessage(where: "dm" | "guild") {
  const channelSend = vi.fn(async () => {});
  const authorSend = vi.fn(async () => {});
  const message = {
    guildId: where === "guild" ? "G1" : null,
    channel: {
      id: "C1",
      type: where === "guild" ? ChannelType.GuildText : ChannelType.DM,
      send: channelSend,
    },
    author: { id: "U1", send: authorSend },
  };
  return { message, channelSend, authorSend };
}

const link = { type: 1 as const, components: [{ type: 2 as const, style: 5 as const, label: "Go", url: "https://x.example" }] };

describe("renderReply — interaction target", () => {
  it("answers an un-acked command ephemerally by default", async () => {
    const ix = fakeInteraction();
    const out = await renderReply({ content: "hi", components: [link] }, { kind: "interaction", interaction: ix as never });
    expect(out).toEqual({ ok: true, via: "interaction" });
    expect(ix.reply).toHaveBeenCalledWith({
      content: "hi",
      components: [link],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  });

  it("an un-acked command with ephemeral:false answers publicly", async () => {
    const ix = fakeInteraction();
    await renderReply({ content: "hi", ephemeral: false, flags: 4096 }, { kind: "interaction", interaction: ix as never });
    expect(ix.reply).toHaveBeenCalledWith({
      content: "hi",
      allowedMentions: { parse: [] },
      flags: 4096,
    });
  });

  it("fills an ephemeral deferral in place when the reply stays private", async () => {
    const ix = fakeInteraction({ deferred: true, ephemeral: true });
    const out = await renderReply({ embeds: [{ title: "t" }], flags: 4 | 4096 }, { kind: "interaction", interaction: ix as never });
    expect(out).toEqual({ ok: true, via: "interaction" });
    // an edit can only carry SuppressEmbeds
    expect(ix.editReply).toHaveBeenCalledWith({
      embeds: [{ title: "t" }],
      allowedMentions: { parse: [] },
      flags: 4,
    });
    expect(ix.followUp).not.toHaveBeenCalled();
  });

  it("posts publicly and drops the placeholder when the reply says ephemeral:false", async () => {
    const ix = fakeInteraction({ deferred: true, ephemeral: true });
    await renderReply({ content: "for everyone", ephemeral: false }, { kind: "interaction", interaction: ix as never });
    expect(ix.followUp).toHaveBeenCalledWith({ content: "for everyone", allowedMentions: { parse: [] } });
    expect(ix.deleteReply).toHaveBeenCalledTimes(1);
    expect(ix.editReply).not.toHaveBeenCalled();
  });

  it("an empty reply removes the placeholder", async () => {
    const ix = fakeInteraction({ deferred: true, ephemeral: true });
    const out = await renderReply({}, { kind: "interaction", interaction: ix as never });
    expect(out).toEqual({ ok: true, via: "none" });
    expect(ix.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("reports a Discord refusal instead of swallowing it", async () => {
    const ix = fakeInteraction({ deferred: true, ephemeral: true });
    ix.editReply.mockRejectedValueOnce(new Error("Invalid Form Body"));
    const out = await renderReply({ content: "x" }, { kind: "interaction", interaction: ix as never });
    expect(out).toEqual({ ok: false, error: "Invalid Form Body" });
  });
});

describe("renderReply — message target", () => {
  it("answers in the DM with the bot whatever ephemeral says", async () => {
    for (const ephemeral of [undefined, true, false]) {
      const { message, channelSend, authorSend } = fakeMessage("dm");
      const out = await renderReply({ content: "pong", ephemeral }, { kind: "message", message: message as never });
      expect(out).toEqual({ ok: true, via: "channel" });
      expect(channelSend).toHaveBeenCalledWith({ content: "pong", allowedMentions: { parse: [] } });
      expect(authorSend).not.toHaveBeenCalled();
    }
  });

  it("posts in the guild channel by default", async () => {
    const { message, channelSend, authorSend } = fakeMessage("guild");
    const out = await renderReply({ content: "roger", flags: 4096 }, { kind: "message", message: message as never });
    expect(out).toEqual({ ok: true, via: "channel" });
    expect(channelSend).toHaveBeenCalledWith({ content: "roger", allowedMentions: { parse: [] }, flags: 4096 });
    expect(authorSend).not.toHaveBeenCalled();
  });

  it("DMs the author instead when a guild reply is ephemeral", async () => {
    const { message, channelSend, authorSend } = fakeMessage("guild");
    const out = await renderReply({ content: "secret", ephemeral: true }, { kind: "message", message: message as never });
    expect(out).toEqual({ ok: true, via: "dm" });
    expect(authorSend).toHaveBeenCalledWith({ content: "secret", allowedMentions: { parse: [] } });
    expect(channelSend).not.toHaveBeenCalled();
  });

  it("never falls back to the channel when the DM fails", async () => {
    const { message, channelSend, authorSend } = fakeMessage("guild");
    authorSend.mockRejectedValueOnce(new Error("Cannot send messages to this user"));
    const out = await renderReply({ content: "secret", ephemeral: true }, { kind: "message", message: message as never });
    expect(out).toEqual({ ok: false, error: "Cannot send messages to this user", dmFailed: true });
    expect(channelSend).not.toHaveBeenCalled();
  });

  it("an empty reply sends nothing", async () => {
    const { message, channelSend } = fakeMessage("guild");
    expect(await renderReply({ ephemeral: true }, { kind: "message", message: message as never })).toEqual({
      ok: true,
      via: "none",
    });
    expect(channelSend).not.toHaveBeenCalled();
  });
});
