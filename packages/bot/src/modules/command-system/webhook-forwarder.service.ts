/**
 * command-system/webhook-forwarder.service.ts
 *
 * WebhookForwarder：把 `source='custom'` behavior 的 webhook 轉發到 admin
 * 設定的外部 URL（POST schema 對齊 RESTPostAPIWebhookWithTokenJSONBody）。
 *
 *   - HMAC 簽署依 behavior.webhookAuthMode（CR-2）：
 *       'token'  → X-Plugin-Webhook-Token: <secret>
 *       'hmac'   → X-Karyl-Signature + X-Karyl-Timestamp
 *       null     → 不簽（裸 HTTP）
 *   - source='system' 不發外部 HTTP（InteractionDispatcher 不會呼叫 forward()）
 *   - URL 從 behaviors.webhookUrl 解密讀
 *   - 解析 response 拿 relayContent + 偵測 [BEHAVIOR:END] sentinel
 *   - 回 ForwardResult { ok, ended, relayContent, status?, error? }
 */

import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  buildOutboundSignatureHeaders,
  verifyInboundSignature,
  SIGNATURE_HEADER,
} from "../../utils/hmac.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  assertExternalTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { decryptSecret } from "../../utils/crypto.js";
import type { BehaviorRow } from "../behavior/models/behavior.model.js";
import type { ForwardResult, SanitizedEmbed } from "./types.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

/**
 * sentinel token（C-runtime §7.3 / R-3 保留）。
 * 出現在 response.content 時觸發 endSession。
 * 與 webhook-dispatch.service.ts 的 BEHAVIOR_END_TOKEN 一致。
 */
export const BEHAVIOR_END_TOKEN = "[BEHAVIOR:END]";
const BEHAVIOR_END_RE = /\[BEHAVIOR:END\]/gi;

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

// ── WebhookForwarder ─────────────────────────────────────────────────────────

export class WebhookForwarder {
  /**
   * 轉發 behavior webhook POST。
   *
   * @param behavior  behaviors 表的 row（含三軸欄位）
   * @param payload   Discord webhook 形狀的 body（RESTPostAPIWebhookWithTokenJSONBody 相容）
   * @returns         含 ended / relayContent 的結果
   */
  async forward(
    behavior: BehaviorRow,
    payload: Record<string, unknown>,
  ): Promise<ForwardResult> {
    // source=system 不應該流到這裡
    if (behavior.source === "system") {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: source=system behavior ${behavior.id} 不應呼叫 forward()，跳過`,
        { behaviorId: behavior.id },
      );
      return {
        ok: false,
        ended: false,
        relayContent: "",
        error: "source=system behaviors 不走外部 HTTP 轉發",
      };
    }

    // 計算目標 URL
    const urlResult = await this.resolveUrl(behavior);
    if (!urlResult.ok) {
      return {
        ok: false,
        ended: false,
        relayContent: "",
        error: urlResult.error,
      };
    }
    const webhookUrl = urlResult.url;

    // 計算 secret（需在解密後才能簽署）
    const rawSecret = behavior.webhookSecret
      ? this.safeDecrypt(behavior.webhookSecret, behavior.id)
      : null;

    // hmac mode is fail-CLOSED by contract (see doPost's response-verification
    // note). Without a usable secret we can neither sign the outbound request
    // nor verify the response, so refuse to forward rather than silently
    // sending unsigned + relaying an unverified response into the user's DM.
    // safeDecrypt returns null on a rotated-out key id / corrupt ciphertext —
    // a reachable operational state, not merely a missing secret (which the
    // model's CHECK already forbids for hmac mode).
    if (behavior.webhookAuthMode === "hmac" && rawSecret === null) {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: behavior ${behavior.id} is hmac mode but its webhookSecret could not be decrypted — refusing to forward (fail closed).`,
        { behaviorId: behavior.id },
      );
      return {
        ok: false,
        ended: false,
        relayContent: "",
        error:
          "hmac mode: webhook secret unavailable (rotated key or corrupt ciphertext) — refusing to forward unsigned",
      };
    }

