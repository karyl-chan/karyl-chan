/**
 * Two emojis in a role-emoji group can map to the SAME role. Removing one
 * emoji's reaction must NOT revoke the role while the user still holds the
 * other emoji's reaction that also grants it.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import type { Client, MessageReaction } from "discord.js";
import { sequelize } from "../src/db.js";
import { addRoleEmojiGroup } from "../src/modules/builtin-features/role-emoji/role-emoji-group.model.js";
import {
  addRoleEmoji,
  removeRoleEmoji,
} from "../src/modules/builtin-features/role-emoji/role-emoji.model.js";
import { upsertRoleReceiveMessage } from "../src/modules/builtin-features/role-emoji/role-receive-message.model.js";
import { registerRoleEmojiEvents } from "../src/modules/builtin-features/role-emoji/role-emoji.events.js";

const GUILD = "g1";
const CHANNEL = "c1";
const MESSAGE = "m1";
const ROLE = "R";
const USER = "u1";

let groupId: number;
let removeSpy: ReturnType<typeof vi.fn>;

function captureRemoveHandler(): (r: MessageReaction, u: { id: string }) => Promise<void> {
  const handlers: Record<string, (r: MessageReaction, u: { id: string }) => Promise<void>> = {};
  const client = {
    user: { id: "bot" },
    on: (event: string, fn: (r: MessageReaction, u: { id: string }) => Promise<void>) => {
      handlers[event] = fn;
    },
  } as unknown as Client;
  registerRoleEmojiEvents(client);
  return handlers["messageReactionRemove"];
}

// A reaction the user may or may not still hold. `held` controls whether the
// user appears in its fetched user list.
function siblingReaction(name: string, held: boolean) {
  return {
    emoji: { id: null, name },
    users: { fetch: async () => ({ has: (id: string) => held && id === USER }) },
  };
}

// The removed reaction (🔴) plus the message it lives on. `remaining` are the
// reactions still on the message after the removal.
function removedReaction(remaining: ReturnType<typeof siblingReaction>[]): MessageReaction {
  return {
    partial: false,
    emoji: { id: null, name: "🔴" },
    message: {
      partial: false,
      guildId: GUILD,
      channelId: CHANNEL,
      id: MESSAGE,
      reactions: { cache: { find: (fn: (r: unknown) => boolean) => remaining.find(fn) } },
      guild: {
        roles: { cache: { get: (id: string) => (id === ROLE ? { id: ROLE, name: "Red" } : undefined) } },
        members: { fetch: async () => ({ roles: { add: vi.fn(), remove: removeSpy } }) },
      },
    },
  } as unknown as MessageReaction;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await sequelize.sync({ force: true });
  removeSpy = vi.fn().mockResolvedValue(undefined);
  const group = await addRoleEmojiGroup(GUILD, "colors");
  groupId = group.getDataValue("id") as number;
  await upsertRoleReceiveMessage(GUILD, CHANNEL, MESSAGE, groupId);
  // 🔴 and 🟥 both grant the same role R.
  await addRoleEmoji(groupId, ROLE, "🔴", "red", "");
  await addRoleEmoji(groupId, ROLE, "🟥", "redsquare", "");
});

describe("role-emoji shared-role revocation", () => {
  it("keeps the role when another emoji's reaction still grants it", async () => {
    const handler = captureRemoveHandler();
    // User removes 🔴 but still holds 🟥 (also → R).
    await handler(removedReaction([siblingReaction("🟥", true)]), { id: USER });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("revokes the role when no other granting reaction remains", async () => {
    const handler = captureRemoveHandler();
    // 🟥 reaction is gone (user does not hold it).
    await handler(removedReaction([siblingReaction("🟥", false)]), { id: USER });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes the role when the emoji is the only one mapping to it", async () => {
    // Drop the 🟥 mapping so 🔴 is the sole grantor of R.
    await removeRoleEmoji(groupId, "🟥", "");
    const handler = captureRemoveHandler();
    await handler(removedReaction([]), { id: USER });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
