/**
 * OpenTelemetry SDK bootstrap (PR-0.1).
 *
 * Closes the follow-up left by `utils/trace-context.ts`: that module
 * already threads valid W3C `traceparent` headers across every dispatch
 * hop (bot → plugin RPC → bot), but until now there was no SDK actually
 * EXPORTING spans, so the trace ids had nowhere to land. This wires
 * `@opentelemetry/sdk-node` with auto-instrumentation + an OTLP/HTTP
 * exporter so a downstream collector (Jaeger / Tempo / Honeycomb / any
 * OTLP receiver) stitches the hops into one trace.
 *
 * DEFAULT-OFF — single-machine simplicity is preserved. With no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set, `startOtel()` returns early and the
 * heavy SDK packages are never even imported (they sit behind a dynamic
 * import), so `docker compose up` keeps zero observability dependencies
 * and zero runtime cost.
 *
 * Bootstrapping: this must run BEFORE the app's own modules import
 * `http` / `pg` / `undici` / `fastify`, otherwise auto-instrumentation
 * patches them too late. We therefore start it from `register.ts` via
 * the node `--import` flag (see Dockerfile CMD and package.json scripts),
 * not from inside `main.ts`.
 *
 * Standard OTLP env vars are honoured by the exporter directly
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, …) — we don't re-parse them.
 */

// Type-only import: erased at compile time, so importing this module
// from main.ts (for shutdownOtel) costs nothing when OTel is disabled.
import type { NodeSDK } from "@opentelemetry/sdk-node";

export interface OtelConfig {
  /** Whether the SDK should start. False ⇒ fully no-op, no deps loaded. */
  enabled: boolean;
  /** OTLP base endpoint (e.g. http://collector:4318). Empty when disabled. */
  endpoint: string;
  /** Reported `service.name`. */
  serviceName: string;
  /** Reported `service.version`. */
  serviceVersion: string;
  /** This process's shard id, attached as a resource attribute. */
  shardId: string;
}

/**
 * Pure decision function — extracted so the enable/disable logic is unit
 * testable without starting the actual SDK.
 *
 * Default-off rule: enabled ONLY when an OTLP endpoint is configured and
 * the OTel-standard `OTEL_SDK_DISABLED` kill switch is not set to true.
 */
export function otelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OtelConfig {
  const endpoint = (
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    ""
  ).trim();
  const explicitlyDisabled =
    (env.OTEL_SDK_DISABLED ?? "").toLowerCase() === "true";
  const enabled = endpoint.length > 0 && !explicitlyDisabled;
  return {
    enabled,
    endpoint,
    serviceName: (env.OTEL_SERVICE_NAME ?? "").trim() || "karyl-bot",
    serviceVersion:
      (env.OTEL_SERVICE_VERSION ?? "").trim() ||
      (env.npm_package_version ?? "").trim() ||
      "0.0.0",
    shardId: (env.SHARD_ID ?? "0").trim() || "0",
  };
}

// Module-level singleton. register.ts (under `--import`) calls startOtel;
// main.ts imports this same module instance (same resolved URL ⇒ same
// singleton) and calls shutdownOtel during gracefulShutdown to flush
// any buffered spans before process.exit.
let sdk: NodeSDK | null = null;

/**
 * Start the OTel SDK if configured. Idempotent. Returns true when the
 * SDK was started (or already running), false when disabled.
 *
 * All heavy `@opentelemetry/*` runtime packages are imported lazily here
 * so the disabled path never pulls them in.
 */
export async function startOtel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (sdk) return true;
  const cfg = otelConfigFromEnv(env);
  if (!cfg.enabled) return false;

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { getNodeAutoInstrumentations },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { diag, DiagConsoleLogger, DiagLogLevel },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/api"),
  ]);

  // Surface SDK diagnostics only when explicitly asked — the SDK is
  // otherwise silent so a misconfigured endpoint doesn't spam logs.
  if ((env.OTEL_LOG_LEVEL ?? "").trim().length > 0) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: cfg.serviceName,
      [ATTR_SERVICE_VERSION]: cfg.serviceVersion,
      // Lets a multi-shard deployment filter traces per gateway slice.
      "karyl.shard_id": cfg.shardId,
    }),
    // No-arg: the exporter reads OTEL_EXPORTER_OTLP_* env vars itself
    // (endpoint, headers, timeout), so all standard OTLP knobs apply.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs/dns/net are high-volume and low-signal for this service —
        // they bury the http/pg/redis/fastify spans we actually want.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });
  sdk.start();
  return true;
}

/**
 * Flush + shut down the SDK. No-op when disabled. Swallows errors —
 * shutdown runs inside gracefulShutdown's try block and a failed span
 * flush must never block process exit.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  try {
    await current.shutdown();
  } catch {
    // Best-effort flush; nothing actionable on shutdown.
  }
}
