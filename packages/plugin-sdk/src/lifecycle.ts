/**
 * Observable lifecycle state for one plugin process.
 *
 * Registration only gives the process credentials. It is not allowed to
 * receive bot dispatches until initialization has completed and the bot has
 * acknowledged the explicit ready transition.
 */
export type PluginLifecycleState =
  | "listening"
  | "registering"
  | "initializing"
  | "ready"
  | "failed"
  | "serving_dark"
  | "stopping";

/** Raised by `StartedPlugin.whenReady()` when readiness cannot be reached. */
export class PluginReadinessError extends Error {
  constructor(
    message: string,
    public readonly state: PluginLifecycleState,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginReadinessError";
  }
}
