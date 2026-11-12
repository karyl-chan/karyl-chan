/**
 * #163 — a reconnect authenticates again with the real `rcon` client.
 * node-rcon authenticates a client once (`hasAuthed`), and a socket
 * reset emits `error` without the `end` that would clear it, so a
 * reused client never emitted `auth` after reconnecting and the
 * attempt count never reset. The service, PinnedRcon and the host
 * policy are real; the server is a loopback Source-RCON listener.
 *
 * #180 — a server that closes the connection gracefully (FIN, `end`
 * without `error`) is reconnected the same way.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  config: {
    rcon: {
      maxRetryAttempts: 3,
      maxQueueSize: 100,
      connectionTimeoutMs: 30_000,
      cleanupIntervalMs: 300_000,
      maxConnections: 50,
    },
  },
}));

vi.mock("../src/logger.js", () => ({
  moduleLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { RconConnectionService } = await import(
  "../src/modules/builtin-features/rcon-forward/rcon-connection.service.js"
);

/** Minimal Source-RCON server: accepts every auth packet. */
function startRconServer(): Promise<{ server: net.Server; port: number; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (data) => {
      const reply = Buffer.alloc(14);
      reply.writeInt32LE(10, 0);
      reply.writeInt32LE(data.readInt32LE(4), 4); // echo the request id
      reply.writeInt32LE(2, 8); // SERVERDATA_AUTH_RESPONSE
      socket.write(reply);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port, sockets });
    });
  });
}

function makeChannel() {
  return {
    id: "channel-1",
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("discord.js").TextChannel;
}

let ctx: Awaited<ReturnType<typeof startRconServer>>;

beforeEach(async () => {
  ctx = await startRconServer();
});

afterEach(async () => {
  await RconConnectionService.cleanupConnection("c1");
  for (const socket of ctx.sockets) socket.destroy();
  await new Promise((resolve) => ctx.server.close(resolve));
});

describe("RCON reconnect with the real client", () => {
  it.each([
    // The client sees ECONNRESET, not `end`.
    ["a reset", (socket: net.Socket) => socket.resetAndDestroy()],
    // FIN: the client sees `end`, no `error`.
    ["a graceful close", (socket: net.Socket) => socket.end()],
  ])("authenticates again after %s and resets the attempt count", async (_, drop) => {
    await RconConnectionService.initializeConnection("c1", "127.0.0.1", ctx.port, "pw", makeChannel());
    await vi.waitFor(() => expect(RconConnectionService.getConnection("c1")?.authenticated).toBe(true));

    drop(ctx.sockets[0]);
    await vi.waitFor(() =>
      expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(1),
    );

    // First backoff is 2 s.
    await vi.waitFor(
      () => {
        const connection = RconConnectionService.getConnection("c1");
        expect(connection?.authenticated).toBe(true);
        expect(connection?.reconnectAttempts).toBe(0);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(ctx.sockets).toHaveLength(2);
  }, 10_000);
});
