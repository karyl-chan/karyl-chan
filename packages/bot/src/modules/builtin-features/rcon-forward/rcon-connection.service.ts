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
import { moduleLogger } from "../../../logger.js";
import { PinnedRcon } from "./pinned-rcon.js";

const log = moduleLogger("rcon-connection");

export interface RconConnection {
  conn: PinnedRcon;
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
 * How long one connect attempt may take, from opening the socket until
 * the server accepts the password. An attempt that runs out fails like a
 * server close. (`CONNECTION_TIMEOUT` above is the idle cleanup.)
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;

class ConnectAttemptTimeoutError extends Error {
  constructor() {
    super("連接超時");
    this.name = "ConnectAttemptTimeoutError";
  }
}

/** A client that has not authenticated yet. */
interface ConnectAttempt {
  timer: ReturnType<typeof setTimeout>;
  /** initializeConnection's client only: ends that call's wait. */
  settle?: (error?: Error) => void;
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
  private static connectionLocks = new Map<string, Promise<void>>();
  private static connectAttempts = new WeakMap<PinnedRcon, ConnectAttempt>();

  /**
   * Connect the named connection and wait until its client authenticates
   * (true) or the attempt fails (false, with "Connection Error" sent to
   * `channel`): a socket error, the server closing the connection, the
   * connect timeout, or the connection cleaned up meanwhile. A first
   * connect is not retried; the reconnect policy starts once it has
   * authenticated. A call made while another one connects the same name
   * shares that call's outcome.
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
      try {
        await inFlight;
      } catch (error) {
        if (error instanceof RconLimitError) throw error;
        // This caller's command is not sent either: tell its channel too.
        await this.sendConnectionError(channel, error);
        return false;
      }
      // Authenticated, or reconnecting since: the caller sends or queues.
      const connection = this.connectionMap[connectionName];
      if (!connection) return false;
      connection.channels.add(channel);
      return true;
    }

    let settleLock: (error?: Error) => void = () => {};
    const lock = new Promise<void>((resolve, reject) => {
      settleLock = (error) => (error ? reject(error) : resolve());
    });
    // Waiters see a failure through their own await; without this, a
    // failed connect nobody waited on is an unhandled rejection.
    lock.catch(() => {});
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

      // Resolved and vetted once; the client connects only to these.
      const addresses = await resolveAllowedTarget(host, port);

      this.dropClient(connectionName);

      rconInstance = new PinnedRcon(host, port, password, addresses);

      this.connectionMap[connectionName] = {
        conn: rconInstance,
        channels: new Set([channel]),
        authenticated: false,
        queuedCommands: [],
        lastUsed: new Date(),
        reconnectAttempts: 0,
        maxQueueSize: MAX_QUEUE_SIZE,
        host: host,
        port: port,
      };

      let settleAttempt: (error?: Error) => void = () => {};
      const authenticated = new Promise<void>((resolve, reject) => {
        settleAttempt = (error) => (error ? reject(error) : resolve());
      });
      // Settled by the client's events, possibly before it is awaited.
      authenticated.catch(() => {});
      this.setupEventListeners(
        connectionName,
        host,
        port,
        password,
        settleAttempt,
      );

      // Returns once the socket is opening; the client's events (and its
      // connect timeout) settle the attempt.
      await rconInstance.connect();
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
      log.error({ err: error, connectionName }, "Connection init failed");
      botEventLog.record(
        "error",
        "feature",
        `RCON connection failed: ${host}:${port} — ${(error as Error).message}`,
        {
          host,
          port,
          errorType:
            error instanceof HostPolicyError
              ? "HostPolicyError"
              : error instanceof ConnectAttemptTimeoutError
                ? "timeout"
                : "other",
        },
      );
      await this.sendConnectionError(channel, error);
      return false;
    } finally {
      if (this.connectionLocks.get(connectionName) === lock) {
        this.connectionLocks.delete(connectionName);
      }
    }
  }

  private static async sendConnectionError(
    channel: TextChannel,
    error: unknown,
  ) {
    const userMessage =
      error instanceof HostPolicyError
        ? error.message
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
   */
  private static retireClient(connectionName: string, client: PinnedRcon) {
    this.endConnectAttempt(client, new Error("連線已關閉"));
    client.removeAllListeners();
    client.on("error", (err: Error) => {
      log.debug({ err, connectionName }, "Ignored error from a retired client");
    });
    try {
      client.disconnect();
    } catch (error) {
      log.error({ err: error, connectionName }, "關閉連接時發生錯誤");
    }
  }

