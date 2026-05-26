// SPA boot routing for plugin-example.
//
// Plugin-example serves multiple surfaces from one SPA bundle, so the
// surface name lives in the URL (`?surface=...`) — different from
// other plugins which use one bundle per surface. The bootstrap SDK
// (0.6+) is surface-agnostic; this composable reads `?surface=` here
// (via the SDK's `extraUrlParams` strip), decides whether to pass
// `exchangeJwt: true` for that surface, then calls the orchestrator.
//
// Surfaces (from Discord slash command links):
//   /example-manage     → "manage"   — admin/manage UI (manage cap)
//   /example-chat       → "chat"     — channel-bound chat SPA
//   /example-sticky     → "sticky"   — user-bound sticky notes
//   /example-showcase   → "showcase" — UI component showcase (manage cap)
//   /example-bench      → "bench"    — UI stress test page (manage cap)

import { ref } from "vue";
import {
  bootstrapPluginSession,
  type SessionHandle,
} from "@karyl-chan/plugin-sdk/web";
import { setApi } from "../api";

const PLUGIN_KEY = "karyl-example";
const MANAGE_CAP_TOKEN = `plugin:${PLUGIN_KEY}:manage`;

// Surfaces that go through the JWT-exchange flow (longer-lived
// access + refresh pair, gated on the manage capability) — everything
// else uses the boot JWT directly as a session bearer.
const EXCHANGE_SURFACES = new Set<AppSurface>(["manage", "showcase", "bench"]);
const SESSION_SURFACES = new Set<AppSurface>(["chat", "sticky"]);

// sessionStorage key for the surface + binding state we need to survive
// a tab reload. The SDK persists the auth credential itself; what it
// does NOT persist is which surface we landed on or the bootstrap
// params we stripped from the URL. Without this our own record, the
// reload path bails out on every chat/sticky tab and lands every
// manage user on whatever default we pick.
const SESSION_STORAGE_KEY = `${PLUGIN_KEY}:session-route`;

interface PersistedRoute {
  surface: AppSurface;
  channelId?: string | null;
  guildId?: string | null;
}

function loadPersistedRoute(): PersistedRoute | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedRoute>;
    if (
      parsed.surface === "manage" ||
      parsed.surface === "chat" ||
      parsed.surface === "sticky" ||
      parsed.surface === "showcase" ||
      parsed.surface === "bench"
    ) {
      return {
        surface: parsed.surface,
        channelId: parsed.channelId ?? null,
        guildId: parsed.guildId ?? null,
      };
    }
  } catch {
    // Corrupted JSON or sessionStorage denied — fall through to null.
  }
  return null;
}

function savePersistedRoute(route: PersistedRoute): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(route));
  } catch {
    // Quota or privacy-mode denial — in-memory state still works for
    // this tab; we just lose the reload behaviour.
  }
}

function clearPersistedRoute(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch { /* ignore */ }
}

export type AppSurface =
  | "loading"
  | "denied"
  | "manage"
  | "chat"
  | "sticky"
  | "showcase"
  | "bench";

export interface ChatBinding {
  channelId: string;
  guildId: string | null;
}

const surface = ref<AppSurface>("loading");
const deniedMessage = ref<string>("");
const chatBinding = ref<ChatBinding | null>(null);
const guildId = ref<string | null>(null);

let sessionHandle: SessionHandle | null = null;

function deny(message: string): void {
  deniedMessage.value = message;
  surface.value = "denied";
  // A denial is terminal — if a stale route is sitting in storage,
  // wipe it so the user doesn't loop back into the same dead surface
  // on the next reload.
  clearPersistedRoute();
}

/**
 * Land on a non-denied surface. Always mirrors the choice into
 * sessionStorage so the next tab reload (where the SDK has no URL
 * token and no claims) lands on the same place.
 */
function enterSurface(target: AppSurface, opts: { channelId?: string | null } = {}): void {
  surface.value = target;
  savePersistedRoute({
    surface: target,
    channelId: opts.channelId ?? chatBinding.value?.channelId ?? null,
    guildId: guildId.value,
  });
}

function hasManageCaps(claims: { capabilities?: unknown } | null): boolean {
  const caps = Array.isArray(claims?.capabilities)
    ? (claims!.capabilities as string[])
    : [];
  return caps.includes("admin") || caps.includes(MANAGE_CAP_TOKEN);
}

function isKnownSurface(name: string): name is AppSurface {
  return (
    name === "manage" ||
    name === "chat" ||
    name === "sticky" ||
    name === "showcase" ||
    name === "bench"
  );
}

