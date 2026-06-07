/**
 * Voice service configuration (env-driven). Single-machine deployments never
 * run this process — these defaults only matter when the split is enabled.
 */

function str(name: string, fallback: string): string {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : fallback;
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface VoiceServiceConfig {
  /** Port the voice service's HTTP API listens on. */
  port: number;
  /** Bind host. 0.0.0.0 inside a container so the bot can reach it. */
  host: string;
  /**
   * Base URL of the bot's internal API (e.g. http://karyl-bot:3000). The
   * service POSTs OP4 gateway-send payloads + destroy notices here.
   */
  botInternalUrl: string;
  /**
   * Shared HMAC secret for the bot↔voice-service internal channel. Both sides
   * sign + verify with it. REQUIRED — the service refuses to start without it.
   */
  hmacSecret: string;
}

/**
 * Load + validate config. Throws (fail-loud) if the HMAC secret or the bot
 * URL is missing — an unauthenticated or un-routable voice service is a
 * security / correctness footgun, not a degraded mode.
 */
export function loadConfig(): VoiceServiceConfig {
  const hmacSecret = str("VOICE_HMAC_SECRET", "");
  if (!hmacSecret) {
    throw new Error(
      "VOICE_HMAC_SECRET is required (shared secret for the bot↔voice-service " +
        "internal channel).",
    );
  }
  const botInternalUrl = str("BOT_INTERNAL_URL", "");
  if (!botInternalUrl) {
    throw new Error(
      "BOT_INTERNAL_URL is required (base URL of the bot's internal API, e.g. " +
        "http://karyl-bot:3000).",
    );
  }
  return {
    port: int("VOICE_PORT", 4000),
    host: str("VOICE_HOST", "0.0.0.0"),
    botInternalUrl: botInternalUrl.replace(/\/+$/, ""),
    hmacSecret,
  };
}
