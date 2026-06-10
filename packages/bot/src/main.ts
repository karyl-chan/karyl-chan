// Entry point. All the boot wiring lives in src/runtime/* — this file
// just runs the fail-closed config assertion, builds the runtime, and
// starts it. Nothing imports from here (the bot client is dependency-
// injected, not imported), so this module is a pure leaf.
import { config } from "./config.js";
import { validateMetadataCoverage } from "./config-metadata.js";
import { createRuntime } from "./runtime/runtime.js";

// Fail-closed boot assertion: every config leaf must have explicit
// classification in config-metadata.ts. We run this at module load
// (before building the runtime) so a missing entry crashes the process
// once, instead of being caught by the resetBot retry loop and crash-
// looping every 10 seconds.
validateMetadataCoverage(config);

const runtime = createRuntime();
// Fire-and-forget, as before the runtime split — nothing awaits the
// entry point; startup's own catch drives the resetBot retry loop.
void runtime.start();
