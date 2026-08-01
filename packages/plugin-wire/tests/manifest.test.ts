import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_FIELD_TYPES,
  COMMAND_OPTION_TYPES,
  type ConfigFieldType,
  type CommandOptionType,
  type PluginManifest,
} from "../src/index.js";

test("config-field vocabulary is the exact closed set", () => {
  assert.deepEqual(
    [...CONFIG_FIELD_TYPES].sort(),
    [
      "boolean",
      "channel",
      "number",
      "regex",
      "role",
      "secret",
      "select",
      "text",
      "textarea",
      "url",
      "user",
    ],
  );
});

test("command-option vocabulary is the exact closed set", () => {
  assert.deepEqual(
    [...COMMAND_OPTION_TYPES].sort(),
    [
      "attachment",
      "boolean",
      "channel",
      "integer",
      "mentionable",
      "number",
      "role",
      "string",
      "sub_command",
      "sub_command_group",
      "user",
    ],
  );
});

test("vocab element types line up with the string unions", () => {
  const cf: ConfigFieldType = "select";
  const co: CommandOptionType = "sub_command_group";
  assert.ok(CONFIG_FIELD_TYPES.includes(cf));
  assert.ok(COMMAND_OPTION_TYPES.includes(co));
});

test("PluginManifest storage block is camelCase (wire form)", () => {
  // Compile-time proof the wire shape is camelCase, not the snake_case
  // the frontend had drifted to. A snake_case key here would not typecheck.
  const m: PluginManifest = {
    plugin: { id: "x", name: "X", version: "1.0.0", url: "https://x.test" },
    storage: { guildKv: true, guildKvQuotaKb: 64, requiresSecrets: false },
  };
  assert.equal(m.storage?.guildKv, true);
});
