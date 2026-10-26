/**
 * JSON schemas shared by the behavior routes (validated by the behavior
 * scope's strict ajv, see behavior-api-error.ts). Every object schema is
 * closed (`additionalProperties: false`); Discord ids are snowflakes.
 */

import { BEHAVIOR_OPTION_TYPES } from "./models/behavior-definition.model.js";
import {
  NON_BLANK_PATTERN,
  ROW_ID_PATTERN,
  SNOWFLAKE_PATTERN,
} from "./behavior-api-error.js";

export const snowflake = { type: "string", pattern: SNOWFLAKE_PATTERN } as const;
export const nullableSnowflake = {
  anyOf: [snowflake, { type: "null" }],
} as const;

/** `:id` of a behavior_definitions / behavior_commands row. */
export const idParams = {
  type: "object",
  properties: { id: { type: "string", pattern: ROW_ID_PATTERN } },
  required: ["id"],
  additionalProperties: false,
} as const;

export function parseRowId(params: unknown): number {
  return Number.parseInt((params as { id: string }).id, 10);
}

// ── behavior fields ─────────────────────────────────────────────────────────

/** A behavior's admin-facing name; also a subcommand's fallback description, hence ≤100. */
export const titleSchema = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: NON_BLANK_PATTERN,
} as const;

/** Admin note, never sent to Discord. */
export const noteSchema = { type: "string", maxLength: 1000 } as const;

/** ISO time from a view's `updatedAt` — refuse the write if the row changed since. */
export const ifUpdatedAtSchema = { type: "string", minLength: 1, maxLength: 64 } as const;

/** Fields every behavior (message trigger or command leaf) carries. */
export const behaviorCommonFields = {
  title: titleSchema,
  description: noteSchema,
  enabled: { type: "boolean" },
} as const;

/** Message Trigger fields (ADR 0003). */
export const messageTriggerFields = {
  surface: { enum: ["bot_dm", "guild"] },
  guildId: nullableSnowflake,
  channelId: nullableSnowflake,
  patternKind: { enum: ["startswith", "endswith", "regex"] },
  patternValue: { type: "string", minLength: 1, maxLength: 500 },
  stopOnMatch: { type: "boolean" },
  ignoreBots: { type: "boolean" },
  audienceKind: { enum: ["all", "user", "group"] },
  audienceUserId: nullableSnowflake,
  audienceGroupName: {
    anyOf: [
      { type: "string", minLength: 1, maxLength: 200, pattern: NON_BLANK_PATTERN },
      { type: "null" },
    ],
  },
} as const;

// ── command fields ──────────────────────────────────────────────────────────

/** Discord chat-input names (commands, subcommands, options); lower case. */
export const COMMAND_NAME_PATTERN = "^[a-z0-9_-]{1,32}$";

export const commandNameSchema = { type: "string", pattern: COMMAND_NAME_PATTERN } as const;

/** '' = the root leaf; otherwise a subcommand name. */
export const subcommandSchema = {
  anyOf: [{ const: "" }, commandNameSchema],
} as const;

/** A Discord description: 1–100 characters, not blank (#97). */
export const discordDescriptionSchema = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: NON_BLANK_PATTERN,
} as const;

export const commandOptionSchema = {
  type: "object",
  properties: {
    type: { enum: [...BEHAVIOR_OPTION_TYPES] },
    name: commandNameSchema,
    description: discordDescriptionSchema,
    required: { type: "boolean" },
  },
  required: ["type", "name", "description"],
  additionalProperties: false,
} as const;

/** Command (container) fields: name and visibility (ADR 0003). */
export const commandFields = {
  name: commandNameSchema,
  description: discordDescriptionSchema,
  registration: { enum: ["global", "guild"] },
  guildId: nullableSnowflake,
  integrationTypes: {
    type: "array",
    items: { enum: ["guild_install", "user_install"] },
    minItems: 1,
    uniqueItems: true,
  },
  contexts: {
    type: "array",
    items: { enum: ["Guild", "BotDM", "PrivateChannel"] },
    minItems: 1,
    uniqueItems: true,
  },
  defaultMemberPermissions: {
    anyOf: [{ type: "string", pattern: "^\\d{1,20}$" }, { type: "null" }],
  },
} as const;

/** Command Leaf fields (besides the common ones and the webhook). */
export const commandLeafFields = {
  leafDescription: { anyOf: [discordDescriptionSchema, { type: "null" }] },
  options: { type: "array", maxItems: 25, items: commandOptionSchema },
} as const;
