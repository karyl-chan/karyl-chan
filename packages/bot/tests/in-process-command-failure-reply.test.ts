import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Interaction } from "discord.js";

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import {
  dispatchInProcessInteraction,
  registerInProcessCommand,
  registerInProcessModal,
  _resetInProcessRegistry,
} from "../src/modules/builtin-features/in-process-command-registry.service.js";
import { t } from "../src/i18n/index.js";

/**
 * When an in-process handler throws, the registry sends a best-effort
 * failure message so the interaction never hangs on Discord's
 * "thinking…" indicator (#179). Which Discord call it uses depends on
 * how far the handler got before throwing:
 *   - nothing acked yet   → reply (ephemeral)
 *   - deferReply'd        → editReply (the deferred message is the
 *                           only place the user is looking)
 *   - already replied     → leave it alone
 */

interface FakeState {
  replied: boolean;
  deferred: boolean;
}

function fakeInteraction(kind: "command" | "modal", state: FakeState) {
  const reply = vi.fn(async () => {
    state.replied = true;
  });
  const editReply = vi.fn(async () => {
    state.replied = true;
  });
  const deferReply = vi.fn(async () => {
    state.deferred = true;
  });
  const interaction = {
    locale: "en-US",
    guildLocale: null,
    guildId: null,
    user: { id: "u1" },
    commandName: "boom",
    customId: "boom-modal:tail",
    isChatInputCommand: () => kind === "command",
    isModalSubmit: () => kind === "modal",
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    reply,
    editReply,
    deferReply,
  };
  return { interaction, reply, editReply, deferReply };
}

const COMMAND_FAILED = t("en", "common.command-failed");
const MODAL_FAILED = t("en", "common.modal-failed");

describe("in-process handler failure reply", () => {
  beforeEach(() => {
    _resetInProcessRegistry();
  });

  describe("chat-input command", () => {
    function registerThrowing(
      before: (i: {
        deferReply: (o?: unknown) => Promise<void>;
        reply: (o?: unknown) => Promise<void>;
      }) => Promise<void>,
    ) {
      registerInProcessCommand({
        data: { name: "boom", description: "boom" },
        scope: "global",
        handler: async (i) => {
          await before(i as never);
          throw new Error("kaboom");
        },
      });
    }

    it("edits the deferred reply when the handler throws after deferReply", async () => {
      registerThrowing((i) => i.deferReply({ flags: "Ephemeral" }));
      const f = fakeInteraction("command", { replied: false, deferred: false });

      const handled = await dispatchInProcessInteraction(
        f.interaction as unknown as Interaction,
      );

      expect(handled).toBe(true);
      expect(f.editReply).toHaveBeenCalledTimes(1);
      expect(f.editReply).toHaveBeenCalledWith({ content: COMMAND_FAILED });
      expect(f.reply).not.toHaveBeenCalled();
    });

    it("replies ephemerally when the handler throws before acking", async () => {
      registerThrowing(async () => {});
      const f = fakeInteraction("command", { replied: false, deferred: false });

      await dispatchInProcessInteraction(
        f.interaction as unknown as Interaction,
      );

      expect(f.reply).toHaveBeenCalledWith({
        content: COMMAND_FAILED,
        flags: "Ephemeral",
      });
      expect(f.editReply).not.toHaveBeenCalled();
    });

    it("sends nothing more when the handler already replied", async () => {
      registerThrowing((i) => i.reply({ content: "ok" }));
      const f = fakeInteraction("command", { replied: false, deferred: false });

      await dispatchInProcessInteraction(
        f.interaction as unknown as Interaction,
      );

      expect(f.reply).toHaveBeenCalledTimes(1); // the handler's own reply
      expect(f.editReply).not.toHaveBeenCalled();
    });

    it("swallows a failing editReply (interaction token may be gone)", async () => {
      registerThrowing((i) => i.deferReply());
      const f = fakeInteraction("command", { replied: false, deferred: false });
      f.editReply.mockRejectedValueOnce(new Error("Unknown interaction"));

      await expect(
        dispatchInProcessInteraction(f.interaction as unknown as Interaction),
      ).resolves.toBe(true);
    });
  });

  describe("modal submit", () => {
    function registerThrowing(
      before: (i: {
        deferReply: (o?: unknown) => Promise<void>;
      }) => Promise<void>,
    ) {
      registerInProcessModal({
        prefix: "boom-modal",
        handler: async (i) => {
          await before(i as never);
          throw new Error("kaboom");
        },
      });
    }

    it("edits the deferred reply when the handler throws after deferReply", async () => {
      registerThrowing((i) => i.deferReply({ flags: "Ephemeral" }));
      const f = fakeInteraction("modal", { replied: false, deferred: false });

      const handled = await dispatchInProcessInteraction(
        f.interaction as unknown as Interaction,
      );

      expect(handled).toBe(true);
      expect(f.editReply).toHaveBeenCalledTimes(1);
      expect(f.editReply).toHaveBeenCalledWith({ content: MODAL_FAILED });
      expect(f.reply).not.toHaveBeenCalled();
    });

    it("replies ephemerally when the handler throws before acking", async () => {
      registerThrowing(async () => {});
      const f = fakeInteraction("modal", { replied: false, deferred: false });

      await dispatchInProcessInteraction(
        f.interaction as unknown as Interaction,
      );

      expect(f.reply).toHaveBeenCalledWith({
        content: MODAL_FAILED,
        flags: "Ephemeral",
      });
      expect(f.editReply).not.toHaveBeenCalled();
    });
  });
});
