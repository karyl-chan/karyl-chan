/**
 * behavior-routes.ts — admin behaviors REST API（ADR 0003 trigger/action 模型）
 *
 * 路由表：
 *   GET  /api/behaviors                          — { system, commands, messageTriggers }
 *   GET  /api/behaviors/schema                   — the write schemas, for the admin UI's form checks
 *   POST /api/behaviors/:id/test                 — 對 behavior 的 webhook 動作試發
 *   POST / PATCH / DELETE /api/behaviors[/:id]   — 訊息觸發的寫入（behavior-write-routes.ts）
 *   PUT  /api/behaviors/reorder                  — 一個位置內的訊息觸發排序（message-trigger-reorder.ts）
 *   POST /api/behaviors/:id/webhook-secret/rotate — 輪換 webhook 密鑰（webhook-secret-rotate.ts）
 *   /api/behavior-commands[/:id[/resync]]        — 指令的寫入與重新註冊（behavior-command-routes.ts）
 *   PUT  /api/behaviors/system/login/trigger     — 切換登入系統列的觸發（system-login-trigger-route.ts）
 *   GET  /api/behavior-groups/:groupName/members — 群組名單
 *   PUT  /api/behavior-groups/:groupName/members — 全量替換群組名單
 *
 * 寫入路由（新增 / 修改 / 刪除 / 排序 / resync）在 S4（#136）以新模型重新
 * 提供；這個切片的 admin UI 是唯讀的。
 *
 * 權限：requireBehaviorAdmin（behavior.manage 或 admin），在 schema 驗證之前。
 * 拒絕一律是 `{ error: { code, message, field? } }`（behavior-api-error.ts）。
 */

import type { FastifyInstance } from "fastify";
import {
  requireBehaviorAdmin,
  type BehaviorRoutesOptions,
} from "./behavior-helpers.js";
import { loadBehaviorCatalog } from "./behavior-catalog.js";
import { buildBehaviorListView } from "./behavior-list-view.js";
import {
  BehaviorDefinition,
  rowOfBehaviorDefinition,
} from "./models/behavior-definition.model.js";
import {
  BehaviorWebhookAction,
  rowOfBehaviorWebhookAction,
} from "./models/behavior-webhook-action.model.js";
import { findStatsBulk } from "./models/behavior-stats.model.js";
import {
  findGroupMembers,
  groupInUse,
  replaceGroupMembers,
} from "./models/behavior-group-member.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  BehaviorApiError,
  installBehaviorRouteValidation,
} from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import {
  createMessageTriggerSchema,
  registerBehaviorWriteRoutes,
} from "./behavior-write-routes.js";
import { registerMessageTriggerReorderRoute } from "./message-trigger-reorder.js";
import { registerWebhookSecretRotateRoute } from "./webhook-secret-rotate.js";
import {
  addLeafSchema,
  createCommandSchema,
  registerBehaviorCommandRoutes,
} from "./behavior-command-routes.js";
import { idParams, parseRowId, snowflake } from "./behavior-schemas.js";
import {
  loginTriggerSchema,
  registerSystemLoginTriggerRoute,
} from "./system-login-trigger-route.js";

export type { BehaviorRoutesOptions };

/** The placeholder user a test-fire carries instead of a real identity (#101). */
const TEST_FIRE_USER = {
  id: "0",
  username: "karyl-test",
  global_name: null,
  discriminator: "0",
  avatar: null,
} as const;

export async function registerBehaviorRoutes(
  server: FastifyInstance,
  options: BehaviorRoutesOptions = {},
): Promise<void> {
  // One encapsulated scope: the strict validator and the uniform error
  // body apply to the behavior routes and to nothing else.
  await server.register(async (scope) => {
    installBehaviorRouteValidation(scope);
    // The gate runs before validation, so a caller without the
    // capability learns nothing about the request shape.
    scope.addHook("preValidation", async (request, reply) => {
      if (!requireBehaviorAdmin(request, reply)) return reply;
    });
    registerReadAndTestRoutes(scope, options);
    registerBehaviorWriteRoutes(scope, options.reconciler);
    registerMessageTriggerReorderRoute(scope);
    registerWebhookSecretRotateRoute(scope);
    registerBehaviorCommandRoutes(scope, options);
    registerSystemLoginTriggerRoute(scope, options);
    registerGroupMemberRoutes(scope);
  });
}

