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
  // sessionStorage. Resume manage but not session surfaces (no record
  // of which surface was originally requested).
  if (!handle.claims) {
    if (handle.mode === "manage") {
      surface.value = "manage";
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
    surface.value = requestedSurface;
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
    surface.value = "chat";
    return;
  }
  if (requestedSurface === "sticky") {
    surface.value = "sticky";
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
