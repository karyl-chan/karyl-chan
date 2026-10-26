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
 *   - 回 ForwardResult { ok, reply, notes, status?, error? }
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
import { createPinnedAgent } from "../../utils/pinned-dispatcher.js";
import { webhookAllowlist } from "../../config.js";
import type { AllowlistEntry } from "../../utils/webhook-allowlist.js";
import { decryptSecret } from "../../utils/crypto.js";
import type { BehaviorWebhookActionRow } from "../behavior/models/behavior-webhook-action.model.js";
import type { ForwardErrorCode, ForwardResult } from "./types.js";
import {
  MAX_REPLY_BODY_BYTES,
  parseBehaviorReply,
  type ReplyNote,
} from "./behavior-reply.js";

/**
 * Read the body, giving up past `max` bytes (null). A declared
 * Content-Length over the cap is refused before reading anything.
 */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
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
   */
  constructor(
    private readonly allowlist: readonly AllowlistEntry[] = webhookAllowlist,
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
        `webhookUrl 解密失敗：${err instanceof Error ? err.message : String(err)}`,
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
          signal: AbortSignal.timeout(10_000),
          // `dispatcher` is Node's (undici) fetch extension — absent from
          // the DOM RequestInit type the project compiles against.
        } as RequestInit);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
          `could not read the response body: ${err instanceof Error ? err.message : String(err)}`,
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
    const okWith = (reply: ForwardResult["reply"], notes: ForwardResult["notes"]): ForwardResult =>
      verified ? { ok: true, reply, notes, verified } : { ok: true, reply, notes };
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
        `webhook-forwarder: behavior ${behaviorId} webhookSecret 解密失敗，以 null 處理：${err instanceof Error ? err.message : String(err)}`,
        { behaviorId },
      );
      return null;
    }
  }
}
