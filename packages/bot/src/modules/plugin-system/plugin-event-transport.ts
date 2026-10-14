import {
  EVENT_TRANSPORTS,
  type EventTransport,
  type EventTransportCapabilities,
  type EventTransportSelection,
  type PluginManifest,
} from "@karyl-chan/plugin-wire";

/** A register refusal that the SDK must treat as a permanent readiness failure. */
export class EventTransportNegotiationError extends Error {
  readonly code = "event_transport_unavailable" as const;

  constructor(
    message: string,
    readonly selected: EventTransport,
  ) {
    super(message);
    this.name = "EventTransportNegotiationError";
  }
}

/** True when the manifest asks the bot to deliver at least one event. */
export function manifestSubscribesToEvents(manifest: PluginManifest): boolean {
  if ((manifest.events_subscribed_global?.length ?? 0) > 0) return true;
  return (manifest.guild_features ?? []).some(
    (feature) => (feature.events_subscribed?.length ?? 0) > 0,
  );
}

/**
 * Select the bot-configured transport or fail closed. This is deliberately a
 * two-adapter seam, not a generic message-bus negotiation framework.
 */
export function negotiateEventTransport(
  manifest: PluginManifest,
  rawCapabilities: unknown,
  selected: EventTransport,
): EventTransportSelection {
  const consumerRequired =
    selected === "redis-streams" && manifestSubscribesToEvents(manifest);

  // A plugin with no event subscriptions never consumes event delivery, so
  // transport capability is irrelevant and legacy replicas remain valid.
  if (!manifestSubscribesToEvents(manifest)) {
    return { selected, consumerRequired: false };
  }

  // Legacy SDKs did not advertise capabilities. HTTP preserves their old
  // behaviour; Streams must refuse them because the bot cannot prove a
  // consumer exists.
  if (rawCapabilities === undefined) {
    if (selected === "http") return { selected, consumerRequired: false };
    throw new EventTransportNegotiationError(
      "Bot requires redis-streams event delivery, but this event-subscribing plugin uses a legacy SDK that did not advertise transport capability. Rebuild it with the current @karyl-chan/plugin-sdk and configure EVENT_BUS=redis-streams plus REDIS_URL.",
      selected,
    );
  }

  const capabilities = parseCapabilities(rawCapabilities);
  if (capabilities.available.includes(selected)) {
    return { selected, consumerRequired };
  }

  const diagnostic = capabilities.unavailable?.[selected];
  const requirement =
    selected === "redis-streams"
      ? "Set EVENT_BUS=redis-streams and REDIS_URL on the plugin, and install its optional ioredis peer dependency."
      : "HTTP must be advertised by every current SDK replica.";
  throw new EventTransportNegotiationError(
    `Bot selected '${selected}', but this plugin replica advertised only [${capabilities.available.join(", ") || "none"}].${diagnostic ? ` ${diagnostic}.` : ""} ${requirement}`,
    selected,
  );
}

function parseCapabilities(raw: unknown): EventTransportCapabilities {
  if (!raw || typeof raw !== "object") return { available: [] };
  const candidate = raw as {
    available?: unknown;
    unavailable?: unknown;
  };
  const allowed = new Set<string>(EVENT_TRANSPORTS);
  const available = Array.isArray(candidate.available)
    ? candidate.available.filter(
        (value): value is EventTransport =>
          typeof value === "string" && allowed.has(value),
      )
    : [];
  const unavailable: Partial<Record<EventTransport, string>> = {};
  if (candidate.unavailable && typeof candidate.unavailable === "object") {
    for (const transport of EVENT_TRANSPORTS) {
      const value = (candidate.unavailable as Record<string, unknown>)[
        transport
      ];
      if (typeof value === "string" && value.length > 0) {
        unavailable[transport] = value.slice(0, 500);
      }
    }
  }
  return {
    available: [...new Set(available)],
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
  };
}
