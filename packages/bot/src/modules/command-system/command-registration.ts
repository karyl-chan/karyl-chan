/**
 * command-system/command-registration.ts
 *
 * 純函式：把一個指令定義組成 Discord 註冊資料（deriveRegistrationCall），
 * 以及判斷 Discord 現況是否需要 patch（commandNeedsPatch）。
 * 不碰 Discord / DB；reconciler 與 DesiredCommandSource adapters 共用。
 */

import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type ApplicationCommandData,
  type ApplicationCommand,
} from "discord.js";
import type {
  DiscordContext,
  DiscordIntegrationType,
  DiscordRegistrationSpec,
} from "./types.js";
import { RejectionError } from "./types.js";
import type { ManifestCommandOption } from "../plugin-system/plugin-registry.service.js";
import { manifestOptionToData } from "../plugin-system/plugin-command-registry.service.js";
import { targetDiscordScope, type CommandTarget } from "./command-target.js";

// ── Discord 三軸對照表 ────────────────────────────────────────────────────────

const CONTEXT_MAP: Record<DiscordContext, InteractionContextType> = {
  Guild: InteractionContextType.Guild,
  BotDM: InteractionContextType.BotDM,
  PrivateChannel: InteractionContextType.PrivateChannel,
};

const INTEGRATION_MAP: Record<
  DiscordIntegrationType,
  ApplicationIntegrationType
> = {
  guild_install: ApplicationIntegrationType.GuildInstall,
  user_install: ApplicationIntegrationType.UserInstall,
};

// ── 輔助：三軸 → 型別化陣列 ─────────────────────────────────────────────────

/** behaviors 表存逗號字串、manifest 存陣列；兩者都過濾掉不認得的值。 */
function splitAxis(raw: string | readonly string[]): string[] {
  return (typeof raw === "string" ? raw.split(",") : [...raw]).map((s) =>
    s.trim(),
  );
}

export function parseContexts(
  raw: string | readonly string[],
): DiscordContext[] {
  return splitAxis(raw).filter(
    (s): s is DiscordContext =>
      s === "Guild" || s === "BotDM" || s === "PrivateChannel",
  );
}

export function parseIntegrationTypes(
  raw: string | readonly string[],
): DiscordIntegrationType[] {
  return splitAxis(raw).filter(
    (s): s is DiscordIntegrationType =>
      s === "guild_install" || s === "user_install",
  );
}

// ── 指令定義（deriveRegistrationCall 的輸入）─────────────────────────────────

export interface CommandLocalizations {
  description_localizations?: Record<string, string>;
  name_localizations?: Record<string, string>;
}

/**
 * 指令底下一個可呼叫的路徑（Command Leaf）。
 *   - path []        根葉節點：指令本身可呼叫，options 是指令的參數
 *   - path [sub]     子指令
 *   - path [g, sub]  子指令群組 —— 路徑預留，第一階段不支援（ADR 0003）
 * 根葉節點的 description 不送 Discord（根指令的說明屬於指令本身）。
 */
export interface CommandLeafDefinition {
  path: string[];
  description: string;
  localizations?: CommandLocalizations;
  /** 葉節點的參數；只能是一般參數，不能再含 sub_command / sub_command_group。 */
  options?: ManifestCommandOption[];
}

/**
 * 一個 Discord 指令（Command）的定義：名稱、說明與可見性設定。
 * 指令的內容二選一：
 *   - leaves：葉節點組成的樹（behavior；S3 由指令容器 + 葉節點表供給）
 *   - options：直接給整份 options（軌三 plugin 在 manifest 裡自己寫的樹）
 * 兩者都省略 = 沒有參數的單一指令。
 */
export interface CommandDefinition {
  name: string;
  description: string;
  integrationTypes: DiscordIntegrationType[];
  contexts: DiscordContext[];
  leaves?: CommandLeafDefinition[];
  options?: ManifestCommandOption[];
  localizations?: CommandLocalizations;
  /**
   * Discord permission bitfield（十進位字串，例如 "32" = ManageGuild）。
   * null / 省略 = 不限制（所有成員可見）。Discord 在私訊與使用者安裝情境
   * 下會忽略它。
   */
  defaultMemberPermissions?: string | null;
}

// ── deriveRegistrationCall（C-runtime §3.3 三軸 → Discord 登記形狀）──────────

/**
 * 依目標 + 三軸計算 Discord API call shape。
 * 對齊 C-runtime §3.3 的合法組合（含 #8 非法修正）；非法組合丟 RejectionError。
 * `guild:<id>` 與 `all_guilds` 在 Discord 端都是伺服器指令，規則相同。
 */
