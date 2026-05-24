import { DataTypes, Op } from "sequelize";
import { sequelize } from "../../../db.js";

/**
 * reconciler_owned_commands — CommandReconciler 的「管理名冊」。
 *
 * 記錄由 reconciler 負責的 Discord 指令，防止 reconcile diff 誤刪軌一
 * in-process 指令或 plugin guild_features.commands。
 *
 * 欄位（M0-FROZEN §1.3 + C-runtime OQ-3）：
 *   name     TEXT NOT NULL     — Discord 指令名稱
 *   scope    ENUM NOT NULL     — 'global' 或 'guild'（Discord 登記作用域）
 *   guildId  TEXT NULL         — scope='guild' 時填 guild ID；scope='global' 時 NULL
 *   ownedAt  DATETIME NOT NULL — 首次登記時間戳
 *
 * 此表的讀寫一律經由此 model（reconcile.service.ts 的名冊操作）。
 * sync() 依此 model 建表，取代原本由 migration 建表的職責。
 *
 * 原 DDL 無 primary key；define() 後呼叫 removeAttribute("id") 移除
 * Sequelize 預設補上的 id 欄，使 sync() 產出的 schema 與原 DDL 一致。
 * 名冊操作只用 findAll / create / destroy(where)，不需要 PK。
 *
 * 跨欄位 CHECK invariant（原 DDL 的 table-level CHECK）無法由 Sequelize
 * 欄位定義表達，下放為 model-level validate 函式；因所有寫入都經 create()，
 * 此 validate 會在每次新增時觸發。
 */
export const ReconcilerOwnedCommand = sequelize.define(
  "ReconcilerOwnedCommand",
  {
    name: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    scope: {
      // ENUM → sync() 發出 CHECK(scope IN ('global','guild'))
      type: DataTypes.ENUM("global", "guild"),
      allowNull: false,
    },
    guildId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ownedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: "reconciler_owned_commands",
    timestamps: false,
    indexes: [
      {
        // global 指令唯一性：partial UNIQUE index 只看 global / NULL 列，
        // 避開 SQLite UNIQUE 中 NULL != NULL 的語意洞。
        name: "reconciler_owned_global_uq",
        unique: true,
        fields: ["name"],
        where: { scope: "global", guildId: { [Op.is]: null } },
      },
      {
        // guild 指令唯一性：相同名稱不得在同一 guild 登記兩次。
        name: "reconciler_owned_guild_uq",
        unique: true,
        fields: ["name", "guildId"],
        where: { scope: "guild" },
      },
    ],
    // 跨欄位 CHECK invariant（app-level downgrade —— DB 不再強制）：
    //   (scope='global' AND guildId IS NULL)
    //   OR (scope='guild' AND guildId IS NOT NULL)
    validate: {
      scopeGuildShape(this: { scope?: string; guildId?: string | null }) {
        const ok =
          (this.scope === "global" && this.guildId == null) ||
          (this.scope === "guild" && this.guildId != null);
        if (!ok) {
          throw new Error(
            "reconciler_owned_commands: scope='global' requires guildId NULL; scope='guild' requires guildId set",
          );
        }
      },
    },
  },
);

// 原 DDL 無 primary key —— 移除 Sequelize 預設補上的 id 欄，
// 使 sync() 產出的 schema 與原 DDL 一致。名冊操作不需要 PK。
ReconcilerOwnedCommand.removeAttribute("id");
