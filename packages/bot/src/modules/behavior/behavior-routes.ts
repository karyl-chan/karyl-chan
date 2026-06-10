/**
 * behavior-routes.ts — admin/behaviors REST API
 *
 * 路由表：
 *   GET    /api/behaviors                  — list（可帶 audienceKind/source/triggerType filter）
 *   GET    /api/behaviors/:id              — 單條
 *   POST   /api/behaviors                  — 建立（custom source 才能用）
 *   PATCH  /api/behaviors/:id              — 修改（source 依據限制不同欄位）
 *   DELETE /api/behaviors/:id              — 刪除（system/plugin 不可刪）
 *   POST   /api/behaviors/:id/resync       — 觸發 CommandReconciler.reconcileForBehavior
 *
 * 權限：requireBehaviorAdmin（需 behavior.manage 或 admin）。
 *
 * 審計 log：CRUD 後寫 botEventLog。
 */

import type { FastifyInstance } from "fastify";
import type { BehaviorRoutesOptions } from "./behavior-helpers.js";
import {
  requireBehaviorAdmin,
  decryptedView,
  isValidWebhookUrl,
  isValidRegex,
} from "./behavior-helpers.js";
import { sortJoin } from "../../utils/sort-join.js";
import {
  Behavior,
  rowOfBehavior,
  type BehaviorRow,
  type BehaviorTriggerType,
  type BehaviorAudienceKind,
  type BehaviorWebhookAuthMode,
} from "./models/behavior.model.js";
import {
  BehaviorScopeTab,
  deriveFieldsFromTab,
  rowOf as tabRowOf,
} from "./models/behavior-scope-tab.model.js";
import { BehaviorSession } from "./models/behavior-session.model.js";
import { Op, fn, col } from "sequelize";
import { sequelize } from "../../db.js";
import { encryptSecret } from "../../utils/crypto.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import type { CommandReconciler } from "../command-system/reconcile.service.js";

export type { BehaviorRoutesOptions };

/** The valid `messagePatternKind` values, single-sourced for every
 *  validation site in this module (create, PATCH switch, PATCH sub-field). */
const MESSAGE_PATTERN_KINDS = ["startswith", "endswith", "regex"];

// ── 主函式 ────────────────────────────────────────────────────────────────────

