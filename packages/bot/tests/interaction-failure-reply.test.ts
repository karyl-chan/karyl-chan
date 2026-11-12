/**
 * replyInteractionFailure (#179) picks the one Discord call that still
 * reaches the user for the interaction's ack state, so a throw after
 * deferReply / deferUpdate never leaves them on "thinking…".
 */
import { describe, it, expect, vi } from "vitest";
import { MessageFlags, type Interaction } from "discord.js";
import { replyInteractionFailure } from "../src/modules/command-system/interaction-failure-reply.js";
import { t } from "../src/i18n/index.js";

interface Ack {
  replied?: boolean;
  deferred?: boolean;
  /** discord.js: boolean after deferReply / reply, null after deferUpdate. */
  ephemeral?: boolean | null;
}

function fake(
  kind: "command" | "modal" | "component" | "autocomplete",
  ack: Ack = {},
) {
  const reply = vi.fn(async () => {});
  const editReply = vi.fn(async () => {});
  const followUp = vi.fn(async () => {});
  const interaction = {
    locale: "en-US",
    guildLocale: null,
    isRepliable: () => kind !== "autocomplete",
    isModalSubmit: () => kind === "modal",
    replied: ack.replied ?? false,
    deferred: ack.deferred ?? false,
    ephemeral: ack.ephemeral ?? null,
    reply,
    editReply,
    followUp,
  } as unknown as Interaction;
  return { interaction, reply, editReply, followUp };
}

const COMMAND_FAILED = t("en", "common.command-failed");
const MODAL_FAILED = t("en", "common.modal-failed");

describe("replyInteractionFailure", () => {
  it("replies ephemerally when nothing was acked yet", async () => {
    const f = fake("command");
    await replyInteractionFailure(f.interaction);
    expect(f.reply).toHaveBeenCalledWith({
      content: COMMAND_FAILED,
      flags: MessageFlags.Ephemeral,
    });
    expect(f.editReply).not.toHaveBeenCalled();
    expect(f.followUp).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "edits the placeholder after deferReply (ephemeral=%s)",
    async (ephemeral) => {
      const f = fake("command", { deferred: true, ephemeral });
      await replyInteractionFailure(f.interaction);
      expect(f.editReply).toHaveBeenCalledWith({ content: COMMAND_FAILED });
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.followUp).not.toHaveBeenCalled();
    },
  );

  it("follows up ephemerally after deferUpdate, leaving the component's message alone", async () => {
    const f = fake("component", { deferred: true, ephemeral: null });
    await replyInteractionFailure(f.interaction);
    expect(f.followUp).toHaveBeenCalledWith({
      content: COMMAND_FAILED,
      flags: MessageFlags.Ephemeral,
    });
    expect(f.editReply).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("uses the modal failure line for a modal submit", async () => {
    const f = fake("modal", { deferred: true, ephemeral: true });
    await replyInteractionFailure(f.interaction);
    expect(f.editReply).toHaveBeenCalledWith({ content: MODAL_FAILED });
  });

  it("sends nothing when the interaction was already replied", async () => {
    const f = fake("command", {
      replied: true,
      deferred: true,
      ephemeral: true,
    });
    await replyInteractionFailure(f.interaction);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.editReply).not.toHaveBeenCalled();
    expect(f.followUp).not.toHaveBeenCalled();
  });

  it("does nothing for a non-repliable interaction (autocomplete)", async () => {
    const f = fake("autocomplete");
    await replyInteractionFailure(f.interaction);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("swallows a failing Discord call (token may be gone)", async () => {
    const f = fake("command", { deferred: true, ephemeral: true });
    f.editReply.mockRejectedValueOnce(new Error("Unknown interaction"));
    await expect(
      replyInteractionFailure(f.interaction),
    ).resolves.toBeUndefined();
  });
});
