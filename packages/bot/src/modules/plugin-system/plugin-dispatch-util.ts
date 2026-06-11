/**
 * Shared plumbing for signed bot→plugin dispatch POSTs (PM-7.9 review
 * follow-up). Command / autocomplete / component / modal / lifecycle /
 * probe dispatches all resolve a manifest endpoint template against
 * the plugin's base URL, SSRF-check the target, and sign the body with
 * the per-plugin dispatch key. These used to be five private copies —
 * and the dispatch probe's whole value depends on resolving and
 * signing EXACTLY like a real dispatch, so the copies were a
 * correctness risk, not just noise.
 */

import type { PluginRow } from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { buildOutboundSignatureHeaders } from "../../utils/hmac.js";

export function parsePluginManifest(plugin: PluginRow): PluginManifest | null {
  try {
    return JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

/**
 * Substitute `{variable}` placeholders into an endpoint template and
 * resolve it against the plugin's base URL. Returns null when the
 * result is not a valid URL.
 */
export function resolvePluginEndpoint(
  baseUrl: string,
  template: string,
  variables: Record<string, string> = {},
): string | null {
  let path = template;
  for (const [k, v] of Object.entries(variables)) {
    path = path.split(`{${k}}`).join(encodeURIComponent(v));
  }
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * SSRF / reachability pre-flight for a resolved dispatch URL.
 * `assertPluginTarget` raises HostPolicyError both for policy refusals
 * and for DNS-resolution failures (an unreachable container), so a
 * `{ ok: false }` here means "this dispatch cannot reach the plugin" —
 * callers must record it into dispatch health, not just drop it.
 * Non-HostPolicyError failures rethrow.
 */
export async function preflightPluginTarget(
  url: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = new URL(url);
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsed.hostname, port);
    return { ok: true };
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    return { ok: false, reason: err.message };
  }
}

/** Content-Type + HMAC signature headers for a dispatch POST. */
export function buildSignedDispatchHeaders(
  secret: string,
  url: string,
  body: string,
): Record<string, string> {
  const urlPath = new URL(url).pathname;
  return {
    "Content-Type": "application/json",
    ...buildOutboundSignatureHeaders(secret, "POST", urlPath, body),
  };
}
