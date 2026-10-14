import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectRequiredTap } from "./required-result.mjs";

const e2eRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const requiredEnvironment = {
  TEST_E2E_REQUIRED: "1",
  TEST_CHAOS: "1",
  TEST_E2E_DB_URL: undefined,
  TEST_E2E_REDIS_URL: undefined,
};

const environmentErrors = Object.entries(requiredEnvironment).flatMap(
  ([name, expected]) => {
    const actual = process.env[name]?.trim();
    if (!actual) return [`${name} is required`];
    if (expected !== undefined && actual !== expected) {
      return [
        `${name} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      ];
    }
    return [];
  },
);

if (environmentErrors.length > 0) {
  process.stderr.write(
    `[plugin-platform-e2e] invalid required environment:\n- ${environmentErrors.join("\n- ")}\n`,
  );
  process.exit(1);
}

const scenarios = [
  {
    path: "Streams round-trip",
    file: "dist/src/streams-roundtrip.e2e.js",
    marker: "PR-6.2 streams round-trip over real Redis",
  },
  {
    path: "lifecycle",
    file: "dist/src/plugin-lifecycle.e2e.js",
    marker: "plugin lifecycle E2E (PM-2.1, path 3)",
  },
  {
    path: "admin auth",
    file: "dist/src/admin-dashboard.e2e.js",
    marker: "admin auth + builtin feature E2E (PM-2.2, paths 1+2)",
  },
  {
    path: "behavior/DM",
    file: "dist/src/behavior-and-dm.e2e.js",
    marker: "behavior webhook + DM inbox E2E (PM-2.3, paths 4+5)",
  },
  {
    path: "transport negotiation",
    file: "dist/src/transport-negotiation.e2e.js",
    marker: "#66 event transport negotiation E2E",
  },
  {
    path: "chaos recovery",
    file: "dist/src/chaos-scenarios.chaos.js",
    marker: "plugin-platform chaos recovery",
  },
];

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n[plugin-platform-e2e] START ${scenario.path}\n`);
    let output = "";
    let timedOut = false;
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-reporter=tap", scenario.file],
      {
        cwd: e2eRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const record = (destination, chunk) => {
      const text = chunk.toString();
      output += text;
      destination.write(text);
    };
    child.stdout.on("data", (chunk) => record(process.stdout, chunk));
    child.stderr.on("data", (chunk) => record(process.stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `[plugin-platform-e2e] ${scenario.path}: could not start test process: ${error.message}`,
        ),
      );
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const failures = [];
      if (timedOut) failures.push("timed out after 120 seconds");
      if (code !== 0) {
        failures.push(
          `test process exited ${code ?? `by signal ${signal ?? "unknown"}`}`,
        );
      }
      failures.push(...inspectRequiredTap(output, scenario.marker));

      if (failures.length > 0) {
        reject(
          new Error(
            `[plugin-platform-e2e] ${scenario.path} FAILED: ${failures.join("; ")}`,
          ),
        );
        return;
      }

      process.stdout.write(`[plugin-platform-e2e] PASS ${scenario.path}\n`);
      resolve();
    });
  });
}

for (const scenario of scenarios) {
  try {
    await runScenario(scenario);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

process.stdout.write(
  `\n[plugin-platform-e2e] PASS all ${scenarios.length} required paths; no skips or TODOs\n`,
);
