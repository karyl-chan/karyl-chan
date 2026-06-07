/**
 * Voice service entrypoint (PR-2.3c).
 *
 * Boots the HTTP API, listens, and wires graceful shutdown (tear down all
 * voice connections, then close the server). Single-machine deployments never
 * run this — it's only started when the split is enabled (VOICE_SERVICE_URL on
 * the bot points here).
 */
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { shutdownAllVoice } from "./voice-manager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server } = buildServer({
    hmacSecret: config.hmacSecret,
    botInternalUrl: config.botInternalUrl,
    logger: true,
  });

  await server.listen({ port: config.port, host: config.host });
  server.log.info(
    { port: config.port, host: config.host, bot: config.botInternalUrl },
    "voice service listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, "voice service shutting down");
    try {
      shutdownAllVoice();
    } catch (err) {
      server.log.error({ err }, "error tearing down voice connections");
    }
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "voice service failed to start", err: String(err) }));
  process.exit(1);
});
