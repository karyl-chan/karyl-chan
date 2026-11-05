/**
 * Idempotent seed for the System Behavior (登入，the only one since
 * ADR 0003). Runs after migrations and before the boot reconcile.
 *
 * An existing row is never touched: its trigger is the admin's choice
 * (migration 011 copies the pre-upgrade one exactly). A missing row is
 * created with the default trigger — a DM message pattern `!login`, as
 * production has always had it.
 */

import {
  BehaviorDefinition,
  SYSTEM_BEHAVIOR_KEYS,
  SYSTEM_BEHAVIOR_KEY_LOGIN,
  type BehaviorSystemKey,
} from "./models/behavior-definition.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";

const LOGIN_SEED = {
  title: "發送登入連結",
  description:
    "私訊 bot `!login`（或目前設定的觸發方式）時，發送一次性 admin 登入連結給授權使用者。系統行為，不能新增、刪除或停用，只能改觸發方式。",
  // 系統列排在所屬分區最前面
  sortOrder: -1000,
} as const;

export async function ensureSystemBehaviors(): Promise<{
  created: BehaviorSystemKey[];
  existing: BehaviorSystemKey[];
}> {
  const created: BehaviorSystemKey[] = [];
  const existing: BehaviorSystemKey[] = [];

  const rows = await BehaviorDefinition.findAll({
    where: { systemKey: [...SYSTEM_BEHAVIOR_KEYS] },
  });
  const present = new Set(
    rows.map((r) => r.getDataValue("systemKey") as BehaviorSystemKey),
  );

  if (present.has(SYSTEM_BEHAVIOR_KEY_LOGIN)) {
    existing.push(SYSTEM_BEHAVIOR_KEY_LOGIN);
  } else {
    await BehaviorDefinition.create({
      ...LOGIN_SEED,
      enabled: true,
      systemKey: SYSTEM_BEHAVIOR_KEY_LOGIN,
      triggerKind: "message",
      actionSource: "builtin",
      commandId: null,
      subcommandGroup: null,
      subcommand: null,
      surface: "bot_dm",
      guildId: null,
      channelId: null,
      patternKind: "startswith",
      patternValue: "!login",
      stopOnMatch: true,
      audienceKind: "all",
      audienceUserId: null,
      audienceGroupName: null,
    });
    created.push(SYSTEM_BEHAVIOR_KEY_LOGIN);
    botEventLog.record(
      "info",
      "bot",
      "system-seed: 補建登入系統 behavior（與 bot 私訊的 `!login`）",
      { created },
    );
  }

  return { created, existing };
}
