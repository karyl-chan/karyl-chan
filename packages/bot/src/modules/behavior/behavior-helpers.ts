import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCapability } from "../web-core/route-guards.js";
import { webhookAllowlist } from "../../config.js";
import type { AllowlistEntry } from "../../utils/webhook-allowlist.js";
import {
  HostPolicyError,
  resolveWebhookTarget,
  type HostPolicyCode,
} from "../../utils/host-policy.js";
import { checkTriggerRegex, type TriggerRegexRefusal } from "../../utils/linear-regex.js";
import type { PluginActionCatalog } from "./behavior-action-input.js";

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
  reconciler?: import("./command-registration-sync.js").BehaviorCommandRegistrar &
    import("./system-login-trigger-route.js").SystemLoginRegistrar;
  /** Bot owners（測試用）；正式環境讀 BOT_OWNER_IDS。登入觸發的切換與系統指令 resync 只限 owner。 */
  ownerIds?: readonly string[];
  /** 指令名稱衝突檢查（CommandNamespace）；指令寫入必填。 */
  namespace?: import("./command-registration-sync.js").CommandNamespaceChecker;
  /**
   * 已安裝 plugin 宣告的 behavior action（#203）：綁定 plugin action 時驗證、
   * 動作選單列出。由 route wiring 注入（behavior 不 import plugin-system）；
   * 綁定 plugin action 時必填。
   */
  plugins?: PluginActionCatalog;
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

const REGEX_REFUSALS: Record<TriggerRegexRefusal, string> = {
  syntax: "the regex does not compile",
  not_linear:
    "the regex uses a feature that cannot run in linear time (backreferences, lookahead, large repeat counts); rewrite it without them",
  unsafe:
    "the regex may take exponential time on some messages (a repeat inside a repeat, like (a+)+); rewrite it without nesting repeats",
};

/**
 * Save-time regex check (#119) — the same compile the matcher runs
 * (`compileTriggerRegex`: the linear-time engine, or safe-regex2 without
 * it), so a pattern that would never match is refused on save, with the
 * reason.
 */
export function isValidRegex(value: string): { ok: true } | { ok: false; reason: string } {
  const refusal = checkTriggerRegex(value);
  return refusal === null ? { ok: true } : { ok: false, reason: REGEX_REFUSALS[refusal] };
}
