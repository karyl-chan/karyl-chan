/**
 * #144 — the RCON client is pinned to the addresses the host policy
 * vetted, and every reconnect resolves and vets the host again (DNS
 * rebinding guard). DNS (`dns/promises.lookup`) and the pinned client
 * are stubbed; the host policy itself is the real one. That the pinned
 * client connects only to its addresses is tests/pinned-rcon.test.ts.
 *
 * #163 — every reconnect builds a fresh client, and a replaced client's
 * late events never touch the connection that replaced it.
 *
 * #180 — a server that closes the connection gracefully (`end`, no
 * `error`) is a failure like any other: it is retried and, after the
 * last attempt, reported. Every connect attempt is bounded by a timeout
 * that ends once the client authenticates or is closed. initializeConnection
 * and the callers waiting on its lock settle with the attempt: true once
 * the client authenticates, false when the first connect fails. Only the
 * call that took the lock releases it.
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
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
}

const instances: FakeRcon[] = [];
/** While set, the server accepts a new client's password as it connects. */
let authOnConnect = false;

vi.mock("../src/modules/builtin-features/rcon-forward/pinned-rcon.js", () => {
  type Self = FakeRcon & { handlers: Map<string, Array<(...a: unknown[]) => void>> };
  function MockPinnedRcon(this: Self, host: string, port: number, password: string, pinned: Pinned) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.pinned = pinned;
    this.handlers = new Map();
    this.connect = vi.fn(() => {
      if (authOnConnect) this.emit("auth");
    });
    this.disconnect = vi.fn();
    this.destroy = vi.fn();
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
    const listeners = this.handlers.get(event) ?? [];
    // Like an EventEmitter: an "error" nobody listens to throws.
    if (event === "error" && listeners.length === 0) throw args[0];
    for (const cb of listeners) cb(...args);
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

/** initializeConnection for "c1", against a server that accepts the password. */
async function initialize(channel = makeChannel()) {
  authOnConnect = true;
  try {
    return await RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", channel);
  } finally {
    authOnConnect = false;
  }
}

/** initializeConnection for "c1"; the test drives its client. */
function startConnect(channel = makeChannel()) {
  return RconConnectionService.initializeConnection("c1", "mc-server", 25575, "pw", channel);
}

/** Connect "c1" under fake timers; its client has authenticated. */
async function connectAndAuth() {
  vi.useFakeTimers();
  mockedLookup.mockResolvedValue(answer("10.0.0.5"));
  const channel = makeChannel();
  await expect(initialize(channel)).resolves.toBe(true);
  return channel;
}

/** Whether a promise has settled, after the pending microtasks ran. */
async function isSettled(promise: Promise<unknown>) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return settled;
}

beforeEach(() => {
  instances.length = 0;
  authOnConnect = false;
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

    await expect(initialize()).resolves.toBe(true);

    expect(mockedLookup).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(1);
    expect(instances[0].pinned).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(instances[0].port).toBe(25575);
    expect(instances[0].password).toBe("pw");
    expect(instances[0].connect).toHaveBeenCalledOnce();
  });

  it("pins every vetted answer when the host has several", async () => {
    mockedLookup.mockResolvedValue(answer("fd00::7", "10.0.0.7"));

    await initialize();

    expect(instances[0].pinned).toEqual([
      { address: "fd00::7", family: 6 },
      { address: "10.0.0.7", family: 4 },
    ]);
  });

  it("keeps showing and logging the hostname", async () => {
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));

    await initialize();

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
    await initialize(channel);
    instances[0].emit("error", new Error("ECONNRESET"));
    return channel;
  }

  it("re-resolves and connects a fresh client pinned to the new IP", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValue(answer("10.0.0.6"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockedLookup).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);
    expect(instances[1].pinned).toEqual([{ address: "10.0.0.6", family: 4 }]);
    expect(instances[1].connect).toHaveBeenCalledOnce();
    expect(instances[0].connect).toHaveBeenCalledOnce();
    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
    expect(RconConnectionService.getConnection("c1")?.host).toBe("mc-server");
  });

  it("fails the attempt when the host now resolves to metadata, then tries again", async () => {
    const channel = await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValueOnce(answer("169.254.169.254"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances).toHaveLength(1);

    // The next attempt (4 s backoff) resolves to the real address again.
    await vi.advanceTimersByTimeAsync(4000);

    expect(instances).toHaveLength(2);
    expect(instances[1].pinned).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(instances[1].connect).toHaveBeenCalledOnce();
    expect(embedTitles(channel)).toEqual(["RCON Error", "Connection Lost", "Connection Lost"]);
  });

  it("fails the attempt on a DNS failure, then tries again", async () => {
    await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockRejectedValueOnce(new Error("EAI_AGAIN"));

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4000);

    expect(instances).toHaveLength(2);
    expect(instances[1].connect).toHaveBeenCalledOnce();
  });

  it("gives up after the last attempt when every re-resolve is refused", async () => {
    const channel = await connectThenDrop(answer("10.0.0.5"));
    mockedLookup.mockResolvedValue(answer("169.254.169.254"));

    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);

    expect(instances).toHaveLength(1);
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
    await initialize();
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

    expect(instances).toHaveLength(1);
  });
});

