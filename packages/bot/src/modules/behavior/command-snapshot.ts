/**
 * A command's rows as they were before a write — the command, its leaves,
 * their webhook actions and stats — so a write Discord refuses can be put
 * back exactly (ids included). See command-registration-sync.ts for when
 * that happens.
 */

import type { Transaction } from "sequelize";
import { BehaviorCommand } from "./models/behavior-command.model.js";
import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import { BehaviorStat } from "./models/behavior-stats.model.js";
import { BehaviorWebhookAction } from "./models/behavior-webhook-action.model.js";
import { behaviorTransaction } from "./behavior-write-lock.js";

type Raw = Record<string, unknown>;

interface LeafSnapshot {
  definition: Raw;
  webhook: Raw | null;
  stats: Raw | null;
}

export interface CommandSnapshot {
  commandId: number;
  /** null: the command did not exist (the write created it) */
  command: Raw | null;
  leaves: LeafSnapshot[];
}

const raw = (m: { get(options: { plain: true }): unknown }): Raw =>
  m.get({ plain: true }) as Raw;

export async function snapshotCommand(commandId: number): Promise<CommandSnapshot> {
  const command = await BehaviorCommand.findByPk(commandId);
  if (!command) return { commandId, command: null, leaves: [] };
  const definitions = await BehaviorDefinition.findAll({ where: { commandId } });
  const ids = definitions.map((d) => d.getDataValue("id") as number);
  const [webhooks, stats] = await Promise.all([
    BehaviorWebhookAction.findAll({ where: { behaviorId: ids } }),
    BehaviorStat.findAll({ where: { behaviorId: ids } }),
  ]);
  const byBehavior = <M extends { getDataValue(k: string): unknown }>(rows: M[]) =>
    new Map(rows.map((r) => [r.getDataValue("behaviorId") as number, r]));
  const webhookOf = byBehavior(webhooks);
  const statsOf = byBehavior(stats);
  return {
    commandId,
    command: raw(command),
    leaves: definitions.map((d) => {
      const id = d.getDataValue("id") as number;
      const webhook = webhookOf.get(id);
      const stat = statsOf.get(id);
      return {
        definition: raw(d),
        webhook: webhook ? raw(webhook) : null,
        stats: stat ? raw(stat) : null,
      };
    }),
  };
}

async function destroyLeaves(ids: number[], transaction: Transaction): Promise<void> {
  if (ids.length === 0) return;
  // explicit, not via FK cascade: SQLite may run without FK enforcement
  await BehaviorWebhookAction.destroy({ where: { behaviorId: ids }, transaction });
  await BehaviorStat.destroy({ where: { behaviorId: ids }, transaction });
  await BehaviorDefinition.destroy({ where: { id: ids }, transaction });
}

/** Delete a command with everything under it. */
export async function destroyCommandRows(
  commandId: number,
  transaction: Transaction,
): Promise<void> {
  const leaves = await BehaviorDefinition.findAll({ where: { commandId }, transaction });
  await destroyLeaves(
    leaves.map((l) => l.getDataValue("id") as number),
    transaction,
  );
  await BehaviorCommand.destroy({ where: { id: commandId }, transaction });
}

/** Put the command's rows back as the snapshot has them. */
export async function restoreCommand(snapshot: CommandSnapshot): Promise<void> {
  await behaviorTransaction(async (transaction) => {
    const { commandId } = snapshot;
    if (snapshot.command === null) {
      await destroyCommandRows(commandId, transaction);
      return;
    }
    const keep = new Set(snapshot.leaves.map((l) => l.definition["id"] as number));
    const current = await BehaviorDefinition.findAll({ where: { commandId }, transaction });
    await destroyLeaves(
      current
        .map((l) => l.getDataValue("id") as number)
        .filter((id) => !keep.has(id)),
      transaction,
    );

    // silent: the restored rows keep their updatedAt, so an admin's
    // ifUpdatedAt from before the refused write still matches
    await BehaviorCommand.update(snapshot.command, {
      where: { id: commandId },
      silent: true,
      transaction,
    });
    const present = new Set(current.map((l) => l.getDataValue("id") as number));
    for (const leaf of snapshot.leaves) {
      const id = leaf.definition["id"] as number;
      if (present.has(id)) {
        await BehaviorDefinition.update(leaf.definition, {
          where: { id },
          silent: true,
          transaction,
        });
      } else {
        await BehaviorDefinition.create(leaf.definition, { transaction });
      }
      await BehaviorWebhookAction.destroy({ where: { behaviorId: id }, transaction });
      if (leaf.webhook) await BehaviorWebhookAction.create(leaf.webhook, { transaction });
      if (leaf.stats && !(await BehaviorStat.findByPk(id, { transaction }))) {
        await BehaviorStat.create(leaf.stats, { transaction });
      }
    }
  });
}
