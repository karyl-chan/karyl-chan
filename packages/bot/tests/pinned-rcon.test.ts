/**
 * #144 — PinnedRcon drives the real `rcon` client against a loopback
 * listener, so it also guards the node-rcon internals it relies on.
 * No DNS is involved: the hostname is `.invalid`, which never resolves.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PinnedRcon } from "../src/modules/builtin-features/rcon-forward/pinned-rcon.js";

/** Minimal Source-RCON server: accepts every auth packet. */
function startRconServer(): Promise<{ server: net.Server; port: number; peers: string[] }> {
  const peers: string[] = [];
  const server = net.createServer((socket) => {
    peers.push(socket.remoteAddress ?? "");
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
      resolve({ server, port: (server.address() as net.AddressInfo).port, peers });
    });
  });
}

function authenticated(client: PinnedRcon): Promise<void> {
  return new Promise((resolve, reject) => {
    client.on("auth", () => resolve());
    client.on("error", reject);
  });
}

let ctx: Awaited<ReturnType<typeof startRconServer>>;
let client: PinnedRcon | undefined;

beforeEach(async () => {
  ctx = await startRconServer();
});

afterEach(async () => {
  client?.removeAllListeners();
  client?.on("error", () => {});
  client?.disconnect();
  client = undefined;
  await new Promise((resolve) => ctx.server.close(resolve));
});

describe("PinnedRcon", () => {
  it("connects to the pinned address without resolving the hostname", async () => {
    client = new PinnedRcon("rcon.invalid", ctx.port, "pw", [
      { address: "127.0.0.1", family: 4 },
    ]);
    const auth = authenticated(client);

    await client.connect();
    await auth;

    expect(ctx.peers).toEqual(["127.0.0.1"]);
  });

  it("falls back to the next pinned address when the first is unreachable", async () => {
    client = new PinnedRcon("rcon.invalid", ctx.port, "pw", [
      { address: "127.0.0.2", family: 4 }, // loopback, but nothing listens there
      { address: "127.0.0.1", family: 4 },
    ]);
    const auth = authenticated(client);

    await client.connect();
    await auth;

    expect(ctx.peers).toEqual(["127.0.0.1"]);
  });

  it("emits end when the server closes the connection", async () => {
    ctx.server.on("connection", (socket) => {
      socket.once("data", () => setImmediate(() => socket.end()));
    });
    client = new PinnedRcon("rcon.invalid", ctx.port, "pw", [
      { address: "127.0.0.1", family: 4 },
    ]);
    const ended = new Promise<void>((resolve) => client!.on("end", () => resolve()));
    const auth = authenticated(client);

    await client.connect();
    await auth;
    await ended;
  });
});
