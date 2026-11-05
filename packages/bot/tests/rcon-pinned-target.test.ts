/**
 * #144 — the RCON client is pinned to the addresses the host policy
 * vetted, and every reconnect resolves and vets the host again (DNS
 * rebinding guard). DNS (`dns/promises.lookup`) and the pinned client
 * are stubbed; the host policy itself is the real one. That the pinned
 * client connects only to its addresses is tests/pinned-rcon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({ lookup: vi.fn() }));

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

type Pinned = Array<{ address: string; family: number }>;

interface FakeRcon {
  host: string;
  port: number;
  password: string;
  pinned: Pinned;
  repin: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
}

const instances: FakeRcon[] = [];

vi.mock("../src/modules/builtin-features/rcon-forward/pinned-rcon.js", () => {
  type Self = FakeRcon & { handlers: Map<string, Array<(...a: unknown[]) => void>> };
  function MockPinnedRcon(this: Self, host: string, port: number, password: string, pinned: Pinned) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.pinned = pinned;
    this.repin = vi.fn((next: Pinned) => {
      this.pinned = next;
    });
    this.handlers = new Map();
    this.connect = vi.fn();
    this.disconnect = vi.fn();
    this.send = vi.fn();
    instances.push(this);
  }
  MockPinnedRcon.prototype.on = function (this: Self, event: string, cb: (...a: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    return this;
  };
  MockPinnedRcon.prototype.removeAllListeners = function (this: Self) {
    this.handlers.clear();
  };
  MockPinnedRcon.prototype.emit = function (this: Self, event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  };
  return { PinnedRcon: MockPinnedRcon };
});

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

const { lookup } = await import("dns/promises");
const { RconConnectionService } = await import(
  "../src/modules/builtin-features/rcon-forward/rcon-connection.service.js"
);
const { botEventLog } = await import("../src/modules/bot-events/bot-event-log.js");

const mockedLookup = vi.mocked(lookup);
type LookupResult = Awaited<ReturnType<typeof lookup>>;

function answer(...addresses: string[]): LookupResult {
  return addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  })) as unknown as LookupResult;
}

function makeChannel() {
  return {
    id: "channel-1",
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("discord.js").TextChannel & {
    send: ReturnType<typeof vi.fn>;
  };
}

function embedTitles(channel: { send: ReturnType<typeof vi.fn> }): string[] {
  return channel.send.mock.calls.map(
    (args: unknown[]) => (args[0] as { embeds: Array<{ title: string }> }).embeds[0].title,
  );
}

const svc = RconConnectionService as unknown as {
  connectionMap: Record<string, unknown>;
  connectionLocks: Map<string, Promise<void>>;
};

beforeEach(() => {
  instances.length = 0;
  svc.connectionMap = {};
  svc.connectionLocks = new Map();
  mockedLookup.mockReset();
  vi.mocked(botEventLog.record).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RCON initial connect", () => {
  it("pins the client to the vetted IP", async () => {
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));

    await expect(
      RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", makeChannel()),
    ).resolves.toBe(true);

    expect(mockedLookup).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    expect(instances[0].pinned).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(instances[0].port).toBe(25575);
    expect(instances[0].password).toBe("pw");
    expect(instances[0].connect).toHaveBeenCalledOnce();
  });

  it("pins every vetted answer when the host has several", async () => {
    mockedLookup.mockResolvedValue(answer("fd00::7", "10.0.0.7"));

    await RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", makeChannel());

    expect(instances[0].pinned).toEqual([
      { address: "fd00::7", family: 6 },
      { address: "10.0.0.7", family: 4 },
    ]);
  });

  it("keeps showing and logging the hostname", async () => {
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));

    await RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", makeChannel());
    instances[0].emit("auth");

    expect(instances[0].host).toBe("mc-server");
    expect(RconConnectionService.getConnection("c1")?.host).toBe("mc-server");
    expect(botEventLog.record).toHaveBeenCalledWith(
      "info",
      "feature",
      "RCON connected: mc-server:25575",
      { host: "mc-server", port: 25575 },
    );
  });

  it("never builds a client when an answer is a metadata address", async () => {
    mockedLookup.mockResolvedValue(answer("10.0.0.5", "169.254.169.254"));
    const channel = makeChannel();

    await expect(
      RconConnectionService.initializeConnection("c1", "rebind.example", 25575, "pw", channel),
    ).resolves.toBe(false);

    expect(instances).toHaveLength(0);
    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel)).toEqual(["Connection Error"]);
  });
});

describe("RCON reconnect", () => {
  async function connectThenDrop(first: LookupResult) {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(first);
    const channel = makeChannel();
    await RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", channel);
    instances[0].emit("error", new Error("ECONNRESET"));
    return channel;
  }

  it("re-resolves and repins the client to the new IP before connecting", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValue(answer("10.0.0.6"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockedLookup).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(1);
    expect(instances[0].repin).toHaveBeenCalledWith([{ address: "10.0.0.6", family: 4 }]);
    expect(instances[0].connect).toHaveBeenCalledTimes(2);
    expect(instances[0].repin.mock.invocationCallOrder[0]).toBeLessThan(
      instances[0].connect.mock.invocationCallOrder[1],
    );
    expect(RconConnectionService.getConnection("c1")?.host).toBe("mc-server");
    // The listeners were re-attached; a later auth resets the attempt count.
    instances[0].emit("auth");
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(0);
  });

  it("fails the attempt when the host now resolves to metadata, then tries again", async () => {
    const channel = await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValueOnce(answer("169.254.169.254"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances[0].repin).not.toHaveBeenCalled();
    expect(instances[0].connect).toHaveBeenCalledOnce();

    // The next attempt (4 s backoff) resolves to the real address again.
    await vi.advanceTimersByTimeAsync(4000);

    expect(instances[0].repin).toHaveBeenCalledWith([{ address: "10.0.0.5", family: 4 }]);
    expect(instances[0].connect).toHaveBeenCalledTimes(2);
    expect(embedTitles(channel)).toEqual(["RCON Error", "Connection Lost", "Connection Lost"]);
  });

  it("fails the attempt on a DNS failure, then tries again", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockRejectedValueOnce(new Error("EAI_AGAIN"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances[0].connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4000);

    expect(instances[0].connect).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt when every re-resolve is refused", async () => {
    const channel = await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValue(answer("169.254.169.254"));

    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);

    expect(instances[0].repin).not.toHaveBeenCalled();
    expect(instances[0].connect).toHaveBeenCalledOnce();
    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel).at(-1)).toBe("Connection Failed");
    expect(botEventLog.record).toHaveBeenCalledWith(
      "error",
      "feature",
      "RCON reconnect exhausted: mc-server:25575",
      expect.objectContaining({ host: "mc-server", attempts: 3 }),
    );
  });

  it("leaves a connection re-created during a failing re-resolve alone", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    let failLookup: () => void = () => {};
    mockedLookup.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failLookup = () => reject(new Error("EAI_AGAIN"));
        }),
    );
    await vi.advanceTimersByTimeAsync(2000); // reconnect now waits on DNS

    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    await RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", makeChannel());
    failLookup();
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);

    expect(instances).toHaveLength(2);
    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
    expect(instances[1].connect).toHaveBeenCalledOnce();
  });

  it("does not reconnect a connection removed while it waited", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    await RconConnectionService.cleanupConnection("c1");

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances[0].repin).not.toHaveBeenCalled();
    expect(instances[0].connect).toHaveBeenCalledOnce();
  });
});
