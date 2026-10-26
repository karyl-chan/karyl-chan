/**
 * BH-2.2C — admin-defined slash command options.
 *
 * parseSlashCommandOptions enforces Discord's hard rules (name format,
 * description length, required-before-optional ordering, unique names,
 * count cap, type whitelist) before a leaf's options are stored.
 */
import { describe, it, expect } from "vitest";
import { parseSlashCommandOptions } from "../src/modules/behavior/behavior-helpers.js";

describe("parseSlashCommandOptions", () => {
  it("accepts a valid flat option list", () => {
    const r = parseSlashCommandOptions([
      { type: "string", name: "query", description: "What to ask", required: true },
      { type: "integer", name: "count", description: "How many" },
    ]);
    expect(r).toEqual({
      ok: true,
      options: [
        { type: "string", name: "query", description: "What to ask", required: true },
        { type: "integer", name: "count", description: "How many", required: false },
      ],
    });
  });

  it("rejects unknown types, bad names, dupes, and required-after-optional", () => {
    expect(
      parseSlashCommandOptions([{ type: "sub_command", name: "x", description: "d" }]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([{ type: "string", name: "BadName", description: "d" }]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([
        { type: "string", name: "a", description: "d" },
        { type: "string", name: "a", description: "d" },
      ]).ok,
    ).toBe(false);
    expect(
      parseSlashCommandOptions([
        { type: "string", name: "a", description: "d" },
        { type: "string", name: "b", description: "d", required: true },
      ]).ok,
    ).toBe(false);
    expect(parseSlashCommandOptions("nope").ok).toBe(false);
  });
});
