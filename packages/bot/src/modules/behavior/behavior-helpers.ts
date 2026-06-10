import type { Client } from "discord.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCapability } from "../web-core/route-guards.js";
import {
  hasBehaviorCapability,
  type AdminCapability,
} from "../admin/admin-capabilities.js";
import { decryptSecret } from "../../utils/crypto.js";
import type { BehaviorRow } from "./models/behavior.model.js";
import {
  assertExternalTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";

export interface BehaviorRoutesOptions {
  bot?: Client;
  reconciler?: import("../command-system/reconcile.service.js").CommandReconciler;
  /** BH-6.2 test-fire 用；未提供時 route 自建（測試注入 stub 用）。 */
  forwarder?: import("../command-system/webhook-forwarder.service.js").WebhookForwarder;
}

/**
 * Decrypt the URL + secret before handing them to the admin UI. Both
 * fields round-trip in plaintext: the URL is operator config (treated
 * as plain config like a host:port) and the secret is needed to
 * verify it matches what the receiving server expects. They remain
 * AES-encrypted at rest.
 */
export function decryptedView(row: BehaviorRow): BehaviorRow {
  return {
    ...row,
    webhookUrl: row.webhookUrl ? decryptSecret(row.webhookUrl) : row.webhookUrl,
    webhookSecret: row.webhookSecret ? decryptSecret(row.webhookSecret) : null,
  };
}

/**
 * Module-level gate for actions that mutate the TARGET catalog itself
 * (add target, delete target, manage group membership). Per the spec
 * scoped users can only CRUD behaviors UNDER targets they were granted
 * — the catalog stays admin / behavior.manage.
 */
export function requireBehaviorAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  return requireCapability(request, reply, "behavior.manage");
}

// ── BH-5：scoped 委派（behavior:<scopeKey>.manage）────────────────────────────

function grantedCaps(request: FastifyRequest): Set<AdminCapability> {
  return (request.authCapabilities ?? new Set()) as Set<AdminCapability>;
}

/** 持全域 behavior.manage（或 admin）。 */
export function hasGlobalBehaviorManage(request: FastifyRequest): boolean {
  const caps = grantedCaps(request);
  return caps.has("admin") || caps.has("behavior.manage");
}

/**
 * 進入 behavior 模組的最低門檻：全域 token、或至少一張 scoped token。
 * 個別資源仍須通過 requireBehaviorScope（per-tab 比對）。
 */
export function requireAnyBehaviorAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (hasGlobalBehaviorManage(request)) return true;
  for (const cap of grantedCaps(request)) {
    if (typeof cap === "string" && /^behavior:.+\.manage$/.test(cap)) {
      return true;
    }
  }
  void reply.code(403).send({ error: "缺少 behavior 管理權限" });
  return false;
}

/** 純判斷版（list 過濾用，不發 403）。 */
export function behaviorScopeAllowed(
  request: FastifyRequest,
  scopeKey: string,
): boolean {
  return hasBehaviorCapability(grantedCaps(request), scopeKey);
}

/**
 * Per-tab 守衛：admin / behavior.manage / 對應 behavior:<scopeKey>.manage
 * 任一即過；否則 403。day-1 設計的委派邊界（BH-5 接線）。
 */
export function requireBehaviorScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scopeKey: string,
): boolean {
  if (behaviorScopeAllowed(request, scopeKey)) return true;
  void reply.code(403).send({ error: "缺少此範圍的 behavior 管理權限" });
  return false;
}

export async function isValidWebhookUrl(
  value: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: "無效的 URL 格式" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Webhook URL 必須使用 http 或 https" };
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  try {
    await assertExternalTarget(u.hostname, port);
  } catch (err) {
    const reason =
      err instanceof HostPolicyError ? err.message : "Webhook 目標不被允許";
    return { ok: false, reason };
  }
  return { ok: true };
}

export function isValidRegex(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

// ── BH-2.2C：slash command options 驗證 ──────────────────────────────────────

/** behaviors 允許的扁平 scalar option 型別（OPTION_TYPE_MAP 的子集；
 *  不開 sub_command / choices / autocomplete —— 那些屬 plugin SDK 的進階面）。 */
export const BEHAVIOR_OPTION_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "user",
  "channel",
  "role",
  "mentionable",
  "attachment",
] as const;

export interface BehaviorCommandOption {
  type: (typeof BEHAVIOR_OPTION_TYPES)[number];
  name: string;
  description: string;
  required: boolean;
}

const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_OPTIONS = 10;

/**
 * 驗證 admin 提交的 slash command options 定義並正規化。
 * Discord 的硬規則都在這裡擋：name 格式、description 長度、required 必須
 * 排在 optional 前、名稱不重複、數量上限。
 */
export function parseSlashCommandOptions(
  raw: unknown,
):
  | { ok: true; options: BehaviorCommandOption[] }
  | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "slashCommandOptions 必須是陣列" };
  }
  if (raw.length > MAX_OPTIONS) {
    return { ok: false, reason: `options 過多 (max ${MAX_OPTIONS})` };
  }
  const options: BehaviorCommandOption[] = [];
  const seen = new Set<string>();
  let sawOptional = false;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: "option 必須是物件" };
    }
    const o = item as Record<string, unknown>;
    const type = String(o["type"] ?? "");
    if (!(BEHAVIOR_OPTION_TYPES as readonly string[]).includes(type)) {
      return { ok: false, reason: `不支援的 option 型別：${type}` };
    }
    const name = String(o["name"] ?? "");
    if (!OPTION_NAME_RE.test(name)) {
      return {
        ok: false,
        reason: `option 名稱必須是 1-32 字的 [a-z0-9_-]：'${name}'`,
      };
    }
    if (seen.has(name)) {
      return { ok: false, reason: `option 名稱重複：'${name}'` };
    }
    seen.add(name);
    const description = String(o["description"] ?? "").trim();
    if (!description || description.length > 100) {
      return {
        ok: false,
        reason: `option '${name}' 的 description 必填且 ≤100 字`,
      };
    }
    const required = !!o["required"];
    // Discord 規則：required options 必須排在所有 optional 之前
    if (required && sawOptional) {
      return {
        ok: false,
        reason: "required option 必須排在 optional options 之前",
      };
    }
    if (!required) sawOptional = true;
    options.push({
      type: type as BehaviorCommandOption["type"],
      name,
      description,
      required,
    });
  }
  return { ok: true, options };
}
