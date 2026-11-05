/**
 * command-system/webhook-attachment.ts
 *
 * One entry of a behavior webhook payload's `_meta.attachments`, the same
 * for both triggers: `{ id, url, filename, content_type, size }` (#152).
 * `id` is the Discord attachment id, the value a command's attachment
 * option carries, so a receiver can match the option to its file.
 */
import type { Attachment } from "discord.js";

export interface WebhookAttachment {
  id: string;
  url: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
}

export function toWebhookAttachment(
  a: Pick<Attachment, "id" | "url" | "name" | "contentType" | "size">,
): WebhookAttachment {
  return {
    id: a.id,
    url: a.url,
    filename: a.name ?? null,
    content_type: a.contentType ?? null,
    size: a.size ?? null,
  };
}
