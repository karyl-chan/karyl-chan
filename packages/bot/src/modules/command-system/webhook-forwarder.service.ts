/**
 * command-system/webhook-forwarder.service.ts
 *
 * WebhookForwarder：執行 behavior 的 webhook 動作 —— 把 payload 轉發到
 * admin 設定的外部 URL（POST schema 對齊 RESTPostAPIWebhookWithTokenJSONBody）。
 *
 *   - 輸入是 behavior_webhook_actions 的一列（url / secret 為密文）
 *   - 簽署依 authMode（CR-2）：
 *       'token'  → X-Plugin-Webhook-Token: <secret>
 *       'hmac'   → X-Karyl-Signature + X-Karyl-Timestamp + X-Karyl-Nonce
 *       null     → 不簽（裸 HTTP）
 *   - 密鑰輪換的寬限期（#99，previousSecret 未過期時）：標準 header 一律用
 *     新密鑰，另外附上舊密鑰的版本 —— X-Plugin-Webhook-Token-Previous /
 *     X-Karyl-Signature-Previous（同一組 timestamp / nonce / body）；回應用
 *     新舊任一把簽都接受。標準 header 在輪換當下就改用新密鑰（格式不變），
 *     只認得舊密鑰又只讀標準 header 的 receiver 會立刻拒收 —— 無停機輪換
 *     要 receiver 先同時接受 -Previous header（docs/features/behavior-webhook-protocol.md）。
 *   - URL 解密後才用
 *   - 解析 response 成回覆模型（behavior-reply.ts，#140）
 *   - 回 ForwardResult { ok, reply, notes, status?, error?, errorCode?, verified? }
 *   - 回覆的附件（#156）：fetchReplyFiles 從 webhook URL 的 origin 下載，
 *     與 POST 同一套 host policy、pinned 連線、不跟 redirect、逾時，並邊讀
 *     邊限制大小
 */

import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  buildOutboundSignatureHeaders,
  generateNonce,
  signBody,
  verifyInboundSignatureWithKeys,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../../utils/hmac.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  HostPolicyError,
  resolveWebhookTarget,
  type WebhookTarget,
} from "../../utils/host-policy.js";
import { createPinnedAgent, type PinnedAddress } from "../../utils/pinned-dispatcher.js";
import { webhookAllowlist } from "../../config.js";
import type { AllowlistEntry } from "../../utils/webhook-allowlist.js";
import { decryptSecret } from "../../utils/crypto.js";
import type { BehaviorWebhookActionRow } from "../behavior/models/behavior-webhook-action.model.js";
import type { ForwardErrorCode, ForwardResult } from "./types.js";
import {
  MAX_REPLY_ATTACHMENT_BYTES,
  MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
  MAX_REPLY_BODY_BYTES,
  attachmentsProblem,
  parseBehaviorReply,
  type ReplyAttachment,
  type ReplyNote,
} from "./behavior-reply.js";
import type { ReplyFile, ReplyFilesResult } from "./reply-files.js";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read the body, giving up past `max` bytes (null). A declared
 * Content-Length over the cap is refused before reading anything.
 */
async function readCappedBytes(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const bytes = await readCappedBytes(res, max);
  return bytes === null ? null : bytes.toString("utf8");
}

/**
 * What a reply lost in parsing is the receiver author's business: log it
 * once per behavior and kind of loss for the life of the process, not on
 * every message (#140 — unknown fields are ignored and logged once). The
 * set is capped; past the cap the oldest key is forgotten.
 */
const loggedReplyNotes = new Set<string>();
const MAX_LOGGED_REPLY_NOTES = 1000;

function logReplyNotes(behaviorId: number, notes: readonly ReplyNote[]): void {
  for (const note of notes) {
    const detail =
      note.kind === "unknown_fields"
        ? note.fields.join(",")
        : note.kind === "invalid_field"
          ? note.field
          : "";
    const key = `${behaviorId}:${note.kind}:${detail}`;
    if (loggedReplyNotes.has(key)) continue;
    if (loggedReplyNotes.size >= MAX_LOGGED_REPLY_NOTES) {
      loggedReplyNotes.delete(loggedReplyNotes.values().next().value as string);
    }
    loggedReplyNotes.add(key);
    botEventLog.record(
      "warn",
      "bot",
      `webhook-forwarder: behavior ${behaviorId}'s reply was adjusted (${note.kind}${detail ? `: ${detail}` : ""}) — see the reply contract in docs/features/behavior-webhook-protocol.md`,
      { behaviorId, note },
    );
  }
}

