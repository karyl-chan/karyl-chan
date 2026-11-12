import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type Interaction } from "discord.js";

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

type Kind = "command" | "modal";

function fakeInteraction(kind: Kind) {
  const state = {
    replied: false,
    deferred: false,
    ephemeral: null as boolean | null,
  };
  const reply = vi.fn(async () => {
    state.replied = true;
    state.ephemeral = false;
  });
  const editReply = vi.fn(async () => {
    state.replied = true;
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
    isRepliable: () => true,
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    get ephemeral() {
      return state.ephemeral;
    },
    reply,
    editReply,
    deferReply: vi.fn(async () => {
      state.deferred = true;
      state.ephemeral = true;
    }),
  } as unknown as Interaction;
  return { interaction, reply, editReply };
}

/** Register a handler of `kind` that runs `before`, then throws. */
function registerThrowing(
  kind: Kind,
  before: (i: {
    deferReply: (o?: unknown) => Promise<void>;
    reply: (o?: unknown) => Promise<void>;
  }) => Promise<void>,
) {
  const handler = async (i: unknown) => {
    await before(i as never);
    throw new Error("kaboom");
  };
  if (kind === "command") {
    registerInProcessCommand({
      data: { name: "boom", description: "boom" },
      scope: "global",
      handler,
    });
  } else {
    registerInProcessModal({ prefix: "boom-modal", handler });
  }
}

const COMMAND_FAILED = t("en", "common.command-failed");
const MODAL_FAILED = t("en", "common.modal-failed");

describe("in-process handler failure reply", () => {
  beforeEach(() => {
    _resetInProcessRegistry();
  });

  describe.each([
    ["command", COMMAND_FAILED],
    ["modal", MODAL_FAILED],
  ] as const)("%s", (kind, failed) => {
    it("edits the deferred reply when the handler throws after deferReply", async () => {
      registerThrowing(kind, (i) => i.deferReply({ flags: "Ephemeral" }));
      const f = fakeInteraction(kind);

      const handled = await dispatchInProcessInteraction(f.interaction);

      expect(handled).toBe(true);
      expect(f.editReply).toHaveBeenCalledTimes(1);
      expect(f.editReply).toHaveBeenCalledWith({ content: failed });
      expect(f.reply).not.toHaveBeenCalled();
    });

    it("replies ephemerally when the handler throws before acking", async () => {
      registerThrowing(kind, async () => {});
      const f = fakeInteraction(kind);

      await dispatchInProcessInteraction(f.interaction);

      expect(f.reply).toHaveBeenCalledWith({
        content: failed,
        flags: MessageFlags.Ephemeral,
      });
      expect(f.editReply).not.toHaveBeenCalled();
    });

    it("sends nothing more when the handler already replied", async () => {
      registerThrowing(kind, (i) => i.reply({ content: "ok" }));
      const f = fakeInteraction(kind);

      await dispatchInProcessInteraction(f.interaction);

      expect(f.reply).toHaveBeenCalledTimes(1); // the handler's own reply
      expect(f.editReply).not.toHaveBeenCalled();
    });

    it("swallows a failing editReply (interaction token may be gone)", async () => {
      registerThrowing(kind, (i) => i.deferReply());
      const f = fakeInteraction(kind);
      f.editReply.mockRejectedValueOnce(new Error("Unknown interaction"));

      await expect(dispatchInProcessInteraction(f.interaction)).resolves.toBe(
        true,
      );
    });
  });
});
