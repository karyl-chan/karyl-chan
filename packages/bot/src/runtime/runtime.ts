import { createBotClient, patchRestSetToken } from "./discord-client.js";
import { WebhookForwarder } from "../modules/command-system/webhook-forwarder.service.js";
import { InteractionDispatcher } from "../modules/command-system/interaction-dispatcher.service.js";
import { CommandReconciler } from "../modules/command-system/reconcile.service.js";
import { MessagePatternMatcher } from "../modules/command-system/message-pattern-matcher.service.js";
import { installProcessErrorHandlers } from "./process-errors.js";
import { installSignalHandlers } from "./shutdown.js";
import { registerRuntimeEvents } from "./discord-runtime-events.js";
import { runStartup } from "./startup.js";
import type { RuntimeContext } from "./context.js";

export interface Runtime {
  readonly ctx: RuntimeContext;
  /** Run the startup sequence (DB, seeds, web server, Discord login). */
  start(): Promise<void>;
}

/**
 * Build the runtime: construct the Discord client + command-system
 * singletons, wire the process / signal handlers and gateway event
 * handlers, and return a `start()` that runs the boot sequence.
 *
 * This replaces the module-load side-effects that used to live inline in
 * main.ts. Order matters only in that the client + singletons (held in
 * `ctx`) must exist before the handlers that close over them are
 * installed; the handlers themselves are inert until a signal / event /
 * start() fires, so installing them before start() is equivalent to the
 * old "register at module load, then call run()" flow.
 */
export function createRuntime(): Runtime {
  const bot = createBotClient();

  // command-system 三模組 singleton 初始化。
  // bot 已宣告，使用閉包安全存取（CommandReconciler.getBot 在 ready 後才被呼叫）。
  const webhookForwarder = new WebhookForwarder();
  const interactionDispatcher = new InteractionDispatcher(webhookForwarder);
  const commandReconciler = new CommandReconciler(() =>
    bot.isReady() ? bot : null,
  );
  const messageMatcher = new MessagePatternMatcher(webhookForwarder);

  const ctx: RuntimeContext = {
    bot,
    webhookForwarder,
    interactionDispatcher,
    commandReconciler,
    messageMatcher,
    shuttingDown: false,
    dbReady: false,
    webServer: null,
    sessionStore: null,
  };

  installProcessErrorHandlers(ctx);
  installSignalHandlers(ctx);
  patchRestSetToken(bot);
  registerRuntimeEvents(ctx);

  return {
    ctx,
    start: () => runStartup(ctx),
  };
}