/** A failed forward: no reply, and the detail for the log / stats / admin. */
function fail(error: string, status?: number, errorCode?: ForwardErrorCode): ForwardResult {
  return {
    ok: false,
    reply: {},
    notes: [],
    error,
    ...(status !== undefined ? { status } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

/** X-Plugin-Webhook-Token header name（CR-2 token mode）。 */
const PLUGIN_WEBHOOK_TOKEN_HEADER = "x-plugin-webhook-token";

/** 輪換寬限期內，舊密鑰的 token / 簽章（#99）。 */
export const PREVIOUS_TOKEN_HEADER = "x-plugin-webhook-token-previous";
export const PREVIOUS_SIGNATURE_HEADER = "x-karyl-signature-previous";

/**
 * Test-fire (#101): a marker header, where token mode puts the token
 * instead, and the prefix of every signed string (request and response).
 * A receiver that verifies only the real scheme thus refuses a test at the
 * signature level. Published in CONTRACT_FIXTURES.behaviorWebhook.signing.
 */
export const TEST_HEADER = "x-karyl-test";
export const TEST_TOKEN_HEADER = "x-plugin-webhook-test-token";
export const TEST_PREVIOUS_TOKEN_HEADER = "x-plugin-webhook-test-token-previous";
export const TEST_SIGNATURE_PREFIX = "test:";

/** How one request is authenticated: a real one, or an admin test-fire. */
interface SigningScheme {
  tokenHeader: string;
  previousTokenHeader: string;
  signaturePrefix: string;
  /** Extra headers that mark the request. */
  marker: Record<string, string>;
}

const REAL_SCHEME: SigningScheme = {
  tokenHeader: PLUGIN_WEBHOOK_TOKEN_HEADER,
  previousTokenHeader: PREVIOUS_TOKEN_HEADER,
  signaturePrefix: "",
  marker: {},
};

const TEST_SCHEME: SigningScheme = {
  tokenHeader: TEST_TOKEN_HEADER,
  previousTokenHeader: TEST_PREVIOUS_TOKEN_HEADER,
  signaturePrefix: TEST_SIGNATURE_PREFIX,
  marker: { [TEST_HEADER]: "1" },
};

/** One POST: where, what, and with which keys and scheme. */
interface PostRequest {
  webhookUrl: string;
  payload: Record<string, unknown>;
  action: BehaviorWebhookActionRow;
  secret: string | null;
  /** The previous secret during a rotation's grace period. */
  previous: string | null;
  scheme: SigningScheme;
}

export interface ForwardOptions {
  /** An admin test-fire: signed under the test prefix / test headers. */
  test?: boolean;
}

// ── WebhookForwarder ─────────────────────────────────────────────────────────

export class WebhookForwarder {
  /**
   * @param allowlist  WEBHOOK_PRIVATE_ALLOWLIST entries the target policy
   *                   applies; defaults to the boot-parsed config value
   *                   (tests inject their own).
   * @param timeoutMs  how long one POST may take before it is aborted
   *                   (headers and body together); tests inject a short one.
   */
  constructor(
    private readonly allowlist: readonly AllowlistEntry[] = webhookAllowlist,
    private readonly timeoutMs: number = 10_000,
  ) {}

  /**
   * 執行一個 webhook 動作。
   *
   * @param action   behavior_webhook_actions 的列（url / secret 為密文）
   * @param payload  Discord webhook 形狀的 body（RESTPostAPIWebhookWithTokenJSONBody 相容）
   * @returns        含解析後回覆（reply / notes）的結果
   */
  async forward(
    action: BehaviorWebhookActionRow,
    payload: Record<string, unknown>,
    opts: ForwardOptions = {},
  ): Promise<ForwardResult> {
    let webhookUrl: string;
    try {
      webhookUrl = decryptSecret(action.url);
    } catch (err) {
      return fail(
        `webhookUrl 解密失敗：${errorText(err)}`,
      );
    }

    // 計算 secret（需在解密後才能簽署）
    const rawSecret = action.secret
      ? this.safeDecrypt(action.secret, action.behaviorId)
      : null;

    // hmac mode is fail-CLOSED by contract (see doPost's response-verification
    // note). Without a usable secret we can neither sign the outbound request
    // nor verify the response, so refuse to forward rather than silently
    // sending unsigned + relaying an unverified response into the user's DM.
    // safeDecrypt returns null on a rotated-out key id / corrupt ciphertext —
    // a reachable operational state, not merely a missing secret (which the
    // model's CHECK already forbids for hmac mode).
    if (action.authMode === "hmac" && rawSecret === null) {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: behavior ${action.behaviorId} is hmac mode but its webhookSecret could not be decrypted — refusing to forward (fail closed).`,
        { behaviorId: action.behaviorId },
      );
      return fail(
        "hmac mode: webhook secret unavailable (rotated key or corrupt ciphertext) — refusing to forward unsigned",
      );
    }

    // 輪換寬限期內的舊密鑰；過期或解不開就當作沒有
    const rawPrevious =
      rawSecret !== null &&
      action.previousSecret !== null &&
      action.previousSecretExpiresAt !== null &&
      action.previousSecretExpiresAt.getTime() > Date.now()
        ? this.safeDecrypt(action.previousSecret, action.behaviorId)
        : null;

    return this.doPost({
      webhookUrl,
      payload,
      action,
      secret: rawSecret,
      previous: rawPrevious,
      scheme: opts.test ? TEST_SCHEME : REAL_SCHEME,
    });
  }

  /**
   * Download a reply's attachments (#156) from the webhook URL's origin:
   * each `path` (checked by attachmentsProblem: no `//host`, no absolute
   * URL, no backslash) is resolved against it and fetched with a GET under
   * the same rules as the POST — the target policy (private addresses only
   * when allowlisted), a connection pinned to the checked addresses, no
   * redirects, and one timeout for the whole batch. Each body is cut off
   * as it streams, past MAX_REPLY_ATTACHMENT_BYTES or past what is left of
   * MAX_REPLY_ATTACHMENT_TOTAL_BYTES. No credentials are sent. One file
   * that can't be had fails them all. Never throws.
   *
   * At most MAX_DOWNLOAD_BATCHES batches download at a time across the
   * process (each may hold up to the total cap), and at most one per
   * behavior, so one slow receiver can't take every turn. A batch waits
   * for its turns within its own timeout, and fails when it ends first;
   * the target check counts against that timeout too.
   */
  async fetchReplyFiles(
    action: BehaviorWebhookActionRow,
    attachments: readonly ReplyAttachment[],
  ): Promise<ReplyFilesResult> {
    const problem = attachmentsProblem(attachments);
    if (problem) return { ok: false, error: problem };
    if (attachments.length === 0) return { ok: true, files: [] };
    let origin: URL;
    try {
      origin = new URL(new URL(decryptSecret(action.url)).origin);
    } catch (err) {
      return {
        ok: false,
        error: `the webhook URL is unusable: ${errorText(err)}`,
      };
    }
    return downloadReplyFiles({
      behaviorId: action.behaviorId,
      base: origin,
      attachments,
      timeoutMs: this.timeoutMs,
      resolveAddresses: async (o) => (await resolveWebhookTarget(o, this.allowlist)).addresses,
    });
  }

  // ── 私有：HTTP POST ───────────────────────────────────────────────────────

  private async doPost(request: PostRequest): Promise<ForwardResult> {
    const { webhookUrl, payload, action, scheme } = request;
    const rawSecret = request.secret;
    const rawPrevious = request.previous;
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      return fail("無效的 webhook URL");
    }

    url.searchParams.set("wait", "true");

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...scheme.marker,
    };

    // HMAC 簽署（CR-2 兩 mode）。每個請求一個 nonce；回應的簽章必須綁定
    // 它（#102），token mode 也送，讓有簽回應的 receiver 能綁。
    const authMode = action.authMode;
    const nonce = generateNonce();
    if (rawSecret) {
      if (authMode === "token") {
        // token mode：X-Plugin-Webhook-Token: <secret>（裸 shared secret）；
        // test-fire 改放 X-Plugin-Webhook-Test-Token（scheme 決定）
        headers[scheme.tokenHeader] = rawSecret;
        if (rawPrevious) headers[scheme.previousTokenHeader] = rawPrevious;
        headers[NONCE_HEADER] = nonce;
      } else if (authMode === "hmac") {
        const sigHeaders = buildOutboundSignatureHeaders(
          rawSecret,
          "POST",
          url.pathname,
          body,
          { nonce, prefix: scheme.signaturePrefix },
        );
        Object.assign(headers, sigHeaders);
        if (rawPrevious) {
          headers[PREVIOUS_SIGNATURE_HEADER] = signBody(
            rawPrevious,
            "POST",
            url.pathname,
            sigHeaders[TIMESTAMP_HEADER]!,
            sigHeaders[NONCE_HEADER]!,
            body,
            { prefix: scheme.signaturePrefix },
          );
        }
      }
      // authMode=null 且有 secret：異常狀態，不簽（已由 CR-6 DB CHECK 攔截）
    }

    // host-policy 檢查（與存檔時同一套：允許清單、https 規則、封鎖段）。
    // 回傳的 addresses 是實際檢查過的 IP，下面的連線只會打這些 IP。
    let target: WebhookTarget;
    try {
      target = await resolveWebhookTarget(url, this.allowlist);
    } catch (err) {
      if (!(err instanceof HostPolicyError)) throw err;
      return fail(err.message, undefined, err.code);
    }

    // 發送 HTTP POST —— connection pinned to the checked addresses so a DNS
    // answer that changes after the check (rebinding) can't redirect it.
    const agent = createPinnedAgent(target.addresses);
    let res: Response;
    let rawText: string | null;
    try {
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body,
          dispatcher: agent,
          // Do NOT follow redirects. resolveWebhookTarget above validated the
          // configured host, but a 3xx `Location` is attacker-controlled and
          // `redirect: "follow"` (the default) would chase it WITHOUT
          // re-validating — an SSRF into cloud metadata (169.254.169.254) or
          // internal hosts whose response we'd then relay back into Discord.
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
          // `dispatcher` is Node's (undici) fetch extension — absent from
          // the DOM RequestInit type the project compiles against.
        } as RequestInit);
      } catch (err) {
        const msg = errorText(err);
        return fail(`network error: ${msg}`);
      }

      // A webhook endpoint redirecting is not a success — and with
      // redirect: "manual" we won't have followed it. Treat any 3xx as a
      // failed delivery rather than reading the redirect body as content.
      if (res.status >= 300 && res.status < 400) {
        return fail(
          `webhook returned a redirect (HTTP ${res.status}); redirects are not followed`,
          res.status,
        );
      }

      try {
        rawText = await readCapped(res, MAX_REPLY_BODY_BYTES);
      } catch (err) {
        return fail(
          `could not read the response body: ${errorText(err)}`,
          res.status,
        );
      }
    } finally {
      // One-shot agent: drop its socket once the response is read (or
      // abandoned on the error / redirect paths above).
      void agent.destroy().catch(() => {});
    }

    if (rawText === null) {
      return fail(`response body exceeds ${MAX_REPLY_BODY_BYTES / 1024} KiB`, res.status);
    }

    if (!res.ok) {
      return fail(
        rawText ? rawText.slice(0, 500) : `HTTP ${res.status}`,
        res.status,
      );
    }

    // Response signature verification — over the REQUEST's nonce
    // (`<METHOD>:<path>:<ts>:<request nonce>:<body>`, #102), so a response
    // signed for another request (another user's) can't be swapped in. No
    // legacy nonce-less form: a hard switch, documented in
    // docs/features/behavior-webhook-protocol.md.
    //
    //  - hmac mode → required, fail closed if missing/invalid.
    //  - token mode → optional but verified opportunistically: if the
    //    webhook server signs its response with the shared bearer
    //    secret as the HMAC key, we verify and trust. If it omits the
    //    signature headers, we log once (deduped) so the operator
    //    knows responses from this behavior aren't authenticated,
    //    but accept the response — most existing token-mode webhooks
    //    don't sign and forcing them to upgrade in lockstep would
    //    break compat.
    //
    //  Webhook authors who want token-mode signing can use the same
    //  buildOutboundSignatureHeaders helper from utils/hmac.ts.
    const hasSignatureHeaders = res.headers.has(SIGNATURE_HEADER);
    let verified: ForwardResult["verified"];
    if (rawSecret && (authMode === "hmac" || hasSignatureHeaders)) {
      const verdict = verifyInboundSignatureWithKeys(
        rawPrevious ? [rawSecret, rawPrevious] : [rawSecret],
        res.headers,
        rawText,
        Math.floor(Date.now() / 1000),
        "POST",
        url.pathname,
        { boundNonce: nonce, prefix: scheme.signaturePrefix },
      );
      if (!verdict.ok) {
        return fail(verdict.reason, res.status, "response_signature");
      }
      verified = authMode === "hmac" ? "hmac" : "token";
    } else if (
      authMode === "token" &&
      rawText.length > 0 &&
      shouldRecord(`webhook-token-unsigned:${action.behaviorId}`)
    ) {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: behavior ${action.behaviorId} (token mode) returned an unsigned response — content is being relayed unauthenticated. Switch to hmac mode or sign responses with the shared secret to harden.`,
        { behaviorId: action.behaviorId, authMode },
      );
    }

    // 解析 response body（#140 回覆模型）。空 body = 動作選擇不回覆；
    // 非 JSON 或不是物件 = receiver 壞掉，算失敗（不再默默變成空回覆）。
    const okWith = (reply: ForwardResult["reply"], notes: ForwardResult["notes"]): ForwardResult => ({
      ok: true,
      reply,
      notes,
      status: res.status,
      ...(verified ? { verified } : {}),
    });
    if (rawText.length === 0) return okWith({}, []);
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawText);
    } catch {
      return fail("response body is not JSON", res.status);
    }
    const parsed = parseBehaviorReply(decoded);
    if (!parsed.ok) {
      return fail(parsed.error, res.status);
    }
    // a test-fire's notes go back to the admin, not into the log
    if (scheme === REAL_SCHEME) logReplyNotes(action.behaviorId, parsed.notes);
    return okWith(parsed.reply, parsed.notes);
  }

  // ── 私有：安全解密（不讓解密失敗 crash forward）──────────────────────────

  private safeDecrypt(encrypted: string, behaviorId: number): string | null {
    try {
      return decryptSecret(encrypted);
    } catch (err) {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: behavior ${behaviorId} webhookSecret 解密失敗，以 null 處理：${errorText(err)}`,
        { behaviorId },
      );
      return null;
    }
  }
}

