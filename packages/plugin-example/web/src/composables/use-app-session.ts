// SPA boot routing: decode URL token once, drop into one of five
// surfaces (manage / chat / sticky / showcase / bench / denied). The
// active surface is derived from (a) the `?surface=` URL param, and
// (b) the JWT capabilities — manage-gated surfaces only allow callers
// holding the manage capability.

import { ref } from "vue";
import {
  auth,
  decodeJwt,
  exchangeManageJwt,
  readQueryParamAndStrip,
  readTokenFromUrl,
  API_BASE,
} from "../api";

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

let listenerInstalled = false;
function ensureDeniedListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  auth.onAccessDenied((msg) => deny(msg || "Access denied. Request a new link from Discord."));
}

export async function bootstrap(): Promise<void> {
  ensureDeniedListener();

  const requestedSurface = (readQueryParamAndStrip("surface") ?? "") as AppSurface | "";
  const channelFromUrl = readQueryParamAndStrip("c");
  const urlToken = readTokenFromUrl();

  if (urlToken) {
    const claims = decodeJwt(urlToken);
    if (!claims) {
      deny("Token is malformed.");
      return;
    }
    guildId.value = typeof claims.guildId === "string" ? claims.guildId : null;

    const wantsManage =
      requestedSurface === "manage" ||
      requestedSurface === "showcase" ||
      requestedSurface === "bench";

    if (wantsManage) {
      if (!hasManageCaps(claims)) {
        deny(`You need ${MANAGE_CAP_TOKEN} (or admin) to open this surface.`);
        return;
      }
      const tokens = await exchangeManageJwt(urlToken, API_BASE);
      if (!tokens) {
        deny("Couldn't establish a manage session — the link may have expired.");
        return;
      }
      auth.setManageTokens(tokens);
      surface.value = requestedSurface;
      return;
    }

    // Session-mode surfaces.
    auth.setSessionToken(urlToken);
    if (requestedSurface === "chat") {
      if (!channelFromUrl) {
        deny("Chat link is missing channel info — please rerun /example-chat.");
        return;
      }
      chatBinding.value = {
        channelId: channelFromUrl,
        guildId: guildId.value,
      };
      surface.value = "chat";
      return;
    }
    if (requestedSurface === "sticky") {
      surface.value = "sticky";
      return;
    }

    deny(`Unknown surface: ${requestedSurface || "(none)"}.`);
    return;
  }

  // Tab reload — fall back to stored auth + surface inference.
  const restored = auth.loadStored();
  if (restored === "manage") {
    surface.value = "manage";
    return;
  }
  if (restored === "session") {
    // Without the original `?surface=` we can't know which session
    // surface to restore. The user re-runs the slash command. This is
    // a known simplification; a richer plugin would persist the
    // requested surface alongside the token in storage.
    deny("Tab reloaded without context — request a new link from Discord.");
    return;
  }
  deny("Please open this page via /example-* on Discord.");
}

export function useAppSession() {
  return { surface, deniedMessage, chatBinding, guildId, bootstrap };
}
