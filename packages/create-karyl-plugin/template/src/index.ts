import { plugin } from "./plugin.js";

// start() spins up the plugin's HTTP server, and — when
// KARYL_PLUGIN_SETUP_SECRET is set — registers with the bot and begins
// the heartbeat loop. Reads PORT / HOST / BOT_URL / PLUGIN_URL /
// KARYL_PLUGIN_SETUP_SECRET from the environment (see .env.example).
async function main(): Promise<void> {
  await plugin.start();
}

main().catch((err) => {
  console.error("__PLUGIN_KEY__ failed to start:", err);
  process.exit(1);
});
