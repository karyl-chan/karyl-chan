/**
 * A dispatch layer that throws AFTER it acked the interaction has claimed
 * it: the dispatcher must tell the user it failed (instead of leaving the
 * deferred "thinking…" up until Discord times out) and must not hand the
 * interaction on to a later layer (#179). A layer that throws BEFORE
 * acking still falls through, as before.
 */
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock(
  "../src/modules/plugin-system/plugin-interaction-dispatch.service.js",
  () => ({ dispatchInteractionToPlugin: vi.fn() }),
);
vi.mock(
  "../src/modules/plugin-system/plugin-component-dispatch.service.js",
  () => ({ dispatchComponentToPlugin: vi.fn() }),
);
vi.mock(
  "../src/modules/plugin-system/plugin-modal-dispatch.service.js",
  () => ({
    dispatchModalToPlugin: vi.fn(),
  }),
);
vi.mock(
  "../src/modules/builtin-features/in-process-command-registry.service.js",
  () => ({ dispatchInProcessInteraction: vi.fn() }),
);
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { MessageFlags, type Interaction } from "discord.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { dispatchInteractionToPlugin } from "../src/modules/plugin-system/plugin-interaction-dispatch.service.js";
import { dispatchComponentToPlugin } from "../src/modules/plugin-system/plugin-component-dispatch.service.js";
import { dispatchModalToPlugin } from "../src/modules/plugin-system/plugin-modal-dispatch.service.js";
import { dispatchInProcessInteraction } from "../src/modules/builtin-features/in-process-command-registry.service.js";
import { t } from "../src/i18n/index.js";

type Kind = "command" | "component" | "modal";

/**
 * A fake interaction whose defer calls flip the same state discord.js
 * does: deferReply sets `ephemeral`, deferUpdate leaves it null.
 */
function fake(kind: Kind) {
  const state = {
    replied: false,
    deferred: false,
    ephemeral: null as boolean | null,
  };
  const raw = {
    locale: "en-US",
    guildLocale: null,
    commandName: "boom",
    customId: "kc:demo:x",
    // false even for "command": skips layer 1 (the behavior catalog),
    // which these tests don't exercise; layers 2–3 are mocked anyway
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    isButton: () => kind === "component",
    isAnySelectMenu: () => false,
    isModalSubmit: () => kind === "modal",
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    get ephemeral() {
      return state.ephemeral;
    },
    deferReply: vi.fn(async () => {
      state.deferred = true;
      state.ephemeral = true;
    }),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    reply: vi.fn(async () => {
      state.replied = true;
    }),
    editReply: vi.fn(async () => {
      state.replied = true;
    }),
    followUp: vi.fn(async () => {}),
  };
  return { raw, interaction: raw as unknown as Interaction };
}

function makeDispatcher(): InteractionDispatcher {
  return new InteractionDispatcher({} as never);
}

const COMMAND_FAILED = t("en", "common.command-failed");
const MODAL_FAILED = t("en", "common.modal-failed");

beforeEach(() => {
  vi.clearAllMocks();
  (dispatchInteractionToPlugin as Mock).mockResolvedValue(false);
  (dispatchComponentToPlugin as Mock).mockResolvedValue(false);
  (dispatchModalToPlugin as Mock).mockResolvedValue(false);
  (dispatchInProcessInteraction as Mock).mockResolvedValue(false);
});

describe("InteractionDispatcher — a layer throws after acking", () => {
  it("layer 2 (plugin command): edits the deferred reply and claims", async () => {
    const f = fake("command");
    (dispatchInteractionToPlugin as Mock).mockImplementation(async (i) => {
      await i.deferReply({ ephemeral: true });
      throw new Error("buildCommandBody: capabilities lookup failed");
    });

    const outcome = await makeDispatcher().dispatch(f.interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_command" });
    expect(f.raw.editReply).toHaveBeenCalledWith({ content: COMMAND_FAILED });
    expect(dispatchInProcessInteraction).not.toHaveBeenCalled();
  });

  it("layer 2.5 (plugin component): follows up ephemerally after deferUpdate", async () => {
    const f = fake("component");
    (dispatchComponentToPlugin as Mock).mockImplementation(async (i) => {
      await i.deferUpdate();
      throw new Error("deliver blew up");
    });

    const outcome = await makeDispatcher().dispatch(f.interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_component" });
    expect(f.raw.followUp).toHaveBeenCalledWith({
      content: COMMAND_FAILED,
      flags: MessageFlags.Ephemeral,
    });
    // the message hosting the clicked component is left alone
    expect(f.raw.editReply).not.toHaveBeenCalled();
    expect(dispatchInProcessInteraction).not.toHaveBeenCalled();
  });

  it("layer 2.6 (plugin modal): edits the deferred reply and claims", async () => {
    const f = fake("modal");
    (dispatchModalToPlugin as Mock).mockImplementation(async (i) => {
      await i.deferReply({ ephemeral: true });
      throw new Error("deliver blew up");
    });

    const outcome = await makeDispatcher().dispatch(f.interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "plugin_modal" });
    expect(f.raw.editReply).toHaveBeenCalledWith({ content: MODAL_FAILED });
    expect(dispatchInProcessInteraction).not.toHaveBeenCalled();
  });

  it("a layer that throws before acking still falls through to layer 3", async () => {
    const f = fake("modal");
    (dispatchModalToPlugin as Mock).mockRejectedValue(new Error("db down"));
    (dispatchInProcessInteraction as Mock).mockResolvedValue(true);

    const outcome = await makeDispatcher().dispatch(f.interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "in_process" });
    expect(f.raw.reply).not.toHaveBeenCalled();
    expect(f.raw.editReply).not.toHaveBeenCalled();
  });

  it("layer 3 (in-process) throwing replies with the failure line and claims", async () => {
    const f = fake("command");
    (dispatchInProcessInteraction as Mock).mockRejectedValue(
      new Error("resolveBuiltinFeatureEnabled: SQLITE_BUSY"),
    );

    const outcome = await makeDispatcher().dispatch(f.interaction);

    expect(outcome).toEqual({ claimed: true, claimedBy: "in_process" });
    expect(f.raw.reply).toHaveBeenCalledWith({
      content: COMMAND_FAILED,
      flags: MessageFlags.Ephemeral,
    });
  });
});
