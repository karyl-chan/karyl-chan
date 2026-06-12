/**
 * PluginEventBus — deliver a Discord-side event to ONE plugin's mailbox.
 *
 * The InProcess default is HTTP fan-out via the existing
 * `plugin-event-bridge.service.ts` — the bot POSTs to each plugin's
 * `/events` directly. A Redis Streams implementation can swap in: the
 * bot does `XADD karyl:plugin:<pluginKey>:events …` and the SDK side
 * consumes via a consumer group. Plugin authors see no difference —
 * `eventHandlers` is the same surface either way (this is exactly why
 * `/events` is SDK-owned and not exposed to plugins).
 *
 * PM-8 (event-reach enforcement): the bus is per-plugin by
 * construction. The bridge resolves each plugin's reach gates
 * (feature-scoped vs approved-global routes) BEFORE handing the event
 * to the transport, so a plugin can never read another plugin's — or a
 * non-enabled guild's — events off a shared channel. This is why the
 * old shared-stream-per-event-type model (`karyl:events:<type>`) was
 * retired: a shared stream is readable by every consumer regardless of
 * what the bot decided.
 *
 * `dispatchToPlugin` is fire-and-forget. Errors per plugin land in the
 * bot event log inside the implementation; they do not propagate to
 * the caller. Subscription/route state lives elsewhere — the
 * event-bridge service owns the route index; the bus is just the
 * transport.
 */

export interface PluginEventBus {
  dispatchToPlugin(
    pluginId: number,
    pluginKey: string,
    eventType: string,
    data: unknown,
  ): void;
  /** Stop background work (HTTP keep-alive pool drain, consumer groups, …). */
  stop?(): Promise<void>;
}
