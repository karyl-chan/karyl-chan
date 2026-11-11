/**
 * BehaviorCatalog：behaviors 的唯讀模型 —— 指令（含葉節點）、訊息觸發、
 * 各 behavior 的 webhook / plugin 動作、Service Behavior 的服務、群組名單
 * —— 一次讀齊。
 *
 *   - loadBehaviorCatalog()：直接讀 DB（admin API 用）
 *   - getBehaviorCatalog()：記憶體快照（每則訊息 / 每次 interaction 的熱
 *     路徑用）。behavior 相關的表一有寫入（任何 model 寫入，含 bulk 與
 *     transaction commit 後）就失效；另有 TTL 兜底，讓別的 process 的寫入
 *     最遲 SNAPSHOT_TTL_MS 後也會被看到。
 */

import type { Transaction } from "sequelize";
import {
  BehaviorCommand,
  rowOfBehaviorCommand,
  type BehaviorCommandRow,
} from "./models/behavior-command.model.js";
import {
  BehaviorDefinition,
  rowOfBehaviorDefinition,
  type BehaviorDefinitionRow,
} from "./models/behavior-definition.model.js";
import {
  BehaviorWebhookAction,
  rowOfBehaviorWebhookAction,
  type BehaviorWebhookActionRow,
} from "./models/behavior-webhook-action.model.js";
import {
  BehaviorPluginAction,
  rowOfBehaviorPluginAction,
  type BehaviorPluginActionRow,
} from "./models/behavior-plugin-action.model.js";
import { BehaviorGroupMember } from "./models/behavior-group-member.model.js";
import { Service, rowOfService, type ServiceRow } from "./models/service.model.js";
import {
  SYSTEM_BEHAVIOR_KEY_LOGIN,
  isServiceBehavior,
} from "./models/behavior-definition.model.js";

/**
 * 自訂 behavior 的動作，依來源區分（actionSource 'webhook' / 'plugin'）。
 * Service Behavior（'service'）的動作固定，不在這裡 —— 它的服務見
 * CatalogBehavior.service。
 */
export type CatalogAction =
  | { source: "webhook"; webhook: BehaviorWebhookActionRow }
  | { source: "plugin"; binding: BehaviorPluginActionRow };

/**
 * 一個 behavior 與它的動作。
 *   - action：webhook / plugin 動作；null = 內建動作（System Behavior）、
 *     Service Behavior，或來源對應的那一列不存在（手動改過 DB 等）——
 *     那時執行當成沒有動作。
 *   - service：Service Behavior（actionSource='service'）的服務；其餘 null。
 */
export interface CatalogBehavior extends BehaviorDefinitionRow {
  action: CatalogAction | null;
  service: ServiceRow | null;
}

function actionOf(
  row: BehaviorDefinitionRow,
  webhook: BehaviorWebhookActionRow | undefined,
  binding: BehaviorPluginActionRow | undefined,
): CatalogAction | null {
  if (row.actionSource === "webhook" && webhook) return { source: "webhook", webhook };
  if (row.actionSource === "plugin" && binding) return { source: "plugin", binding };
  return null;
}

/** 一個指令與它的葉節點（依 sortOrder、子指令名排序）。 */
export interface CatalogCommand extends BehaviorCommandRow {
  leaves: CatalogBehavior[];
}

export interface BehaviorCatalog {
  commands: CatalogCommand[];
  /** 依 sortOrder、id 排序 —— 訊息比對的順序 */
  messageTriggers: CatalogBehavior[];
  /** groupName → 成員 user id */
  groupMembers: Map<string, Set<string>>;
}

export async function loadBehaviorCatalog(): Promise<BehaviorCatalog> {
  const [commandModels, definitionModels, webhookModels, pluginActionModels, memberModels, serviceModels] =
    await Promise.all([
      BehaviorCommand.findAll({ order: [["id", "ASC"]] }),
      BehaviorDefinition.findAll({
        order: [
          ["sortOrder", "ASC"],
          ["id", "ASC"],
        ],
      }),
      BehaviorWebhookAction.findAll(),
      BehaviorPluginAction.findAll(),
      BehaviorGroupMember.findAll(),
      Service.findAll(),
    ]);

  const webhooks = new Map(
    webhookModels.map((m) => {
      const row = rowOfBehaviorWebhookAction(m);
      return [row.behaviorId, row] as const;
    }),
  );
  const pluginActions = new Map(
    pluginActionModels.map((m) => {
      const row = rowOfBehaviorPluginAction(m);
      return [row.behaviorId, row] as const;
    }),
  );
  const services = new Map(
    serviceModels.map((m) => {
      const row = rowOfService(m);
      return [row.id, row] as const;
    }),
  );
  const behaviors: CatalogBehavior[] = definitionModels.map((m) => {
    const row = rowOfBehaviorDefinition(m);
    return {
      ...row,
      action: actionOf(row, webhooks.get(row.id), pluginActions.get(row.id)),
      service: row.serviceId !== null ? (services.get(row.serviceId) ?? null) : null,
    };
  });

  const leavesByCommand = new Map<number, CatalogBehavior[]>();
  for (const b of behaviors) {
    if (b.triggerKind !== "command" || b.commandId === null) continue;
    const list = leavesByCommand.get(b.commandId) ?? [];
    list.push(b);
    leavesByCommand.set(b.commandId, list);
  }
  const commands = commandModels.map((m) => {
    const row = rowOfBehaviorCommand(m);
    const leaves = (leavesByCommand.get(row.id) ?? []).sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        (a.subcommand ?? "").localeCompare(b.subcommand ?? ""),
    );
    return { ...row, leaves };
  });

  const groupMembers = new Map<string, Set<string>>();
  for (const m of memberModels) {
    const group = m.getDataValue("groupName") as string;
    const set = groupMembers.get(group) ?? new Set<string>();
    set.add(m.getDataValue("userId") as string);
    groupMembers.set(group, set);
  }

  return {
    commands,
    messageTriggers: behaviors.filter((b) => b.triggerKind === "message"),
    groupMembers,
  };
}

