/**
 * Seed helpers for the trigger/action behavior tables. Every custom
 * behavior gets a webhook action (url encrypted with the test key).
 */
import { BehaviorCommand } from "../src/modules/behavior/models/behavior-command.model.js";
import { BehaviorDefinition } from "../src/modules/behavior/models/behavior-definition.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { encryptSecret } from "../src/utils/crypto.js";

export const TEST_WEBHOOK_URL = "https://hooks.example/behavior";

async function attachWebhook(
  behaviorId: number,
  webhook: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (webhook === null) return;
  await BehaviorWebhookAction.create({
    behaviorId,
    url: encryptSecret(TEST_WEBHOOK_URL),
    secret: null,
    authMode: null,
    ...webhook,
  });
}

/** A custom message trigger (bot DM `!go` by default). Returns its id. */
export async function seedMessageTrigger(
  overrides: Record<string, unknown> = {},
  webhook?: Record<string, unknown> | null,
): Promise<number> {
  const row = await BehaviorDefinition.create({
    title: "message trigger",
    enabled: true,
    sortOrder: 0,
    systemKey: null,
    triggerKind: "message",
    actionSource: "webhook",
    surface: "bot_dm",
    guildId: null,
    channelId: null,
    patternKind: "startswith",
    patternValue: "!go",
    stopOnMatch: false,
    ignoreBots: true,
    audienceKind: "all",
    audienceUserId: null,
    audienceGroupName: null,
    ...overrides,
  });
  const id = row.getDataValue("id") as number;
  if (overrides["actionSource"] !== "builtin") await attachWebhook(id, webhook);
  return id;
}

/** The system login on a bot DM message trigger. */
export async function seedSystemLogin(
  overrides: Record<string, unknown> = {},
): Promise<number> {
  return seedMessageTrigger(
    {
      title: "login",
      sortOrder: -1000,
      systemKey: "admin-login",
      actionSource: "builtin",
      patternValue: "!login",
      stopOnMatch: true,
      ...overrides,
    },
    null,
  );
}

/** A command (global, guild-usable by default). Returns its id. */
export async function seedCommand(
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const row = await BehaviorCommand.create({
    name: "ping",
    description: "ping",
    registration: "global",
    guildId: null,
    integrationTypes: "guild_install",
    contexts: "Guild",
    defaultMemberPermissions: null,
    isSystem: false,
    ...overrides,
  });
  return row.getDataValue("id") as number;
}

/** A leaf under `commandId` (root leaf by default). Returns its id. */
export async function seedLeaf(
  commandId: number,
  overrides: Record<string, unknown> = {},
  webhook?: Record<string, unknown> | null,
): Promise<number> {
  const row = await BehaviorDefinition.create({
    title: "leaf",
    enabled: true,
    sortOrder: 0,
    systemKey: null,
    triggerKind: "command",
    actionSource: "webhook",
    commandId,
    subcommandGroup: "",
    subcommand: "",
    leafDescription: null,
    options: null,
    surface: null,
    guildId: null,
    channelId: null,
    patternKind: null,
    patternValue: null,
    audienceKind: "all",
    audienceUserId: null,
    audienceGroupName: null,
    ...overrides,
  });
  const id = row.getDataValue("id") as number;
  if (overrides["actionSource"] !== "builtin") await attachWebhook(id, webhook);
  return id;
}

/** Remove every behavior row (cascades leaves, webhook actions, stats). */
export async function clearBehaviors(): Promise<void> {
  await BehaviorWebhookAction.destroy({ where: {} });
  await BehaviorDefinition.destroy({ where: {} });
  await BehaviorCommand.destroy({ where: {} });
}
