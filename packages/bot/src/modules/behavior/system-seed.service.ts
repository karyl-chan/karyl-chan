/**
 * Idempotent seed for the three v2 system behaviors (admin-login / manual / break).
 *
 * Uniqueness key: (source='system', systemKey) — aligned with unique index
 * `behaviors_system_uq`. Existing rows are never overwritten because admin
 * may have edited slashCommandName / contexts / enabled / etc.
 *
 * I-2 / I-3 / I-4 / I-5 / I-6 / I-7 invariants all satisfied (I-3 exempts
 * source='system', so BotDM context + global scope is legal).
 */

import {
  Behavior,
  SYSTEM_BEHAVIOR_KEYS,
  type BehaviorSystemKey,
} from "./models/behavior.model.js";
import {
  BehaviorScopeTab,
  FIXED_TAB_IDS,
  deriveFieldsFromTab,
  rowOf as tabRowOf,
} from "./models/behavior-scope-tab.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";

interface SystemBehaviorSeed {
  systemKey: BehaviorSystemKey;
  slashCommandName: string;
  title: string;
  description: string;
  slashCommandDescription: string;
  sortOrder: number;
}

// Home tab for the three system behaviours. Earlier seeds put them on
// `all_dms` (contexts = BotDM + PrivateChannel) which surfaced /login
// in group DMs whenever a user user-installed the bot. PrivateChannel
// added no real value over BotDM for any of these commands, so we
// tightened the home to `all_bot_dms` (contexts = BotDM only). The
// self-heal block below migrates pre-existing rows from the old home.
const SYSTEM_SCOPE_TAB_ID = FIXED_TAB_IDS.all_bot_dms;

const SEEDS: SystemBehaviorSeed[] = [
  {
    systemKey: "admin-login",
    slashCommandName: "login",
    title: "發送登入連結",
    description:
      "私訊 bot `/login`(或符合觸發條件)時,發送一次性 admin 登入連結給授權使用者。系統行為,不可刪除或更換目標對象。",
    slashCommandDescription: "取得 admin 後台一次性登入連結(僅授權使用者)",
    sortOrder: -1000,
  },
  {
    systemKey: "manual",
    slashCommandName: "manual",
    title: "查看可用行為列表",
    description:
      "私訊 bot `/manual`(或符合觸發條件)時,列出此使用者在私訊可用的所有 behaviors。系統行為,不可刪除或更換目標對象。",
    slashCommandDescription: "查看你在私訊可用的行為列表",
    sortOrder: -999,
  },
  {
    systemKey: "break",
    slashCommandName: "break",
    title: "結束持續轉發",
    description:
      "私訊 bot `/break`(或符合觸發條件)時,結束此使用者目前的持續轉發 session。系統行為,不可刪除或更換目標對象。",
    slashCommandDescription: "結束目前正在進行的持續轉發",
    sortOrder: -998,
  },
];

/**
 * Idempotent upsert: ensure the three system behavior rows exist. Must run
 * after migrations and before commandReconciler.reconcileAll() so the
 * desired set includes them.
 */
