import { TextChannel } from "discord.js";
import { config } from "../../../config.js";
import {
  DEFAULT_COLOR,
  FAILED_COLOR,
  SUCCEEDED_COLOR,
} from "../../../utils/constant.js";
import {
  HostPolicyError,
  resolveAllowedTarget,
} from "../../../utils/host-policy.js";
import { botEventLog } from "../../bot-events/bot-event-log.js";
import type { PinnedAddress } from "../../../utils/pinned-dispatcher.js";
import { moduleLogger } from "../../../logger.js";
import { PinnedRcon } from "./pinned-rcon.js";

const log = moduleLogger("rcon-connection");

export interface RconConnection {
  /**
   * The current client. Undefined only while a first connect whose host
   * did not resolve in time waits for its retry.
   */
  conn: PinnedRcon | undefined;
  channels: Set<TextChannel>;
  authenticated: boolean;
  queuedCommands: QueuedCommand[];
  lastUsed: Date;
  reconnectAttempts: number;
  maxQueueSize: number;
  host: string;
  port: number;
}

interface RconConnectionManager {
  [key: string]: RconConnection;
}

export interface QueuedCommand {
  content: string;
  timestamp: number;
  channelId: string;
}

const MAX_RETRY_ATTEMPTS = config.rcon.maxRetryAttempts;
const MAX_QUEUE_SIZE = config.rcon.maxQueueSize;
const CONNECTION_TIMEOUT = config.rcon.connectionTimeoutMs;
const MAX_CONNECTIONS = config.rcon.maxConnections;
/**
 * How long one connect attempt may take, from resolving the host until
 * the server accepts the password. An attempt that runs out fails like a
 * server close. (`CONNECTION_TIMEOUT` above is the idle cleanup.)
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;

/** The retries ran out; giveUpReconnecting notifies the channels. */
class ReconnectExhaustedError extends Error {
  constructor() {
    super("重連次數已達上限");
    this.name = "ReconnectExhaustedError";
  }
}

/** The attempt's time ran out before the host resolved. */
class ResolveTimeoutError extends Error {
  constructor() {
    super("解析主機逾時");
    this.name = "ResolveTimeoutError";
  }
}

/** The connection was closed on our side (cleanup) before it authenticated. */
class ConnectionClosedError extends Error {
  constructor() {
    super("連接已關閉");
    this.name = "ConnectionClosedError";
  }
}

/** An initializeConnection in flight, and the channels waiting on it. */
interface ConnectionLock {
  done: Promise<void>;
  /** Becomes the connection's `channels`, so every waiter gets its notices. */
  channels: Set<TextChannel>;
}

/** Add a channel once: the same Discord channel can arrive as another object. */
function addChannel(channels: Set<TextChannel>, channel: TextChannel) {
  for (const known of channels) {
    if (known.id === channel.id) return;
  }
  channels.add(channel);
}

export class RconLimitError extends Error {
  constructor(host: string, limit: number) {
    super(
      `RCON connection limit reached (${limit}): cannot open new connection to ${host}. Remove unused rcon-forward channels to free slots.`,
    );
    this.name = "RconLimitError";
  }
}

export class RconConnectionService {
  private static connectionMap: RconConnectionManager = {};
  private static connectionLocks = new Map<string, ConnectionLock>();
  /** The connect timeout of each client still connecting. */
  private static connectTimers = new WeakMap<
    PinnedRcon,
    ReturnType<typeof setTimeout>
  >();
  /** Ends initializeConnection's wait for a connection's first auth. */
  private static firstAuthWaits = new WeakMap<
    RconConnection,
    (error?: Error) => void
  >();