describe("RCON reconnect lifecycle", () => {
  /** Drop the current client and let the next attempt's backoff elapse. */
  async function dropAndRetry(delayMs: number) {
    instances.at(-1)!.emit("error", new Error("ECONNRESET"));
    await vi.advanceTimersByTimeAsync(delayMs);
  }

  it("a replaced client's late end leaves the re-created connection alone", async () => {
    await connectAndAuth();
    await initialize();
    expect(instances).toHaveLength(2);

    instances[0].emit("end");
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
  });

  it("the dropped client's late end leaves the reconnected connection alone", async () => {
    await connectAndAuth();
    await dropAndRetry(2000);
    expect(instances).toHaveLength(2);

    instances[0].emit("end");
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
  });

  it("a replaced client's late error neither throws nor drives another attempt", async () => {
    const channel = await connectAndAuth();
    await dropAndRetry(2000);
    instances[1].emit("auth");
    const sent = channel.send.mock.calls.length;

    expect(() => instances[0].emit("error", new Error("EPIPE"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(instances).toHaveLength(2);
    expect(channel.send.mock.calls.length).toBe(sent);
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(0);
  });

  it("a cleaned-up client's late error does not throw", async () => {
    await connectAndAuth();
    await RconConnectionService.cleanupConnection("c1");

    expect(() => instances[0].emit("error", new Error("EPIPE"))).not.toThrow();
  });

  it("queues commands until the reconnected client authenticates", async () => {
    await connectAndAuth();
    instances[0].emit("error", new Error("ECONNRESET"));

    expect(RconConnectionService.getConnection("c1")?.authenticated).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    RconConnectionService.getConnection("c1")!.queuedCommands.push({
      content: "list",
      timestamp: Date.now(),
      channelId: "channel-1",
    });
    instances[1].emit("auth");

    expect(RconConnectionService.getConnection("c1")?.authenticated).toBe(true);
    expect(instances[1].send).toHaveBeenCalledWith("list");
    expect(instances[0].send).not.toHaveBeenCalled();
  });

  it("a successful reconnect resets the attempt count", async () => {
    const channel = await connectAndAuth();
    await dropAndRetry(2000);
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(1);

    instances[1].emit("auth");
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(0);

    // The next drop starts the count again, with the first backoff.
    await dropAndRetry(2000);
    expect(instances).toHaveLength(3);
    const lost = channel.send.mock.calls
      .map((args: unknown[]) => (args[0] as { embeds: Array<{ title: string; description?: string }> }).embeds[0])
      .filter((embed) => embed.title === "Connection Lost")
      .map((embed) => embed.description);
    expect(lost).toEqual(["正在嘗試重新連接 (1/3)...", "正在嘗試重新連接 (1/3)..."]);
  });

  it("notifies the channel when socket errors use up every attempt", async () => {
    const channel = await connectAndAuth();
    await dropAndRetry(2000);
    await dropAndRetry(4000);
    await dropAndRetry(8000);
    expect(instances).toHaveLength(4);

    instances[3].emit("error", new Error("ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel).at(-1)).toBe("Connection Failed");
    expect(botEventLog.record).toHaveBeenCalledWith(
      "error",
      "feature",
      "RCON reconnect exhausted: mc-server:25575",
      expect.objectContaining({ host: "mc-server", attempts: 3 }),
    );
  });

  it("a connection re-created while the failure notice is sent stays", async () => {
    const channel = await connectAndAuth();
    await dropAndRetry(2000);
    await dropAndRetry(4000);
    await dropAndRetry(8000);
    let deliver: () => void = () => {};
    channel.send.mockImplementation((message: { embeds: Array<{ title: string }> }) =>
      message.embeds[0].title === "Connection Failed"
        ? new Promise<void>((resolve) => {
            deliver = resolve;
          })
        : Promise.resolve(),
    );
    instances[3].emit("error", new Error("ECONNREFUSED")); // "Connection Failed" now in flight

    await initialize();
    deliver();
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[4]);
  });
});

describe("RCON graceful server close (#180)", () => {
  it("reconnects after the server closes an authenticated connection", async () => {
    const channel = await connectAndAuth();

    instances[0].emit("end");
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(1);
    expect(RconConnectionService.getConnection("c1")?.authenticated).toBe(false);
    expect(instances[0].disconnect).toHaveBeenCalled();
    expect(embedTitles(channel)).toEqual(["Connection Lost"]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(instances).toHaveLength(2);
    expect(instances[1].connect).toHaveBeenCalledOnce();
    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
  });

  it("keeps the queued commands for the reconnected client", async () => {
    await connectAndAuth();
    instances[0].emit("end");
    RconConnectionService.getConnection("c1")!.queuedCommands.push({
      content: "list",
      timestamp: Date.now(),
      channelId: "channel-1",
    });

    await vi.advanceTimersByTimeAsync(2000);
    instances[1].emit("auth");

    expect(instances[1].send).toHaveBeenCalledWith("list");
  });

  it("notifies the channel when every reconnect client is closed right after connecting", async () => {
    const channel = await connectAndAuth();
    instances[0].emit("end");
    for (const [index, delay] of [[1, 2000], [2, 4000], [3, 8000]] as const) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(instances).toHaveLength(index + 1);
      instances[index].emit("end");
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel)).toEqual([
      "Connection Lost",
      "Connection Lost",
      "Connection Lost",
      "Connection Failed",
    ]);
    expect(botEventLog.record).toHaveBeenCalledWith(
      "error",
      "feature",
      "RCON reconnect exhausted: mc-server:25575",
      expect.objectContaining({ host: "mc-server", attempts: 3 }),
    );
  });
});

describe("RCON connect timeout (#180)", () => {
  it("fails a first connect that does not authenticate within 10 s, without retrying", async () => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const channel = makeChannel();
    const result = startConnect(channel);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(await isSettled(result)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(instances[0].destroy).toHaveBeenCalled();
    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel)).toEqual(["Connection Error"]);
    expect(botEventLog.record).toHaveBeenCalledWith(
      "error",
      "feature",
      expect.stringContaining("RCON connection failed: mc-server:25575"),
      expect.objectContaining({ errorType: "timeout" }),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
  });

  it("fails a reconnect attempt that runs out like a close: destroyed, Lost only, retried", async () => {
    const channel = await connectAndAuth();
    instances[0].emit("end");
    await vi.advanceTimersByTimeAsync(2000);
    expect(instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(instances[1].destroy).toHaveBeenCalled();
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(2);
    expect(embedTitles(channel)).toEqual(["Connection Lost", "Connection Lost"]);

    await vi.advanceTimersByTimeAsync(4000);
    expect(instances).toHaveLength(3);
  });

  it("bounds every reconnect attempt and gives up after the last one", async () => {
    const channel = await connectAndAuth();
    instances[0].emit("end");

    // 2 s / 4 s / 8 s backoff, each attempt timing out after 10 s.
    await vi.advanceTimersByTimeAsync(2000 + 10_000 + 4000 + 10_000 + 8000 + 10_000);

    expect(instances).toHaveLength(4);
    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel)).toEqual([
      "Connection Lost",
      "Connection Lost",
      "Connection Lost",
      "Connection Failed",
    ]);
  });

  it("stops the timer once the client authenticates", async () => {
    const channel = await connectAndAuth();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(instances).toHaveLength(1);
    expect(RconConnectionService.getConnection("c1")?.reconnectAttempts).toBe(0);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("stops the timer, and ends the wait, when the connection is cleaned up", async () => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const result = startConnect();
    await vi.advanceTimersByTimeAsync(0);

    await RconConnectionService.cleanupConnection("c1");

    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a reconnect client's timer when the client is replaced", async () => {
    await connectAndAuth();
    instances[0].emit("error", new Error("ECONNRESET"));
    await vi.advanceTimersByTimeAsync(2000); // instances[1] is connecting

    await initialize();

    expect(instances).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a reconnect client's timer when it fails", async () => {
    await connectAndAuth();
    instances[0].emit("error", new Error("ECONNRESET"));
    await vi.advanceTimersByTimeAsync(2000);
    instances[1].emit("error", new Error("ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(0);

    // Only the 4 s backoff is left.
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("RCON first connect (#180)", () => {
  it.each([
    ["a socket error", (client: FakeRcon) => client.emit("error", new Error("ECONNREFUSED"))],
    ["the server closing the connection", (client: FakeRcon) => client.emit("end")],
  ])("fails on %s before authenticating, without retrying", async (_, drop) => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const channel = makeChannel();
    const result = startConnect(channel);
    await vi.advanceTimersByTimeAsync(0);

    drop(instances[0]);

    await expect(result).resolves.toBe(false);
    expect(RconConnectionService.getConnection("c1")).toBeUndefined();
    expect(embedTitles(channel)).toEqual(["Connection Error"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances).toHaveLength(1);
  });
});

describe("RCON connection lock (#180)", () => {
  it("a caller during a connect waits for it to authenticate, then joins it", async () => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const first = makeChannel();
    const second = makeChannel();
    const firstResult = startConnect(first);
    const secondResult = startConnect(second);

    expect(await isSettled(firstResult)).toBe(false);
    expect(await isSettled(secondResult)).toBe(false);

    instances[0].emit("auth");

    await expect(firstResult).resolves.toBe(true);
    await expect(secondResult).resolves.toBe(true);
    expect(instances).toHaveLength(1);
    expect(mockedLookup).toHaveBeenCalledOnce();
    // The second caller's channel gets the responses too.
    expect(RconConnectionService.getConnection("c1")?.channels).toEqual(new Set([first, second]));
  });

  it("a caller during a failing connect fails too, and its channel is told", async () => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const first = makeChannel();
    const second = makeChannel();
    const firstResult = startConnect(first);
    const secondResult = startConnect(second);
    await vi.advanceTimersByTimeAsync(0);

    instances[0].emit("error", new Error("ECONNREFUSED"));

    await expect(firstResult).resolves.toBe(false);
    await expect(secondResult).resolves.toBe(false);
    expect(embedTitles(first)).toEqual(["Connection Error"]);
    expect(embedTitles(second)).toEqual(["Connection Error"]);
    expect(instances).toHaveLength(1);
    expect(svc.connectionLocks.size).toBe(0);
  });

  it("cleaning up a connection keeps the lock of a connect in flight", async () => {
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    await initialize();

    let resolveLookup: (value: LookupResult) => void = () => {};
    mockedLookup.mockImplementationOnce(
      () =>
        new Promise<LookupResult>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const first = startConnect();
    await vi.waitFor(() => expect(mockedLookup).toHaveBeenCalledTimes(2));

    await RconConnectionService.cleanupConnection("c1");
    const second = startConnect();

    authOnConnect = true;
    resolveLookup(answer("10.0.0.5"));
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // The second connect waited on the first instead of opening its own client.
    expect(mockedLookup).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);
    expect(RconConnectionService.getConnection("c1")?.conn).toBe(instances[1]);
  });

  it("releases only its own lock", async () => {
    vi.useFakeTimers();
    mockedLookup.mockResolvedValue(answer("10.0.0.5"));
    const result = startConnect();
    await vi.advanceTimersByTimeAsync(0);
    const foreign = new Promise<void>(() => {});
    svc.connectionLocks.set("c1", foreign);

    instances[0].emit("auth");

    await expect(result).resolves.toBe(true);
    expect(svc.connectionLocks.get("c1")).toBe(foreign);
  });
});
