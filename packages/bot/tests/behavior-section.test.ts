/**
 * Behavior Section derivation (ADR 0003): the admin UI groups behaviors by
 * where they can be used, derived from the trigger — never stored.
 *
 *   command, registered to one guild                → that guild
 *   command, global, user_install or > 1 context    → App 指令
 *   command, global, only BotDM                     → 與 bot 的私訊
 *   command, global, only Guild                     → 伺服器 › 全部伺服器
 *   message, bot_dm                                 → 與 bot 的私訊
 *   message, guild (no guild)                       → 伺服器 › 全部伺服器
 *   message, guild + guild                          → that guild
 *   message, guild + guild + channel                → that channel
 */
import { describe, it, expect } from "vitest";
import { behaviorSection } from "../src/modules/behavior/behavior-section.js";

const command = (
  over: Partial<{
    registration: "global" | "guild";
    guildId: string | null;
    integrationTypes: ("guild_install" | "user_install")[];
    contexts: ("Guild" | "BotDM" | "PrivateChannel")[];
  }>,
) =>
  behaviorSection({
    kind: "command",
    registration: "global",
    guildId: null,
    integrationTypes: ["guild_install"],
    contexts: ["Guild"],
    ...over,
  });

const message = (
  over: Partial<{
    surface: "bot_dm" | "guild";
    guildId: string | null;
    channelId: string | null;
  }>,
) =>
  behaviorSection({
    kind: "message",
    surface: "guild",
    guildId: null,
    channelId: null,
    ...over,
  });

describe("behaviorSection — command triggers", () => {
  it("a guild-registered command belongs to its guild", () => {
    expect(command({ registration: "guild", guildId: "123" })).toBe(
      "guild:123",
    );
  });

  it("a global command open to user installs is an App 指令", () => {
    expect(
      command({
        integrationTypes: ["guild_install", "user_install"],
        contexts: ["BotDM"],
      }),
    ).toBe("app");
  });

  it("a global command usable in more than one context is an App 指令", () => {
    expect(command({ contexts: ["BotDM", "Guild"] })).toBe("app");
  });

  it("a global command usable only in bot DMs belongs to 與 bot 的私訊", () => {
    expect(command({ contexts: ["BotDM"] })).toBe("bot_dm");
  });

  it("a global command usable only in guilds belongs to 全部伺服器", () => {
    expect(command({ contexts: ["Guild"] })).toBe("guild:all");
  });

  it("a global command usable only in group DMs is an App 指令", () => {
    expect(command({ contexts: ["PrivateChannel"] })).toBe("app");
  });
});

describe("behaviorSection — message triggers", () => {
  it("a bot DM trigger belongs to 與 bot 的私訊", () => {
    expect(message({ surface: "bot_dm" })).toBe("bot_dm");
  });

  it("a guild trigger without a guild belongs to 全部伺服器", () => {
    expect(message({})).toBe("guild:all");
  });

  it("a guild trigger pinned to a guild belongs to that guild", () => {
    expect(message({ guildId: "123" })).toBe("guild:123");
  });

  it("a guild trigger pinned to a channel belongs to that channel", () => {
    expect(message({ guildId: "123", channelId: "456" })).toBe(
      "channel:123:456",
    );
  });
});
