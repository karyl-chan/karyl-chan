import type { Client } from "discord.js";
import type { SessionStore } from "../adapters/session-store.js";
import type { startWebServer } from "../modules/web-core/server.js";
import type { CommandReconciler } from "../modules/command-system/reconcile.service.js";
import type { InteractionDispatcher } from "../modules/command-system/interaction-dispatcher.service.js";
import type { WebhookForwarder } from "../modules/command-system/webhook-forwarder.service.js";
import type { MessagePatternMatcher } from "../modules/command-system/message-pattern-matcher.service.js";

export type WebServerHandle = Awaited<ReturnType<typeof startWebServer>>;

/**
 * Mutable runtime state shared across the bootstrap modules
 * (process-errors / shutdown / startup / discord-runtime-events).
 *
 * Before the split this all lived as module-level `let`/`const` in
 * main.ts; the split moves the behaviour into focused modules and
 * threads the same shared state through this single object so the
 * cross-module reads/writes (e.g. shutdown reading `webServer` that
 * startup set, process-errors reading `shuttingDown` that shutdown set)
 * stay exactly as they were.
 */
export interface RuntimeContext {
  /** The Discord gateway client. Constructed once in createRuntime(). */
  readonly bot: Client;
  readonly webhookForwarder: WebhookForwarder;
  readonly interactionDispatcher: InteractionDispatcher;
  readonly commandReconciler: CommandReconciler;
  readonly messageMatcher: MessagePatternMatcher;

  /**
   * Set true once gracefulShutdown starts so the process-level error
   * handlers don't schedule a fatal exit that races shutdown's budget.
   */
  shuttingDown: boolean;
  /**
   * Set true once sequelize.sync() completes so the process-level error
   * handlers know the bot_events table exists and is safe to write.
   */
  dbReady: boolean;
  /** The running web server, set by startup, closed by shutdown. */
  webServer: WebServerHandle | null;
  /**
   * The session store the bot actually started, resolved once at boot so
   * shutdown stops that instance rather than lazily constructing one.
   */
  sessionStore: SessionStore | null;
}
