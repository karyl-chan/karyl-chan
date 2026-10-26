import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCapability } from "../web-core/route-guards.js";
import { webhookAllowlist } from "../../config.js";
import type { AllowlistEntry } from "../../utils/webhook-allowlist.js";
import {
  BEHAVIOR_OPTION_TYPES,
  type BehaviorCommandOption,
} from "./models/behavior-definition.model.js";
import {
  HostPolicyError,
  resolveWebhookTarget,
  type HostPolicyCode,
} from "../../utils/host-policy.js";

export interface BehaviorRoutesOptions {
  /** BH-6.2 test-fire 用；未提供時 route 自建（測試注入 stub 用）。 */
  forwarder?: import("../command-system/webhook-forwarder.service.js").WebhookForwarder;
  /**
   * 指令寫入向 Discord 註冊用（CommandReconciler）；未提供時註冊延後到
   * 下一次 reconcile。
   */
  reconciler?: import("./command-registration-sync.js").BehaviorCommandRegistrar;
  /** 指令名稱衝突檢查（CommandNamespace）；指令寫入必填。 */
  namespace?: import("./command-registration-sync.js").CommandNamespaceChecker;
}

/**
 * The behavior module's gate: `behavior.manage` (or `admin`). ADR 0003
 * removed per-scope-tab delegation, so there is no finer-grained token.
 */
export function requireBehaviorAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  return requireCapability(request, reply, "behavior.manage");
}

/**
 * Save-time webhook URL check — the same policy the forwarder applies at
 * send time (`resolveWebhookTarget`: allowlist, https rule, blocked
 * ranges), so a target that would be refused is refused on save, with
 * the readable reason and its machine `code` for the 400 body.
 */
export async function isValidWebhookUrl(
  value: string,
  allowlist: readonly AllowlistEntry[] = webhookAllowlist,
): Promise<{ ok: true } | { ok: false; reason: string; code: HostPolicyCode }> {
  try {
    await resolveWebhookTarget(value, allowlist);
  } catch (err) {
    if (err instanceof HostPolicyError) {
      return { ok: false, reason: err.message, code: err.code };
    }
    throw err;
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
