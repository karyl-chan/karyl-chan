/**
 * OpenTelemetry `--import` entry point.
 *
 * Loaded via `node --import ./build/observability/register.js build/main.js`
 * (and the ts-node equivalent in dev) so the SDK starts BEFORE any
 * instrumented module (`http` / `pg` / `undici` / `fastify`) is imported
 * by the app — auto-instrumentation patches modules at load time and must
 * win the race.
 *
 * No-op when OTel is disabled (no OTLP endpoint configured): startOtel
 * returns early without importing the heavy SDK packages.
 */
import { startOtel } from "./otel.js";

// Top-level await: the --import module fully settles before main.ts runs.
await startOtel();
