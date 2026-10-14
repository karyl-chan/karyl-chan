/** Event-delivery transports supported by the bot↔plugin register contract. */
export const EVENT_TRANSPORTS = ["http", "redis-streams"] as const;

export type EventTransport = (typeof EVENT_TRANSPORTS)[number];

/**
 * What one plugin replica can actually start. HTTP is always present; the
 * optional diagnostic explains why Redis Streams could not be advertised.
 */
export interface EventTransportCapabilities {
  available: EventTransport[];
  unavailable?: Partial<Record<EventTransport, string>>;
}

/** The bot's authoritative register-time selection. */
export interface EventTransportSelection {
  selected: EventTransport;
  consumerRequired: boolean;
}
