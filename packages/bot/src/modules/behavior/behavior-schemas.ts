/**
 * JSON schemas shared by the behavior routes (validated by the behavior
 * scope's strict ajv, see behavior-api-error.ts). Every object schema is
 * closed (`additionalProperties: false`); Discord ids are snowflakes.
 */

import { ROW_ID_PATTERN, SNOWFLAKE_PATTERN } from "./behavior-api-error.js";

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
