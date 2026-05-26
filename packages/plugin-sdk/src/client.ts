import type { PluginManifest } from "./manifest.js";
import type { Logger } from "./types.js";

/**
 * Plugin lifecycle client: register-on-startup + heartbeat loop +
 * automatic re-register on 401 (e.g. bot restart wiped token cache).
 *
 * Designed to never throw out to the host process — registration
 * failures and heartbeat errors are logged and retried with backoff.
 * The plugin's primary job (serving /commands/:commandName) keeps working
 * even when registration is offline; the bot just won't dispatch to
 * us until we re-register successfully.
 */

export interface PluginClientOptions {
  botUrl: string;
  setupSecret: string;
  manifest: PluginManifest;
  logger?: Logger;
  /**
   * Called once, after the very first successful register. Receives no
   * arguments — `token()` / `getDispatchHmacKey()` etc. on the client
   * handle are populated by the time this fires. Used by the SDK to
   * build the `PluginContext` and fire the plugin's `onStart` hook.
   * Errors thrown here are caught and logged; they do NOT prevent the
   * client from running.
   */
  onFirstRegister?: () => void | Promise<void>;
}

export interface PluginClient {
  stop(): void;
  /** Currently held bearer token (cleartext); null until first register. */
  token(): string | null;
  /**
   * Per-plugin HMAC key received from the bot on successful register.
   * Used for inbound dispatch HMAC verification.
   * Null until first register or if the bot did not return the field.
   */
  getDispatchHmacKey(): string | null;
  /**
   * Ed25519 public key (SPKI PEM) received from the bot on successful
   * register, used to verify `plugin-session` JWTs offline (see
   * `verifyPluginSession`). Null until first register.
   */
  getSessionVerifyPublicKey(): string | null;
  /**
   * Browser-reachable base URL the bot exposes for this plugin's HTTP
   * surface (i.e. `<bot>/plugin/<key>`). Undefined until first register
   * or when the bot has no `WEB_BASE_URL` configured.
   */
  getPublicBaseUrl(): string | undefined;
}

const REGISTER_BACKOFF_BASE_MS = 2_000;
const REGISTER_BACKOFF_MAX_MS = 60_000;

