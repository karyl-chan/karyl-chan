/**
 * Checks every behavior write route makes before it changes anything:
 * the row exists, it is not the System Behavior (or its command), the
 * admin's edit is based on the current version — plus the `{ from, to }`
 * diff the audit records.
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import {
  BehaviorDefinition,
  rowOfBehaviorDefinition,
  type BehaviorDefinitionRow,
} from "./models/behavior-definition.model.js";

export async function loadBehaviorRow(id: number): Promise<BehaviorDefinitionRow> {
  const model = await BehaviorDefinition.findByPk(id);
  if (!model) throw new BehaviorApiError("not_found", `behavior ${id} does not exist`);
  return rowOfBehaviorDefinition(model);
}

export function refuseSystem(row: { systemKey: string | null }): void {
  if (row.systemKey !== null) {
    throw new BehaviorApiError(
      "system_immutable",
      "the system behavior cannot be changed or deleted here (its trigger switch comes with #139)",
    );
  }
}

/** The system login's command container (S7 #139 will allow its trigger switch). */
export function refuseSystemCommand(command: { isSystem: boolean }): void {
  if (command.isSystem) {
    throw new BehaviorApiError(
      "system_immutable",
      "the system login command cannot be changed here (its trigger switch comes with #139)",
    );
  }
}

export function checkNotStale(
  current: { updatedAt: Date },
  ifUpdatedAt: string | undefined,
  what: string,
): void {
  if (ifUpdatedAt === undefined) return;
  if (current.updatedAt.toISOString() !== ifUpdatedAt) {
    throw BehaviorApiError.stale(
      "ifUpdatedAt",
      `${what} was changed by someone else (now at ${current.updatedAt.toISOString()}); reload and retry`,
    );
  }
}

/** `{ field: { from, to } }` for every field whose value changes. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    const from = before[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
  }
  return changed;
}
