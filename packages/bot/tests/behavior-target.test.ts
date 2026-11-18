/**
 * Behavior Target keys (ADR 0004): the one rule that says which target a
 * message trigger belongs to, and the key ↔ fields round trip the
 * directory rows are built from.
 */
import { describe, it, expect } from "vitest";
import {
  behaviorTargetKey,
  isBuiltinTarget,
  messageTriggerTarget,
  targetFieldsOf,
  type MessageTriggerTargetSource,
} from "../src/modules/behavior/behavior-target.js";

const dm: MessageTriggerTargetSource = {
  surface: "bot_dm",
  guildId: null,
  channelId: null,
  audienceKind: "all",
  audienceUserId: null,
  audienceGroupName: null,
};

describe("messageTriggerTarget", () => {
  it("puts a bot DM trigger for everyone in bot_dm", () => {
    expect(messageTriggerTarget(dm)).toBe("bot_dm");
    // a row written before the surface column: bot DMs
    expect(messageTriggerTarget({ ...dm, surface: null })).toBe("bot_dm");
  });

  it("puts a bot DM trigger for one user or one group in that user's or group's target", () => {
    expect(messageTriggerTarget({ ...dm, audienceKind: "user", audienceUserId: "111111111111111111" })).toBe(
      "user:111111111111111111",
    );
    expect(messageTriggerTarget({ ...dm, audienceKind: "group", audienceGroupName: "家人" })).toBe("group:家人");
  });

  it("puts a guild trigger at its location", () => {
    const guild = { ...dm, surface: "guild" as const };
    expect(messageTriggerTarget(guild)).toBe("guild:all");
    expect(messageTriggerTarget({ ...guild, guildId: "G" })).toBe("guild:G");
    expect(messageTriggerTarget({ ...guild, guildId: "G", channelId: "C" })).toBe("channel:G:C");
  });
});

describe("target keys", () => {
  it("round-trip through their fields", () => {
    for (const key of ["guild:123", "channel:123:456", "user:789", "group:vip"]) {
      expect(behaviorTargetKey(targetFieldsOf(key)!)).toBe(key);
    }
  });

  it("keep a group name whole, whatever it contains", () => {
    expect(targetFieldsOf("group:a:b@guild:1")).toEqual({
      kind: "group",
      guildId: null,
      channelId: null,
      userId: null,
      groupName: "a:b@guild:1",
    });
    // a group named like another kind of key is still a group
    expect(targetFieldsOf("group:user:1")?.kind).toBe("group");
  });

  it("have no fields for the built-in targets", () => {
    for (const key of ["app", "bot_dm", "guild:all"]) {
      expect(isBuiltinTarget(key)).toBe(true);
      expect(targetFieldsOf(key)).toBeNull();
    }
    expect(isBuiltinTarget("guild:123")).toBe(false);
  });
});
