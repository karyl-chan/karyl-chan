import { hostname } from "node:os";
import pino, { type Logger } from "pino";
import { trace, isSpanContextValid } from "@opentelemetry/api";
import { config } from "./config.js";

const isDev = config.env !== "production";

// Service name reported on every log line — kept in sync with the OTel
// resource service.name (observability/otel.ts) so logs and traces share
// one identity in the aggregator. Default matches otel's "karyl-bot".
const serviceName = (process.env.OTEL_SERVICE_NAME ?? "").trim() || "karyl-bot";

/**
 * Trace-correlation fields for a single log line. When the OTel SDK is
 * active (PR-0.1) and a span is in context, every log emitted inside that
 * span carries the same `trace_id` / `span_id` as the exported spans — so
 * a log aggregator (Loki / ELK) can pivot from a log line straight to the
 * trace. When OTel is disabled there is no active span, so the fields are
 * omitted entirely (no all-zero noise).
 *
 * `getSpan` is injectable so the behaviour is unit-testable without
 * standing up a real tracer.
 */
export function traceFields(
  getSpan: () => ReturnType<typeof trace.getActiveSpan> = () =>
    trace.getActiveSpan(),
): { trace_id: string; span_id: string } | Record<string, never> {
  const span = getSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export const logger: Logger = pino({
  level: config.logging.level,
  // Base fields stamped on every line. `service` + `shard_id` let a
  // central aggregator slice logs per deployment identity and per gateway
  // shard in a multi-shard fleet; pid/hostname keep the pino defaults.
  base: {
    pid: process.pid,
    hostname: hostname(),
    service: serviceName,
    shard_id: config.bot.shardId,
  },
  // Per-line trace correlation (see traceFields). Cheap: a single
  // getActiveSpan() lookup; returns {} on the common no-span path.
  mixin() {
    return traceFields();
  },
  // pino-pretty in dev for human-readable output, raw JSON in prod for
  // log aggregators. The transport forks a worker thread in dev so the
  // main event loop isn't blocked by pretty-printing.
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

/**
 * Return a child logger bound to a module label. Each module creates one
 * at module-top-level:
 *
 *   const log = moduleLogger("rcon-connection");
 *
 * so all logs from that module carry `{ module: "rcon-connection" }` as a
 * structured field without repeating it at every callsite.
 */
export function moduleLogger(name: string): Logger {
  return logger.child({ module: name });
}
