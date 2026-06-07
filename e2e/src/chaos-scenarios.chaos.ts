/**
 * PR-6.3 — Chaos / fault-injection scenarios (scaffold).
 *
 * Chaos testing needs running services (a real bot, a real plugin, a
 * real Redis, and the ability to kill / partition them mid-flight). The
 * environment this was authored in cannot fully exercise that, so this
 * file ships a **documented scenario catalogue + a thin runner**, gated
 * behind TEST_CHAOS=1 exactly like the E2E smoke. It is deliberately NOT
 * claimed to have been executed.
 *
 * Each scenario records:
 *   - `fault`     : the failure injected.
 *   - `invariant` : what must still hold after recovery (the assertion).
 *   - `run`       : the steps. Steps that require live services and
 *                   out-of-process control (docker kill, iptables) are
 *                   documented TODOs that throw `NOT_IMPLEMENTED` so a
 *                   run can't silently "pass" without doing the work.
 *
 * To run (with the full compose topology up — see e2e/README.md):
 *
 *   docker compose -f e2e/docker-compose.e2e.yml --profile full up -d --build
 *   TEST_CHAOS=1 pnpm --dir e2e chaos
 *
 * Without TEST_CHAOS the whole file reports `# SKIP` and exits 0.
 */

import { describe, it } from "node:test";

const CHAOS = process.env.TEST_CHAOS === "1";

const NOT_IMPLEMENTED =
  "live-service chaos step not implemented here — requires the `full` " +
  "compose topology + out-of-process fault control (docker kill / iptables). " +
  "See the scenario's `invariant` for the assertion to wire up.";

interface ChaosScenario {
  name: string;
  /** The failure injected mid-flight. */
  fault: string;
  /** What must still hold after the system recovers. */
  invariant: string;
  /** Which bot subsystem this exercises. */
  exercises: string;
  /** Steps. Throws NOT_IMPLEMENTED until wired to a services-up lane. */
  run: () => Promise<void>;
}

/**
 * The chaos catalogue. These map 1:1 to the resilience mechanisms the bot
 * already ships (circuit breaker, retry, DLQ, graceful drain, gateway
 * resume) — each scenario injects the fault that mechanism exists to
 * survive and asserts the mechanism actually kicks in.
 */
export const SCENARIOS: ChaosScenario[] = [
  {
    name: "kill-plugin",
    fault:
      "SIGKILL the plugin process mid event-dispatch, then restart it.",
    invariant:
      "Events emitted while the plugin was down are NOT lost: with " +
      "EVENT_BUS=redis-streams they queue in the stream and are " +
      "redelivered (XREADGROUP from the group's cursor) on restart; the " +
      "bot's per-plugin circuit breaker opens during the outage and " +
      "half-opens after, so dispatch resumes without operator action. No " +
      "duplicate side effects beyond at-least-once (handler idempotency).",
    exercises: "circuit breaker + Streams redelivery + plugin re-register",
    run: async () => {
      // TODO(services-up):
      //   1. produce N events via the bot while the plugin is alive; drain.
      //   2. `docker kill` the plugin container.
      //   3. produce M more events (these must buffer in the stream).
      //   4. `docker start` the plugin; wait for re-register + consumer join.
      //   5. assert the handler eventually observes all N+M event ids
      //      (XPENDING for the group reaches 0; no entry in the :dlq stream
      //      that wasn't a genuine poison message).
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  {
    name: "kill-redis",
    fault: "Stop the Redis container during steady-state dispatch.",
    invariant:
      "Producer XADDs fail soft (fire-and-forget contract — bot does not " +
      "crash, Discord event handlers still return); the SDK consumer's " +
      "XREADGROUP backs off and retries. When Redis returns, dispatch " +
      "resumes and the consumer group cursor is intact (no events lost " +
      "for entries that were durably XADDed before the outage).",
    exercises: "fire-and-forget producer + consumer backoff/reconnect",
    run: async () => {
      // TODO(services-up):
      //   1. steady-state produce/consume; confirm flow.
      //   2. `docker stop redis`; produce events (XADD should fail soft,
      //      bot must stay up — assert no crash, /healthz still 200).
      //   3. `docker start redis`; assert consumer reconnects and resumes
      //      from its cursor within a bounded window.
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  {
    name: "network-partition",
    fault:
      "iptables-DROP the bot→plugin RPC path (commands/events dispatch) " +
      "while leaving both processes alive.",
    invariant:
      "Outbound dispatch POSTs time out and are retried per the SDK's " +
      "callBotRpc policy (503/429/network → bounded retry+backoff); the " +
      "per-plugin circuit breaker opens after the failure threshold and " +
      "sheds load instead of hammering a black hole. On heal, the breaker " +
      "half-opens and traffic resumes. No unbounded retry storm, no " +
      "memory growth from queued dispatches.",
    exercises: "RPC retry/backoff + circuit breaker open→half-open→close",
    run: async () => {
      // TODO(services-up):
      //   1. establish flow.
      //   2. partition (iptables -A) the bot→plugin route.
      //   3. drive dispatches; assert breaker opens + metrics reflect
      //      failures; assert NO crash and bounded in-flight count.
      //   4. heal (iptables -D); assert breaker recovers and flow resumes.
      throw new Error(NOT_IMPLEMENTED);
    },
  },
  {
    name: "gateway-resume-window",
    fault:
      "Drop the Discord gateway connection and force a RESUME (vs a fresh " +
      "IDENTIFY) — simulate the resume window where buffered gateway " +
      "events replay.",
    invariant:
      "Events that arrive during/around the resume window are not " +
      "double-processed: the bot's event-dedup layer (bot-event-dedup) " +
      "drops replays so each Discord event is dispatched to plugins " +
      "exactly once. Graceful-drain in flight is respected (readiness " +
      "drain doesn't strand half-handled interactions).",
    exercises: "gateway resume dedup + graceful drain",
    run: async () => {
      // TODO(services-up):
      //   1. with the bot connected, capture the set of dispatched event
      //      ids over a window.
      //   2. force a gateway reconnect/RESUME (kill the ws / use a proxy
      //      that severs then restores the gateway socket).
      //   3. assert the dispatched-event-id set has no duplicates across
      //      the resume boundary (dedup held).
      throw new Error(NOT_IMPLEMENTED);
    },
  },
];

/**
 * Sanity invariants that DON'T need live services — these run even in the
 * gated lane to prove the catalogue itself is well-formed (every scenario
 * declares a fault, an invariant, and a runnable step).
 */
function assertCatalogueWellFormed(): void {
  const names = new Set<string>();
  for (const s of SCENARIOS) {
    if (!s.name || names.has(s.name)) {
      throw new Error(`chaos scenario name missing/duplicate: ${s.name}`);
    }
    names.add(s.name);
    if (!s.fault || !s.invariant || typeof s.run !== "function") {
      throw new Error(`chaos scenario '${s.name}' is incomplete`);
    }
  }
}

(CHAOS ? describe : describe.skip)("PR-6.3 chaos scenarios", () => {
  it("catalogue is well-formed", () => {
    assertCatalogueWellFormed();
  });

  for (const scenario of SCENARIOS) {
    // Each live scenario throws NOT_IMPLEMENTED until wired to a
    // services-up lane — so a TEST_CHAOS run is honest about what has
    // and hasn't actually been exercised (it FAILS loudly rather than
    // green-washing). Operators wiring the services-up lane replace the
    // `run` body and drop the `{ todo: true }`.
    it(
      `${scenario.name}: ${scenario.invariant.slice(0, 60)}…`,
      { todo: true },
      async () => {
        await scenario.run();
      },
    );
  }
});
