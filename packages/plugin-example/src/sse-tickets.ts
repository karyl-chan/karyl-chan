/**
 * Single-use SSE tickets.
 *
 * EventSource can't send custom headers, so the canonical pattern is:
 *   1. Authenticated POST mints a short-lived ticket.
 *   2. Anonymous SSE GET presents `?ticket=…`; server consumes and
 *      binds the stream to the user/channel the ticket was minted for.
 *
 * Tickets are random 32-byte hex strings, ~20s TTL, single-use. The
 * in-memory store is wiped on restart — fine, since outstanding
 * EventSources would die with the process anyway.
 */

import { randomBytes } from "node:crypto";

const TICKET_TTL_MS = 20_000;

export interface TicketPayload {
  userId: string;
  guildId: string;
  channelId: string;
}

interface StoredTicket extends TicketPayload {
  expiresAt: number;
}

const tickets = new Map<string, StoredTicket>();

/** Sweep expired tickets every minute so the map can't grow unbounded. */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expiresAt <= now) tickets.delete(k);
}, 60_000).unref();

export function mintTicket(payload: TicketPayload): string {
  const ticket = randomBytes(16).toString("hex");
  tickets.set(ticket, { ...payload, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

/** Consume a ticket: return its payload (and delete the entry) or null. */
export function consumeTicket(ticket: string): TicketPayload | null {
  const t = tickets.get(ticket);
  if (!t) return null;
  tickets.delete(ticket);
  if (t.expiresAt <= Date.now()) return null;
  return { userId: t.userId, guildId: t.guildId, channelId: t.channelId };
}