function registerReadAndTestRoutes(
  server: FastifyInstance,
  options: BehaviorRoutesOptions,
): void {
  // ── GET /api/behaviors ──────────────────────────────────────────────────────

  server.get("/api/behaviors", async (request, reply) => {
    const catalog = await loadBehaviorCatalog();
    // BH-6.1：附上 forward 統計（admin UI 顯示 last-fired / 健康警示）
    const ids = [
      ...catalog.messageTriggers.map((t) => t.id),
      ...catalog.commands.flatMap((c) => c.leaves.map((l) => l.id)),
    ];
    const stats = await findStatsBulk(ids);
    return reply.send(buildBehaviorListView(catalog, stats));
  });

  // ── GET /api/behaviors/schema（#108）────────────────────────────────────────
  // 寫入路由實際驗證用的 JSON schema：訊息觸發、指令（含葉節點）與新增的
  // 子指令。admin UI 用它在送出前檢查欄位格式，schema 只有這一份，前端不另抄。
  // 跨欄位規則不在 schema 裡：訊息觸發的（message-trigger-rules.ts）由 UI 的
  // 表單結構避開；指令的（command-tree-rules.ts）是唯一例外，前端有一份鏡像
  // （frontend/.../command-rules.ts），由 tests/behavior-command-rules-mirror.test.ts
  // 釘住兩邊一致（見 architecture.md）。送出後一律仍由這裡把關。

  server.get("/api/behaviors/schema", async (_request, reply) => {
    return reply.send({
      messageTrigger: createMessageTriggerSchema,
      command: createCommandSchema,
      commandLeaf: addLeafSchema,
      loginTrigger: loginTriggerSchema,
    });
  });

  // ── BH-6.2：test-fire ───────────────────────────────────────────────────────
  // 對 behavior 的 webhook 動作發一發測試 payload（_meta.test=true），把結果
  // 直接回給 admin —— 「裝好了有沒有通」從猜變成按一下。不改任何狀態、
  // 不 relay 到任何頻道、不計入統計。
  //
  // #101：測試請求不能被當成真的使用者 —— 以獨立的簽章前綴 / token header
  // 送出（WebhookForwarder 的 test 選項），且不帶任何真實身分：_meta.user
  // 是固定的佔位使用者，不是按下按鈕的管理員。

  server.post(
    "/api/behaviors/:id/test",
    { schema: { params: idParams } },
    async (request, reply) => {
      const numId = parseRowId(request.params);
      const row = await BehaviorDefinition.findByPk(numId);
      if (!row) {
        throw new BehaviorApiError("not_found", `behavior ${numId} does not exist`);
      }
      const behavior = rowOfBehaviorDefinition(row);
      const action = await BehaviorWebhookAction.findByPk(numId);
      if (behavior.actionSource !== "webhook" || !action) {
        throw new BehaviorApiError(
          "validation_failed",
          "this behavior has no webhook action to test (the system behavior runs a built-in action)",
        );
      }
      // injected (runtime.ts builds the one WebhookForwarder): behavior
      // holds only command-system types, so the module edge stays one-way
      const forwarder = options.forwarder;
      if (!forwarder) throw new Error("WebhookForwarder not provided to behavior routes");
      const payload = {
        content: "(test fire from admin UI)",
        username: "karyl-admin-test",
        avatar_url: "",
        _meta: {
          test: true,
          behavior_id: behavior.id,
          user: TEST_FIRE_USER,
          // the keys a real trigger sends, so a receiver routes a test the
          // way it routes the real thing (a test matched no message, so no
          // groups; a leaf's own path)
          ...(behavior.triggerKind === "message"
            ? { captures: [] }
            : {
                sub_command_name: behavior.subcommand || null,
                sub_command_group: behavior.subcommandGroup || null,
              }),
        },
      };
      const result = await forwarder.forward(
        rowOfBehaviorWebhookAction(action),
        payload,
        { test: true },
      );
      // 回覆預覽（#140）：解析後的回覆與被規則改掉的部分，admin UI 依觸發
      // 種類顯示誰看得到。
      return reply.send({
        ok: result.ok,
        reply: result.reply,
        notes: result.notes,
        status: result.status ?? null,
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
        // which key verified the response's signature (null: unsigned)
        verified: result.verified ?? null,
      });
    },
  );
}

// ── audience group 成員管理（BH-1）─────────────────────────────────────────
//
// group 以名字為單位（訊息觸發的 audienceGroupName），名單存
// behavior_group_members，同名 group 的 behaviors 共享。group 沒有自己的
// 列：只有被訊息觸發引用的 group 能設名單，沒有觸發用了名單就清掉
// （behavior-group-member.model.ts），不會留下孤兒名單（#137）。

const groupParams = {
  type: "object",
  properties: { groupName: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["groupName"],
  additionalProperties: false,
} as const;

const MAX_GROUP_MEMBERS = 1000;

function groupNameOf(params: unknown): string {
  const groupName = (params as { groupName: string }).groupName.trim();
  if (!groupName) {
    throw new BehaviorApiError("validation_failed", "groupName is required", "groupName");
  }
  return groupName;
}

function registerGroupMemberRoutes(server: FastifyInstance): void {
  // GET /api/behavior-groups/:groupName/members
  server.get(
    "/api/behavior-groups/:groupName/members",
    { schema: { params: groupParams } },
    async (request, reply) => {
      const groupName = groupNameOf(request.params);
      const members = await findGroupMembers(groupName);
      return reply.send({ groupName, members });
    },
  );

  // PUT /api/behavior-groups/:groupName/members { userIds: string[] }
  // 全量替換（與 UI 的編輯-儲存模型一致；增/刪都走同一條）。
  // 沒有訊息觸發引用的 group → not_found：先把觸發的對象設成這個群組。
  server.put(
    "/api/behavior-groups/:groupName/members",
    {
      schema: {
        params: groupParams,
        body: {
          type: "object",
          properties: {
            userIds: { type: "array", maxItems: MAX_GROUP_MEMBERS, items: snowflake },
          },
          required: ["userIds"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const groupName = groupNameOf(request.params);
      const { userIds } = request.body as { userIds: string[] };
      await withBehaviorWriteLock(() =>
        behaviorTransaction(async (transaction) => {
          if (!(await groupInUse(groupName, transaction))) {
            throw new BehaviorApiError(
              "not_found",
              `no message trigger uses group '${groupName}'; set a trigger's audience to it first`,
              "groupName",
            );
          }
          await replaceGroupMembers(groupName, userIds, transaction);
        }),
      );
      const members = await findGroupMembers(groupName);
      await auditBehaviorWrite(request, "behavior.group_members.replace", `group:${groupName}`, {
        userIds: members,
      });
      botEventLog.record(
        "info",
        "bot",
        `behavior-group: '${groupName}' 成員更新為 ${members.length} 人`,
        { groupName, count: members.length, actor: request.authUserId ?? null },
      );
      return reply.send({ groupName, members });
    },
  );
}
