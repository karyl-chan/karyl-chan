import type {
  PluginBotEventEntry,
  PluginBotEventLog,
} from "./context.js";

/**
 * Plugin-side accumulator for `ctx.botEventLog.emit()`. Entries are
 * appended to an in-memory ring buffer and flushed to the bot in
 * batches via `POST /api/plugin/log.emit`. Flush triggers:
 *
 *   1. The buffer fills (cap = `RING_CAP`, 50 entries)
 *   2. The periodic timer fires (default 5 s)
 *   3. The plugin shuts down (caller invokes `stop()`)
 *
 * Batching keeps the bot's `botEventLog` writes (which hit SQLite) from
 * being driven at every-emit cadence by a chatty plugin.
 */

const RING_CAP = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export interface BotEventEmitterOptions {
  /**
   * Push function — SDK wires this to `callBotRpc`. Receives the batch
   * of buffered entries; resolves once the POST completes (or fails).
   */
  push: (batch: PluginBotEventEntry[]) => Promise<void>;
  /** Local logger for warning on flush failure. */
  log: {
    warn(msg: string, context?: Record<string, unknown>): void;
  };
  flushIntervalMs?: number;
}

export class BotEventEmitter implements PluginBotEventLog {
  private buffer: PluginBotEventEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;

  constructor(private readonly opts: BotEventEmitterOptions) {
    this.intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  emit(entry: PluginBotEventEntry): void {
    if (this.stopped) return;
    if (
      entry.level !== "info" &&
      entry.level !== "warn" &&
      entry.level !== "error"
    ) {
      return;
    }
    if (typeof entry.message !== "string" || entry.message.length === 0) {
      return;
    }
    this.buffer.push({
      level: entry.level,
      message: entry.message,
      context: entry.context,
      eventKey: entry.eventKey,
    });
    if (this.buffer.length >= RING_CAP) {
      void this.flushNow();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushNow();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushNow();
  }

  async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.opts.push(batch);
    } catch (err) {
      this.opts.log.warn("botEventLog flush failed", {
        error: err instanceof Error ? err.message : String(err),
        dropped: batch.length,
      });
    }
  }
}
