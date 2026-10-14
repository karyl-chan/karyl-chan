import { plugin } from "./plugin.js";

// start() spins up the plugin's HTTP server, and — when
// KARYL_PLUGIN_SETUP_SECRET is set — registers with the bot and begins
// the heartbeat loop. Reads PORT / HOST / BOT_URL / PLUGIN_URL /
// KARYL_PLUGIN_SETUP_SECRET from the environment (see .env.example).
async function main(): Promise<void> {
  const started = await plugin.start();
  // start() means the HTTP listener is available. whenReady() is the
  // stronger platform guarantee: registration, transport startup, onStart,
  // and the bot-side ready transition have all completed.
  await started.whenReady();
  console.log("__PLUGIN_KEY__ is ready for dispatch");
}

main().catch((err) => {
  console.error("__PLUGIN_KEY__ failed to start:", err);
  process.exit(1);
});
