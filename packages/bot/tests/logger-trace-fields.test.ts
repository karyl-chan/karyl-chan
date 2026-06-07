/**
 * Structured-log trace correlation (PR-0.2).
 *
 * traceFields() injects trace_id/span_id into every log line when a valid
 * OTel span is in context, and emits nothing otherwise — so logs correlate
 * with traces when OTel is on (PR-0.1) and stay clean when it's off. We
 * inject the span getter so the behaviour is testable without a live SDK.
 */

import { describe, expect, it } from "vitest";
import type { Span } from "@opentelemetry/api";
import { traceFields } from "../src/logger.js";

function fakeSpan(traceId: string, spanId: string, flags = 1): Span {
  return {
    spanContext: () => ({ traceId, spanId, traceFlags: flags }),
  } as unknown as Span;
}

describe("traceFields", () => {
  it("returns nothing when there is no active span (OTel off / no context)", () => {
    expect(traceFields(() => undefined)).toEqual({});
  });

  it("emits trace_id + span_id for a valid active span", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    expect(traceFields(() => fakeSpan(traceId, spanId))).toEqual({
      trace_id: traceId,
      span_id: spanId,
    });
  });

  it("ignores an invalid (all-zero) span context", () => {
    expect(
      traceFields(() =>
        fakeSpan(
          "00000000000000000000000000000000",
          "0000000000000000",
        ),
      ),
    ).toEqual({});
  });
});
