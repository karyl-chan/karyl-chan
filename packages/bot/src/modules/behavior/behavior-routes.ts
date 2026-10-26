/**
 * behavior-routes.ts — admin behaviors REST API（ADR 0003 trigger/action 模型）
 *
 * 路由表：
 *   GET  /api/behaviors                          — { system, commands, messageTriggers }
 *   POST /api/behaviors/:id/test                 — 對 behavior 的 webhook 動作試發
 *   POST / PATCH / DELETE /api/behaviors[/:id]   — 訊息觸發的寫入（behavior-write-routes.ts）
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
import { WebhookForwarder } from "../command-system/webhook-forwarder.service.js";
import {
  findGroupMembers,
  replaceGroupMembers,
} from "./models/behavior-group-member.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import {
  BehaviorApiError,
  installBehaviorRouteValidation,
} from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { registerBehaviorWriteRoutes } from "./behavior-write-routes.js";
import { idParams, parseRowId, snowflake } from "./behavior-schemas.js";

export type { BehaviorRoutesOptions };

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
    registerBehaviorWriteRoutes(scope);
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

  // ── BH-6.2：test-fire ───────────────────────────────────────────────────────
  // 對 behavior 的 webhook 動作發一發測試 payload（_meta.test=true），把結果
  // 直接回給 admin —— 「裝好了有沒有通」從猜變成按一下。不改任何狀態、
  // 不 relay 到任何頻道、不計入統計。

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
      const forwarder = options.forwarder ?? new WebhookForwarder();
      const payload = {
        content: "(test fire from admin UI)",
        username: "karyl-admin-test",
        avatar_url: "",
        _meta: {
          test: true,
          behavior_id: behavior.id,
          user: {
            id: request.authUserId ?? "admin",
            username: "admin-test",
            global_name: null,
            discriminator: "0",
            avatar: null,
          },
        },
      };
      const result = await forwarder.forward(
        rowOfBehaviorWebhookAction(action),
        payload,
      );
      return reply.send({
        ok: result.ok,
        relayContent: result.relayContent,
        relayEmbeds: result.relayEmbeds ?? [],
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
      });
    },
  );
}

// ── audience group 成員管理（BH-1）─────────────────────────────────────────
//
// group 以名字為單位（訊息觸發的 audienceGroupName），名單存
// behavior_group_members，同名 group 的 behaviors 共享。

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
      await replaceGroupMembers(groupName, userIds);
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