/**
 * A fixed row in a catalog — the System Behavior or a Service Behavior
 * (fixed-trigger-switch.ts): its row, and its command when its trigger
 * is one.
 */
export interface FixedRowEntry {
  row: CatalogBehavior;
  command: CatalogCommand | null;
}

/** The System Behavior (login) in a catalog. */
export type SystemLoginEntry = FixedRowEntry;

function fixedRowOf(
  catalog: BehaviorCatalog,
  isRow: (b: CatalogBehavior) => boolean,
): FixedRowEntry | null {
  const command = catalog.commands.find((c) => c.leaves.some(isRow)) ?? null;
  const row = command?.leaves.find(isRow) ?? catalog.messageTriggers.find(isRow);
  return row ? { row, command } : null;
}

export function systemLoginOf(catalog: BehaviorCatalog): SystemLoginEntry | null {
  return fixedRowOf(catalog, (b) => b.systemKey === SYSTEM_BEHAVIOR_KEY_LOGIN);
}

/** One service's Service Behavior, wherever its trigger is. */
export function serviceBehaviorOf(catalog: BehaviorCatalog, serviceId: number): FixedRowEntry | null {
  return fixedRowOf(catalog, (b) => isServiceBehavior(b) && b.serviceId === serviceId);
}

/** Every Service Behavior, by service id (commands' leaves and message triggers alike). */
export function serviceBehaviorsOf(catalog: BehaviorCatalog): FixedRowEntry[] {
  const entries: FixedRowEntry[] = [];
  for (const command of catalog.commands) {
    for (const row of command.leaves) if (isServiceBehavior(row)) entries.push({ row, command });
  }
  for (const row of catalog.messageTriggers) {
    if (isServiceBehavior(row)) entries.push({ row, command: null });
  }
  return entries.sort((a, b) => (a.row.serviceId ?? 0) - (b.row.serviceId ?? 0));
}

// ── 快照 ────────────────────────────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 30_000;

let snapshot: { catalog: Promise<BehaviorCatalog>; loadedAt: number } | null =
  null;
/** 每次失效 +1；載入中途失效的結果不寫回快照。 */
let generation = 0;

export function getBehaviorCatalog(): Promise<BehaviorCatalog> {
  if (snapshot && Date.now() - snapshot.loadedAt < SNAPSHOT_TTL_MS) {
    return snapshot.catalog;
  }
  const startedAt = generation;
  const catalog = loadBehaviorCatalog();
  const entry = { catalog, loadedAt: Date.now() };
  snapshot = entry;
  catalog.then(
    () => {
      if (generation !== startedAt && snapshot === entry) snapshot = null;
    },
    () => {
      if (snapshot === entry) snapshot = null;
    },
  );
  return catalog;
}

export function invalidateBehaviorCatalog(): void {
  generation++;
  snapshot = null;
}

// 寫入即失效：behaviors 的每張表、每種寫法。transaction 內的寫入在 commit
// 後再失效一次，避免 commit 前重載的快照留著舊資料。
function onWrite(...args: unknown[]): void {
  invalidateBehaviorCatalog();
  const options = args[args.length - 1] as
    | { transaction?: Transaction | null }
    | undefined;
  options?.transaction?.afterCommit(() => invalidateBehaviorCatalog());
}

const WRITE_HOOKS = [
  "afterCreate",
  "afterUpdate",
  "afterDestroy",
  "afterUpsert",
  "afterBulkCreate",
  "afterBulkUpdate",
  "afterBulkDestroy",
] as const;

for (const model of [
  BehaviorCommand,
  BehaviorDefinition,
  BehaviorWebhookAction,
  BehaviorPluginAction,
  BehaviorGroupMember,
  Service,
]) {
  for (const hook of WRITE_HOOKS) {
    model.addHook(hook, onWrite);
  }
}