  /**
   * Connect the named connection and wait until it authenticates (true)
   * or gives up (false). A first connect that fails (socket error, server
   * close, connect timeout, also while still resolving the host) is
   * retried like any drop; the channels waiting get the same notices,
   * ending in "Connection Failed". A call made while
   * another one connects the same name waits with it and shares its
   * result. Every false leaves the waiting channels notified.
   */
  static async initializeConnection(
    connectionName: string,
    host: string,
    port: number,
    password: string,
    channel: TextChannel,
  ): Promise<boolean> {
    const inFlight = this.connectionLocks.get(connectionName);
    if (inFlight) {
      addChannel(inFlight.channels, channel);
      try {
        await inFlight.done;
      } catch (error) {
        if (error instanceof RconLimitError) throw error;
        // The call that took the lock notified every waiting channel.
        return false;
      }
      const connection = this.connectionMap[connectionName];
      if (!connection) {
        // Cleaned up between authenticating and this call resuming.
        await this.sendConnectionError(channel, new ConnectionClosedError());
        return false;
      }
      addChannel(connection.channels, channel);
      return true;
    }

    let settleLock: (error?: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      settleLock = (error) => (error ? reject(error) : resolve());
    });
    // Waiters see a failure through their own await; without this, a
    // failed connect nobody waited on is an unhandled rejection.
    done.catch(() => {});
    const lock: ConnectionLock = { done, channels: new Set([channel]) };
    this.connectionLocks.set(connectionName, lock);