export async function bootstrap(): Promise<void> {
  // Read + strip `?surface=` ourselves (via extraUrlParams) so the
  // SDK doesn't have to know about our routing model — and use it
  // to decide which flow to ask the orchestrator for.
  const urlSurface = new URLSearchParams(window.location.search).get("surface");
  const requestedSurface =
    urlSurface && isKnownSurface(urlSurface) ? urlSurface : null;

  const handle = await bootstrapPluginSession({
    pluginKey: PLUGIN_KEY,
    // Exchange flow for manage-tier surfaces; direct bearer for chat /
    // sticky. The decision is made off the URL surface — same source
    // the bot's link emitter wrote it from.
    exchangeJwt: requestedSurface !== null && EXCHANGE_SURFACES.has(requestedSurface),
    extraUrlParams: ["c", "surface"],
    onAccessDenied: (msg) =>
      deny(msg || "Access denied. Request a new link from Discord."),
  });
  sessionHandle = handle;
  setApi(handle.api);

  if (handle.denied) {
    if (surface.value !== "denied") {
      deny(handle.deniedReason ?? "Access denied. Request a new link from Discord.");
    }
    return;
  }

  guildId.value = handle.guildId;

  // No URL token AND no restored session: nothing more we can do —
  // point the user back to Discord.
  if (!handle.isAuthenticated) {
    deny("Please open this page via /example-* on Discord.");
    return;
  }

  const channelFromUrl = handle.urlParams["c"];

  // Tab-reload path: handle.claims is null when we restored from
  // sessionStorage. The SDK kept the auth tokens; we kept the
  // surface + channelId + guildId in our own storage. Combine them
  // to resume the previous surface.
  if (!handle.claims) {
    const persisted = loadPersistedRoute();
    if (persisted) {
      if (persisted.guildId) guildId.value = persisted.guildId;
      if (persisted.surface === "chat") {
        if (handle.hasRefreshPair || !persisted.channelId) {
          // Auth or storage drifted (chat shouldn't have a refresh
          // pair) — fall back to deny.
          deny("Tab reloaded without context — request a new link from Discord.");
          return;
        }
        chatBinding.value = {
          channelId: persisted.channelId,
          guildId: persisted.guildId ?? null,
        };
        enterSurface("chat", { channelId: persisted.channelId });
        return;
      }
      if (persisted.surface === "sticky") {
        if (handle.hasRefreshPair) {
          deny("Tab reloaded without context — request a new link from Discord.");
          return;
        }
        enterSurface("sticky");
        return;
      }
      // Manage-tier surfaces (manage / showcase / bench) — require
      // the exchange pair to still be present.
      if (handle.hasRefreshPair) {
        enterSurface(persisted.surface);
        return;
      }
    }
    // No persisted route — fall back: a refresh pair always has at
    // least the manage surface available; a direct bearer carries no
    // surface info on reload.
    if (handle.hasRefreshPair) {
      enterSurface("manage");
      return;
    }
    deny("Tab reloaded without context — request a new link from Discord.");
    return;
  }

  // Fresh URL with token + claims. Surface must be present and known
  // (we only support links the bot emitted).
  if (!requestedSurface) {
    deny("Unknown surface — please rerun /example-* on Discord.");
    return;
  }

  if (EXCHANGE_SURFACES.has(requestedSurface)) {
    // Bootstrap already exchanged for the access pair — but it doesn't
    // know our manage-cap rule. Validate now.
    if (!hasManageCaps(handle.claims)) {
      deny(`You need ${MANAGE_CAP_TOKEN} (or admin) to open this surface.`);
      return;
    }
    enterSurface(requestedSurface);
    return;
  }

  // Session-tier surfaces.
  if (requestedSurface === "chat") {
    if (!channelFromUrl) {
      deny("Chat link is missing channel info — please rerun /example-chat.");
      return;
    }
    chatBinding.value = {
      channelId: channelFromUrl,
      guildId: handle.guildId,
    };
    enterSurface("chat", { channelId: channelFromUrl });
    return;
  }
  if (SESSION_SURFACES.has(requestedSurface)) {
    enterSurface(requestedSurface);
    return;
  }
  deny(`Unknown surface: ${requestedSurface || "(none)"}.`);
}

export function useAppSession() {
  return {
    surface,
    deniedMessage,
    chatBinding,
    guildId,
    bootstrap,
    /** Underlying SDK handle for advanced consumers (debug panel, etc.). */
    handle: (): SessionHandle | null => sessionHandle,
  };
}