export async function ensureSystemBehaviors(): Promise<{
  created: BehaviorSystemKey[];
  existing: BehaviorSystemKey[];
}> {
  const created: BehaviorSystemKey[] = [];
  const existing: BehaviorSystemKey[] = [];

  // 三個 system behaviour 共用同一個 home tab,所以 derive 一次重複用。
  // ensureFixedScopeTabs() 在 main.ts 早一步呼叫,target tab 必定存在;
  // 真的不在就 throw 讓 boot 失敗（比之後跑出怪事好）。
  const targetTabRow = await BehaviorScopeTab.findByPk(SYSTEM_SCOPE_TAB_ID);
  if (!targetTabRow) {
    throw new Error(
      `system-seed: fixed scope tab #${SYSTEM_SCOPE_TAB_ID} 不存在,` +
        " ensureFixedScopeTabs() 沒先跑成功?",
    );
  }
  const derived = deriveFieldsFromTab(tabRowOf(targetTabRow));
  // all_bot_dms 的 derive 回傳 integrationTypes 不會是 null,但型別簽章
  // 容許,所以這裡防呆 fallback 一下。
  const expectedIntegrationTypes =
    derived.integrationTypes ?? "guild_install,user_install";

  const rows = await Behavior.findAll({
    where: {
      source: "system",
      systemKey: SEEDS.map((s) => s.systemKey),
    },
  });
  const rowByKey = new Map(
    rows.map(
      (row) =>
        [row.getDataValue("systemKey") as BehaviorSystemKey, row] as const,
    ),
  );

  for (const seed of SEEDS) {
    const row = rowByKey.get(seed.systemKey);
    if (row) {
      existing.push(seed.systemKey);
      // Self-heal: 兩種情況都把 row 拉回 target tab 的 derive
      //   (a) 既存 row 還在舊預設 all_dms → 連 scopeTabId 一起搬
      //   (b) 已在 target tab 但 contexts / integrationTypes 漂走 → 直接 realign
      // 在其他 tab（admin 主動搬出去）就放著不動,respect 他們的選擇。
      const currentTabId = row.getDataValue("scopeTabId") as number;
      const currentContexts = row.getDataValue("contexts") as string;
      const currentIntegrationTypes = row.getDataValue(
        "integrationTypes",
      ) as string | null;
      const needsMigrate = currentTabId === FIXED_TAB_IDS.all_dms;
      const needsRealign =
        currentTabId === SYSTEM_SCOPE_TAB_ID &&
        (currentContexts !== derived.contexts ||
          currentIntegrationTypes !== expectedIntegrationTypes);
      if (needsMigrate || needsRealign) {
        await row.update({
          scopeTabId: SYSTEM_SCOPE_TAB_ID,
          scope: derived.scope,
          contexts: derived.contexts,
          integrationTypes: expectedIntegrationTypes,
          audienceKind: derived.audienceKind,
          audienceUserId: derived.audienceUserId,
          audienceGroupName: derived.audienceGroupName,
          placementGuildId: derived.placementGuildId,
          placementChannelId: derived.placementChannelId,
        });
        botEventLog.record(
          "info",
          "bot",
          `system-seed: self-heal ${seed.systemKey} tab=${currentTabId} → ${SYSTEM_SCOPE_TAB_ID}`,
          {
            systemKey: seed.systemKey,
            before: {
              tabId: currentTabId,
              contexts: currentContexts,
              integrationTypes: currentIntegrationTypes,
            },
          },
        );
      }
      continue;
    }

    await Behavior.create({
      title: seed.title,
      description: seed.description,
      enabled: true,
      sortOrder: seed.sortOrder,
      stopOnMatch: true,
      forwardType: "one_time",
      source: "system",
      triggerType: "slash_command",
      messagePatternKind: null,
      messagePatternValue: null,
      slashCommandName: seed.slashCommandName,
      slashCommandDescription: seed.slashCommandDescription,
      scope: derived.scope,
      integrationTypes: expectedIntegrationTypes,
      contexts: derived.contexts,
      placementGuildId: derived.placementGuildId,
      placementChannelId: derived.placementChannelId,
      audienceKind: derived.audienceKind,
      audienceUserId: derived.audienceUserId,
      audienceGroupName: derived.audienceGroupName,
      webhookUrl: null,
      webhookSecret: null,
      webhookAuthMode: null,
      systemKey: seed.systemKey,
      scopeTabId: SYSTEM_SCOPE_TAB_ID,
    });
    created.push(seed.systemKey);
  }

  if (created.length > 0) {
    botEventLog.record(
      "info",
      "bot",
      `system-seed: 補建 ${created.length} 條 system behavior(${created.join(", ")})`,
      { created, existing },
    );
  }

  // Fail-fast on missing keys: a system slash command never being registered
  // would silently break /login etc., so we'd rather crash boot than warn.
  const missing = SYSTEM_BEHAVIOR_KEYS.filter(
    (k) => !created.includes(k) && !existing.includes(k),
  );
  if (missing.length > 0) {
    throw new Error(
      `system-seed: 預期 3 條 system behavior 全部到位,但仍缺 ${missing.join(", ")}`,
    );
  }

  return { created, existing };
}