export async function registerBehaviorRoutes(
  server: FastifyInstance,
  options: BehaviorRoutesOptions = {},
): Promise<void> {
  function getReconciler(): CommandReconciler {
    if (!options.reconciler) {
      throw new Error("CommandReconciler not provided to behavior routes");
    }
    return options.reconciler;
  }

  /**
   * Fire-and-forget reconcileAll after CRUD that could shift Discord 指令
   * 登記（CREATE / UPDATE / DELETE behavior row）。不 await，避免 admin
   * UI 多吃一個 Discord round-trip 的延遲；失敗只記 log，因為 bot ready
   * 時的 reconcileAll 仍會兜底，下次重啟會自我修復。
   *
   * 為什麼需要：PATCH 把 triggerType 從 slash_command 切到 message_pattern
   * 後，DB row 的 slashCommandName 已被清成 null。reconcileForBehavior 對
   * non-slash_command 直接 noop，且抓不到舊指令名，因此無法刪除 Discord
   * 端的舊登記。reconcileAll 走 owned_commands 名冊 + desired set diff，
   * 能正確識別 stale 並清除。
   */
  function scheduleReconcileAfterMutation(reason: string): void {
    getReconciler()
      .reconcileAll()
      .then((report) => {
        // Tests stub reconciler.reconcileAll as `() => undefined`; production
        // returns a real ReconcileReport. Tolerate either shape rather than
        // letting an undefined-deref leak into the warn branch in test runs.
        if (!report) return;
        botEventLog.record(
          "info",
          "bot",
          `behavior-routes: reconcileAll(${reason}) created=${report.created} patched=${report.patched} deleted=${report.deleted} errors=${report.errors.length}`,
        );
      })
      .catch((err: unknown) => {
        botEventLog.record(
          "warn",
          "bot",
          `behavior-routes: reconcileAll(${reason}) 失敗：${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // ── GET /api/behaviors ──────────────────────────────────────────────────────

  server.get("/api/behaviors", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const query = request.query as {
      scopeTabId?: string;
      audienceKind?: string;
      audienceUserId?: string;
      audienceGroupName?: string;
      source?: string;
      triggerType?: string;
    };

    const where: Record<string, unknown> = {};
    if (query.scopeTabId) {
      const tabId = parseInt(query.scopeTabId, 10);
      if (!isNaN(tabId)) where["scopeTabId"] = tabId;
    }
    if (
      query.audienceKind &&
      ["all", "user", "group"].includes(query.audienceKind)
    ) {
      where["audienceKind"] = query.audienceKind;
    }
    if (query.audienceUserId) {
      where["audienceUserId"] = query.audienceUserId;
    }
    if (query.audienceGroupName) {
      where["audienceGroupName"] = query.audienceGroupName;
    }
    if (query.source && ["custom", "system"].includes(query.source)) {
      where["source"] = query.source;
    }
    if (
      query.triggerType &&
      ["slash_command", "message_pattern"].includes(query.triggerType)
    ) {
      where["triggerType"] = query.triggerType;
    }

    const rows = await Behavior.findAll({
      where: Object.keys(where).length > 0 ? where : undefined,
      order: [
        ["sortOrder", "ASC"],
        ["id", "ASC"],
      ],
    });

    const behaviors = rows.map((r) => decryptedView(rowOfBehavior(r)));
    return reply.send({ behaviors });
  });

  // ── GET /api/behaviors/:id ──────────────────────────────────────────────────

  server.get("/api/behaviors/:id", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const numId = parseInt(id, 10);
    if (isNaN(numId)) {
      return reply.code(400).send({ error: "無效的 behavior ID" });
    }

    const row = await Behavior.findByPk(numId);
    if (!row) {
      return reply.code(404).send({ error: "Behavior 不存在" });
    }

    return reply.send({ behavior: decryptedView(rowOfBehavior(row)) });
  });

  // ── POST /api/behaviors ─────────────────────────────────────────────────────
  // admin 只能建立 source=custom（webhook URL）的 behavior；system 由系統 seed。

  server.post("/api/behaviors", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const body = request.body as {
      title?: string;
      description?: string;
      triggerType?: BehaviorTriggerType;
      messagePatternKind?: string;
      messagePatternValue?: string;
      slashCommandName?: string;
      slashCommandDescription?: string;
      scope?: string;
      integrationTypes?: string;
      contexts?: string;
      audienceKind?: BehaviorAudienceKind;
      audienceUserId?: string;
      audienceGroupName?: string;
      webhookUrl?: string;
      webhookSecret?: string;
      webhookAuthMode?: BehaviorWebhookAuthMode;
      forwardType?: string;
      stopOnMatch?: boolean;
      enabled?: boolean;
      scopeTabId?: number;
    };

    // 基本驗證
    if (!body.title?.trim()) {
      return reply.code(400).send({ error: "title 為必填" });
    }
    if (
      !body.triggerType ||
      !["slash_command", "message_pattern"].includes(body.triggerType)
    ) {
      return reply.code(400).send({ error: "無效的 triggerType" });
    }

    // webhookUrl（custom behavior 必填）驗證
    if (!body.webhookUrl?.trim()) {
      return reply.code(400).send({ error: "需要 webhookUrl" });
    }
    const urlCheck = await isValidWebhookUrl(body.webhookUrl.trim());
    if (!urlCheck.ok) {
      return reply.code(400).send({ error: urlCheck.reason });
    }

    // triggerType 相關驗證
    if (body.triggerType === "message_pattern") {
      if (
        !body.messagePatternKind ||
        !MESSAGE_PATTERN_KINDS.includes(body.messagePatternKind)
      ) {
        return reply.code(400).send({ error: "無效的 messagePatternKind" });
      }
      if (!body.messagePatternValue?.trim()) {
        return reply.code(400).send({ error: "messagePatternValue 為必填" });
      }
      if (
        body.messagePatternKind === "regex" &&
        !isValidRegex(body.messagePatternValue)
      ) {
        return reply.code(400).send({ error: "regex 格式錯誤" });
      }
    } else {
      // slash_command
      if (!body.slashCommandName?.trim()) {
        return reply.code(400).send({ error: "slashCommandName 為必填" });
      }
    }

    // webhookAuthMode 與 webhookSecret 一致性
    if (body.webhookAuthMode && !body.webhookSecret) {
      return reply.code(400).send({
        error: "設定 webhookAuthMode 需要先設定 webhookSecret",
      });
    }

    // Resolve scope tab — derive scope/contexts/audience/placement
    let derivedScope = body.scope ?? "global";
    let derivedContexts: string;
    let derivedAudienceKind = body.audienceKind ?? "all";
    let derivedAudienceUserId = body.audienceUserId ?? null;
    let derivedAudienceGroupName = body.audienceGroupName ?? null;
    let derivedPlacementGuildId: string | null = null;
    let derivedPlacementChannelId: string | null = null;
    // tab 同步來的 integrationTypes (null = 該 tab 不指定,admin 自選)
    let tabIntegrationTypes: string | null = null;
    let resolvedTabId = body.scopeTabId ?? 1;

    if (body.scopeTabId) {
      const tabRow = await BehaviorScopeTab.findByPk(body.scopeTabId);
      if (!tabRow) {
        return reply.code(400).send({ error: "無效的 scopeTabId" });
      }
      const tab = tabRowOf(tabRow);
      const derived = deriveFieldsFromTab(tab);
      derivedScope = derived.scope;
      derivedContexts = derived.contexts;
      derivedAudienceKind = derived.audienceKind;
      derivedAudienceUserId = derived.audienceUserId;
      derivedAudienceGroupName = derived.audienceGroupName;
      derivedPlacementGuildId = derived.placementGuildId;
      derivedPlacementChannelId = derived.placementChannelId;
      tabIntegrationTypes = derived.integrationTypes;
      resolvedTabId = body.scopeTabId;
    } else {
      derivedContexts = sortJoin(body.contexts || "Guild");
    }

    // integrationTypes:tab 寫死的優先（admin 在非 global_all tab 上的
    // 設定會被覆蓋）；tab 沒寫死才採 body 給的值，最後才落到預設。
    // message_pattern 不經指令註冊、沒有安裝面 — body 給的值一律忽略，
    // 只存 tab 衍生/預設值（BH-0.2；PATCH 端對顯式設定則直接 400）。
    const integrationTypes =
      tabIntegrationTypes ??
      sortJoin(
        (body.triggerType === "message_pattern"
          ? ""
          : body.integrationTypes || "") || "guild_install",
      );
    const contexts = body.scopeTabId
      ? derivedContexts
      : sortJoin(body.contexts || "Guild");

    // 最大 sortOrder
    const maxSortRow = await Behavior.findOne({
      order: [["sortOrder", "DESC"]],
      attributes: ["sortOrder"],
    });
    const nextSortOrder = maxSortRow
      ? (maxSortRow.getDataValue("sortOrder") as number) + 1
      : 0;

    const row = await Behavior.create({
      title: body.title.trim(),
      description: body.description ?? "",
      source: "custom",
      triggerType: body.triggerType,
      messagePatternKind:
        body.triggerType === "message_pattern" ? body.messagePatternKind : null,
      messagePatternValue:
        body.triggerType === "message_pattern"
          ? body.messagePatternValue
          : null,
      slashCommandName:
        body.triggerType === "slash_command"
          ? body.slashCommandName?.trim()
          : null,
      slashCommandDescription:
        body.triggerType === "slash_command"
          ? (body.slashCommandDescription ?? "")
          : null,
      scope: derivedScope,
      integrationTypes,
      contexts,
      audienceKind: derivedAudienceKind,
      audienceUserId:
        derivedAudienceKind === "user" ? derivedAudienceUserId : null,
      audienceGroupName:
        derivedAudienceKind === "group" ? derivedAudienceGroupName : null,
      placementGuildId: derivedPlacementGuildId,
      placementChannelId: derivedPlacementChannelId,
      webhookUrl: encryptSecret(body.webhookUrl.trim()),
      webhookSecret: body.webhookSecret
        ? encryptSecret(body.webhookSecret)
        : null,
      webhookAuthMode: body.webhookSecret
        ? (body.webhookAuthMode ?? "token")
        : null,
      systemKey: null,
      forwardType: body.forwardType ?? "one_time",
      stopOnMatch: !!body.stopOnMatch,
      enabled: body.enabled !== undefined ? !!body.enabled : true,
      sortOrder: nextSortOrder,
      scopeTabId: resolvedTabId,
    });

    const created = decryptedView(rowOfBehavior(row));

    botEventLog.record(
      "info",
      "web",
      `behavior 已建立 id=${created.id} source=${created.source}`,
      {
        behaviorId: created.id,
      },
    );

    scheduleReconcileAfterMutation(`create id=${created.id}`);

    return reply.code(201).send({ behavior: created });
  });

  // ── PATCH /api/behaviors/:id ────────────────────────────────────────────────
  // custom：全欄位可改
  // system：只能改 trigger value（slashCommandName / messagePatternValue）+ enabled

  server.patch("/api/behaviors/:id", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const numId = parseInt(id, 10);
    if (isNaN(numId)) {
      return reply.code(400).send({ error: "無效的 behavior ID" });
    }

    const existing = await Behavior.findByPk(numId);
    if (!existing) {
      return reply.code(404).send({ error: "Behavior 不存在" });
    }

    const existingRow = rowOfBehavior(existing);
    const body = request.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (existingRow.source === "system") {
      // system：可改 triggerType（+ 對應子欄位）、enabled。title /
      // description / 三軸 / audience / forward / webhook 仍鎖住 —
      // 由 system-seed 控制，其他欄位若 body 帶來會被忽略而非報錯。
      const touchesTrigger =
        "triggerType" in body ||
        "slashCommandName" in body ||
        "slashCommandDescription" in body ||
        "messagePatternKind" in body ||
        "messagePatternValue" in body;

      if (touchesTrigger) {
        const newTriggerType =
          "triggerType" in body
            ? (body["triggerType"] as string)
            : existingRow.triggerType;
        if (!["slash_command", "message_pattern"].includes(newTriggerType)) {
          return reply.code(400).send({ error: "無效的 triggerType" });
        }
        const switching = newTriggerType !== existingRow.triggerType;

        if (newTriggerType === "slash_command") {
          const name =
            "slashCommandName" in body
              ? ((body["slashCommandName"] as string | null) ?? "").trim()
              : (existingRow.slashCommandName ?? "").trim();
          if (!name) {
            return reply.code(400).send({ error: "slashCommandName 為必填" });
          }
          patch["slashCommandName"] = name;
          if ("slashCommandDescription" in body) {
            patch["slashCommandDescription"] =
              (body["slashCommandDescription"] as string | null) ?? null;
          }
          if (switching) {
            patch["triggerType"] = "slash_command";
            // Null out message_pattern 側，滿足 triggerTypeShape invariant。
            patch["messagePatternKind"] = null;
            patch["messagePatternValue"] = null;
          }
        } else {
          const kind =
            "messagePatternKind" in body
              ? (body["messagePatternKind"] as string)
              : existingRow.messagePatternKind;
          if (!kind || !MESSAGE_PATTERN_KINDS.includes(kind)) {
            return reply
              .code(400)
              .send({ error: "無效的 messagePatternKind" });
          }
          const val =
            "messagePatternValue" in body
              ? ((body["messagePatternValue"] as string | null) ?? "").trim()
              : (existingRow.messagePatternValue ?? "").trim();
          if (!val) {
            return reply
              .code(400)
              .send({ error: "messagePatternValue 為必填" });
          }
          if (kind === "regex" && !isValidRegex(val)) {
            return reply.code(400).send({ error: "regex 格式錯誤" });
          }
          patch["messagePatternKind"] = kind;
          patch["messagePatternValue"] = val;
          if (switching) {
            patch["triggerType"] = "message_pattern";
            patch["slashCommandName"] = null;
            patch["slashCommandDescription"] = null;
          }
        }
      }

      if ("enabled" in body) {
        const nextEnabled = !!body["enabled"];
        // admin-login / break 是 admin 後台與 session 收尾的唯一逃生口，
        // 一旦被停用就找不回後台，也沒辦法手動結束 session。manual 可關
        // （只是失去 DM 列表助理）。系統行為的 protected set 在此明列。
        if (
          !nextEnabled &&
          (existingRow.systemKey === "admin-login" ||
            existingRow.systemKey === "break")
        ) {
          return reply.code(403).send({
            error: `系統行為 ${existingRow.systemKey} 不可停用`,
          });
        }
        patch["enabled"] = nextEnabled;
      }
    } else {
      // custom：全欄位可改
      if ("title" in body) {
        const title = (body["title"] as string)?.trim();
        if (!title) return reply.code(400).send({ error: "title 不可為空" });
        patch["title"] = title;
      }
      if ("description" in body)
        patch["description"] = body["description"] ?? "";
      if ("triggerType" in body) {
        if (
          !["slash_command", "message_pattern"].includes(
            body["triggerType"] as string,
          )
        ) {
          return reply.code(400).send({ error: "無效的 triggerType" });
        }
        patch["triggerType"] = body["triggerType"];
      }
      if ("messagePatternKind" in body)
        patch["messagePatternKind"] = body["messagePatternKind"] ?? null;
      if ("messagePatternValue" in body) {
        const val =
          (body["messagePatternValue"] as string | null)?.trim() ?? null;
        if (
          val &&
          (body["messagePatternKind"] ?? existingRow.messagePatternKind) ===
            "regex" &&
          !isValidRegex(val)
        ) {
          return reply.code(400).send({ error: "regex 格式錯誤" });
        }
        patch["messagePatternValue"] = val;
      }
      if ("slashCommandName" in body)
        patch["slashCommandName"] =
          (body["slashCommandName"] as string | null)?.trim() ?? null;
      if ("slashCommandDescription" in body)
        patch["slashCommandDescription"] =
          body["slashCommandDescription"] ?? null;
      // When triggerType is (re)set, enforce the cross-field invariant the
      // model validates on save (triggerTypeShape): a row must carry ONLY
      // its trigger type's columns, with the required one present. The
      // per-field blocks above can leave the previous type's columns stale,
      // and because the PATCH applies via an instance update (full row in
      // the validate context), a switch then throws and 500s the edit
      // instead of clearing the old side. Reconcile here — mirrors the
      // system branch and the create path.
      if ("triggerType" in body) {
        if (body["triggerType"] === "slash_command") {
          const name = String(
            (patch["slashCommandName"] as string | null | undefined) ??
              existingRow.slashCommandName ??
              "",
          ).trim();
          if (!name) {
            return reply.code(400).send({ error: "slashCommandName 為必填" });
          }
          patch["slashCommandName"] = name;
          patch["messagePatternKind"] = null;
          patch["messagePatternValue"] = null;
        } else {
          const kind =
            (patch["messagePatternKind"] as string | null | undefined) ??
            existingRow.messagePatternKind ??
            null;
          const val = String(
            (patch["messagePatternValue"] as string | null | undefined) ??
              existingRow.messagePatternValue ??
              "",
          ).trim();
          if (!kind || !MESSAGE_PATTERN_KINDS.includes(kind)) {
            return reply.code(400).send({ error: "無效的 messagePatternKind" });
          }
          if (!val) {
            return reply
              .code(400)
              .send({ error: "messagePatternValue 為必填" });
          }
          if (kind === "regex" && !isValidRegex(val)) {
            return reply.code(400).send({ error: "regex 格式錯誤" });
          }
          patch["messagePatternKind"] = kind;
          patch["messagePatternValue"] = val;
          patch["slashCommandName"] = null;
          patch["slashCommandDescription"] = null;
        }
      } else {
        // triggerType is NOT changing in this PATCH. The per-field blocks
        // above still let a caller set a sub-field that belongs to the
        // OTHER trigger type (or an out-of-enum messagePatternKind) without
        // going through the reconcile block. Validate against the EXISTING
        // type here so we return a clean 400 instead of (a) letting the
        // model's triggerTypeShape validator throw a 500 on update, or
        // (b) silently writing a behavior that never fires (matchesTrigger
        // returns false for an unknown kind).
        if (existingRow.triggerType === "slash_command") {
          if (
            ("messagePatternKind" in body &&
              patch["messagePatternKind"] != null) ||
            ("messagePatternValue" in body &&
              patch["messagePatternValue"] != null)
          ) {
            return reply.code(400).send({
              error: "messagePattern 欄位不適用於 slash_command behavior",
            });
          }
        } else {
          if (
            ("slashCommandName" in body && patch["slashCommandName"] != null) ||
            ("slashCommandDescription" in body &&
              patch["slashCommandDescription"] != null)
          ) {
            return reply.code(400).send({
              error: "slashCommand 欄位不適用於 message_pattern behavior",
            });
          }
          if (
            "messagePatternKind" in body &&
            patch["messagePatternKind"] != null &&
            !MESSAGE_PATTERN_KINDS.includes(
              patch["messagePatternKind"] as string,
            )
          ) {
            return reply
              .code(400)
              .send({ error: "無效的 messagePatternKind" });
          }
        }
      }
      if ("scope" in body) patch["scope"] = body["scope"];
      if ("integrationTypes" in body) {
        // integrationTypes 是 slash 指令的安裝面設定（Discord application
        // command install scope）；message_pattern 不經指令註冊，設定它
        // 沒有任何效果 — 拒絕，不留「看似生效」的假象（BH-0.2）。
        const effectiveTrigger =
          (body["triggerType"] as string | undefined) ??
          existingRow.triggerType;
        if (effectiveTrigger === "message_pattern") {
          return reply.code(400).send({
            error:
              "message_pattern behavior 不使用 integrationTypes（僅 slash command 有安裝面）",
          });
        }
        // integrationTypes 只在 global_all tab 上可自選 — 其他 tab 由
        // deriveFieldsFromTab() 寫死。若 admin 嘗試覆蓋,拒絕並告知。
        const tabRow = await BehaviorScopeTab.findByPk(existingRow.scopeTabId);
        if (!tabRow) {
          return reply.code(400).send({ error: "無效的 scopeTabId" });
        }
        const tabFixed = deriveFieldsFromTab(tabRowOf(tabRow)).integrationTypes;
        const wanted = sortJoin(body["integrationTypes"] as string);
        if (tabFixed !== null && tabFixed !== wanted) {
          return reply.code(400).send({
            error:
              "integrationTypes 由範圍分頁決定,僅「全範圍」分頁可自訂",
          });
        }
        patch["integrationTypes"] = wanted;
      }
      if ("contexts" in body) {
        patch["contexts"] = sortJoin(body["contexts"] as string);
      }
      if ("audienceKind" in body) patch["audienceKind"] = body["audienceKind"];
      if ("audienceUserId" in body)
        patch["audienceUserId"] = body["audienceUserId"] ?? null;
      if ("audienceGroupName" in body)
        patch["audienceGroupName"] = body["audienceGroupName"] ?? null;
      if ("enabled" in body) patch["enabled"] = !!body["enabled"];
      if ("forwardType" in body) patch["forwardType"] = body["forwardType"];
      if ("stopOnMatch" in body) patch["stopOnMatch"] = !!body["stopOnMatch"];
      if ("webhookUrl" in body) {
        const url = (body["webhookUrl"] as string | null)?.trim();
        if (url) {
          const urlCheck = await isValidWebhookUrl(url);
          if (!urlCheck.ok)
            return reply.code(400).send({ error: urlCheck.reason });
          patch["webhookUrl"] = encryptSecret(url);
        } else {
          patch["webhookUrl"] = null;
        }
      }
      if ("webhookSecret" in body) {
        const secret = body["webhookSecret"] as string | null;
        if (secret === null || secret === "") {
          patch["webhookSecret"] = null;
          patch["webhookAuthMode"] = null;
        } else {
          patch["webhookSecret"] = encryptSecret(secret);
          patch["webhookAuthMode"] =
            (body["webhookAuthMode"] as BehaviorWebhookAuthMode) ?? "token";
        }
      } else if ("webhookAuthMode" in body) {
        const mode = body["webhookAuthMode"] as BehaviorWebhookAuthMode | null;
        const currentSecret = existingRow.webhookSecret;
        if (mode && !currentSecret) {
          return reply
            .code(400)
            .send({ error: "設定 webhookAuthMode 需要先設定 webhookSecret" });
        }
        patch["webhookAuthMode"] = mode ?? null;
      }
    }

    if (Object.keys(patch).length === 0) {
      return reply.send({ behavior: decryptedView(existingRow) });
    }

    await existing.update(patch);
    const updated = decryptedView(rowOfBehavior(existing));

    // H-3 修：forwardType 改成非 continuous（或 enabled 被關掉）後，殘留
    // session 不應繼續吞 DM。matcher 也會在下一則訊息進來時自我修復，
    // 但這裡眼前清掉避免 user 多吃一發 forward。
    const wasContinuous = existingRow.forwardType === "continuous";
    const stillContinuous = updated.forwardType === "continuous";
    const becameDisabled = existingRow.enabled && updated.enabled === false;
    if ((wasContinuous && !stillContinuous) || becameDisabled) {
      const ended = await BehaviorSession.destroy({
        where: { behaviorId: numId },
      });
      if (ended > 0) {
        botEventLog.record(
          "info",
          "web",
          `behavior 更新連帶結束 ${ended} 條 session id=${numId}`,
          { behaviorId: numId, sessionsEnded: ended },
        );
      }
    }

    botEventLog.record(
      "info",
      "web",
      `behavior 已更新 id=${numId} source=${existingRow.source}`,
      {
        behaviorId: numId,
      },
    );

    scheduleReconcileAfterMutation(`patch id=${numId}`);

    return reply.send({ behavior: updated });
  });

  // ── DELETE /api/behaviors/:id ───────────────────────────────────────────────

  server.delete("/api/behaviors/:id", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const numId = parseInt(id, 10);
    if (isNaN(numId)) {
      return reply.code(400).send({ error: "無效的 behavior ID" });
    }

    const existing = await Behavior.findByPk(numId);
    if (!existing) {
      return reply.code(404).send({ error: "Behavior 不存在" });
    }

    const existingRow = rowOfBehavior(existing);
    if (existingRow.source === "system") {
      return reply.code(403).send({ error: "system behavior 不可刪除" });
    }

    // H-2 修：FK onDelete:CASCADE 會在 SQLite FK 開啟時靜默清掉 session，
    // 但 admin 看不到「連帶結束 N 條 session」這件事。先顯式清、log 數量，
    // 再 destroy；同時讓 FK pragma 萬一沒生效時行為仍正確。
    const endedSessions = await BehaviorSession.destroy({
      where: { behaviorId: numId },
    });

    await existing.destroy();

    botEventLog.record(
      "info",
      "web",
      `behavior 已刪除 id=${numId}${endedSessions > 0 ? `（連帶結束 ${endedSessions} 條 session）` : ""}`,
      { behaviorId: numId, sessionsEnded: endedSessions },
    );

    scheduleReconcileAfterMutation(`delete id=${numId}`);

    return reply.code(204).send();
  });

  // ── POST /api/behaviors/:id/resync ──────────────────────────────────────────

  server.post("/api/behaviors/:id/resync", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const numId = parseInt(id, 10);
    if (isNaN(numId)) {
      return reply.code(400).send({ error: "無效的 behavior ID" });
    }

    const existing = await Behavior.findByPk(numId);
    if (!existing) {
      return reply.code(404).send({ error: "Behavior 不存在" });
    }

    const result = await getReconciler().reconcileForBehavior(numId);

    botEventLog.record(
      "info",
      "web",
      `behavior resync id=${numId} result=${result.ok ? "ok" : "fail"}`,
      {
        behaviorId: numId,
      },
    );

    return reply.send({ result });
  });

  // ── PATCH /api/behaviors/reorder ────────────────────────────────────────────
  // 接受 orderedIds: number[]，只針對 source=custom 的排序

  server.patch("/api/behaviors/reorder", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;

    const body = request.body as { orderedIds?: number[] };
    if (!Array.isArray(body.orderedIds)) {
      return reply.code(400).send({ error: "orderedIds 為必填陣列" });
    }
    // Cap the batch so a malicious / typo'd request can't ship a
    // gigantic array that takes the lock for seconds.
    if (body.orderedIds.length > 500) {
      return reply.code(400).send({ error: "orderedIds 過長 (max 500)" });
    }

    // Single transaction: a concurrent read of the behaviors table
    // mid-reorder used to see partially-applied sort orders, and a
    // failure on the Nth update left the first N-1 rows reordered
    // with no rollback. Sequelize will wrap the entire block in a
    // BEGIN/COMMIT against SQLite.
    await sequelize.transaction(async (transaction) => {
      for (let index = 0; index < body.orderedIds!.length; index++) {
        await Behavior.update(
          { sortOrder: index },
          {
            where: { id: body.orderedIds![index], source: "custom" },
            transaction,
          },
        );
      }
    });

    return reply.send({ ok: true });
  });
}