/** The most reply attachment downloads in flight at once, process-wide (#156). */
export const MAX_DOWNLOAD_BATCHES = 2;

/**
 * Turns at something, at most `limit` at a time; the rest wait in order.
 * A waiter whose signal aborts leaves the queue without a turn.
 */
class Turns {
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  take(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        resolve(false);
      };
      // a released turn passes straight to the waiter: inFlight stays
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      };
      this.waiting.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight -= 1;
  }

  /** No turn taken and none waited for. */
  get idle(): boolean {
    return this.inFlight === 0 && this.waiting.length === 0;
  }
}

/** Reply attachment downloads in flight, process-wide (#156). */
const downloadTurns = new Turns(MAX_DOWNLOAD_BATCHES);
/** One download in flight per behavior; a key goes when it is idle. */
const behaviorDownloadTurns = new Map<number, Turns>();

/**
 * A turn to download a behavior's reply files: the behavior's own first
 * (so its second batch waits without holding a process-wide turn), then
 * a process-wide one. Resolves the release, or null when `signal` ended
 * the wait.
 */
async function takeDownloadTurn(behaviorId: number, signal: AbortSignal): Promise<(() => void) | null> {
  let own = behaviorDownloadTurns.get(behaviorId);
  if (!own) {
    own = new Turns(1);
    behaviorDownloadTurns.set(behaviorId, own);
  }
  const forget = () => {
    if (own.idle && behaviorDownloadTurns.get(behaviorId) === own) behaviorDownloadTurns.delete(behaviorId);
  };
  if (!(await own.take(signal))) {
    forget();
    return null;
  }
  if (!(await downloadTurns.take(signal))) {
    own.release();
    forget();
    return null;
  }
  return () => {
    downloadTurns.release();
    own.release();
    forget();
  };
}

