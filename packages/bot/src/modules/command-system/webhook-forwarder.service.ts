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
 *     要 receiver 先同時接受 -Previous header（docs/features/behaviors.md）。
 *   - URL 解密後才用
 *   - 解析 response 拿 relayContent / relayEmbeds
 *   - 回 ForwardResult { ok, relayContent, relayEmbeds?, status?, error? }
 */

import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  buildOutboundSignatureHeaders,
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
import type { ForwardResult, SanitizedEmbed } from "./types.js";

// ── BH-2.2A：embeds 白名單清洗 ───────────────────────────────────────────────
// webhook 回應來自外部服務，不可信：只搬白名單欄位、強制型別、按 Discord
// 上限截斷。壞形狀的個別 embed 靜默丟棄（content 仍照常 relay）。

const MAX_EMBEDS = 10;
const MAX_FIELDS = 25;

function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function sanitizeOneEmbed(raw: unknown): SanitizedEmbed | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const out: SanitizedEmbed = {};
  const title = clampStr(e["title"], 256);
  if (title) out.title = title;
  const description = clampStr(e["description"], 4096);
  if (description) out.description = description;
  const url = clampStr(e["url"], 2048);
  if (url && /^https?:\/\//i.test(url)) out.url = url;
  if (typeof e["color"] === "number" && Number.isInteger(e["color"])) {
    out.color = Math.max(0, Math.min(0xffffff, e["color"]));
  }
  const ts = clampStr(e["timestamp"], 64);
  if (ts && !Number.isNaN(new Date(ts).getTime())) out.timestamp = ts;
  const footer = e["footer"] as Record<string, unknown> | undefined;
  const footerText = footer ? clampStr(footer["text"], 2048) : undefined;
  if (footerText) {
    out.footer = { text: footerText };
    const icon = footer ? clampStr(footer["icon_url"], 2048) : undefined;
    if (icon && /^https?:\/\//i.test(icon)) out.footer.icon_url = icon;
  }
  for (const key of ["image", "thumbnail"] as const) {
    const obj = e[key] as Record<string, unknown> | undefined;
    const u = obj ? clampStr(obj["url"], 2048) : undefined;
    if (u && /^https?:\/\//i.test(u)) out[key] = { url: u };
  }
  const author = e["author"] as Record<string, unknown> | undefined;
  const authorName = author ? clampStr(author["name"], 256) : undefined;
  if (authorName) {
    out.author = { name: authorName };
    const aUrl = author ? clampStr(author["url"], 2048) : undefined;
    if (aUrl && /^https?:\/\//i.test(aUrl)) out.author.url = aUrl;
    const aIcon = author ? clampStr(author["icon_url"], 2048) : undefined;
    if (aIcon && /^https?:\/\//i.test(aIcon)) out.author.icon_url = aIcon;
  }
  if (Array.isArray(e["fields"])) {
    const fields: NonNullable<SanitizedEmbed["fields"]> = [];
    for (const f of e["fields"] as unknown[]) {
      if (typeof f !== "object" || f === null) continue;
      const fr = f as Record<string, unknown>;
      const name = clampStr(fr["name"], 256);
      const value = clampStr(fr["value"], 1024);
      if (!name || !value) continue;
      fields.push({ name, value, inline: !!fr["inline"] });
      if (fields.length >= MAX_FIELDS) break;
    }
    if (fields.length > 0) out.fields = fields;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function sanitizeEmbeds(raw: unknown): SanitizedEmbed[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedEmbed[] = [];
  for (const item of raw) {
    const e = sanitizeOneEmbed(item);
    if (e) out.push(e);
    if (out.length >= MAX_EMBEDS) break;
  }
  return out;
}

/** X-Plugin-Webhook-Token header name（CR-2 token mode）。 */
const PLUGIN_WEBHOOK_TOKEN_HEADER = "x-plugin-webhook-token";

/** 輪換寬限期內，舊密鑰的 token / 簽章（#99）。 */
export const PREVIOUS_TOKEN_HEADER = "x-plugin-webhook-token-previous";
export const PREVIOUS_SIGNATURE_HEADER = "x-karyl-signature-previous";

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
   * @returns        含 relayContent / relayEmbeds 的結果
   */
  async forward(
    action: BehaviorWebhookActionRow,
    payload: Record<string, unknown>,
  ): Promise<ForwardResult> {
    let webhookUrl: string;
    try {
      webhookUrl = decryptSecret(action.url);
    } catch (err) {
      return {
        ok: false,
        relayContent: "",
        error: `webhookUrl 解密失敗：${err instanceof Error ? err.message : String(err)}`,
      };
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
      return {
        ok: false,
        relayContent: "",
        error:
          "hmac mode: webhook secret unavailable (rotated key or corrupt ciphertext) — refusing to forward unsigned",
      };
    }

    // 輪換寬限期內的舊密鑰；過期或解不開就當作沒有
    const rawPrevious =
      rawSecret !== null &&
      action.previousSecret !== null &&
      action.previousSecretExpiresAt !== null &&
      action.previousSecretExpiresAt.getTime() > Date.now()
        ? this.safeDecrypt(action.previousSecret, action.behaviorId)
        : null;

    return this.doPost(webhookUrl, payload, action, rawSecret, rawPrevious);
  }

  // ── 私有：HTTP POST ───────────────────────────────────────────────────────

  private async doPost(
    webhookUrl: string,
    payload: Record<string, unknown>,
    action: BehaviorWebhookActionRow,
    rawSecret: string | null,
    rawPrevious: string | null,
  ): Promise<ForwardResult> {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      return {
        ok: false,
        relayContent: "",
        error: "無效的 webhook URL",
      };
    }

    url.searchParams.set("wait", "true");

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // HMAC 簽署（CR-2 兩 mode）
    const authMode = action.authMode;
    if (rawSecret) {
      if (authMode === "token") {
        // token mode：X-Plugin-Webhook-Token: <secret>（裸 shared secret）
        headers[PLUGIN_WEBHOOK_TOKEN_HEADER] = rawSecret;
        if (rawPrevious) headers[PREVIOUS_TOKEN_HEADER] = rawPrevious;
      } else if (authMode === "hmac") {
        const sigHeaders = buildOutboundSignatureHeaders(
          rawSecret,
          "POST",
          url.pathname,
          body,
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
      return {
        ok: false,
        relayContent: "",
        error: err.message,
        errorCode: err.code,
      };
    }

    // 發送 HTTP POST —— connection pinned to the checked addresses so a DNS
    // answer that changes after the check (rebinding) can't redirect it.
    const agent = createPinnedAgent(target.addresses);
    let res: Response;
    let rawText: string;
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
        return {
          ok: false,
          relayContent: "",
          error: `network error: ${msg}`,
        };
      }

      // A webhook endpoint redirecting is not a success — and with
      // redirect: "manual" we won't have followed it. Treat any 3xx as a
      // failed delivery rather than reading the redirect body as content.
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          relayContent: "",
          status: res.status,
          error: `webhook returned a redirect (HTTP ${res.status}); redirects are not followed`,
        };
      }

      rawText = await res.text().catch(() => "");
    } finally {
      // One-shot agent: drop its socket once the response is read (or
      // abandoned on the error / redirect paths above).
      void agent.destroy().catch(() => {});
    }

    if (!res.ok) {
      return {
        ok: false,
        relayContent: "",
        status: res.status,
        error: rawText ? rawText.slice(0, 500) : `HTTP ${res.status}`,
      };
    }

    // Response signature verification:
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
    if (rawSecret && (authMode === "hmac" || hasSignatureHeaders)) {
      const verdict = verifyInboundSignatureWithKeys(
        rawPrevious ? [rawSecret, rawPrevious] : [rawSecret],
        res.headers,
        rawText,
        Math.floor(Date.now() / 1000),
        "POST",
        url.pathname,
      );
      if (!verdict.ok) {
        return {
          ok: false,
          relayContent: "",
          status: res.status,
          error: verdict.reason,
        };
      }
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

    // 解析 response body
    let responseContent = "";
    let relayEmbeds: SanitizedEmbed[] | undefined;
    if (rawText.length > 0) {
      try {
        const parsed = JSON.parse(rawText) as {
          content?: unknown;
          embeds?: unknown;
        };
        if (typeof parsed.content === "string") {
          responseContent = parsed.content;
        }
        // BH-2.2A：embeds（白名單清洗；壞形狀靜默丟個別 embed）
        const sanitized = sanitizeEmbeds(parsed.embeds);
        if (sanitized.length > 0) relayEmbeds = sanitized;
      } catch {
        // wait=true 應永遠回 JSON，misbehaving webhook server 回純文字時視為無 content
        return { ok: true, relayContent: "" };
      }
    }

    return { ok: true, relayContent: responseContent.trim(), relayEmbeds };
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
