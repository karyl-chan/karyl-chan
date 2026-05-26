/**
 * PluginEventBus — fan out a Discord-side event to every subscribed
 * plugin.
 *
 * The InProcess default is HTTP fan-out via the existing
 * `plugin-event-bridge.service.ts` — the bot POSTs to each plugin's
 * `/events` directly. Phase 2.2 of SCALING_PLAN swaps in a Redis
 * Streams implementation: the bot does `XADD plugin-events:<id> …`
 * and the SDK side consumes via a consumer group. Plugin authors
 * see no difference — `eventHandlers` is the same surface either
 * way (this is exactly why L-1 took `/events` away from plugins).
 *
 * `dispatch` is fire-and-forget. Errors per plugin land in the bot
 * event log inside the implementation; they do not propagate to the
 * caller. Subscription state lives elsewhere — the event-bridge
 * service owns the index of `eventType → Set<pluginId>`; the bus is
 * just the transport.
 */

export interface PluginEventBus {
  dispatch(eventType: string, data: unknown): void;
  /** Stop background work (HTTP keep-alive pool drain, consumer groups, …). */
  stop?(): Promise<void>;
}
