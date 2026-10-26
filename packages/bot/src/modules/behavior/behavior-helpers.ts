import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCapability } from "../web-core/route-guards.js";
import { webhookAllowlist } from "../../config.js";
import type { AllowlistEntry } from "../../utils/webhook-allowlist.js";
import {
  HostPolicyError,
  resolveWebhookTarget,
  type HostPolicyCode,
} from "../../utils/host-policy.js";

export interface BehaviorRoutesOptions {
  /**
   * BH-6.2 test-fire 用（runtime 的 WebhookForwarder，由 route wiring 注入；
   * 測試注入 stub）。test-fire 必填。
   */
  forwarder?: Pick<
    import("../command-system/webhook-forwarder.service.js").WebhookForwarder,
    "forward"
  >;
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
