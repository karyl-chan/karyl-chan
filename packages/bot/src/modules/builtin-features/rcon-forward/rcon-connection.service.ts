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

  static async initializeConnection(
    connectionName: string,
    host: string,
    port: number,
    password: string,
    channel: TextChannel,
  ): Promise<boolean> {
    let connectionLockPromise = this.connectionLocks.get(connectionName);
    if (connectionLockPromise) {
      try {
        await connectionLockPromise;
        return (
          this.connectionMap[connectionName] !== undefined &&
          this.connectionMap[connectionName].authenticated
        );
      } catch {
        this.connectionLocks.delete(connectionName);
      }
    }

    let lockResolver: {
      resolve: () => void;
      reject: (error: Error) => void;
    } = { resolve: () => {}, reject: () => {} };

    connectionLockPromise = new Promise<void>((resolve, reject) => {
      lockResolver.resolve = resolve;
      lockResolver.reject = reject;
    });
    // Waiters see a failure through their own await; without this, a
    // failed connect nobody waited on is an unhandled rejection.
    connectionLockPromise.catch(() => {});
    this.connectionLocks.set(connectionName, connectionLockPromise);

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

      if (this.connectionMap[connectionName]) {
        this.retireClient(connectionName, this.connectionMap[connectionName].conn);
        delete this.connectionMap[connectionName];
      }

      const rconInstance = new PinnedRcon(host, port, password, addresses);

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

      this.setupEventListeners(connectionName, host, port, password);

      const connectionTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("連接超時")), 10000);
      });

      await Promise.race([rconInstance.connect(), connectionTimeout]);

      lockResolver.resolve();
      return true;
    } catch (error) {
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
              : error instanceof Error && error.message.includes("超時")
                ? "timeout"
                : "other",
        },
      );
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

      if (this.connectionMap[connectionName]) {
        this.retireClient(connectionName, this.connectionMap[connectionName].conn);
        delete this.connectionMap[connectionName];
      }

      lockResolver.reject(
        error instanceof Error ? error : new Error("未知錯誤"),
      );
      return false;
    } finally {
      this.connectionLocks.delete(connectionName);
    }
  }

  static getConnection(connectionName: string): RconConnection | undefined {
    return this.connectionMap[connectionName];
  }

  static getAllConnections(): RconConnectionManager {
    return this.connectionMap;
  }

  static async cleanupConnection(connectionName: string): Promise<void> {
    return this.handleConnectionEnd(connectionName);
  }

  /**
   * Stop listening to a client that is being replaced or closed, and
   * close it. Its socket can still emit afterwards (a late `end`, or an
   * error on the dying socket); those must neither reach the connection
   * that replaced it nor throw as an unhandled `error` event.
   */
  private static retireClient(connectionName: string, client: PinnedRcon) {
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

  /** Attach the handlers for the connection's current client. */
  private static setupEventListeners(
    connectionName: string,
    host: string,
    port: number,
    password: string,
  ) {
    const connection = this.connectionMap[connectionName];
    if (!connection) return;
    const client = connection.conn;
    // A client acts on the connection only while it is that connection's
    // client: a replaced client's late events are ignored.
    const isCurrent = () =>
      this.connectionMap[connectionName] === connection &&
      connection.conn === client;

    client
      .on("auth", () => {
        if (!isCurrent()) return;
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
      .on("error", (err: Error) => {
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
        this.handleConnectionError(connectionName, host, port, password);
      })
      .on("end", () => {
        if (!isCurrent()) return;
        log.info({ connectionName }, "Connection ended");
        this.handleConnectionEnd(connectionName);
      });
  }

  private static async handleConnectionEnd(connectionName: string) {
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

      this.retireClient(connectionName, connection.conn);

      delete this.connectionMap[connectionName];
      this.connectionLocks.delete(connectionName);
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

  /** Every attempt failed: notify the channels, then close the connection. */
  private static async giveUpReconnecting(
    connectionName: string,
    connection: RconConnection,
  ) {
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
    await this.handleConnectionEnd(connectionName);
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
