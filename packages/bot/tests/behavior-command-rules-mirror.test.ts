/**
 * The admin UI's command form (#138) shows a command's Behavior Section
 * and Discord's visibility / option rules while the admin edits, without
 * a round trip. It cannot import the server's rule modules (they pull in
 * the models, Sequelize and Fastify), so it keeps a dependency-free
 * mirror: frontend/src/views/admin/behaviors/command-rules.ts. This test
 * pins the mirror to the server's rules — behavior-section.ts and
 * command-tree-rules.ts — over every visibility combination, so the two
 * cannot drift apart unnoticed.
 */
import { describe, expect, it } from "vitest";
import { behaviorSection } from "../src/modules/behavior/behavior-section.js";
import { BehaviorApiError } from "../src/modules/behavior/behavior-api-error.js";
import {
  MAX_COMMAND_CHARS,
  MAX_OPTIONS,
  MAX_SUBCOMMANDS,
  RESERVED_COMMAND_NAMES,
  checkCommandSettings,
  checkLeafOptions,
  commandCharCount,
} from "../src/modules/behavior/command-tree-rules.js";
import type { BehaviorCommandOption } from "../src/modules/behavior/models/behavior-definition.model.js";
import * as mirror from "../frontend/src/views/admin/behaviors/command-rules.js";

type Context = "Guild" | "BotDM" | "PrivateChannel";
type Install = "guild_install" | "user_install";

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => all.concat(all.map((s) => [...s, item])), [[]]);
}

const visibilities = (["global", "guild"] as const).flatMap((registration) =>
  [null, "123456789012345678"].flatMap((guildId) =>
    subsets<Install>(["guild_install", "user_install"]).flatMap((integrationTypes) =>
      subsets<Context>(["Guild", "BotDM", "PrivateChannel"]).map((contexts) => ({
        registration,
        guildId,
        integrationTypes,
        contexts,
      })),
    ),
  ),
);

/** The field of the first rule the server refuses, or null. */
function serverRefusal(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (err) {
    if (err instanceof BehaviorApiError) return err.field ?? "";
    throw err;
  }
}

describe("command-rules.ts mirrors the server's command rules", () => {
  it.each(visibilities)("same section and visibility verdict for %o", (v) => {
    expect(mirror.commandSection(v)).toBe(behaviorSection({ kind: "command", ...v }));
    const settings = { name: "x", description: "x", ...v };
    expect(mirror.visibilityIssues(v)[0]?.field ?? null).toBe(
      serverRefusal(() => checkCommandSettings(settings)),
    );
  });

  const option = (name: string, required = false): BehaviorCommandOption => ({
    type: "string",
    name,
    description: `${name} description`,
    required,
  });

  it.each([
    [[]],
    [[option("a", true), option("b")]],
    [[option("a"), option("b", true)]],
    [[option("a"), option("a")]],
    [[option("a", true), option("b"), option("a")]],
    [Array.from({ length: 26 }, (_, i) => option(`o${i}`))],
  ])("same option verdict for %#", (options) => {
    const issue = mirror.optionIssues(options)[0];
    const field = issue ? (issue.index === null ? "options" : `options.${issue.index}.${issue.field}`) : null;
    expect(field).toBe(serverRefusal(() => checkLeafOptions(options, "options")));
  });

  it("counts a command's characters the way Discord's limit does", () => {
    const leaves = [
      { subcommand: "", title: "Root", leafDescription: null, options: [option("host", true)] },
      { subcommand: "wake", title: "Wake a host", leafDescription: null, options: [] },
      { subcommand: "sleep", title: "Sleep", leafDescription: "Put a host to sleep", options: [option("at")] },
    ];
    const command = { name: "nas", description: "NAS tools" };
    expect(mirror.commandCharCount(command, leaves)).toBe(commandCharCount(command, leaves));
  });

  it("knows the same limits and reserved names", () => {
    expect(mirror.MAX_COMMAND_CHARS).toBe(MAX_COMMAND_CHARS);
    expect(mirror.MAX_OPTIONS).toBe(MAX_OPTIONS);
    expect(mirror.MAX_SUBCOMMANDS).toBe(MAX_SUBCOMMANDS);
    expect([...mirror.RESERVED_COMMAND_NAMES].sort()).toEqual([...RESERVED_COMMAND_NAMES].sort());
  });
});
