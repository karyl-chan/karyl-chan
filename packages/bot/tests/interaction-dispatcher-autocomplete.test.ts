/**
 * Autocomplete interactions have a hard ~3s deadline and can only be closed
 * with respond(). When no dispatch layer claims an autocomplete — the plugin
 * layer threw (caught + fell through) or the command was deregistered while
 * Discord still offers it — the dispatcher must still ack it with an empty
 * list, or the user stares at a frozen suggestion list until Discord drops
 * it. These tests lock the fallback safety-net.
 */
import { vi, describe, it, expect, beforeEach, type Mock } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// Mock every dispatch layer so we can drive the orchestration deterministically.
vi.mock(
  "../src/modules/plugin-system/plugin-interaction-dispatch.service.js",
  () => ({ dispatchInteractionToPlugin: vi.fn() }),
);
vi.mock(
  "../src/modules/plugin-system/plugin-component-dispatch.service.js",
  () => ({ dispatchComponentToPlugin: vi.fn() }),
);
vi.mock("../src/modules/plugin-system/plugin-modal-dispatch.service.js", () => ({
  dispatchModalToPlugin: vi.fn(),
}));
vi.mock(
  "../src/modules/builtin-features/in-process-command-registry.service.js",
  () => ({ dispatchInProcessInteraction: vi.fn() }),
);
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { Interaction } from "discord.js";
import { InteractionDispatcher } from "../src/modules/command-system/interaction-dispatcher.service.js";
import { dispatchInteractionToPlugin } from "../src/modules/plugin-system/plugin-interaction-dispatch.service.js";
import { dispatchInProcessInteraction } from "../src/modules/builtin-features/in-process-command-registry.service.js";

function fakeAutocomplete(respond: Mock): Interaction {
  return {
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    respond,
  } as unknown as Interaction;
}

function makeDispatcher(): InteractionDispatcher {
  // The forwarder is only used by the slash/behavior layer; autocomplete
  // never touches it.
  return new InteractionDispatcher({} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InteractionDispatcher — autocomplete fallthrough ack", () => {
  it("acks an unclaimed autocomplete (all layers return false) with []", async () => {
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(false);
    (dispatchInProcessInteraction as Mock).mockResolvedValue(false);
    const respond = vi.fn(async () => {});
    const outcome = await makeDispatcher().dispatch(fakeAutocomplete(respond));
    expect(respond).toHaveBeenCalledWith([]);
    expect(outcome.claimed).toBe(false);
  });

  it("acks an autocomplete even when the plugin layer THROWS", async () => {
    (dispatchInteractionToPlugin as Mock).mockRejectedValue(
      new Error("plugin lookup timed out"),
    );
    (dispatchInProcessInteraction as Mock).mockResolvedValue(false);
    const respond = vi.fn(async () => {});
    await makeDispatcher().dispatch(fakeAutocomplete(respond));
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("does NOT ack a CLAIMED autocomplete (plugin layer handled it)", async () => {
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(true);
    const respond = vi.fn(async () => {});
    const outcome = await makeDispatcher().dispatch(fakeAutocomplete(respond));
    // The plugin layer owns the respond; the fallback must not double-ack.
    expect(respond).not.toHaveBeenCalled();
    expect(outcome.claimed).toBe(true);
  });

  it("does not respond([]) on a non-autocomplete unclaimed interaction", async () => {
    (dispatchInteractionToPlugin as Mock).mockResolvedValue(false);
    (dispatchInProcessInteraction as Mock).mockResolvedValue(false);
    const respond = vi.fn(async () => {});
    const chatInput = {
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      commandName: "nope",
      respond,
    } as unknown as Interaction;
    const outcome = await makeDispatcher().dispatch(chatInput);
    expect(respond).not.toHaveBeenCalled();
    expect(outcome.claimed).toBe(false);
  });
});
