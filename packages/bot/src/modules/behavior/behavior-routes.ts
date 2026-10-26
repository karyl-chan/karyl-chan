/**
 * behavior-routes.ts — admin behaviors REST API（ADR 0003 trigger/action 模型）
 *
 * 路由表：
 *   GET  /api/behaviors                          — { system, commands, messageTriggers }
 *   POST /api/behaviors/:id/test                 — 對 behavior 的 webhook 動作試發
 *   GET  /api/behavior-groups/:groupName/members — 群組名單
 *   PUT  /api/behavior-groups/:groupName/members — 全量替換群組名單
 *
 * 寫入路由（新增 / 修改 / 刪除 / 排序 / resync）在 S4（#136）以新模型重新
 * 提供；這個切片的 admin UI 是唯讀的。
 *
 * 權限：requireBehaviorAdmin（behavior.manage 或 admin）。
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

export type { BehaviorRoutesOptions };

export async function registerBehaviorRoutes(
  server: FastifyInstance,
  options: BehaviorRoutesOptions = {},
): Promise<void> {
  // ── GET /api/behaviors ──────────────────────────────────────────────────────

  server.get("/api/behaviors", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;
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

  server.post("/api/behaviors/:id/test", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const numId = parseInt(id, 10);
    if (isNaN(numId)) {
      return reply.code(400).send({ error: "無效的 behavior ID" });
    }
    const row = await BehaviorDefinition.findByPk(numId);
    if (!row) {
      return reply.code(404).send({ error: "Behavior 不存在" });
    }
    const behavior = rowOfBehaviorDefinition(row);
    const action = await BehaviorWebhookAction.findByPk(numId);
    if (behavior.actionSource !== "webhook" || !action) {
      return reply
        .code(400)
        .send({ error: "這個 behavior 沒有 webhook 動作可測（系統行為走內建動作）" });
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
  });

  // ── audience group 成員管理（BH-1）─────────────────────────────────────────
  //
  // group 以名字為單位（訊息觸發的 audienceGroupName），名單存
  // behavior_group_members，同名 group 的 behaviors 共享。

  // GET /api/behavior-groups/:groupName/members
  server.get("/api/behavior-groups/:groupName/members", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;
    const groupName = decodeURIComponent(
      (request.params as { groupName: string }).groupName,
    ).trim();
    if (!groupName) {
      return reply.code(400).send({ error: "groupName 為必填" });
    }
    const members = await findGroupMembers(groupName);
    return reply.send({ groupName, members });
  });

  // PUT /api/behavior-groups/:groupName/members { userIds: string[] }
  // 全量替換（與 UI 的編輯-儲存模型一致；增/刪都走同一條）。
  server.put("/api/behavior-groups/:groupName/members", async (request, reply) => {
    if (!requireBehaviorAdmin(request, reply)) return;
    const groupName = decodeURIComponent(
      (request.params as { groupName: string }).groupName,
    ).trim();
    if (!groupName || groupName.length > 200) {
      return reply.code(400).send({ error: "groupName 為必填（max 200）" });
    }
    const body = request.body as { userIds?: unknown };
    if (!Array.isArray(body?.userIds)) {
      return reply.code(400).send({ error: "userIds 為必填陣列" });
    }
    if (body.userIds.length > 1000) {
      return reply.code(400).send({ error: "userIds 過長 (max 1000)" });
    }
    const userIds: string[] = [];
    for (const raw of body.userIds) {
      if (typeof raw !== "string") {
        return reply.code(400).send({ error: "userIds 必須是字串陣列" });
      }
      const id = raw.trim();
      if (!id) continue;
      if (!/^\d{5,25}$/.test(id)) {
        return reply
          .code(400)
          .send({ error: `無效的 user id：${id.slice(0, 30)}` });
      }
      userIds.push(id);
    }
    await replaceGroupMembers(groupName, userIds);
    const members = await findGroupMembers(groupName);
    botEventLog.record(
      "info",
      "bot",
      `behavior-group: '${groupName}' 成員更新為 ${members.length} 人`,
      { groupName, count: members.length, actor: request.authUserId ?? null },
    );
    return reply.send({ groupName, members });
  });
}
