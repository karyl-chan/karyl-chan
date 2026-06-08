import {
  findAllPlugins,
  type PluginRow,
} from "./models/plugin.model.js";
import type { PluginManifest } from "./plugin-registry.service.js";
import {
  setHealth,
  type HealthStatus,
  type StoredHealthEntry,
} from "./plugin-health-store.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";

/**
 * Periodic health prober.
 *
 * Walks every active+enabled plugin every `POLL_INTERVAL_MS`, GETs
 * `endpoints.health` (default `/health/detail`), and writes the result
 * into `plugin-health-store`. The admin UI reads from the store, never
 * from this poller directly — that keeps the read path cheap and
 * insulates the UI from one slow plugin blocking other dashboards.
 *
 * No auth on the GET: `/health/detail` is intentionally public on the
 * plugin's own service (the bot's `assertPluginTarget` SSRF guard
 * applies). A plugin that wants to hide its health-detail should not
 * expose it via the SDK in the first place.
 */

const POLL_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

function parseManifest(plugin: PluginRow): PluginManifest | null {
  try {
    return JSON.parse(plugin.manifestJson) as PluginManifest;
  } catch {
    return null;
  }
}

function resolveHealthUrl(
  plugin: PluginRow,
  manifest: PluginManifest,
): string | null {
  const path = manifest.endpoints?.health ?? "/health/detail";
  try {
    return new URL(path, plugin.url).toString();
  } catch {
    return null;
  }
}

function isHealthStatus(v: unknown): v is HealthStatus {
  return v === "healthy" || v === "degraded" || v === "unhealthy";
}

async function probeOne(plugin: PluginRow): Promise<void> {
  const manifest = parseManifest(plugin);
  if (!manifest) return;
  const url = resolveHealthUrl(plugin, manifest);
  if (!url) return;
  const parsedUrl = new URL(url);
  const port = parsedUrl.port
    ? Number(parsedUrl.port)
    : parsedUrl.protocol === "https:"
      ? 443
      : 80;
  try {
    await assertPluginTarget(parsedUrl.hostname, port);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    // Treat host-policy refusal as unhealthy — operators see this in
    // the UI badge instead of silently stale data.
    await setHealth(plugin.pluginKey, {
      status: "unhealthy",
      message: `host policy: ${err.message}`,
      checkedAt: Date.now(),
      fromError: true,
    });
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      // Don't follow redirects past the assertPluginTarget host check (SSRF).
      redirect: "manual",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await setHealth(plugin.pluginKey, {
        status: "unhealthy",
        message: `HTTP ${res.status}`,
        checkedAt: Date.now(),
        fromError: true,
      });
      return;
    }
    const raw = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!raw) {
      await setHealth(plugin.pluginKey, {
        status: "unhealthy",
        message: "invalid JSON",
        checkedAt: Date.now(),
        fromError: true,
      });
      return;
    }
    const status = isHealthStatus(raw.status) ? raw.status : "unhealthy";
    const message = typeof raw.message === "string" ? raw.message : undefined;
    const checks: StoredHealthEntry["checks"] = [];
    if (Array.isArray(raw.checks)) {
      for (const c of raw.checks) {
        if (!c || typeof c !== "object") continue;
        const cc = c as Record<string, unknown>;
        if (typeof cc.name !== "string" || !isHealthStatus(cc.status)) {
          continue;
        }
        checks.push({
          name: cc.name,
          status: cc.status,
          ...(typeof cc.message === "string" ? { message: cc.message } : {}),
        });
      }
    }
    const checkedAt =
      typeof raw.checkedAt === "number" ? raw.checkedAt : Date.now();
    await setHealth(plugin.pluginKey, {
      status,
      ...(message !== undefined ? { message } : {}),
      ...(checks.length > 0 ? { checks } : {}),
      checkedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setHealth(plugin.pluginKey, {
      status: "unhealthy",
      message: msg,
      checkedAt: Date.now(),
      fromError: true,
    });
    if (shouldRecord(`plugin-health-probe-fail:${plugin.id}`)) {
      botEventLog.record(
        "warn",
        "bot",
        `health probe for ${plugin.pluginKey} failed: ${msg}`,
        { pluginId: plugin.id, error: msg },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

let pollTimer: NodeJS.Timeout | null = null;

async function pollOnce(): Promise<void> {
  const plugins = await findAllPlugins();
  const active = plugins.filter((p) => p.enabled && p.status === "active");
  // Probe in parallel; one slow plugin shouldn't delay another's reading.
  await Promise.allSettled(active.map((p) => probeOne(p)));
}

/** Start the periodic poll. Idempotent — second call is a no-op. */
export function startPluginHealthPoller(): void {
  if (pollTimer) return;
  // First poll immediately so the admin UI has data on the first page
  // load after a bot restart instead of waiting up to a minute.
  void pollOnce();
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

export function stopPluginHealthPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
