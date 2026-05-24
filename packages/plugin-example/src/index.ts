import { plugin, wireStarted } from "./plugin.js";

async function main(): Promise<void> {
  const started = await plugin.start();
  wireStarted({
    botRpc: started.botRpc,
    getSessionVerifyPublicKey: started.getSessionVerifyPublicKey,
    getPublicBaseUrl: started.getPublicBaseUrl,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("plugin-example failed to start:", err);
  process.exit(1);
});
