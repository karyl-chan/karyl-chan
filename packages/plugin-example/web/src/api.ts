// Browser-side API client for plugin-example. Builds on
// @karyl-chan/plugin-sdk/web for the auth + fetch boilerplate; adds the
// plugin-specific helpers (chat, sticky, manage-only listings).

import {
  API_BASE,
  createAuthState,
  createPluginApi,
  openSseChannel,
  type AuthState,
  type ManageTokens,
  type PluginApi,
  type SseChannel,
} from "@karyl-chan/plugin-sdk/web";

const bundle = createAuthState("karyl-example");
export const auth: AuthState = bundle.state;
const api: PluginApi = createPluginApi({
  apiBase: API_BASE,
  auth,
  emitDenied: bundle.emitDenied,
});

// Re-export the API base so views can build asset URLs directly when
// needed (none currently, but it's a stable hook for future use).
export { API_BASE };

// ── Auth bootstrap helpers ─────────────────────────────────────────────
export {
  decodeJwt,
  readTokenFromUrl,
  readQueryParamAndStrip,
  exchangeManageJwt,
} from "@karyl-chan/plugin-sdk/web";
export type { ManageTokens };

// ── Manage surface ─────────────────────────────────────────────────────
export interface StickyRow {
  userId: string;
  body: string;
  updated: number;
}
export function listStickies(guildId: string): Promise<{ stickies: StickyRow[] }> {
  return api.request(
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
  return api.request(
    "GET",
    `/api/chat/history?channelId=${encodeURIComponent(channelId)}`,
  );
}

export function sendChat(
  channelId: string,
  content: string,
): Promise<{ ok: true; event: ChatEvent }> {
  return api.request("POST", "/api/chat/send", { channelId, content });
}

async function mintChatTicket(channelId: string): Promise<string | null> {
  try {
    const r = (await api.request("POST", "/api/chat/sse-ticket", {
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
  return api.request("GET", "/api/sticky");
}

export function saveSticky(body: string): Promise<{ sticky: Sticky }> {
  return api.request("PUT", "/api/sticky", { body });
}

export function deleteSticky(): Promise<{ ok: true }> {
  return api.request("DELETE", "/api/sticky");
}
