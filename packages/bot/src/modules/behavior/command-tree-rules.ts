/**
 * Discord's rules for a Command and its Command Leaves (ADR 0003, #97),
 * checked on the state a write would leave — before anything is stored or
 * sent to Discord. Pure; refusals are thrown as BehaviorApiError.
 *
 * Settings (validation_failed):
 *   - a guild command lives in one guild: guildId set, contexts exactly
 *     [Guild], installed by the guild only (Discord's rule for guild
 *     commands); a global command has no guildId
 *
 * Leaves:
 *   - options: ≤ 25, unique names, required ones before optional ones
 *     (names / descriptions / types are the request schema's job)
 *   - ≤ 25 subcommands (validation_failed)
 *   - the root leaf and subcommands never coexist; one leaf per path
 *     (invalid_tree)
 *   - the whole command — names, descriptions, options — ≤ 8000
 *     characters (validation_failed)
 *
 * Disabled leaves count everywhere: re-enabling one must not break the
 * command.
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import type { BehaviorCommandRegistration } from "./models/behavior-command.model.js";
import type { BehaviorCommandOption } from "./models/behavior-definition.model.js";

export const MAX_SUBCOMMANDS = 25;
export const MAX_OPTIONS = 25;
export const MAX_COMMAND_CHARS = 8000;

/** Names the system login may take when its trigger becomes a command (S7). */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(["login"]);

export interface CommandSettings {
  name: string;
  description: string;
  registration: BehaviorCommandRegistration;
  guildId: string | null;
  integrationTypes: readonly string[];
  contexts: readonly string[];
}

export interface LeafShape {
  subcommand: string;
  title: string;
  leafDescription: string | null;
  options: readonly BehaviorCommandOption[];
}

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

/** `prefix.child`, or just `child` when the prefix is empty. */
export function joinField(prefix: string, child: string): string {
  return prefix ? `${prefix}.${child}` : child;
}

export function checkCommandSettings(c: CommandSettings): void {
  if (c.registration === "guild") {
    if (c.guildId === null) refuse("guildId", "a guild command needs its guildId");
    if (c.contexts.length !== 1 || c.contexts[0] !== "Guild") {
      refuse("contexts", "a guild command can only be used in its guild (contexts: [Guild])");
    }
    if (c.integrationTypes.length !== 1 || c.integrationTypes[0] !== "guild_install") {
      refuse(
        "integrationTypes",
        "a guild command is installed by the guild only (integrationTypes: [guild_install])",
      );
    }
  } else if (c.guildId !== null) {
    refuse("guildId", "a global command has no guildId");
  }
}

export function checkLeafOptions(
  options: readonly BehaviorCommandOption[],
  field: string,
): void {
  if (options.length > MAX_OPTIONS) {
    refuse(field, `a command or subcommand takes at most ${MAX_OPTIONS} options`);
  }
  const seen = new Set<string>();
  let sawOptional = false;
  options.forEach((option, i) => {
    if (seen.has(option.name)) {
      refuse(joinField(field, `${i}.name`), `option '${option.name}' appears twice`);
    }
    seen.add(option.name);
    if (option.required && sawOptional) {
      refuse(joinField(field, `${i}.required`), "required options come before optional ones");
    }
    if (!option.required) sawOptional = true;
  });
}

/** Discord's description of a subcommand leaf: its own, else its title. */
export function leafDiscordDescription(leaf: Pick<LeafShape, "leafDescription" | "title">): string {
  return leaf.leafDescription || leaf.title;
}

/** Characters Discord counts toward the 8000 limit. */
export function commandCharCount(
  command: Pick<CommandSettings, "name" | "description">,
  leaves: readonly LeafShape[],
): number {
  let total = command.name.length + command.description.length;
  for (const leaf of leaves) {
    if (leaf.subcommand !== "") {
      total += leaf.subcommand.length + leafDiscordDescription(leaf).length;
    }
    for (const option of leaf.options) {
      total += option.name.length + option.description.length;
    }
  }
  return total;
}

/**
 * The leaf tree. `fieldOf(i)` is the field prefix of leaf i in a refusal:
 * `leaves.<i>` on create, `""` for the leaf a request edits (its own
 * fields are top-level there).
 */
export function checkCommandTree(
  command: Pick<CommandSettings, "name" | "description">,
  leaves: readonly LeafShape[],
  fieldOf: (index: number) => string = (i) => `leaves.${i}`,
): void {
  if (leaves.length === 0) refuse("leaves", "a command needs at least one leaf");
  leaves.forEach((leaf, i) => checkLeafOptions(leaf.options, joinField(fieldOf(i), "options")));

  const seen = new Set<string>();
  leaves.forEach((leaf, i) => {
    if (seen.has(leaf.subcommand)) {
      throw new BehaviorApiError(
        "invalid_tree",
        leaf.subcommand === ""
          ? "the command already has a root leaf"
          : `subcommand '${leaf.subcommand}' already exists`,
        joinField(fieldOf(i), "subcommand"),
      );
    }
    seen.add(leaf.subcommand);
  });
  if (seen.has("") && leaves.length > 1) {
    throw new BehaviorApiError(
      "invalid_tree",
      "a command with subcommands cannot be invoked itself, so its root leaf and subcommands cannot coexist; convert it to subcommands first",
      "leaves",
    );
  }
  if (leaves.length > MAX_SUBCOMMANDS) {
    refuse("leaves", `a command has at most ${MAX_SUBCOMMANDS} subcommands`);
  }
  const chars = commandCharCount(command, leaves);
  if (chars > MAX_COMMAND_CHARS) {
    refuse(
      "leaves",
      `the command totals ${chars} characters of names, descriptions and options; Discord allows ${MAX_COMMAND_CHARS}`,
    );
  }
}
