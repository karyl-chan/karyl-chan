import { describe, expect, it } from "vitest";
import {
  childTraceContext,
  newTraceContext,
  outboundTraceparent,
  parseTraceparent,
  TRACEPARENT_HEADER,
} from "../src/utils/trace-context.js";

const RX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/;

describe("W3C trace context utilities", () => {
  it("exposes the canonical header name", () => {
    expect(TRACEPARENT_HEADER).toBe("traceparent");
  });

  it("newTraceContext generates a sampled, well-formed traceparent", () => {
    const ctx = newTraceContext();
    expect(ctx.traceparent).toMatch(RX);
    expect(ctx.flags).toBe("01");
    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toHaveLength(16);
  });

  it("newTraceContext(false) emits unsampled flag", () => {
    expect(newTraceContext(false).flags).toBe("00");
  });

  it("parseTraceparent accepts a valid header", () => {
    const ctx = newTraceContext();
    const parsed = parseTraceparent(ctx.traceparent);
    expect(parsed).toEqual(ctx);
  });

  it("parseTraceparent rejects malformed input", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("01-aaaa-bbbb-cc")).toBeNull(); // wrong version
    expect(parseTraceparent("00-not-hex-stuff")).toBeNull();
    expect(parseTraceparent(`00-${"x".repeat(32)}-${"y".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(undefined as unknown)).toBeNull();
    expect(parseTraceparent(42 as unknown)).toBeNull();
  });

  it("childTraceContext preserves trace id, mints a fresh span id", () => {
    const parent = newTraceContext();
    const child = childTraceContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.flags).toBe(parent.flags);
    expect(child.traceparent).toMatch(RX);
  });

  it("outboundTraceparent generates fresh when parent is null", () => {
    const tp = outboundTraceparent(null);
    expect(tp).toMatch(RX);
  });

  it("outboundTraceparent produces a child of the parent context", () => {
    const parent = newTraceContext();
    const tp = outboundTraceparent(parent);
    const parsed = parseTraceparent(tp);
    expect(parsed?.traceId).toBe(parent.traceId);
    expect(parsed?.spanId).not.toBe(parent.spanId);
  });
});
