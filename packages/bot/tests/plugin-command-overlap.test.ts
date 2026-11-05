/**
 * #142：findPluginCommandForInvocation 在多列涵蓋同一次呼叫時的 warn。
 *  - 用 shouldRecord 去重：同一個名稱 + 呼叫位置在視窗內只記一次，換一個
 *    commandGuildId 會再記。
 *  - 訊息列出每個候選列的 plugin、列 id 與種類（feature 指令帶 featureKey、
 *    軌三帶 scope），同一個 plugin 時寫明是它自己同時宣告。
 *
 * 這些重疊在註冊時就會被擋下（同一個 plugin 跨種類同名由 manifest 協定、
 * 不同 plugin 撞名由 CommandNamespace），這裡直接種列，模擬既有資料。
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import { sequelize } from "../src/db.js";
import {
  PluginCommand,
  findPluginCommandForInvocation,
} from "../src/modules/plugin-system/models/plugin-command.model.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";

const record = vi.mocked(botEventLog.record);

async function seedFeatureRow(
  pluginId: number,
  name: string,
  guildId: string,
  featureKey: string,
): Promise<number> {
  const row = await PluginCommand.create({
    pluginId,
    guildId,
    name,
    featureKey,
    manifestJson: JSON.stringify({ name, description: name }),
  } as Record<string, unknown>);
  return row.getDataValue("id") as number;
}

async function seedTrack3Row(
  pluginId: number,
  name: string,
  scope: "global" | "guild",
): Promise<number> {
  const row = await PluginCommand.create({
    pluginId,
    guildId: null,
    name,
    featureKey: null,
    manifestJson: JSON.stringify({
      name,
      description: name,
      scope,
      integration_types: ["guild_install"],
      contexts: ["Guild"],
    }),
  } as Record<string, unknown>);
  return row.getDataValue("id") as number;
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  record.mockClear();
  await PluginCommand.destroy({ where: {} });
});

// 去重狀態跨測試保留（模組層級），所以每個測試用自己的指令名稱。
describe("findPluginCommandForInvocation — overlapping rows", () => {
  it("warns once per name and invocation site, again for another guild", async () => {
    await seedFeatureRow(7, "dedup", "g1", "x");
    await seedFeatureRow(7, "dedup", "g2", "x");
    await seedTrack3Row(7, "dedup", "guild");

    await findPluginCommandForInvocation("dedup", "g1");
    await findPluginCommandForInvocation("dedup", "g1");
    expect(record).toHaveBeenCalledTimes(1);

    await findPluginCommandForInvocation("dedup", "g2");
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("names one plugin declaring both kinds as that plugin's own clash", async () => {
    const featureId = await seedFeatureRow(7, "same", "g1", "x");
    const track3Id = await seedTrack3Row(7, "same", "guild");

    const row = await findPluginCommandForInvocation("same", "g1");

    expect(row?.id).toBe(featureId);
    expect(record).toHaveBeenCalledWith(
      "warn",
      "bot",
      `plugin-commands: /same（commandGuildId=g1）有 2 列涵蓋同一次呼叫，` +
        `都是同一個 plugin 7 同時宣告的：` +
        `列 ${featureId}（plugin 7，feature 指令 x）、` +
        `列 ${track3Id}（plugin 7，軌三 scope=guild）；選用列 ${featureId}`,
      {
        cmd: "same",
        commandGuildId: "g1",
        candidates: [
          { id: featureId, pluginId: 7, kind: "feature", featureKey: "x" },
          { id: track3Id, pluginId: 7, kind: "plugin_command", featureKey: null },
        ],
      },
    );
  });

  it("names every plugin when the rows come from different plugins", async () => {
    const firstId = await seedTrack3Row(7, "cross", "global");
    const secondId = await seedTrack3Row(8, "cross", "global");

    const row = await findPluginCommandForInvocation("cross", null);

    expect(row?.id).toBe(firstId);
    expect(record).toHaveBeenCalledWith(
      "warn",
      "bot",
      `plugin-commands: /cross（commandGuildId=global）有 2 列涵蓋同一次呼叫，` +
        `來自 2 個 plugin：` +
        `列 ${firstId}（plugin 7，軌三 scope=global）、` +
        `列 ${secondId}（plugin 8，軌三 scope=global）；選用列 ${firstId}`,
      expect.objectContaining({ commandGuildId: null }),
    );
  });
});