/** One batch of a reply's attachments to download from one base URL. */
export interface ReplyFilesDownload {
  behaviorId: number;
  /**
   * What every path is appended to: a webhook URL's origin, or a plugin's
   * registered URL with its path prefix (#203), as the plugin RPC's own
   * attachments are (`<plugin.url><path>`). A file must stay under it.
   */
  base: URL;
  attachments: readonly ReplyAttachment[];
  timeoutMs: number;
  /** The target policy of the base's host: the addresses to connect to, or a throw. */
  resolveAddresses: (base: URL) => Promise<PinnedAddress[]>;
}

/**
 * Download a reply's attachments from under `base` (#156) under the rules
 * of fetchReplyFiles — a download turn, the base's target policy, a
 * connection pinned to the vetted addresses, no redirects, the caps, one
 * timeout for the batch. Shared by a webhook's run and a plugin action's
 * (#203), which differ only in the base and its policy. Never throws.
 */
export async function downloadReplyFiles(batch: ReplyFilesDownload): Promise<ReplyFilesResult> {
  const { base, attachments } = batch;
  const problem = attachmentsProblem(attachments);
  if (problem) return { ok: false, error: problem };
  if (attachments.length === 0) return { ok: true, files: [] };
  const signal = AbortSignal.timeout(batch.timeoutMs);
  const release = await takeDownloadTurn(batch.behaviorId, signal);
  if (!release) {
    return { ok: false, error: "timed out waiting for a download slot (the bot is downloading other replies' files)" };
  }
  try {
    let addresses: PinnedAddress[];
    try {
      // a lookup that hangs must not keep the turn past the timeout
      addresses = await untilAborted(batch.resolveAddresses(base), signal);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
    const agent = createPinnedAgent(addresses);
    const files: ReplyFile[] = [];
    let total = 0;
    try {
      for (const [i, attachment] of attachments.entries()) {
        const got = await fetchReplyFile(base, attachment, agent, signal, MAX_REPLY_ATTACHMENT_TOTAL_BYTES - total);
        if (!got.ok) {
          return { ok: false, error: `attachment ${i + 1} (${JSON.stringify(attachment.name)}): ${got.error}` };
        }
        total += got.file.data.byteLength;
        files.push(got.file);
      }
    } finally {
      // one-shot agent, as for the POST
      void agent.destroy().catch(() => {});
    }
    return { ok: true, files };
  } finally {
    release();
  }
}

/** `promise`, or a rejection with the signal's reason once it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

const MiB = 1024 * 1024;

/**
 * `path` (a single leading `/`, checked by attachmentsProblem) appended to
 * `base` — `<base without trailing slashes><path>` — or null when the
 * result is not under the base: another origin, or `..` segments that
 * climb out of its path prefix. For an origin base this is `path` on the
 * origin.
 */
export function fileUrl(base: URL, path: string): URL | null {
  const prefix = base.pathname.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${base.origin}${prefix}${path}`);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  return url;
}

/**
 * GET one attachment over the pinned connection, cut off past the per-file
 * cap or past `budget`, what is left of the batch's total.
 */
async function fetchReplyFile(
  base: URL,
  { name, path }: ReplyAttachment,
  agent: ReturnType<typeof createPinnedAgent>,
  signal: AbortSignal,
  budget: number,
): Promise<{ ok: true; file: ReplyFile } | { ok: false; error: string }> {
  const url = fileUrl(base, path);
  // attachmentsProblem lets only a plain path through; this is the backstop
  if (!url) return { ok: false, error: "the path leaves the base URL" };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      dispatcher: agent,
      // a Location is the receiver's to choose: never followed (SSRF)
      redirect: "manual",
      signal,
    } as RequestInit);
  } catch (err) {
    return { ok: false, error: `network error: ${errorText(err)}` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      error:
        res.status >= 300 && res.status < 400
          ? `a redirect (HTTP ${res.status}); redirects are not followed`
          : `HTTP ${res.status}`,
    };
  }
  let data: Buffer | null;
  try {
    data = await readCappedBytes(res, Math.min(MAX_REPLY_ATTACHMENT_BYTES, budget));
  } catch (err) {
    return { ok: false, error: `could not read it: ${errorText(err)}` };
  }
  if (data === null) {
    return {
      ok: false,
      error:
        budget < MAX_REPLY_ATTACHMENT_BYTES
          ? `the files together are larger than ${MAX_REPLY_ATTACHMENT_TOTAL_BYTES / MiB} MiB`
          : `larger than ${MAX_REPLY_ATTACHMENT_BYTES / MiB} MiB`,
    };
  }
  return { ok: true, file: { name, data } };
}