export function startPluginClient(opts: PluginClientOptions): PluginClient {
  const log = opts.logger ?? consoleLogger();
  const botUrl = opts.botUrl.replace(/\/+$/, "");
  let token: string | null = null;
  let dispatchHmacKey: string | null = null;
  let sessionVerifyPublicKey: string | null = null;
  let publicBaseUrl: string | undefined = undefined;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let registerAttempt = 0;
  // `onFirstRegister` fires exactly once across the client's lifetime —
  // re-register after a 401 must not re-fire `onStart` (which would
  // double-seed state / double-flush metrics).
  let firstRegisterFired = false;

  async function register(): Promise<boolean> {
    try {
      const res = await fetch(`${botUrl}/api/plugins/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Setup-Secret": opts.setupSecret,
        },
        body: JSON.stringify({ manifest: opts.manifest }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log.warn(
          `register rejected by bot: ${res.status} ${text.slice(0, 200)}`,
          { status: res.status },
        );
        return false;
      }
      const data = (await res.json()) as {
        plugin?: { id: number; pluginKey: string };
        token?: string;
        dispatchHmacKey?: string;
        sessionVerifyPublicKey?: string;
        publicBaseUrl?: string;
        heartbeat?: { path?: string; interval_seconds?: number };
      };
      if (typeof data.token !== "string" || data.token.length === 0) {
        log.error("register response missing token");
        return false;
      }
      token = data.token;
      if (
        typeof data.dispatchHmacKey === "string" &&
        data.dispatchHmacKey.length > 0
      ) {
        dispatchHmacKey = data.dispatchHmacKey;
      }
      if (
        typeof data.sessionVerifyPublicKey === "string" &&
        data.sessionVerifyPublicKey.length > 0
      ) {
        sessionVerifyPublicKey = data.sessionVerifyPublicKey;
      }
      if (typeof data.publicBaseUrl === "string" && data.publicBaseUrl.length > 0) {
        publicBaseUrl = data.publicBaseUrl;
      } else {
        publicBaseUrl = undefined;
      }
      const intervalSec = data.heartbeat?.interval_seconds ?? 30;
      scheduleHeartbeat(intervalSec * 1000);
      log.info("registered with bot", {
        pluginKey: data.plugin?.pluginKey,
        botPluginId: data.plugin?.id,
        heartbeatIntervalSec: intervalSec,
      });
      registerAttempt = 0;
      if (!firstRegisterFired && typeof opts.onFirstRegister === "function") {
        firstRegisterFired = true;
        try {
          await opts.onFirstRegister();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`onFirstRegister hook threw: ${msg}`);
        }
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`register network error: ${msg}`);
      return false;
    }
  }

  function scheduleRegisterRetry() {
    if (stopped) return;
    registerAttempt++;
    const base = Math.min(
      REGISTER_BACKOFF_MAX_MS,
      REGISTER_BACKOFF_BASE_MS * Math.pow(2, Math.min(registerAttempt - 1, 5)),
    );
    // Add ±30% jitter to avoid thundering-herd when multiple plugins restart simultaneously.
    const delay = base + Math.floor(Math.random() * base * 0.3);
    log.info(`registration retry in ${delay}ms (attempt ${registerAttempt})`);
    setTimeout(() => {
      void registerWithRetry();
    }, delay).unref();
  }

  async function registerWithRetry(): Promise<void> {
    if (stopped) return;
    const ok = await register();
    if (!ok) scheduleRegisterRetry();
  }

  async function heartbeat(): Promise<void> {
    if (!token || stopped) return;
    try {
      const res = await fetch(`${botUrl}/api/plugins/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        log.warn("heartbeat 401, re-registering");
        token = null;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        void registerWithRetry();
        return;
      }
      if (!res.ok) {
        log.warn(`heartbeat HTTP ${res.status}`);
        return;
      }
      // The bot echoes its current JWT verify public key and publicBaseUrl
      // on every beat; pick up rotated values here without waiting for a
      // re-register.
      const data = (await res.json().catch(() => null)) as {
        sessionVerifyPublicKey?: unknown;
        publicBaseUrl?: unknown;
      } | null;
      if (
        data &&
        typeof data.sessionVerifyPublicKey === "string" &&
        data.sessionVerifyPublicKey.length > 0 &&
        data.sessionVerifyPublicKey !== sessionVerifyPublicKey
      ) {
        sessionVerifyPublicKey = data.sessionVerifyPublicKey;
        log.info("session verify key updated from heartbeat");
      }
      if (data) {
        const hbUrl =
          typeof data.publicBaseUrl === "string" && data.publicBaseUrl.length > 0
            ? data.publicBaseUrl
            : undefined;
        if (hbUrl !== publicBaseUrl) {
          publicBaseUrl = hbUrl;
          log.info("publicBaseUrl updated from heartbeat");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`heartbeat network error: ${msg}`);
    }
  }

  function scheduleHeartbeat(intervalMs: number) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      void heartbeat();
    }, intervalMs);
    heartbeatTimer.unref();
  }

  // Kick off the first attempt async — we return synchronously so the
  // host's listen() can proceed even if the bot is slow / down.
  void registerWithRetry();

  return {
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    },
    token: () => token,
    getDispatchHmacKey: () => dispatchHmacKey,
    getSessionVerifyPublicKey: () => sessionVerifyPublicKey,
    getPublicBaseUrl: () => publicBaseUrl,
  };
}

function consoleLogger(): Logger {
  return {
    info: (msg: string, meta?: Record<string, unknown>) =>
      console.log("[plugin-client]", msg, meta ?? ""),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      console.warn("[plugin-client]", msg, meta ?? ""),
    error: (msg: string, meta?: Record<string, unknown>) =>
      console.error("[plugin-client]", msg, meta ?? ""),
  };
}