export function deriveRegistrationCall(
  def: CommandDefinition,
  target: CommandTarget,
): DiscordRegistrationSpec {
  const { integrationTypes, contexts } = def;
  // 非法組合檢查（C-runtime §3.3 底部非法清單）
  if (integrationTypes.length === 0) {
    throw new RejectionError("integrationTypes 不得為空");
  }
  if (contexts.length === 0) {
    throw new RejectionError("contexts 不得為空");
  }
  if (targetDiscordScope(target) === "guild") {
    if (integrationTypes.includes("user_install")) {
      throw new RejectionError("伺服器指令（guild 目標）不支援 user_install");
    }
    // M-8 修：伺服器指令 + 含 BotDM 為非法
    if (contexts.some((c) => c !== "Guild")) {
      throw new RejectionError(
        "伺服器指令（guild 目標）的 contexts 只能包含 Guild（BotDM/PrivateChannel 非法）",
      );
    }
  }

  const data: Record<string, unknown> = {
    type: ApplicationCommandType.ChatInput,
    name: def.name,
    description: def.description,
  };

  // Discord's per-locale picker overrides. Map snake_case (manifest /
  // wire shape) → camelCase (discord.js ApplicationCommandData).
  if (def.localizations?.description_localizations) {
    data["descriptionLocalizations"] =
      def.localizations.description_localizations;
  }
  if (def.localizations?.name_localizations) {
    data["nameLocalizations"] = def.localizations.name_localizations;
  }

  // 一律帶上（未設定時為 null）：discord.js 的 edit 會略過 undefined 欄位，
  // 只有明確送 null 才能把先前的限制拿掉。
  data["defaultMemberPermissions"] = def.defaultMemberPermissions ?? null;

  data["contexts"] = contexts.map((c) => CONTEXT_MAP[c]);
  data["integrationTypes"] = integrationTypes.map((t) => INTEGRATION_MAP[t]);
  if (def.leaves && def.options) {
    throw new RejectionError("leaves 與 options 不能同時指定");
  }
  const options = def.leaves ? buildLeafOptions(def.leaves) : def.options;
  if (options && options.length > 0) {
    data["options"] = options.map(manifestOptionToData);
  }

  return {
    target,
    data: data as unknown as ApplicationCommandData,
  };
}

// ── 子指令樹 ────────────────────────────────────────────────────────────────

/** Discord 每層最多 25 個 options（子指令也算）。 */
const MAX_SUBCOMMANDS = 25;

/**
 * 葉節點 → 指令的 options（manifest 形狀，再由 manifestOptionToData 轉成
 * discord.js 資料）。根葉節點回傳它自己的參數；子指令葉節點各成一個
 * sub_command option。違反 Discord 結構規則時丟 RejectionError。
 */
function buildLeafOptions(
  leaves: CommandLeafDefinition[],
): ManifestCommandOption[] {
  if (leaves.length === 0) {
    throw new RejectionError("指令至少要有一個葉節點");
  }
  const seen = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.path.length > 1) {
      throw new RejectionError(
        `子指令群組尚未支援（路徑 ${leaf.path.join(" ")}）`,
      );
    }
    if (leaf.path.some((p) => p.length === 0)) {
      throw new RejectionError("葉節點路徑不能有空白段");
    }
    const key = leaf.path.join(" ");
    if (seen.has(key)) {
      throw new RejectionError(`葉節點路徑重複：${key || "（根）"}`);
    }
    seen.add(key);
    const nested = (leaf.options ?? []).find(
      (o) => o.type === "sub_command" || o.type === "sub_command_group",
    );
    if (nested) {
      throw new RejectionError(
        `葉節點的參數不能是子指令（${nested.name}）；子指令請用葉節點路徑表達`,
      );
    }
  }

  const root = leaves.find((l) => l.path.length === 0);
  if (root) {
    // Discord：有子指令時根指令不能呼叫，所以根葉節點與子指令不並存
    if (leaves.length > 1) {
      throw new RejectionError("根葉節點與子指令不能並存");
    }
    return root.options ?? [];
  }
  if (leaves.length > MAX_SUBCOMMANDS) {
    throw new RejectionError(`子指令最多 ${MAX_SUBCOMMANDS} 個`);
  }
  return leaves.map((leaf) => ({
    type: "sub_command",
    name: leaf.path[0]!,
    description: leaf.description,
    ...(leaf.localizations?.description_localizations
      ? { description_localizations: leaf.localizations.description_localizations }
      : {}),
    ...(leaf.localizations?.name_localizations
      ? { name_localizations: leaf.localizations.name_localizations }
      : {}),
    options: leaf.options ?? [],
  }));
}

// ── commandNeedsPatch（Discord 現況 vs desired）──────────────────────────────

