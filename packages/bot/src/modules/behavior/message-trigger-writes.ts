/**
 * What the routes that write a Message Trigger share
 * (behavior-write-routes.ts, behavior-trigger-convert.ts): the response
 * view and the slot a new trigger takes in the matching order — as
 * command-writes.ts is for commands.
 */

import type { Transaction } from "sequelize";
import { BehaviorApiError } from "./behavior-api-error.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import {
  messageTriggerView,
  serviceBehaviorView,
  type MessageTriggerView,
  type ServiceBehaviorView,
} from "./behavior-list-view.js";
import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";

export async function messageTriggerViewOf(id: number): Promise<MessageTriggerView> {
  const catalog = await loadBehaviorCatalog();
  const trigger = catalog.messageTriggers.find((t) => t.id === id);
  if (!trigger) throw new BehaviorApiError("not_found", `behavior ${id} does not exist`);
  return messageTriggerView(trigger, await findStatsBulk([id]));
}

export async function serviceBehaviorViewOf(id: number): Promise<ServiceBehaviorView> {
  const catalog = await loadBehaviorCatalog();
  const trigger = catalog.messageTriggers.find((t) => t.id === id);
  const view = trigger ? serviceBehaviorView(trigger, await findStatsBulk([id])) : null;
  if (!view) throw new BehaviorApiError("not_found", `service behavior ${id} does not exist`);
  return view;
}

/** The next sortOrder after every message trigger (inside the write transaction). */
export async function nextMessageSortOrder(transaction: Transaction): Promise<number> {
  const max = (await BehaviorDefinition.max("sortOrder", {
    where: { triggerKind: "message" },
    transaction,
  })) as number | null;
  return Number.isFinite(max) ? (max as number) + 1 : 0;
}
