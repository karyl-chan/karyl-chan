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
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  recordProbeResult,
  classifyDispatchFetchError,
  classifyDispatchHttpFailure,
} from "./plugin-dispatch-health.service.js";
import {
  buildSignedDispatchHeaders,
  parsePluginManifest,
  preflightPluginTarget,
  resolvePluginEndpoint,
} from "./plugin-dispatch-util.js";

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
  /** Pre-flight refused: host-policy denial or DNS failure (plugin
   *  container gone). The dispatch path is broken — recorded as such. */
  | { outcome: "unreachable"; reason: string }
  /** Probe not attempted (no dispatch key / bad URL). */
  | { outcome: "skipped"; reason: string };

export async function probePluginDispatch(
  plugin: PluginRow,
): Promise<ProbeVerdict> {
  const key = plugin.dispatchHmacKey;
  if (!key) return { outcome: "skipped", reason: "no dispatch HMAC key" };

  // Resolve and sign through the SAME helpers real dispatches use —
  // the probe's verdict is only meaningful if it hits the exact URL
  // with the exact signature a real command dispatch would.
  const manifest = parsePluginManifest(plugin);
  const template =
    manifest?.endpoints?.plugin_command ?? DEFAULT_COMMAND_PATH;
  if (!template.includes("{command_name}")) {
    // A fixed dispatch path (register doesn't validate the template):
    // substituting nothing would aim the synthetic payload at the
    // plugin's REAL endpoint, where a non-SDK implementation might
    // execute it — the probe's no-side-effects promise only holds for
    // per-command paths.
    return {
      outcome: "skipped",
      reason: "endpoint template lacks {command_name} placeholder",
    };
  }
  const url = resolvePluginEndpoint(plugin.url, template, {
    command_name: PROBE_COMMAND_NAME,
  });
  if (!url) {
    return { outcome: "skipped", reason: "unresolvable plugin URL" };
  }
  const preflight = await preflightPluginTarget(url);
  if (!preflight.ok) {
    // Host-policy refusal or DNS failure — for a probe this is a
    // finding, not a skip: the dispatch path cannot reach the plugin.
    recordProbeResult(plugin.pluginKey, {
      ok: false,
      failureClass: "unreachable",
      message: `probe: ${preflight.reason}`,
    });
    return { outcome: "unreachable", reason: preflight.reason };
  }

  // `user` deliberately absent → the SDK answers 400 right after the
  // signature gate; a real command handler is never invoked.
  const body = JSON.stringify({
    command_name: PROBE_COMMAND_NAME,
    probe: true,
  });
  const headers = buildSignedDispatchHeaders(key, url, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  let verdict: ProbeVerdict;
  try {
    const res = await fetch(url, {
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
    } else if (res.ok) {
      verdict = { outcome: "signature_ok", status: res.status };
    } else if (res.status === 400 && isSdkPostAuth400(text)) {
      // The SDK's 400s all sit AFTER the signature gate, so a 400
      // proves the path — but ONLY when the body carries the SDK's
      // own post-auth markers. A bare 400 can come from a reverse
      // proxy / WAF / non-SDK endpoint that never ran the gate, and
      // calling that "signature verified" would be a false green in
      // the middle of the exact incident this probe exists to catch.
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
    recordProbeResult(plugin.pluginKey, {
      ok: false,
      failureClass: classifyDispatchFetchError(err),
      message: `probe: ${verdict.message}`,
    });
    return verdict;
  } finally {
    clearTimeout(timer);
  }

  switch (verdict.outcome) {
    case "signature_ok":
      recordProbeResult(plugin.pluginKey, {
        ok: true,
        status: verdict.status,
        message: "probe: signature verified",
      });
      break;
    case "rejected_401":
      recordProbeResult(plugin.pluginKey, {
        ok: false,
        status: 401,
        failureClass: "rejected_401",
        message: "probe: signature rejected",
      });
      break;
    case "awaiting_register":
      recordProbeResult(plugin.pluginKey, {
        ok: false,
        status: 503,
        failureClass: "awaiting_register",
        message: "probe: plugin awaiting register",
      });
      break;
    case "inconclusive":
      recordProbeResult(plugin.pluginKey, {
        ok: false,
        ...(verdict.status !== undefined ? { status: verdict.status } : {}),
        failureClass: "http_error",
        message: `probe: ${verdict.message}`,
      });
      break;
  }
  return verdict;
}

/**
 * The SDK's post-signature-gate 400 bodies for a user-less probe
 * payload. Pinned on the SDK side by the route-order contract test
 * (plugin-sdk tests) — keep the two in sync.
 */
function isSdkPostAuth400(bodyText: string): boolean {
  return (
    bodyText.includes("missing user.id") ||
    bodyText.includes("command_name mismatch")
  );
}

/**
 * Fire-and-forget probe a few seconds after a successful register —
 * the moment the wire format CAN be wrong is the moment we check it.
 * One retry when the plugin hasn't finished storing its key yet.
 * Never throws; failures land in dispatch health + botEventLog.
 *
 * Latest-wins per pluginKey (mirroring scheduleCommandSync): a
 * crash-looping plugin re-registering every few seconds replaces its
 * pending probe timer instead of stacking one — and one probe per
 * settled register is all the verdict needs anyway.
 */
const pendingRegisterProbes = new Map<string, NodeJS.Timeout>();

export function scheduleRegisterProbe(pluginKey: string): void {
  const prior = pendingRegisterProbes.get(pluginKey);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingRegisterProbes.delete(pluginKey);
    void runRegisterProbe(pluginKey, 1);
  }, REGISTER_PROBE_DELAY_MS);
  timer.unref();
  pendingRegisterProbes.set(pluginKey, timer);
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
      // The retry shares the latest-wins map so a re-register during
      // the retry window replaces it instead of double-probing.
      const prior = pendingRegisterProbes.get(pluginKey);
      if (prior) clearTimeout(prior);
      const retry = setTimeout(() => {
        pendingRegisterProbes.delete(pluginKey);
        void runRegisterProbe(pluginKey, 2);
      }, REGISTER_PROBE_RETRY_DELAY_MS);
      retry.unref();
      pendingRegisterProbes.set(pluginKey, retry);
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
