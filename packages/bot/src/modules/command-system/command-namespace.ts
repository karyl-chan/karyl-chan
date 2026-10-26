/**
 * command-system/command-namespace.ts
 *
 * CommandNamespace：Discord 指令命名空間的衝突檢查。bot 的指令來自三處
 * —— 內建 in-process 指令、plugin_commands（軌一 guild feature + 軌三）、
 * behaviors（含停用的，停用只是暫時不註冊，名稱仍屬於它）—— 它們共用
 * Discord 的命名空間，同一目標內的名稱衝突要在存檔與註冊時拒絕（ADR 0003），
 * 不能讓後註冊的靜默覆蓋。
 *
 * 衝突規則見 command-target.ts targetsConflict：全域指令與任何同名指令衝突，
 * 只有指定在不同伺服器的兩個指令可以同名。
 *
 * 只回答「現在有沒有人佔用」；「某個名稱永遠保留」之類的政策（例如 plugin
 * 不能用 /login）由呼叫端自己加。
 */

import { Op } from "sequelize";
import {
  Behavior,
  rowOfBehavior,
} from "../behavior/models/behavior.model.js";
import {
  PluginCommand,
  pluginCommandScopeTarget,
  parsePluginCommandManifest,
} from "../plugin-system/models/plugin-command.model.js";
import { listInProcessCommandNames } from "../builtin-features/in-process-command-registry.service.js";
import {
  behaviorTarget,
  targetsConflict,
  type CommandTarget,
} from "./command-target.js";

export type NamespaceOwner =
  | { kind: "builtin" }
  | { kind: "plugin_command"; pluginId: number }
  | { kind: "behavior"; behaviorId: number };

/** 檢查時排除呼叫端自己的指令（重新註冊 / 編輯自己不算衝突）。 */
export type NamespaceExclude = { pluginId: number } | { behaviorId: number };

export type NamespaceCheck =
  | { ok: true }
  | {
      ok: false;
      conflict: { name: string; target: CommandTarget; owner: NamespaceOwner };
    };

interface NamespaceEntry {
  target: CommandTarget;
  owner: NamespaceOwner;
}

export class CommandNamespace {
  /**
   * `name` 在 `target` 是否可用。回傳第一個衝突（內建 → plugin → behavior
   * 的順序）。名稱比對不分大小寫（Discord 的 chat input 指令名一律小寫）。
   */
  async check(
    name: string,
    target: CommandTarget,
    exclude?: NamespaceExclude,
  ): Promise<NamespaceCheck> {
    const wanted = name.toLowerCase();
    for (const entry of await this.entriesNamed(wanted, exclude)) {
      if (targetsConflict(entry.target, target)) {
        return {
          ok: false,
          conflict: { name: wanted, target: entry.target, owner: entry.owner },
        };
      }
    }
    return { ok: true };
  }

  private async entriesNamed(
    name: string,
    exclude?: NamespaceExclude,
  ): Promise<NamespaceEntry[]> {
    const entries: NamespaceEntry[] = [];

    // 內建：guild 指令依 feature 開關逐伺服器註冊，可能出現在任何伺服器
    for (const cmd of listInProcessCommandNames()) {
      if (cmd.name.toLowerCase() !== name) continue;
      entries.push({
        // 同 pluginCommandScopeTarget 的對照：guild = 依開關逐伺服器註冊
        target: cmd.scope === "guild" ? "all_guilds" : "global",
        owner: { kind: "builtin" },
      });
    }

    // plugin_commands：軌三依 manifest scope；軌一 guild feature 指令依每個
    // 伺服器的開關註冊，可能出現在任何伺服器 → all_guilds
    const excludePluginId =
      exclude && "pluginId" in exclude ? exclude.pluginId : null;
    const pluginRows = await PluginCommand.findAll({
      where: {
        name,
        ...(excludePluginId !== null
          ? { pluginId: { [Op.ne]: excludePluginId } }
          : {}),
      },
    });
    for (const r of pluginRows) {
      const pluginId = r.getDataValue("pluginId") as number;
      const featureKey = r.getDataValue("featureKey") as string | null;
      let target: CommandTarget;
      if (featureKey !== null) {
        // 刻意不用 pluginCommandRowTarget（那是這一列「現在」註冊在哪個
        // 伺服器）：命名空間看的是它「可能」出現的範圍 —— 任何開了這個
        // feature 的伺服器。
        target = "all_guilds";
      } else {
        // manifest 解析失敗時保守視為全域（與所有同名指令衝突）
        const manifest = parsePluginCommandManifest(
          r.getDataValue("manifestJson") as string,
        );
        target = pluginCommandScopeTarget(manifest?.scope);
      }
      entries.push({ target, owner: { kind: "plugin_command", pluginId } });
    }

    // behaviors：所有指令觸發的列，含停用的
    const excludeBehaviorId =
      exclude && "behaviorId" in exclude ? exclude.behaviorId : null;
    const behaviorRows = await Behavior.findAll({
      where: {
        triggerType: "slash_command",
        slashCommandName: name,
        ...(excludeBehaviorId !== null
          ? { id: { [Op.ne]: excludeBehaviorId } }
          : {}),
      },
    });
    for (const model of behaviorRows) {
      const row = rowOfBehavior(model);
      entries.push({
        target: behaviorTarget(row),
        owner: { kind: "behavior", behaviorId: row.id },
      });
    }

    return entries;
  }
}
