/**
 * Chat session state — keyed by Discord `channelId`.
 *
 * Each channel keeps:
 *  - a bounded history of recent messages (last 50)
 *  - a fan-out set of SSE writers waiting for `ChatEvent`s
 *
 * Two arrival paths converge here:
 *  - WebUI posts to `/api/chat/send` → pluginBotRpc messages.send →
 *    Discord shows the message; locally we synthesize a ChatEvent and
 *    fan-out to all WebUI subscribers so they see the message even if
 *    they didn't trigger it.
 *  - Discord MESSAGE_CREATE event (subscribed via the plugin manifest)
 *    arrives on `/events`; the bot-side message handler synthesizes a
 *    ChatEvent and pushes through the same fan-out.
 *
 * This is the simplest demonstration of bidirectional sync between a
 * plugin webui and a live Discord channel.
 */

import type { FastifyReply } from "fastify";

export interface ChatEvent {
  /** ms epoch when the message was first seen by this plugin. */
  ts: number;
  /** Source surface — "discord" or "webui". */
  source: "discord" | "webui";
  /** Discord user id. */
  authorId: string;
  /** Display name (resolved from members.get RPC, or echo from webui). */
  authorName: string;
  /** Plain text content. */
  content: string;
}

const HISTORY_LIMIT = 50;
const KEEPALIVE_MS = 20_000;

interface ChannelState {
  history: ChatEvent[];
  subscribers: Set<FastifyReply>;
}

const channels = new Map<string, ChannelState>();

function getOrInit(channelId: string): ChannelState {
  let s = channels.get(channelId);
  if (!s) {
    s = { history: [], subscribers: new Set() };
    channels.set(channelId, s);
  }
  return s;
}

export function getHistory(channelId: string): ChatEvent[] {
  return channels.get(channelId)?.history ?? [];
}

/**
 * Append a chat event to the channel's history and fan-out to all
 * subscribed SSE writers. Caller is responsible for synthesizing the
 * event (i.e. mapping a Discord MESSAGE_CREATE payload or a webui
 * post into a ChatEvent).
 */
export function publish(channelId: string, event: ChatEvent): void {
  const state = getOrInit(channelId);
  state.history.push(event);
  if (state.history.length > HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - HISTORY_LIMIT);
  }
  const frame = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
  for (const reply of state.subscribers) {
    try {
      reply.raw.write(frame);
    } catch {
      // Closed / errored connection — onCloseRequest will clean it up.
    }
  }
}

/**
 * Register a long-poll-style SSE subscriber. Caller is expected to
 * have already minted+consumed a ticket and set the appropriate
 * `text/event-stream` headers. Returns an unsubscribe function the
 * Fastify hook can call on `request.raw.on('close', ...)`.
 *
 * Also sends a `: ping\n\n` heartbeat every 20s to defeat the bot
 * reverse-proxy's 30s idle timeout.
 */
export function subscribe(channelId: string, reply: FastifyReply): () => void {
  const state = getOrInit(channelId);
  state.subscribers.add(reply);

  // Initial backlog so a freshly-mounted SPA sees recent history.
  for (const event of state.history) {
    reply.raw.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {
      // closed; cleanup handled by the close listener below
    }
  }, KEEPALIVE_MS);

  return () => {
    clearInterval(heartbeat);
    state.subscribers.delete(reply);
  };
}
