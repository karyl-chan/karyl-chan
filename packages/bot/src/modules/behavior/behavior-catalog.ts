/**
 * BehaviorCatalog：behaviors 的唯讀模型 —— 指令（含葉節點）、訊息觸發、
 * 各 behavior 的 webhook 動作、群組名單 —— 一次讀齊。
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
import { BehaviorGroupMember } from "./models/behavior-group-member.model.js";
import { SYSTEM_BEHAVIOR_KEY_LOGIN } from "./models/behavior-definition.model.js";

/** 一個 behavior 與它的 webhook 動作（actionSource='webhook' 時）。 */
export interface CatalogBehavior extends BehaviorDefinitionRow {
  webhook: BehaviorWebhookActionRow | null;
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
  const [commandModels, definitionModels, webhookModels, memberModels] =
    await Promise.all([
      BehaviorCommand.findAll({ order: [["id", "ASC"]] }),
      BehaviorDefinition.findAll({
        order: [
          ["sortOrder", "ASC"],
          ["id", "ASC"],
        ],
      }),
      BehaviorWebhookAction.findAll(),
      BehaviorGroupMember.findAll(),
    ]);

  const webhooks = new Map(
    webhookModels.map((m) => {
      const row = rowOfBehaviorWebhookAction(m);
      return [row.behaviorId, row] as const;
    }),
  );
  const behaviors: CatalogBehavior[] = definitionModels.map((m) => {
    const row = rowOfBehaviorDefinition(m);
    return { ...row, webhook: webhooks.get(row.id) ?? null };
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

/** The System Behavior (login) in a catalog: its row, and its command when its trigger is one. */
export interface SystemLoginEntry {
  row: CatalogBehavior;
  command: CatalogCommand | null;
}

export function systemLoginOf(catalog: BehaviorCatalog): SystemLoginEntry | null {
  const isLogin = (b: CatalogBehavior) => b.systemKey === SYSTEM_BEHAVIOR_KEY_LOGIN;
  const command = catalog.commands.find((c) => c.leaves.some(isLogin)) ?? null;
  const row = command?.leaves.find(isLogin) ?? catalog.messageTriggers.find(isLogin);
  return row ? { row, command } : null;
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
  BehaviorGroupMember,
]) {
  for (const hook of WRITE_HOOKS) {
    model.addHook(hook, onWrite);
  }
}