    return this.doPost(webhookUrl, payload, behavior, rawSecret);
  }

  // ── 私有：URL 解析 ────────────────────────────────────────────────────────

  private async resolveUrl(
    behavior: BehaviorRow,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    if (behavior.source === "custom") {
      // source=custom：URL 從 behaviors.webhookUrl 解密讀
      if (!behavior.webhookUrl) {
        return { ok: false, error: "custom behavior 缺少 webhookUrl" };
      }
      try {
        const decrypted = decryptSecret(behavior.webhookUrl);
        return { ok: true, url: decrypted };
      } catch (err) {
        return {
          ok: false,
          error: `webhookUrl 解密失敗：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { ok: false, error: `未知或不可轉發的 source：${behavior.source}` };
  }

  // ── 私有：HTTP POST ───────────────────────────────────────────────────────

  private async doPost(
    webhookUrl: string,
    payload: Record<string, unknown>,
    behavior: BehaviorRow,
    rawSecret: string | null,
  ): Promise<ForwardResult> {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      return {
        ok: false,
        ended: false,
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
    const authMode = behavior.webhookAuthMode;
    if (rawSecret) {
      if (authMode === "token") {
        // token mode：X-Plugin-Webhook-Token: <secret>（裸 shared secret）
        headers[PLUGIN_WEBHOOK_TOKEN_HEADER] = rawSecret;
      } else if (authMode === "hmac") {
        const sigHeaders = buildOutboundSignatureHeaders(
          rawSecret,
          "POST",
          url.pathname,
          body,
        );
        Object.assign(headers, sigHeaders);
      }
      // authMode=null 且有 secret：異常狀態，不簽（已由 CR-6 DB CHECK 攔截）
    }

    // host-policy 檢查
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;

    try {
      await assertExternalTarget(url.hostname, port);
    } catch (err) {
      if (!(err instanceof HostPolicyError)) throw err;
      return { ok: false, ended: false, relayContent: "", error: err.message };
    }

    // 發送 HTTP POST
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        // Do NOT follow redirects. assertExternalTarget above validated the
        // configured host, but a 3xx `Location` is attacker-controlled and
        // `redirect: "follow"` (the default) would chase it WITHOUT
        // re-validating — an SSRF into cloud metadata (169.254.169.254) or
        // internal hosts whose response we'd then relay back into Discord.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        ended: false,
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
        ended: false,
        relayContent: "",
        status: res.status,
        error: `webhook returned a redirect (HTTP ${res.status}); redirects are not followed`,
      };
    }

    const rawText = await res.text().catch(() => "");

    if (!res.ok) {
      return {
        ok: false,
        ended: false,
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
      const verdict = verifyInboundSignature(
        rawSecret,
        res.headers,
        rawText,
        Math.floor(Date.now() / 1000),
        "POST",
        url.pathname,
      );
      if (!verdict.ok) {
        return {
          ok: false,
          ended: false,
          relayContent: "",
          status: res.status,
          error: verdict.reason,
        };
      }
    } else if (
      authMode === "token" &&
      rawText.length > 0 &&
      shouldRecord(`webhook-token-unsigned:${behavior.id}`)
    ) {
      botEventLog.record(
        "warn",
        "bot",
        `webhook-forwarder: behavior ${behavior.id} (token mode) returned an unsigned response — content is being relayed unauthenticated. Switch to hmac mode or sign responses with the shared secret to harden.`,
        { behaviorId: behavior.id, authMode },
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
        return { ok: true, ended: false, relayContent: "" };
      }
    }

    // 偵測 [BEHAVIOR:END] sentinel（C-runtime §7.3 / R-3）
    const ended = BEHAVIOR_END_RE.test(responseContent);
    BEHAVIOR_END_RE.lastIndex = 0; // 重置 global regex lastIndex
    const relayContent = ended
      ? responseContent.replace(BEHAVIOR_END_RE, "").trim()
      : responseContent.trim();
    BEHAVIOR_END_RE.lastIndex = 0;

    return { ok: true, ended, relayContent, relayEmbeds };
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