/**
 * Canonical JSON for options comparison.
 * Projects each option (and nested sub-command options) to a stable
 * {type, name, description, required, options} shape, sorts sibling
 * arrays by name, then serialises to JSON.
 * Used for both the desired side (ApplicationCommandOptionData[]) and
 * the existing side (ApplicationCommandOption[] from Discord's cache).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canonicalOptions(options: any[]): string {
  type CanonicalOption = {
    type: number;
    name: string;
    description: string;
    required: boolean;
    choices?: unknown[];
    channel_types?: number[];
    min_value?: number | null;
    max_value?: number | null;
    autocomplete?: boolean;
    description_localizations?: Record<string, string>;
    name_localizations?: Record<string, string>;
    options?: CanonicalOption[];
  };
  // Discord returns localization maps under snake_case (REST shape) but
  // discord.js camelCases them on `ApplicationCommandOption`. Read both
  // so the diff catches localization-only changes whether the desired
  // side originated from a JS literal (camelCase) or the wire (snake).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sortedLocalizationMap(raw: any): Record<string, string> | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const entries = Object.entries(raw as Record<string, string>);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function project(o: any): CanonicalOption {
    const node: CanonicalOption = {
      type: o.type as number,
      name: o.name as string,
      description: (o.description as string | undefined) ?? "",
      required: (o.required as boolean | undefined) ?? false,
      choices: o.choices ?? [],
      channel_types: o.channel_types ?? o.channelTypes ?? [],
      min_value: o.min_value ?? o.minValue ?? null,
      max_value: o.max_value ?? o.maxValue ?? null,
      autocomplete: o.autocomplete ?? false,
    };
    const descLoc = sortedLocalizationMap(
      o.description_localizations ?? o.descriptionLocalizations,
    );
    if (descLoc) node.description_localizations = descLoc;
    const nameLoc = sortedLocalizationMap(
      o.name_localizations ?? o.nameLocalizations,
    );
    if (nameLoc) node.name_localizations = nameLoc;
    if (Array.isArray(o.options) && o.options.length > 0) {
      node.options = (o.options as unknown[])
        .map(project)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return node;
  }
  return JSON.stringify(
    options.map(project).sort((a, b) => a.name.localeCompare(b.name)),
  );
}

function canonicalPermissions(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return BigInt(raw).toString();
  }
  // 其他形狀（PermissionsBitField 等）不該出現在 desired 端；
  // 當成不同值，寧可多 patch 一次也不要漏掉權限變更。
  return String(raw);
}

export function commandNeedsPatch(
  existing: ApplicationCommand,
  desired: ApplicationCommandData,
): boolean {
  // 比對 description
  const existDesc = "description" in existing ? existing.description : "";
  const desiredDesc =
    "description" in desired
      ? ((desired as { description?: string }).description ?? "")
      : "";
  if (existDesc !== desiredDesc) return true;

  // 比對 top-level description_localizations / name_localizations.
  // discord.js's ApplicationCommand carries them as camelCase
  // (`descriptionLocalizations`); the desired side (our manifest data)
  // uses camelCase too. Compare via sorted-keys canonical JSON.
  const canonLocMap = (raw: unknown): string => {
    if (!raw || typeof raw !== "object") return "";
    const entries = Object.entries(raw as Record<string, string>);
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
  };
  const existDescLoc = (existing as { descriptionLocalizations?: unknown })
    .descriptionLocalizations;
  const desiredDescLoc = (desired as { descriptionLocalizations?: unknown })
    .descriptionLocalizations;
  if (canonLocMap(existDescLoc) !== canonLocMap(desiredDescLoc)) return true;
  const existNameLoc = (existing as { nameLocalizations?: unknown })
    .nameLocalizations;
  const desiredNameLoc = (desired as { nameLocalizations?: unknown })
    .nameLocalizations;
  if (canonLocMap(existNameLoc) !== canonLocMap(desiredNameLoc)) return true;

  // 比對 contexts — numeric enum values, so sort numerically (both sides
  // identically) before joining, otherwise the canonical strings can
  // differ purely from JS's default lexicographic Array.sort().
  const byNumber = (a: number, b: number): number => a - b;
  const existCtxSorted = (existing.contexts ?? [])
    .slice()
    .sort(byNumber)
    .join(",");
  const desiredCtx =
    (desired as { contexts?: InteractionContextType[] }).contexts ?? [];
  const desiredCtxSorted = desiredCtx.slice().sort(byNumber).join(",");
  if (existCtxSorted !== desiredCtxSorted) return true;

  // 比對 integrationTypes — likewise numeric enum values.
  const existItSorted = (existing.integrationTypes ?? [])
    .slice()
    .sort(byNumber)
    .join(",");
  const desiredIt =
    (desired as { integrationTypes?: ApplicationIntegrationType[] })
      .integrationTypes ?? [];
  const desiredItSorted = desiredIt.slice().sort(byNumber).join(",");
  if (existItSorted !== desiredItSorted) return true;

  // 比對 defaultMemberPermissions。Discord 現況是 PermissionsBitField | null；
  // desired 是 bitfield 字串 / bigint / null。兩側都轉成十進位字串（或 null）。
  if (
    canonicalPermissions(
      (existing as { defaultMemberPermissions?: { bitfield: bigint } | null })
        .defaultMemberPermissions?.bitfield,
    ) !==
    canonicalPermissions(
      (desired as { defaultMemberPermissions?: unknown })
        .defaultMemberPermissions,
    )
  ) {
    return true;
  }

  // 比對 options（sub_command / 參數定義）
  // Discord cache 的 existing.options 是 ApplicationCommandOption[]；
  // desired.options 是 ApplicationCommandOptionData[]。
  // 兩側都序列化成 canonical JSON 再比對，避免嵌套 sub_command stale。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existOptions: any[] = (existing as any).options ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desiredOptions: any[] = (desired as any).options ?? [];
  if (canonicalOptions(existOptions) !== canonicalOptions(desiredOptions)) {
    return true;
  }

  return false;
}
