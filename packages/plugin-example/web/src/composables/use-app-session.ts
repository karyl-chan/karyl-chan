// SPA boot routing for plugin-example. Workpack D refactor: delegates
// URL token parsing / JWT decode / manage exchange / sessionStorage
// restore to `bootstrapPluginSession` from the SDK. This module keeps
// only the plugin-specific concerns:
//   - manage-cap gating (which surfaces require the manage capability)
//   - chat binding (the `?c=<channelId>` URL param needed for chat)
//   - the "denied" terminal state for the App-level router
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

// sessionStorage key for the surface + binding state we need to survive
// a tab reload. The SDK already persists the auth tokens themselves;
// what it does NOT persist is which surface was originally requested
// and the per-surface bootstrap params (`?surface=...`, `?c=...`),
// which it strips from the URL at boot. Without our own record, the
// reload path lands every manage user on "manage" and bails out on
// every chat/sticky tab — that's what this storage closes.
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
    // Validate surface against the known set so a stale storage value
    // (e.g. from an older deploy that had a different surface) can't
    // land us on an unrenderable state.
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

export async function bootstrap(): Promise<void> {
  // Per-surface auth mode policy passed to the SDK orchestrator. The
  // orchestrator handles URL token decode + manage exchange + denied
  // wiring; we layer the surface-specific routing on top.
  const handle = await bootstrapPluginSession({
    pluginKey: PLUGIN_KEY,
    surfaces: {
      manage: "manage",
      showcase: "manage",
      bench: "manage",
      chat: "session",
      sticky: "session",
    },
    extraUrlParams: ["c"],
    onAccessDenied: (msg) =>
      deny(msg || "Access denied. Request a new link from Discord."),
  });
  sessionHandle = handle;
  setApi(handle.api);

  // Authoritative deny path (Workpack D post-review): branch on the
  // handle's `denied` field rather than the legacy side-effect flag.
  // onAccessDenied still fires above; this branch catches the same
  // case via the resolved handle and is safe to add belt-and-braces.
  if (handle.denied) {
    if (surface.value !== "denied") {
      deny(handle.deniedReason ?? "Access denied. Request a new link from Discord.");
    }
    return;
  }

  guildId.value = handle.guildId;

  // No URL token AND no restored session: nothing more we can do —
  // bootstrap dispatched no token to us. Point the user back to Discord.
  if (handle.mode === "none") {
    deny("Please open this page via /example-* on Discord.");
    return;
  }

  const requestedSurface = (handle.surface ?? "") as AppSurface | "";
  const channelFromUrl = handle.urlParams["c"];

  // Tab-reload path: handle.claims is null when we restored from
  // sessionStorage. The SDK kept the auth tokens; we kept the
  // surface + channelId + guildId in our own storage. Combine them
  // to resume the previous surface — including chat / sticky, which
  // would otherwise bail out here.
  if (!handle.claims) {
    const persisted = loadPersistedRoute();
    if (persisted) {
      // Restore guild context first so chatBinding sees the same
      // guildId the original session captured.
      if (persisted.guildId) guildId.value = persisted.guildId;
      if (persisted.surface === "chat") {
        if (handle.mode !== "session" || !persisted.channelId) {
          // Auth or storage drifted — fall back to deny.
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
        if (handle.mode !== "session") {
          deny("Tab reloaded without context — request a new link from Discord.");
          return;
        }
        enterSurface("sticky");
        return;
      }
      // Manage-mode surfaces (manage / showcase / bench).
      if (handle.mode === "manage") {
        enterSurface(persisted.surface);
        return;
      }
    }
    // No persisted route — fall back to the historical behaviour:
    // manage tokens always have at least the manage surface available;
    // session tokens carry no surface info on reload.
    if (handle.mode === "manage") {
      enterSurface("manage");
      return;
    }
    deny("Tab reloaded without context — request a new link from Discord.");
    return;
  }

  if (handle.requestedMode === "manage") {
    // bootstrap already exchanged for manage tokens — but it doesn't
    // know our manage-cap rule. Validate now.
    if (!hasManageCaps(handle.claims)) {
      deny(`You need ${MANAGE_CAP_TOKEN} (or admin) to open this surface.`);
      return;
    }
    if (
      requestedSurface !== "manage" &&
      requestedSurface !== "showcase" &&
      requestedSurface !== "bench"
    ) {
      deny(`Unknown manage surface: ${requestedSurface || "(none)"}.`);
      return;
    }
    enterSurface(requestedSurface);
    return;
  }

  // Session-mode surfaces.
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
  if (requestedSurface === "sticky") {
    enterSurface("sticky");
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
