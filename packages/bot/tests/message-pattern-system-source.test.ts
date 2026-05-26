/**
 * Regression：admin 把 source='system' behavior 切到 triggerType='message_pattern'
 * 後，collectApplicableBehaviorsForUser 在 includeSystem=true 下要回傳這條 row；
 * 預設（/manual 列表用）仍要排除 system。
 *
 * 舊行為硬寫 source !== 'system'，導致使用者切換後行為沉默失效。
 */

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

import { sequelize } from "../src/db.js";
import { Behavior } from "../src/modules/behavior/models/behavior.model.js";
import { collectApplicableBehaviorsForUser } from "../src/modules/command-system/message-pattern-matcher.service.js";

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Behavior.destroy({ where: {} });
});

async function seedSystemMessagePattern(): Promise<void> {
  await Behavior.create({
    id: 100,
    title: "manual (message_pattern)",
    enabled: true,
    sortOrder: -999,
    stopOnMatch: true,
    forwardType: "one_time",
    source: "system",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "?manual",
    scope: "global",
    integrationTypes: "guild_install,user_install",
    contexts: "BotDM",
    audienceKind: "all",
    webhookUrl: null,
    webhookSecret: null,
    webhookAuthMode: null,
    systemKey: "manual",
    scopeTabId: 1,
  } as Record<string, unknown>);
}

async function seedCustomMessagePattern(): Promise<void> {
  await Behavior.create({
    id: 200,
    title: "custom ping",
    enabled: true,
    sortOrder: 0,
    stopOnMatch: true,
    forwardType: "one_time",
    source: "custom",
    triggerType: "message_pattern",
    messagePatternKind: "startswith",
    messagePatternValue: "!ping",
    scope: "global",
    integrationTypes: "guild_install",
    contexts: "BotDM,PrivateChannel",
    audienceKind: "all",
    webhookUrl: "http://example.invalid/hook",
    scopeTabId: 1,
  } as Record<string, unknown>);
}

describe("collectApplicableBehaviorsForUser — system source visibility", () => {
  it("excludes source='system' by default (preserves /manual list semantics)", async () => {
    await seedSystemMessagePattern();
    await seedCustomMessagePattern();
    const rows = await collectApplicableBehaviorsForUser("u1", {
      triggerType: "message_pattern",
    });
    expect(rows.map((r) => r.id)).toEqual([200]);
  });

  it("includes source='system' when includeSystem=true (MessagePatternMatcher path)", async () => {
    await seedSystemMessagePattern();
    await seedCustomMessagePattern();
    const rows = await collectApplicableBehaviorsForUser("u1", {
      triggerType: "message_pattern",
      includeSystem: true,
    });
    expect(rows.map((r) => r.id).sort()).toEqual([100, 200]);
  });

  it("still excludes system when triggerType is unspecified and includeSystem omitted", async () => {
    await seedSystemMessagePattern();
    const rows = await collectApplicableBehaviorsForUser("u1");
    expect(rows).toHaveLength(0);
  });
});
