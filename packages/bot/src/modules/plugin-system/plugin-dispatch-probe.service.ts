/**
 * Signed dispatch probe (PM-7.9.4).
 *
 * Verifies the bot→plugin dispatch HMAC path end-to-end without
 * waiting for a real user interaction. The probe POSTs to the
 * plugin's command-dispatch endpoint (the SDK mounts
 * `/commands/:commandName` unconditionally) a fully signed payload
 * that deliberately omits `user` — the SDK's route order makes the
 * response a clean verdict with NO side effects:
 *
 *   1. no dispatch key yet            → 503 "dispatch HMAC key …"
 *   2. signature verification fails   → 401   ← scheme mismatch
 *   3. signature passes, JSON parses,
 *      command_name matches, but
 *      user.id is missing             → 400   ← path proven, handler
 *                                              lookup never reached
 *
 * A 401 here is the 2026-06-11 incident signature (bot and SDK
 * disagreeing on the HMAC scheme), surfaced seconds after register
 * instead of when the first user command fails. Works against every
 * SDK version — older SDKs reject at step 2, which is exactly the
 * verdict we need; no SDK-side probe support required.
 *
 * Outcomes are recorded into the dispatch-health window (PM-7.9.1,
 * source "probe") so the PluginCard badge fires without user traffic.
 */

import {
  findPluginByKey,
  type PluginRow,
} from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";
import {
  recordDispatchAttempt,
  classifyDispatchFetchError,
  classifyDispatchHttpFailure,
} from "./plugin-dispatch-health.service.js";

/** Never collides with a real handler: the missing-user 400 fires
 *  before the SDK's handler lookup even for a same-named command. */
export const PROBE_COMMAND_NAME = "kc-dispatch-probe";
const DEFAULT_COMMAND_PATH = "/commands/{command_name}";
const PROBE_TIMEOUT_MS = 5_000;
/** Register response must reach the plugin (which stores the dispatch
 *  key from it) before a probe can succeed — give it a moment. */
const REGISTER_PROBE_DELAY_MS = 3_000;
const REGISTER_PROBE_RETRY_DELAY_MS = 5_000;

export type ProbeVerdict =
  /** Signature verified end-to-end (SDK answered past the auth gate). */
  | { outcome: "signature_ok"; status: number }
  /** Plugin rejected the signature — HMAC scheme/key mismatch. */
  | { outcome: "rejected_401" }
  /** Plugin is up but hasn't completed its register handshake. */
  | { outcome: "awaiting_register" }
  /** Transport error or a status that proves nothing either way. */
  | { outcome: "inconclusive"; status?: number; message: string }
  /** Probe not attempted (no dispatch key / bad URL / host policy). */
  | { outcome: "skipped"; reason: string };

export async function probePluginDispatch(
  plugin: PluginRow,
): Promise<ProbeVerdict> {
  const key = plugin.dispatchHmacKey;
  if (!key) return { outcome: "skipped", reason: "no dispatch HMAC key" };

  let manifest: PluginManifest | null = null;
  try {
    manifest = JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    /* placeholder row — fall through to the default path template */
  }
  const template =
    manifest?.endpoints?.plugin_command ?? DEFAULT_COMMAND_PATH;
  const path = template
    .split("{command_name}")
    .join(encodeURIComponent(PROBE_COMMAND_NAME));
  let url: URL;
  try {
    url = new URL(path, plugin.url);
  } catch {
    return { outcome: "skipped", reason: "unresolvable plugin URL" };
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(url.hostname, port);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    return { outcome: "skipped", reason: `host policy: ${err.message}` };
  }

  // `user` deliberately absent → the SDK answers 400 right after the
  // signature gate; a real command handler is never invoked.
  const body = JSON.stringify({
    command_name: PROBE_COMMAND_NAME,
    probe: true,
  });
  const headers = {
    "Content-Type": "application/json",
    ...buildOutboundSignatureHeaders(key, "POST", url.pathname, body),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  let verdict: ProbeVerdict;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    // Reuse the shared classifier: the 503 awaiting-register body sniff must
    // have exactly one owner (plugin-dispatch-health.service).
    const failureClass = res.ok ? undefined : classifyDispatchHttpFailure(res.status, text);
    if (failureClass === "rejected_401") {
      verdict = { outcome: "rejected_401" };
    } else if (failureClass === "awaiting_register") {
      verdict = { outcome: "awaiting_register" };
    } else if (res.ok || res.status === 400) {
      // Every 400 branch in the SDK's command route sits AFTER the
      // signature gate, so a 400 proves the path as well as a 2xx.
      verdict = { outcome: "signature_ok", status: res.status };
    } else {
      verdict = {
        outcome: "inconclusive",
        status: res.status,
        message: `HTTP ${res.status}: ${text.slice(0, 120)}`,
      };
    }
  } catch (err) {
    verdict = {
      outcome: "inconclusive",
      message: err instanceof Error ? err.message : String(err),
    };
    recordDispatchAttempt(plugin.pluginKey, {
      ok: false,
      source: "probe",
      failureClass: classifyDispatchFetchError(err),
      message: `probe: ${verdict.message}`,
    });
    return verdict;
  } finally {
    clearTimeout(timer);
  }

  switch (verdict.outcome) {
    case "signature_ok":
      recordDispatchAttempt(plugin.pluginKey, {
        ok: true,
        source: "probe",
        status: verdict.status,
        message: "probe: signature verified",
      });
      break;
    case "rejected_401":
      recordDispatchAttempt(plugin.pluginKey, {
        ok: false,
        source: "probe",
        status: 401,
        failureClass: "rejected_401",
        message: "probe: signature rejected",
      });
      break;
    case "awaiting_register":
      recordDispatchAttempt(plugin.pluginKey, {
        ok: false,
        source: "probe",
        status: 503,
        failureClass: "awaiting_register",
        message: "probe: plugin awaiting register",
      });
      break;
    case "inconclusive":
      recordDispatchAttempt(plugin.pluginKey, {
        ok: false,
        source: "probe",
        ...(verdict.status !== undefined ? { status: verdict.status } : {}),
        failureClass: "http_error",
        message: `probe: ${verdict.message}`,
      });
      break;
  }
  return verdict;
}

/**
 * Fire-and-forget probe a few seconds after a successful register —
 * the moment the wire format CAN be wrong is the moment we check it.
 * One retry when the plugin hasn't finished storing its key yet.
 * Never throws; failures land in dispatch health + botEventLog.
 */
export function scheduleRegisterProbe(pluginKey: string): void {
  setTimeout(() => {
    void runRegisterProbe(pluginKey, 1);
  }, REGISTER_PROBE_DELAY_MS).unref();
}

async function runRegisterProbe(
  pluginKey: string,
  attempt: number,
): Promise<void> {
  try {
    const row = await findPluginByKey(pluginKey);
    if (!row || row.status !== "active") return;
    const verdict = await probePluginDispatch(row);
    if (verdict.outcome === "awaiting_register" && attempt === 1) {
      setTimeout(() => {
        void runRegisterProbe(pluginKey, 2);
      }, REGISTER_PROBE_RETRY_DELAY_MS).unref();
      return;
    }
    if (verdict.outcome === "rejected_401") {
      botEventLog.record(
        "warn",
        "bot",
        `dispatch probe: '${pluginKey}' rejected the bot's signed probe with 401 right after register — the plugin's SDK and this bot disagree on the dispatch HMAC scheme (rebuild the plugin against a compatible @karyl-chan/plugin-sdk)`,
        { pluginId: row.id, pluginKey },
      );
    }
  } catch {
    /* register-time probe is best-effort by design */
  }
}
