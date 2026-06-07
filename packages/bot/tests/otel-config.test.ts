/**
 * OTel SDK bootstrap config (PR-0.1).
 *
 * Exercises the pure enable/disable decision (`otelConfigFromEnv`) and
 * the default-off guarantee of `startOtel` — the SDK must never start,
 * nor import its heavy runtime packages, unless an OTLP endpoint is
 * configured. We pass explicit env objects so the test never depends on
 * the ambient process environment.
 */

import { describe, expect, it } from "vitest";
import { otelConfigFromEnv, startOtel } from "../src/observability/otel.js";

describe("otelConfigFromEnv", () => {
  it("is disabled by default (no endpoint set)", () => {
    const cfg = otelConfigFromEnv({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.endpoint).toBe("");
  });

  it("enables when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    const cfg = otelConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("http://collector:4318");
  });

  it("prefers the traces-specific endpoint over the generic one", () => {
    const cfg = otelConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
    });
    expect(cfg.endpoint).toBe("http://traces:4318/v1/traces");
  });

  it("stays disabled when OTEL_SDK_DISABLED=true even with an endpoint", () => {
    const cfg = otelConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SDK_DISABLED: "true",
    });
    expect(cfg.enabled).toBe(false);
  });

  it("treats a whitespace-only endpoint as unset", () => {
    const cfg = otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " });
    expect(cfg.enabled).toBe(false);
  });

  it("defaults service name / version / shard id", () => {
    const cfg = otelConfigFromEnv({});
    expect(cfg.serviceName).toBe("karyl-bot");
    expect(cfg.serviceVersion).toBe("0.0.0");
    expect(cfg.shardId).toBe("0");
  });

  it("honours explicit service + shard overrides", () => {
    const cfg = otelConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      OTEL_SERVICE_NAME: "karyl-bot-shard-2",
      OTEL_SERVICE_VERSION: "1.2.3",
      SHARD_ID: "2",
    });
    expect(cfg.serviceName).toBe("karyl-bot-shard-2");
    expect(cfg.serviceVersion).toBe("1.2.3");
    expect(cfg.shardId).toBe("2");
  });

  it("falls back to npm_package_version when no explicit version", () => {
    const cfg = otelConfigFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      npm_package_version: "9.9.9",
    });
    expect(cfg.serviceVersion).toBe("9.9.9");
  });
});

describe("startOtel default-off", () => {
  it("returns false and starts nothing when disabled", async () => {
    const started = await startOtel({});
    expect(started).toBe(false);
  });
});
