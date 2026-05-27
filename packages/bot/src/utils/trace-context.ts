/**
 * W3C Trace Context propagation (pre-wiring).
 *
 * Generates and forwards `traceparent` headers across the bot's
 * dispatch surface so that an OpenTelemetry SDK init (Jaeger / Tempo
 * / Honeycomb exporter — any OTLP receiver) can be added later as a
 * single bootstrap call without re-touching every dispatch path.
 *
 * We deliberately do NOT add the OTel SDK as a dependency yet:
 *   1. It auto-instruments http / fetch / sqlite at process start
 *      with default settings; bringing that in alongside a graceful-
 *      drain refactor is too much surface area for one change.
 *   2. Header propagation works fine without an SDK — the trace ids
 *      are valid W3C Trace Context and a downstream system that
 *      DOES have an SDK can stitch them. A later commit will add
 *      `@opentelemetry/sdk-node` with an `OTEL_EXPORTER_OTLP_ENDPOINT`
 *      env switch (default-off).
 *
 * Spec: https://www.w3.org/TR/trace-context/
 *
 *   traceparent = "00-<trace_id:32 hex>-<span_id:16 hex>-<flags:2 hex>"
 *
 * `flags = "01"` ⇒ sampled.
 */

import { randomBytes } from "node:crypto";

const TRACEPARENT_RE =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceContext {
  /** 32-hex W3C trace id (zero-padded). */
  traceId: string;
  /** 16-hex W3C span id (zero-padded). */
  spanId: string;
  /** 2-hex flags; "01" = sampled. */
  flags: string;
  /** Reconstructed traceparent header value. */
  traceparent: string;
}

/**
 * Parse an inbound `traceparent` header value. Returns null on any
 * shape mismatch so callers can fall back to generating a fresh one.
 */
export function parseTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== "string") return null;
  const match = TRACEPARENT_RE.exec(value);
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  return { traceId, spanId, flags, traceparent: value };
}

/**
 * Generate a fresh trace context (new trace + new root span). Used
 * when an inbound request didn't carry a traceparent — typically a
 * gateway-originated Discord event arriving at the bot.
 */
export function newTraceContext(sampled = true): TraceContext {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const flags = sampled ? "01" : "00";
  return {
    traceId,
    spanId,
    flags,
    traceparent: `00-${traceId}-${spanId}-${flags}`,
  };
}

/**
 * Build a child span context that shares the parent's trace id but
 * carries a fresh span id. Used at every outbound hop — the bot dispatches
 * an event to a plugin and the plugin's logs should appear under a
 * sibling span of the bot's event-receive span.
 */
export function childTraceContext(parent: TraceContext): TraceContext {
  const spanId = randomBytes(8).toString("hex");
  return {
    traceId: parent.traceId,
    spanId,
    flags: parent.flags,
    traceparent: `00-${parent.traceId}-${spanId}-${parent.flags}`,
  };
}

/** Convenience: get the traceparent string for outbound headers, or
 *  generate a fresh one if `parent` is null. */
export function outboundTraceparent(parent: TraceContext | null): string {
  return (parent ? childTraceContext(parent) : newTraceContext()).traceparent;
}

export const TRACEPARENT_HEADER = "traceparent" as const;
