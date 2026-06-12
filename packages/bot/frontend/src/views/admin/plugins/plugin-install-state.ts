/**
 * Install-journey state derivation (PD-1.2), extracted pure so the
 * precedence is unit-testable.
 *
 * The plugins API already carries everything needed to tell an operator
 * WHERE in the install journey a plugin is — this maps those fields to
 * one explicit position instead of leaving "secret minted but the
 * container never registered" indistinguishable from a healthy row.
 */

export type PluginInstallState =
  /** Setup secret minted; the plugin process has never registered.
   *  The placeholder row keeps `version: "0.0.0"` until the first real
   *  register replaces it — that, not `status`, is the reliable signal
   *  (the placeholder is born `status: "active"` and only flips to
   *  inactive when the heartbeat reaper catches up). */
  | "awaiting-registration"
  /** Registered at least once, but heartbeats stopped (reaper expired it). */
  | "offline"
  /** Online, but declared RPC scopes await admin approval. */
  | "scope-pending"
  /** Online and registered, but the admin hasn't flipped `enabled` yet. */
  | "not-enabled"
  /** Registered, online, enabled — journey complete. */
  | "ok";

export interface InstallStateInput {
  version: string;
  status: "active" | "inactive";
  enabled: boolean;
  pendingRpcScopes?: string[] | null;
}

export function pluginInstallState(p: InstallStateInput): PluginInstallState {
  if (p.version === "0.0.0") return "awaiting-registration";
  if (p.status === "inactive") return "offline";
  if ((p.pendingRpcScopes?.length ?? 0) > 0) return "scope-pending";
  if (!p.enabled) return "not-enabled";
  return "ok";
}
