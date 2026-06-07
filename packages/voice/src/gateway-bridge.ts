/**
 * Gateway bridge — the crux of the voice split (PR-2.3b).
 *
 * `@discordjs/voice`'s `joinVoiceChannel({ adapterCreator })` needs a
 * `DiscordGatewayAdapter` that (a) SENDS the OP4 VOICE_STATE_UPDATE payload
 * over the main gateway WebSocket and (b) RECEIVES the gateway's
 * VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE events. The main gateway lives in
 * the BOT process; the VoiceConnection we relocated lives HERE in the voice
 * service. So the adapter cannot be the bot's live `guild.voiceAdapterCreator`
 * closure — this module builds an adapter that tunnels both directions over
 * the bot↔voice-service HTTP boundary.
 *
 * Direction OUT (sendPayload): @discordjs/voice → `sendPayload(payload)` →
 * injected `sendPayload` transport (the server POSTs it to the bot's
 * `/internal/voice/gateway-send`, which calls `guild.shard.send(payload)`).
 *
 * Direction IN (gateway events): the bot relays VOICE_STATE_UPDATE /
 * VOICE_SERVER_UPDATE to the service's `/internal/voice/gateway-event`, which
 * calls `dispatchGatewayEvent(guildId, type, data)` here → routed to the
 * guild's `onVoiceStateUpdate` / `onVoiceServerUpdate`.
 *
 * The bridge keeps a `Map<guildId, DiscordGatewayAdapterLibraryMethods>`: the
 * library methods @discordjs/voice handed us when it built the connection for
 * that guild. `adapterCreatorFor(guildId)` returns a one-shot
 * `DiscordGatewayAdapterCreator` to pass to `joinVoiceChannel`; when the
 * connection is destroyed the entry is removed and the injected `onDestroy`
 * fires so the bot can stop relaying for that guild.
 *
 * Framework-free + transport-agnostic on purpose: the HTTP wiring is injected
 * as two callbacks, so this is unit-testable with fakes and has no Fastify /
 * undici dependency.
 */

import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import type {
  GatewayVoiceServerUpdateDispatchData,
  GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

/** The two gateway dispatch types the voice adapter cares about. */
export type GatewayEventType = "VOICE_STATE_UPDATE" | "VOICE_SERVER_UPDATE";

export interface GatewayBridgeTransport {
  /**
   * Send an OP4 payload over the bot's main gateway, for the shard that owns
   * `guildId`. Returns true if it was (or will be) sent — @discordjs/voice
   * treats `false` as a hard send failure and disconnects the connection.
   *
   * The HTTP POST to the bot is fire-and-forget from the adapter's point of
   * view (the adapter contract is synchronous + boolean), so an implementer
   * that does an async POST should return true optimistically and log any
   * delivery failure out-of-band.
   */
  sendPayload(guildId: string, payload: unknown): boolean;
  /**
   * Called when a guild's adapter is destroyed (connection torn down). The
   * implementer should tell the bot to stop relaying gateway events for this
   * guild. Best-effort — never throws back into @discordjs/voice's destroy().
   */
  onDestroy(guildId: string): void;
}

/**
 * Per-guild bridge registry. One instance per voice-service process; the HTTP
 * server owns it and feeds inbound gateway events into it.
 */
export class GatewayBridge {
  private readonly methods = new Map<
    string,
    DiscordGatewayAdapterLibraryMethods
  >();

  constructor(private readonly transport: GatewayBridgeTransport) {}

  /**
   * Build the `DiscordGatewayAdapterCreator` for a guild. Pass the returned
   * value as `joinVoiceChannel({ adapterCreator })`. @discordjs/voice calls
   * it exactly once with its library methods; we stash those (so inbound
   * events can reach them) and return our implementer methods.
   *
   * If a connection for this guild is created again before the previous one
   * was destroyed, the latest library methods win — the map only ever holds
   * the live connection's handle.
   */
  adapterCreatorFor(guildId: string): DiscordGatewayAdapterCreator {
    return (
      libMethods: DiscordGatewayAdapterLibraryMethods,
    ): DiscordGatewayAdapterImplementerMethods => {
      this.methods.set(guildId, libMethods);
      return {
        sendPayload: (payload: unknown): boolean =>
          this.transport.sendPayload(guildId, payload),
        destroy: (): void => {
          // Drop our handle FIRST so a late inbound event can't reach a
          // dead connection, then notify the bot to stop relaying.
          this.methods.delete(guildId);
          try {
            this.transport.onDestroy(guildId);
          } catch {
            // onDestroy is best-effort; never let it propagate into
            // @discordjs/voice's destroy() path.
          }
        },
      };
    };
  }

  /**
   * Feed an inbound gateway event (relayed by the bot) to the guild's
   * connection. Unknown guild (no live connection) is a safe no-op — the bot
   * may relay a trailing event after the connection was destroyed, and we
   * must not throw on that race.
   *
   * @returns true if it was routed to a live adapter, false on no-op.
   */
  dispatchGatewayEvent(
    guildId: string,
    type: GatewayEventType,
    data: unknown,
  ): boolean {
    const lib = this.methods.get(guildId);
    if (!lib) return false;
    if (type === "VOICE_STATE_UPDATE") {
      lib.onVoiceStateUpdate(data as GatewayVoiceStateUpdateDispatchData);
    } else if (type === "VOICE_SERVER_UPDATE") {
      lib.onVoiceServerUpdate(data as GatewayVoiceServerUpdateDispatchData);
    } else {
      return false;
    }
    return true;
  }

  /** True if a live connection's adapter is registered for this guild. */
  has(guildId: string): boolean {
    return this.methods.has(guildId);
  }

  /** Guild ids with a live adapter (used by the relay-gating endpoint). */
  guildIds(): string[] {
    return [...this.methods.keys()];
  }

  /**
   * Tell @discordjs/voice that a guild's adapter is no longer usable (e.g.
   * the bot signalled a gateway disconnect for that shard). Calls the
   * library `destroy()`, which in turn triggers our implementer `destroy()`
   * (cleanup + onDestroy). No-op for an unknown guild.
   */
  destroyGuild(guildId: string): void {
    const lib = this.methods.get(guildId);
    if (!lib) return;
    lib.destroy();
  }
}