  /**
   * Retire the named connection's client and forget the connection. The
   * connection lock is left alone: it belongs to an `initializeConnection`
   * that may still be running, which releases it.
   */
  private static dropClient(connectionName: string) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;
    this.retireClient(connectionName, connection.conn);
    delete this.connectionMap[connectionName];
  }

  /**
   * The client stopped connecting: it authenticated (no `error`) or
   * failed (`error`). Stop its connect timeout and settle the
   * initializeConnection waiting on it. Returns whether one was waiting.
   */
  private static endConnectAttempt(client: PinnedRcon, error?: Error) {
    const attempt = this.connectAttempts.get(client);
    if (!attempt) return false;
    this.connectAttempts.delete(client);
    clearTimeout(attempt.timer);
    if (!attempt.settle) return false;
    attempt.settle(error);
    return true;
  }

  /**
   * Attach the handlers for the connection's current client, and start
   * its connect timeout: the client has until then to authenticate.
   * Until it does, a failure of initializeConnection's client (`settle`)
   * ends that call; any other failure starts or continues the retries.
   */
  private static setupEventListeners(
    connectionName: string,
    host: string,
    port: number,
    password: string,
    settle?: (error?: Error) => void,
  ) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;
    const client = connection.conn;
    // A client acts on the connection only while it is that connection's
    // client: a replaced client's late events are ignored.
    const isCurrent = () =>
      this.connectionMap[connectionName] === connection &&
      connection.conn === client;

    // initializeConnection's client, before it authenticates: the failure
    // ends that call (which reports it) instead of starting the retries.
    const endsFirstConnect = (error: Error) =>
      this.endConnectAttempt(client, error);

    // Retires this client and schedules the next attempt.
    const reconnect = (failedMsg: string) =>
      this.handleConnectionError(connectionName, host, port, password).catch(
        (e: unknown) => log.error({ err: e, connectionName }, failedMsg),
      );

    const onError = (err: Error) => {
      if (!isCurrent()) return;
      log.error({ err, connectionName }, "RCON connection error");
      if (endsFirstConnect(err)) return;
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

    this.connectAttempts.set(client, {
      settle,
      timer: setTimeout(() => {
        if (!isCurrent()) return;
        log.warn({ connectionName }, "Connect attempt timed out");
        // Drop the half-open socket now: end() would wait for a connect
        // a blackholed host never completes, until the OS gives up.
        client.destroy();
        // Like a close: the Lost / Failed notices only, no error notice.
        if (endsFirstConnect(new ConnectAttemptTimeoutError())) return;
        reconnect("處理連接超時時發生錯誤");
      }, CONNECT_ATTEMPT_TIMEOUT_MS),
    });

    client
      .on("auth", () => {
        if (!isCurrent()) return;
        this.endConnectAttempt(client);
        log.info({ connectionName }, "Connection authenticated");
        connection.authenticated = true;
        connection.reconnectAttempts = 0;
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
        // error notice. Includes a reconnect client closed right after
        // connecting, so every attempt counts.
        if (!isCurrent()) return;
        log.info({ connectionName }, "Connection closed by the server");
        if (endsFirstConnect(new Error("伺服器關閉了連接"))) return;
        reconnect("處理連接關閉時發生錯誤");
      });
  }

  /** Close the connection and drop its queued commands. */
  private static async tearDownConnection(connectionName: string) {
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

      this.dropClient(connectionName);
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
        // somewhere refused fails this attempt.
        if (this.connectionMap[connectionName] !== connection) return;
        const addresses = await resolveAllowedTarget(host, port);
        if (this.connectionMap[connectionName] !== connection) return;
        const client = new PinnedRcon(host, port, password, addresses);
        connection.conn = client;
        this.setupEventListeners(connectionName, host, port, password);
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
      await this.tearDownConnection(connectionName);
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
          connection.conn.send(command.content);
        }
      }
    }
  }

  static get connectionTimeout(): number {
    return CONNECTION_TIMEOUT;
  }
}