    let rconInstance: PinnedRcon | undefined;
    try {
      const isNew = !this.connectionMap[connectionName];
      if (isNew && Object.keys(this.connectionMap).length >= MAX_CONNECTIONS) {
        botEventLog.record(
          "warn",
          "feature",
          `RCON connection limit reached (${MAX_CONNECTIONS}): refused new connection to ${host}:${port}`,
          { host, port, limit: MAX_CONNECTIONS },
        );
        throw new RconLimitError(host, MAX_CONNECTIONS);
      }

      // Resolved and vetted once; the client connects only to these. The
      // attempt's time starts before resolving.
      const deadline = Date.now() + CONNECT_ATTEMPT_TIMEOUT_MS;
      let addresses: PinnedAddress[] | undefined;
      try {
        addresses = await this.resolveBefore(host, port, deadline);
      } catch (error) {
        // Out of time is a failed attempt, retried below; a DNS error or
        // a policy refusal ends the first connect at once.
        if (!(error instanceof ResolveTimeoutError)) throw error;
        log.warn(
          { connectionName },
          "Connect attempt timed out resolving the host",
        );
      }

      this.dropClient(connectionName);

      rconInstance =
        addresses && new PinnedRcon(host, port, password, addresses);

      const connection: RconConnection = {
        conn: rconInstance,
        // Shared with the lock: callers that wait later join it too.
        channels: lock.channels,
        authenticated: false,
        queuedCommands: [],
        lastUsed: new Date(),
        reconnectAttempts: 0,
        maxQueueSize: MAX_QUEUE_SIZE,
        host: host,
        port: port,
      };
      this.connectionMap[connectionName] = connection;

      const authenticated = new Promise<void>((resolve, reject) => {
        this.firstAuthWaits.set(connection, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      // Settled by the client's events, possibly before it is awaited.
      authenticated.catch(() => {});
      if (rconInstance) {
        this.setupEventListeners(
          connectionName,
          host,
          port,
          password,
          deadline,
        );
        // Returns once the socket is opening; the client's events (and the
        // retries after a failure) settle the wait.
        await rconInstance.connect();
      } else {
        // Like a connect timeout: the Lost / Failed notices only. The
        // retries settle the wait.
        this.handleConnectionError(connectionName, host, port, password).catch(
          (e: unknown) =>
            log.error({ err: e, connectionName }, "處理連接超時時發生錯誤"),
        );
      }
      await authenticated;

      settleLock();
      return true;
    } catch (error) {
      // Only this call's own client: the name may have been cleaned up.
      if (
        rconInstance &&
        this.connectionMap[connectionName]?.conn === rconInstance
      ) {
        this.dropClient(connectionName);
      }
      settleLock(error instanceof Error ? error : new Error("未知錯誤"));
      if (error instanceof RconLimitError) {
        throw error;
      }
      // giveUpReconnecting sends every channel "Connection Failed".
      if (error instanceof ReconnectExhaustedError) return false;
      log.error({ err: error, connectionName }, "Connection init failed");
      botEventLog.record(
        "error",
        "feature",
        `RCON connection failed: ${host}:${port} — ${(error as Error).message}`,
        {
          host,
          port,
          errorType:
            error instanceof HostPolicyError ? "HostPolicyError" : "other",
        },
      );
      for (const waiting of lock.channels) {
        await this.sendConnectionError(waiting, error);
      }
      return false;
    } finally {
      if (this.connectionLocks.get(connectionName) === lock) {
        this.connectionLocks.delete(connectionName);
      }
    }
  }

  /**
   * Let `channel` share a connection: it gets the connection's responses
   * and notices, once even if it joins again.
   */
  static joinChannel(connection: RconConnection, channel: TextChannel) {
    addChannel(connection.channels, channel);
  }

  private static async sendConnectionError(
    channel: TextChannel,
    error: unknown,
  ) {
    const userMessage =
      error instanceof HostPolicyError
        ? error.message
        : error instanceof ConnectionClosedError
          ? "連接已關閉，未發送的指令已清除。"
          : "無法建立連接，請確認 host/port 設定是否正確。";
    await channel
      .send({
        embeds: [
          {
            color: FAILED_COLOR,
            title: "Connection Error",
            description: userMessage,
          },
        ],
      })
      .catch((err: unknown) =>
        log.error({ err }, "failed to send connection error embed"),
      );
  }

  static getConnection(connectionName: string): RconConnection | undefined {
    return this.connectionMap[connectionName];
  }

  static getAllConnections(): RconConnectionManager {
    return this.connectionMap;
  }

  static async cleanupConnection(connectionName: string): Promise<void> {
    return this.tearDownConnection(connectionName);
  }

  /**
   * Stop listening to a client that is being replaced or closed, and
   * close it. Its socket can still emit afterwards (a late `end`, or an
   * error on the dying socket); those must neither reach the connection
   * that replaced it nor throw as an unhandled `error` event.
   *
   * A client still connecting is destroyed: end() would wait for a
   * connect a blackholed host never completes, until the OS gives up.
   */
  private static retireClient(
    connectionName: string,
    client: PinnedRcon | undefined,
  ) {
    if (!client) return;
    const connecting = this.stopConnectTimer(client);
    client.removeAllListeners();
    client.on("error", (err: Error) => {
      log.debug({ err, connectionName }, "Ignored error from a retired client");
    });
    try {
      if (connecting) client.destroy();
      else client.disconnect();
    } catch (error) {
      log.error({ err: error, connectionName }, "關閉連接時發生錯誤");
    }
  }

  /**
   * Retire the named connection's client and forget the connection. An
   * initializeConnection still waiting for it to authenticate fails with
   * `reason`. The connection lock is left alone: it belongs to that
   * initializeConnection, which releases it.
   */
  private static dropClient(
    connectionName: string,
    reason: Error = new ConnectionClosedError(),
  ) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;
    this.retireClient(connectionName, connection.conn);
    delete this.connectionMap[connectionName];
    this.settleFirstAuth(connection, reason);
  }

  /** Stop the client's connect timeout; returns whether it was connecting. */
  private static stopConnectTimer(client: PinnedRcon) {
    const timer = this.connectTimers.get(client);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.connectTimers.delete(client);
    return true;
  }

  /** End initializeConnection's wait for the connection, if it still waits. */
  private static settleFirstAuth(connection: RconConnection, error?: Error) {
    const settle = this.firstAuthWaits.get(connection);
    if (!settle) return;
    this.firstAuthWaits.delete(connection);
    settle(error);
  }

  /**
   * Resolve and vet the host, or fail with ResolveTimeoutError once the
   * attempt's `deadline` passes. A resolver that never answers (DNS
   * hanging until the OS gives up) would otherwise hold the attempt.
   */
  private static async resolveBefore(
    host: string,
    port: number,
    deadline: number,
  ): Promise<PinnedAddress[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ResolveTimeoutError()),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      return await Promise.race([resolveAllowedTarget(host, port), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Attach the handlers for the connection's current client, and start
   * its connect timeout: the client has until the attempt's `deadline`
   * to authenticate. A failure, before or after authenticating, starts
   * or continues the retries.
   */
  private static setupEventListeners(
    connectionName: string,
    host: string,
    port: number,
    password: string,
    deadline: number,
  ) {
    const connection = this.connectionMap[connectionName];
    const client = connection?.conn;
    if (!connection || !client) return;
    // A client acts on the connection only while it is that connection's
    // client: a replaced client's late events are ignored.
    const isCurrent = () =>
      this.connectionMap[connectionName] === connection &&
      connection.conn === client;

    // Retires this client and schedules the next attempt.
    const reconnect = (failedMsg: string) =>
      this.handleConnectionError(connectionName, host, port, password).catch(
        (e: unknown) => log.error({ err: e, connectionName }, failedMsg),
      );

    const onError = (err: Error) => {
      if (!isCurrent()) return;
      log.error({ err, connectionName }, "RCON connection error");
      for (const channel of connection.channels) {
        channel
          .send({
            embeds: [
              {
                color: FAILED_COLOR,
                title: "RCON Error",
                description: "連線發生錯誤，將嘗試重新連線。",
              },
            ],
          })
          .catch((e: unknown) =>
            log.error({ err: e }, "failed to send RCON error embed"),
          );
      }
      reconnect("處理連接錯誤時發生錯誤");
    };

    this.connectTimers.set(
      client,
      setTimeout(() => {
        if (!isCurrent()) return;
        log.warn({ connectionName }, "Connect attempt timed out");
        // Like a close: the Lost / Failed notices only, no error notice.
        // Retiring the still-connecting client destroys its socket.
        reconnect("處理連接超時時發生錯誤");
      }, Math.max(0, deadline - Date.now())),
    );

    client
      .on("auth", () => {
        if (!isCurrent()) return;
        this.stopConnectTimer(client);
        log.info({ connectionName }, "Connection authenticated");
        connection.authenticated = true;
        connection.reconnectAttempts = 0;
        this.settleFirstAuth(connection);
        this.processQueuedCommands(connectionName);
        botEventLog.record(
          "info",
          "feature",
          `RCON connected: ${host}:${port}`,
          {
            host,
            port,
          },
        );
      })
      .on("response", (str: string) => {
        if (!isCurrent()) return;
        log.debug(
          { connectionName, bytes: str?.length ?? 0 },
          "Received response",
        );
        connection.lastUsed = new Date();
        for (const channel of connection.channels) {
          channel
            .send({
              embeds: [
                {
                  color: SUCCEEDED_COLOR,
                  title:
                    !str || typeof str !== "string" ? "Sent successful" : str,
                },
              ],
            })
            .catch((error: unknown) => {
              log.error(
                { err: error, channelId: channel.id },
                "Error sending response to channel",
              );
            });
        }
      })
      .on("server", (str: string) => {
        if (!isCurrent()) return;
        log.debug(
          { connectionName, bytes: str?.length ?? 0 },
          "Received server message",
        );
        for (const channel of connection.channels) {
          channel
            .send({
              embeds: [
                {
                  color: SUCCEEDED_COLOR,
                  title: "Server Message",
                  description: str || "（無內容）",
                },
              ],
            })
            .catch((error: unknown) => {
              log.error(
                { err: error, channelId: channel.id },
                "Error sending server message to channel",
              );
            });
        }
      })
      .on("error", onError)
      .on("end", () => {
        // Our own closes retire the client first, so this is the server
        // closing the connection: a failure like an error, minus the
        // error notice. Includes a client closed right after connecting,
        // so every attempt counts.
        if (!isCurrent()) return;
        log.info({ connectionName }, "Connection closed by the server");
        reconnect("處理連接關閉時發生錯誤");
      });
  }

  /**
   * Close the connection and drop its queued commands. An
   * initializeConnection still waiting on it fails with `reason`.
   */
  private static async tearDownConnection(
    connectionName: string,
    reason?: Error,
  ) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;

    try {
      log.info(
        { host: connection.host, port: connection.port, connectionName },
        "與遠端的連接已關閉，未發送的指令將被清除",
      );

      // 清理所有待處理的指令
      if (connection.queuedCommands.length > 0) {
        log.debug(
          { connectionName, count: connection.queuedCommands.length },
          "清理未發送的指令",
        );
        connection.queuedCommands = [];
      }

      this.dropClient(connectionName, reason);
    } catch (error) {
      log.error({ err: error, connectionName }, "清理連接時發生錯誤");
    }
  }

  private static async handleConnectionError(
    connectionName: string,
    host: string,
    port: number,
    password: string,
  ) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;

    log.error({ connectionName }, "連接錯誤");

    // Commands queue until a fresh client authenticates again.
    connection.authenticated = false;

    if (connection.reconnectAttempts < MAX_RETRY_ATTEMPTS) {
      connection.reconnectAttempts++;
      // The dropped client is done; every attempt connects a fresh one.
      // node-rcon authenticates a client once, so a reused one would
      // never emit `auth` again (and never reset the attempt count).
      this.retireClient(connectionName, connection.conn);
      const delay = Math.min(
        1000 * Math.pow(2, connection.reconnectAttempts),
        30000,
      );

      for (const channel of connection.channels) {
        try {
          await channel.send({
            embeds: [
              {
                color: DEFAULT_COLOR,
                title: "Connection Lost",
                description: `正在嘗試重新連接 (${connection.reconnectAttempts}/${MAX_RETRY_ATTEMPTS})...`,
              },
            ],
          });
        } catch (error) {
          log.error(
            { err: error, channelId: channel.id },
            "無法發送重連通知到頻道",
          );
        }
      }

      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Every attempt re-resolves and re-vets the host: a container
        // that restarted has a new IP, and an answer that now points
        // somewhere refused, or none in time, fails this attempt.
        if (this.connectionMap[connectionName] !== connection) return;
        const deadline = Date.now() + CONNECT_ATTEMPT_TIMEOUT_MS;
        const addresses = await this.resolveBefore(host, port, deadline);
        if (this.connectionMap[connectionName] !== connection) return;
        const client = new PinnedRcon(host, port, password, addresses);
        connection.conn = client;
        this.setupEventListeners(
          connectionName,
          host,
          port,
          password,
          deadline,
        );
        await client.connect();
      } catch (error) {
        log.error(
          { err: error, connectionName, attempt: connection.reconnectAttempts },
          "重新連接嘗試失敗",
        );
        // Removed or re-created while the attempt waited: not ours to retry or end.
        if (this.connectionMap[connectionName] !== connection) return;

        if (connection.reconnectAttempts >= MAX_RETRY_ATTEMPTS) {
          await this.giveUpReconnecting(connectionName, connection);
        } else {
          // No socket was opened, so no socket error drives the next attempt.
          await this.handleConnectionError(connectionName, host, port, password);
        }
      }
    } else {
      // The last attempt's socket failed too.
      await this.giveUpReconnecting(connectionName, connection);
    }
  }

