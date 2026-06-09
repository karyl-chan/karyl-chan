import { Op } from "sequelize";
import { DmChannel } from "./models/dm-channel.model.js";
import type { Message as ApiMessage } from "../web-core/message-types.js";

export interface DmRecipient {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

export interface DmChannelSummary {
  id: string;
  recipient: DmRecipient;
  lastMessageAt: string | null;
  lastMessageId: string | null;
  lastMessagePreview: string | null;
}

export interface DmInboxStore {
  upsertChannel(
    channelId: string,
    recipient: DmRecipient,
  ): Promise<DmChannelSummary>;
  recordActivity(
    channelId: string,
    recipient: DmRecipient,
    message: ApiMessage,
  ): Promise<DmChannelSummary>;
  updateLatestMessageId(channelId: string, messageId: string): Promise<void>;
  listChannels(): Promise<DmChannelSummary[]>;
  getChannel(channelId: string): Promise<DmChannelSummary | null>;
}

function previewFor(message: ApiMessage): string {
  if (message.content) return message.content.slice(0, 120);
  if (message.attachments?.length)
    return `📎 ${message.attachments[0].filename}`;
  if (message.stickers?.length) return `🏷 ${message.stickers[0].name}`;
  if (message.embeds?.length) return `📰 ${message.embeds[0].title ?? "embed"}`;
  return "";
}

export class InMemoryDmInbox implements DmInboxStore {
  private channels = new Map<string, DmChannelSummary>();

  async upsertChannel(
    channelId: string,
    recipient: DmRecipient,
  ): Promise<DmChannelSummary> {
    const existing = this.channels.get(channelId);
    if (existing) {
      existing.recipient = recipient;
      return { ...existing };
    }
    const summary: DmChannelSummary = {
      id: channelId,
      recipient,
      lastMessageAt: null,
      lastMessageId: null,
      lastMessagePreview: null,
    };
    this.channels.set(channelId, summary);
    return { ...summary };
  }

  async recordActivity(
    channelId: string,
    recipient: DmRecipient,
    message: ApiMessage,
  ): Promise<DmChannelSummary> {
    await this.upsertChannel(channelId, recipient);
    const stored = this.channels.get(channelId)!;
    if (!stored.lastMessageAt || message.createdAt >= stored.lastMessageAt) {
      stored.lastMessageAt = message.createdAt;
      stored.lastMessageId = message.id;
      stored.lastMessagePreview = previewFor(message);
    }
    return { ...stored };
  }

  async updateLatestMessageId(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const existing = this.channels.get(channelId);
    if (!existing) return;
    existing.lastMessageId = messageId;
  }

  async listChannels(): Promise<DmChannelSummary[]> {
    return [...this.channels.values()]
      .map((c) => ({ ...c }))
      .sort((a, b) =>
        (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""),
      );
  }

  async getChannel(channelId: string): Promise<DmChannelSummary | null> {
    const summary = this.channels.get(channelId);
    return summary ? { ...summary } : null;
  }
}

export class SqliteDmInbox implements DmInboxStore {
  async upsertChannel(
    channelId: string,
    recipient: DmRecipient,
  ): Promise<DmChannelSummary> {
    const [row] = await DmChannel.upsert({
      id: channelId,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      recipientGlobalName: recipient.globalName,
      recipientAvatarUrl: recipient.avatarUrl,
    });
    return this.rowToSummary(row);
  }

  async recordActivity(
    channelId: string,
    recipient: DmRecipient,
    message: ApiMessage,
  ): Promise<DmChannelSummary> {
    // Ensure the row exists + refresh the recipient fields. We deliberately do
    // NOT write the lastMessage* columns here — Sequelize upsert only SETs the
    // provided columns, so an existing row keeps its message state.
    await DmChannel.upsert({
      id: channelId,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      recipientGlobalName: recipient.globalName,
      recipientAvatarUrl: recipient.avatarUrl,
    });
    // Advance the latest-message columns with a single atomic conditional
    // UPDATE that only fires when this message is at least as new as the
    // stored one. The previous read-then-upsert raced: two near-simultaneous
    // DMs both read the same previousLast and the OLDER one's write could land
    // last, regressing lastMessageAt (sidebar then shows a stale "latest").
    // The DB evaluates this WHERE against the committed row, so a stale write
    // matches nothing.
    await DmChannel.update(
      {
        lastMessageAt: message.createdAt,
        lastMessageId: message.id,
        lastMessagePreview: previewFor(message),
      },
      {
        where: {
          id: channelId,
          [Op.or]: [
            { lastMessageAt: null },
            { lastMessageAt: { [Op.lte]: message.createdAt } },
          ],
        },
      },
    );
    // The row was just upserted, so it always exists. Return its current
    // state (which reflects the newest message, even if a concurrent newer
    // one landed in between — that's the correct sidebar value).
    const row = await DmChannel.findByPk(channelId);
    return this.rowToSummary(row!);
  }

  async updateLatestMessageId(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await DmChannel.update(
      { lastMessageId: messageId },
      { where: { id: channelId } },
    );
  }

  async listChannels(): Promise<DmChannelSummary[]> {
    const rows = await DmChannel.findAll({
      order: [["lastMessageAt", "DESC"]],
    });
    return rows.map((r) => this.rowToSummary(r));
  }

  async getChannel(channelId: string): Promise<DmChannelSummary | null> {
    const row = await DmChannel.findByPk(channelId);
    return row ? this.rowToSummary(row) : null;
  }

  private rowToSummary(row: {
    getDataValue: (key: string) => unknown;
  }): DmChannelSummary {
    return {
      id: row.getDataValue("id") as string,
      recipient: {
        id: row.getDataValue("recipientId") as string,
        username: row.getDataValue("recipientUsername") as string,
        globalName:
          (row.getDataValue("recipientGlobalName") as string | null) ?? null,
        avatarUrl:
          (row.getDataValue("recipientAvatarUrl") as string | null) ?? null,
      },
      lastMessageAt:
        (row.getDataValue("lastMessageAt") as string | null) ?? null,
      lastMessageId:
        (row.getDataValue("lastMessageId") as string | null) ?? null,
      lastMessagePreview:
        (row.getDataValue("lastMessagePreview") as string | null) ?? null,
    };
  }
}

export const dmInboxService: DmInboxStore = new SqliteDmInbox();
