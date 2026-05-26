// Browser-side API client for plugin-example. Built on
// @karyl-chan/plugin-sdk/web's `bootstrapPluginSession` orchestrator
// (Workpack D) — auth + the fetch wrapper live inside the SessionHandle
// owned by `use-app-session.ts`. This module exposes the typed
// per-feature endpoints; it receives the PluginApi via `setApi` once
// bootstrap resolves.

import {
  API_BASE,
  openSseChannel,
  type BearerPair,
  type PluginApi,
  type SseChannel,
} from "@karyl-chan/plugin-sdk/web";

// Wired at bootstrap time via setApi(handle.api). Throws if any feature
// function fires before bootstrap (boot bug — bootstrap must resolve
// before App mounts the surfaces that call these).
let _api: PluginApi | null = null;

export function setApi(api: PluginApi): void {
  _api = api;
}

function api(): PluginApi {
  if (!_api) {
    throw new Error("plugin-example api used before bootstrapPluginSession resolved");
  }
  return _api;
}

export { API_BASE };
export type { BearerPair };

// ── Viewer info (works for both session + manage modes) ───────────────
export interface MeResponse {
  userId: string;
  /** Raw Discord username (post-2023 unique handle), e.g. `karyl_bot`. */
  username: string | null;
  /** Global display name (Discord user-set, not unique). */
  globalName: string | null;
  /** Guild-specific nickname when the viewer is being read from a
   *  guild context AND has a nickname distinct from globalName. */
  nickname: string | null;
  /** Best display label: guild nickname → globalName → username → userId. */
  displayName: string;
  /** Pre-baked with `?animated=true` for animated assets. */
  avatarUrl: string | null;
  /** Global Discord banner (animated supported), null when unset. */
  bannerUrl: string | null;
  /** Discord accent colour (24-bit int), null when unset. */
  accentColor: number | null;
  isBot: boolean;
  /** Null in DM / private-channel / user-install contexts. */
  guildId: string | null;
  /**
   * `guild`    — guild-context members.get returned the viewer.
   * `global`   — no guild or member wasn't in the guild; only users.get applied.
   * `fallback` — neither RPC returned anything; only the userId is real.
   */
  source: "guild" | "global" | "fallback";
}

export function fetchMe(): Promise<MeResponse> {
  return api().request("GET", "/api/me");
}

// ── Manage surface ─────────────────────────────────────────────────────
export interface StickyRow {
  userId: string;
  body: string;
  updated: number;
}
export function listStickies(guildId: string): Promise<{ stickies: StickyRow[] }> {
  return api().request(
    "GET",
    `/api/manage/stickies?guildId=${encodeURIComponent(guildId)}`,
  );
}

// ── Chat surface ───────────────────────────────────────────────────────
export interface ChatEvent {
  ts: number;
  source: "discord" | "webui";
  authorId: string;
  authorName: string;
  content: string;
}

export function fetchChatHistory(
  channelId: string,
): Promise<{ events: ChatEvent[] }> {
  return api().request(
    "GET",
    `/api/chat/history?channelId=${encodeURIComponent(channelId)}`,
  );
}

export function sendChat(
  channelId: string,
  content: string,
): Promise<{ ok: true; event: ChatEvent }> {
  return api().request("POST", "/api/chat/send", { channelId, content });
}

async function mintChatTicket(channelId: string): Promise<string | null> {
  try {
    const r = (await api().request("POST", "/api/chat/sse-ticket", {
      channelId,
    })) as { ticket?: string };
    return r?.ticket ?? null;
  } catch {
    return null;
  }
}

export function openChatSse(
  channelId: string,
  onEvent: (event: ChatEvent) => void,
  onGiveUp?: () => void,
): SseChannel {
  return openSseChannel<ChatEvent>({
    url: `${API_BASE}/api/chat/events`,
    fetchTicket: () => mintChatTicket(channelId),
    onEvent,
    onGiveUp,
  });
}

// ── Sticky surface ─────────────────────────────────────────────────────
export interface Sticky {
  body: string;
  updated: number;
}

export function getSticky(): Promise<{ sticky: Sticky }> {
  return api().request("GET", "/api/sticky");
}

export function saveSticky(body: string): Promise<{ sticky: Sticky }> {
  return api().request("PUT", "/api/sticky", { body });
}

export function deleteSticky(): Promise<{ ok: true }> {
  return api().request("DELETE", "/api/sticky");
}
