/**
 * command-system/reply-files.ts
 *
 * Between a Behavior Reply as received and as rendered (#156): a reply's
 * `attachments` are only descriptors (`{ name, path }`); the renderer sends
 * files. readyToRender downloads them through the run's fetcher and hands
 * back a RenderableReply — a reply whose attachments are files — so a
 * reply cannot reach the renderer with its attachments not downloaded.
 *
 * The synchronous answer (runWebhookAction) and the callback calls
 * (behavior-callback.ts) both go through here, in the run's turn, after
 * they know the reply will be shown.
 */

import type { BehaviorReply, ReplyAttachment } from "./behavior-reply.js";

/** A downloaded attachment. */
export interface ReplyFile {
  name: string;
  data: Buffer;
}

/** The downloaded attachments of a reply, or why they could not be had. */
export type ReplyFilesResult = { ok: true; files: ReplyFile[] } | { ok: false; error: string };

/**
 * Downloads a reply's attachments from where its run says they are: a
 * webhook run's from its webhook URL's origin (WebhookForwarder.fetchReplyFiles).
 */
export type ReplyFileFetcher = (attachments: readonly ReplyAttachment[]) => Promise<ReplyFilesResult>;

/**
 * A reply ready for the ReplyRenderer: no attachment descriptors (and no
 * `defer`, which never reaches a render), only the files downloaded for them.
 */
export type RenderableReply = Omit<BehaviorReply, "attachments" | "defer"> & {
  attachments?: never;
  defer?: never;
  files?: ReplyFile[];
};

/**
 * The reply ready to render, its attachments downloaded; or why they could
 * not be, as the delivery code and error to record. Without a fetcher a
 * reply with attachments can't be had at all.
 */
export async function readyToRender(
  reply: BehaviorReply,
  fetchFiles: ReplyFileFetcher | undefined,
): Promise<
  { ok: true; reply: RenderableReply } | { ok: false; errorCode: "attachment_failed"; error: string }
> {
  const { attachments, defer: _defer, ...rest } = reply;
  if (!attachments?.length) return { ok: true, reply: rest };
  const fetched: ReplyFilesResult = fetchFiles
    ? await fetchFiles(attachments)
    : { ok: false, error: "not available for this reply" };
  return fetched.ok
    ? { ok: true, reply: { ...rest, files: fetched.files } }
    : { ok: false, errorCode: "attachment_failed", error: `attachments: ${fetched.error}` };
}
