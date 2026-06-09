import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { DmChannel } from "../src/modules/dm-inbox/models/dm-channel.model.js";
import {
  SqliteDmInbox,
  type DmRecipient,
} from "../src/modules/dm-inbox/dm-inbox.service.js";
import type { Message } from "../src/modules/web-core/message-types.js";

const RECIPIENT: DmRecipient = {
  id: "500000000000000001",
  username: "alice",
  globalName: "Alice",
  avatarUrl: "https://example.test/u1.png",
};

const RECIPIENT_2: DmRecipient = {
  id: "500000000000000002",
  username: "bob",
  globalName: null,
  avatarUrl: null,
};

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-1",
    channelId: "c-1",
    guildId: null,
    author: {
      id: "111111111111111111",
      username: "a",
      globalName: null,
      avatarUrl: "",
      bot: false,
    },
    content: "hi",
    createdAt: "2026-04-25T12:00:00.000Z",
    attachments: [],
    ...overrides,
  } as Message;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe("SqliteDmInbox", () => {
  it("upsertChannel persists and surfaces a recipient", async () => {
    const inbox = new SqliteDmInbox();
    const summary = await inbox.upsertChannel("c-1", RECIPIENT);
    expect(summary.id).toBe("c-1");
    expect(summary.recipient.id).toBe(RECIPIENT.id);
    expect(summary.recipient.username).toBe("alice");
  });

  it("upsertChannel rewrites recipient fields on second call (same channel)", async () => {
    const inbox = new SqliteDmInbox();
    await inbox.upsertChannel("c-1", RECIPIENT);
    const updated = await inbox.upsertChannel("c-1", {
      ...RECIPIENT,
      username: "alice-new",
    });
    expect(updated.recipient.username).toBe("alice-new");
  });

  it("recordActivity advances lastMessageAt + lastMessageId on a newer message", async () => {
    const inbox = new SqliteDmInbox();
    await inbox.recordActivity(
      "c-1",
      RECIPIENT,
      fakeMessage({
        id: "600000000000000001",
        createdAt: "2026-04-25T12:00:00.000Z",
        content: "older",
      }),
    );
    const after = await inbox.recordActivity(
      "c-1",
      RECIPIENT,
      fakeMessage({
        id: "600000000000000002",
        createdAt: "2026-04-25T13:00:00.000Z",
        content: "newer",
      }),
    );
    expect(after.lastMessageId).toBe("600000000000000002");
    expect(after.lastMessagePreview).toBe("newer");
  });

  it("recordActivity does not overwrite when an older message arrives later", async () => {
    const inbox = new SqliteDmInbox();
    await inbox.recordActivity(
      "c-1",
      RECIPIENT,
      fakeMessage({
        id: "600000000000000005",
        createdAt: "2026-04-25T13:00:00.000Z",
        content: "newer",
      }),
    );
    const after = await inbox.recordActivity(
      "c-1",
      RECIPIENT,
      fakeMessage({
        id: "600000000000000003",
        createdAt: "2026-04-25T11:00:00.000Z",
        content: "older",
      }),
    );
    // The "newer" first write should still be the persisted state.
    expect(after.lastMessageId).toBe("600000000000000005");
    expect(after.lastMessagePreview).toBe("newer");
  });

  it("recordActivity does not lose a concurrent newer write (race regression)", async () => {
    // Deterministically reproduce the read-modify-write race: a NEWER message
    // lands in the window between an older recordActivity's DB read and its
    // write. We force that window by spying on findByPk so the first read
    // captures a stale snapshot, then a newer message is fully recorded, then
    // the stale snapshot is returned to the caller. The old code (findByPk →
    // upsert) would then write the stale/older state back, clobbering the
    // newer message. The atomic conditional UPDATE evaluates against the
    // committed row instead, so the newer message survives.
    const inbox = new SqliteDmInbox();
    // Capture the real implementation before spying so the spy can still
    // perform a genuine (stale) read.
    const realFindByPk = DmChannel.findByPk.bind(DmChannel);
    let injected = false;
    const spy = vi
      .spyOn(DmChannel, "findByPk")
      .mockImplementation(async (id, options) => {
        const snapshot = await realFindByPk(id, options);
        if (!injected) {
          injected = true;
          // A newer message arrives mid-flight and is committed.
          await inbox.recordActivity(
            "c-1",
            RECIPIENT,
            fakeMessage({
              id: "600000000000000200",
              createdAt: "2026-04-25T14:00:00.000Z",
              content: "newer-concurrent",
            }),
          );
        }
        return snapshot; // intentionally stale read for the outer caller
      });
    try {
      await inbox.recordActivity(
        "c-1",
        RECIPIENT,
        fakeMessage({
          id: "600000000000000199",
          createdAt: "2026-04-25T13:00:00.000Z",
          content: "older-outer",
        }),
      );
    } finally {
      spy.mockRestore();
    }
    // The newer concurrent message must not have been clobbered.
    const summary = await inbox.getChannel("c-1");
    expect(summary?.lastMessageId).toBe("600000000000000200");
    expect(summary?.lastMessagePreview).toBe("newer-concurrent");
  });

  it("listChannels orders by lastMessageAt DESC", async () => {
    const inbox = new SqliteDmInbox();
    await inbox.recordActivity(
      "c-old",
      RECIPIENT,
      fakeMessage({
        id: "600000000000000010",
        createdAt: "2026-04-20T00:00:00.000Z",
      }),
    );
    await inbox.recordActivity(
      "c-new",
      RECIPIENT_2,
      fakeMessage({
        id: "600000000000000020",
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    );
    const list = await inbox.listChannels();
    expect(list.map((c) => c.id)).toEqual(["c-new", "c-old"]);
  });

  it("updateLatestMessageId only writes the messageId column", async () => {
    const inbox = new SqliteDmInbox();
    await inbox.upsertChannel("c-1", RECIPIENT);
    await inbox.updateLatestMessageId("c-1", "600000000000000099");
    const summary = await inbox.getChannel("c-1");
    expect(summary?.lastMessageId).toBe("600000000000000099");
  });

  it("getChannel returns null for an unknown channel id", async () => {
    const inbox = new SqliteDmInbox();
    expect(await inbox.getChannel("c-missing")).toBeNull();
  });

  describe("recipientId unique constraint", () => {
    it("enforces unique recipientId across rows", async () => {
      const inbox = new SqliteDmInbox();
      await inbox.upsertChannel("c-1", RECIPIENT);
      // A second channel id with the same recipient should be
      // rejected by the unique index added in M2/M3 — it's a
      // Discord invariant we now enforce.
      await expect(inbox.upsertChannel("c-2", RECIPIENT)).rejects.toThrow();
    });

    it("allows the same recipient under the same channel id (upsert)", async () => {
      const inbox = new SqliteDmInbox();
      await inbox.upsertChannel("c-1", RECIPIENT);
      // Upsert under the same primary key should succeed.
      const second = await inbox.upsertChannel("c-1", RECIPIENT);
      expect(second.id).toBe("c-1");
      // Only one row exists.
      expect(await DmChannel.count()).toBe(1);
    });
  });
});
