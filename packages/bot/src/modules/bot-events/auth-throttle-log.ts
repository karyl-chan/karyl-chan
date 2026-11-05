import { botEventLog } from "./bot-event-log.js";
import { shouldRecord } from "./bot-event-dedup.js";

/**
 * A public auth endpoint throttled a client: one `auth` warning per
 * client and path per dedup window, so a flood does not flood the log.
 */
export function recordAuthThrottled(path: string, ip: string): void {
  if (!shouldRecord(`rateLimit:${ip}:${path}`)) return;
  botEventLog.record("warn", "auth", `Auth rate-limit hit: ${path}`, { endpoint: path, ip });
}
