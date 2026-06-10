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
  /**
   * This replica's own advertised address (the `plugin.url` the manifest
   * carries). Sent on every heartbeat and on graceful deregister so the
   * bot's multi-endpoint registry (PR-3.1) can track / age out THIS
   * replica independently of any siblings sharing the pluginKey.
   * Defaults to `manifest.plugin.url` when omitted.
   */
  pluginUrl?: string;
  logger?: Logger;
  /**
   * Per-call timeouts for the lifecycle fetches. A bot whose register
   * handler wedges (e.g. blocked on a rate-limited Discord call) must
   * not wedge the plugin with it: an aborted call is treated exactly
   * like a network error, so the existing backoff/retry loop owns
   * recovery. Defaults: register 30s, heartbeat 10s, deregister 5s.
   * Override mainly for tests.
   */
  lifecycleTimeoutsMs?: {
    register?: number;
    heartbeat?: number;
    deregister?: number;
  };
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
  /**
   * Best-effort graceful deregister (PR-3.1): tell the bot this replica
   * is shutting down so it drops the endpoint immediately instead of
   * waiting for the heartbeat reaper. Safe to call before `stop()`;
   * never throws (network errors are swallowed). No-op if not yet
   * registered (no token).
   */
  deregister(): Promise<void>;
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

const REGISTER_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const DEREGISTER_TIMEOUT_MS = 5_000;
// After this many consecutive register timeouts the problem is almost
// certainly a wedged bot-side handler (not a blip), so escalate from
// warn to error with a pointer at the bot.
const TIMEOUT_ESCALATION_THRESHOLD = 3;

/** True when `err` is the rejection produced by `AbortSignal.timeout`. */
function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

export function startPluginClient(opts: PluginClientOptions): PluginClient {
  const log = opts.logger ?? consoleLogger();
  const botUrl = opts.botUrl.replace(/\/+$/, "");
  const pluginUrl = (opts.pluginUrl ?? opts.manifest.plugin.url).replace(
    /\/+$/,
    "",
  );
  let token: string | null = null;
  let dispatchHmacKey: string | null = null;
  let sessionVerifyPublicKey: string | null = null;
  let publicBaseUrl: string | undefined = undefined;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let registerAttempt = 0;
  let consecutiveRegisterTimeouts = 0;
  const timeoutsMs = {
    register: opts.lifecycleTimeoutsMs?.register ?? REGISTER_TIMEOUT_MS,
    heartbeat: opts.lifecycleTimeoutsMs?.heartbeat ?? HEARTBEAT_TIMEOUT_MS,
    deregister: opts.lifecycleTimeoutsMs?.deregister ?? DEREGISTER_TIMEOUT_MS,
  };
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
        signal: AbortSignal.timeout(timeoutsMs.register),
      });
      consecutiveRegisterTimeouts = 0;
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
      if (isTimeoutError(err)) {
        consecutiveRegisterTimeouts++;
        if (consecutiveRegisterTimeouts >= TIMEOUT_ESCALATION_THRESHOLD) {
          log.error(
            `register timed out ${consecutiveRegisterTimeouts}x in a row after ${timeoutsMs.register}ms — ` +
              "the bot accepted the connection but never answered; its register handler is likely wedged. " +
              "Check the bot's logs for a /api/plugins/register request without a completion.",
            { consecutiveTimeouts: consecutiveRegisterTimeouts },
          );
        } else {
          log.warn(`register timed out after ${timeoutsMs.register}ms`);
        }
      } else {
        log.warn(`register network error: ${msg}`);
      }
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
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // Advertise this replica's own address so the bot's
        // multi-endpoint registry slides THIS endpoint's TTL forward
        // (PR-3.1), keeping sibling replicas tracked independently.
        body: JSON.stringify({ url: pluginUrl }),
        signal: AbortSignal.timeout(timeoutsMs.heartbeat),
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
      if (isTimeoutError(err)) {
        log.warn(`heartbeat timed out after ${timeoutsMs.heartbeat}ms`);
      } else {
        log.warn(`heartbeat network error: ${msg}`);
      }
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

  async function deregister(): Promise<void> {
    if (!token) return;
    try {
      await fetch(`${botUrl}/api/plugins/deregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: pluginUrl }),
        signal: AbortSignal.timeout(timeoutsMs.deregister),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`deregister network error: ${msg}`);
    }
  }

  return {
    stop() {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    },
    deregister,
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