  /** Every attempt failed: close the connection, then notify its channels. */
  private static async giveUpReconnecting(
    connectionName: string,
    connection: RconConnection,
  ) {
    // Close first: the notices below wait on Discord, and by then the
    // name may belong to a connection re-created in the meantime.
    if (this.connectionMap[connectionName] === connection) {
      // The notices below reach every waiting channel; the waiting
      // initializeConnection adds none of its own.
      await this.tearDownConnection(
        connectionName,
        new ReconnectExhaustedError(),
      );
    }
    for (const channel of connection.channels) {
      try {
        await channel.send({
          embeds: [
            {
              color: FAILED_COLOR,
              title: "Connection Failed",
              description:
                "重連次數已達上限，連接將被關閉。所有未發送的指令將被清除。",
            },
          ],
        });
      } catch (error) {
        log.error(
          { err: error, channelId: channel.id },
          "無法發送連接失敗通知到頻道",
        );
      }
    }
    botEventLog.record(
      "error",
      "feature",
      `RCON reconnect exhausted: ${connection.host}:${connection.port}`,
      {
        host: connection.host,
        port: connection.port,
        attempts: connection.reconnectAttempts,
      },
    );
  }

  private static processQueuedCommands(connectionName: string) {
    const connection = this.connectionMap[connectionName];
    if (connection && connection.authenticated) {
      const now = Date.now();
      const validCommands = connection.queuedCommands.filter(
        (cmd) => now - cmd.timestamp < 5 * 60 * 1000, // 5 minutes timeout
      );

      connection.queuedCommands = validCommands;

      while (connection.queuedCommands.length > 0) {
        const command = connection.queuedCommands.shift();
        if (command) {
          connection.conn?.send(command.content);
        }
      }
    }
  }

  static get connectionTimeout(): number {
    return CONNECTION_TIMEOUT;
  }
}
