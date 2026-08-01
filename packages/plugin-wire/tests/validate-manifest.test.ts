import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PLUGIN_CAPABILITIES,
  validateManifestProtocol,
  type ManifestValidation,
} from "../src/index.js";

/** Smallest manifest that passes every protocol rule. */
function base(): Record<string, unknown> {
  return {
    plugin: {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      url: "https://demo.test",
    },
  };
}

function fail(input: unknown): string {
  const v: ManifestValidation = validateManifestProtocol(input);
  assert.equal(v.ok, false, `expected rejection, got ok for ${JSON.stringify(input)}`);
  return (v as { ok: false; error: string }).error;
}

function pass(input: unknown): void {
  const v = validateManifestProtocol(input);
  assert.equal(
    v.ok,
    true,
    `expected accept, got: ${v.ok ? "" : (v as { error: string }).error}`,
  );
}

// ─── Shape + version metadata ──────────────────────────────────────────

test("non-object input is rejected", () => {
  assert.match(fail(null), /manifest must be an object/);
  assert.match(fail("nope"), /manifest must be an object/);
  assert.match(fail(42), /manifest must be an object/);
});

test("minimal manifest passes", () => {
  pass(base());
});

test("schema_version: absent and legacy \"1\" tolerated, anything else rejected", () => {
  pass(base());
  pass({ ...base(), schema_version: "1" });
  pass({ ...base(), schema_version: null });
  assert.match(fail({ ...base(), schema_version: "2" }), /unsupported schema_version/);
});

test("sdk_version must be semver-ish when present", () => {
  pass({ ...base(), sdk_version: "0.13.0" });
  pass({ ...base(), sdk_version: "1.0.0-rc.1" });
  pass({ ...base(), sdk_version: null });
  assert.match(
    fail({ ...base(), sdk_version: "0.13" }),
    /sdk_version must be a semver string/,
  );
  assert.match(
    fail({ ...base(), sdk_version: 13 }),
    /sdk_version must be a semver string/,
  );
});

// ─── V-02: plugin block ────────────────────────────────────────────────

test("V-02: plugin block is required", () => {
  assert.match(fail({}), /manifest\.plugin missing/);
  assert.match(fail({ plugin: "x" }), /manifest\.plugin missing/);
});

test("V-02: id / name / version / url are required non-empty strings", () => {
  for (const k of ["id", "name", "version", "url"] as const) {
    const m = base();
    delete (m.plugin as Record<string, unknown>)[k];
    assert.match(fail(m), new RegExp(`manifest\\.plugin\\.${k} required`));

    const empty = base();
    (empty.plugin as Record<string, unknown>)[k] = "";
    assert.match(fail(empty), new RegExp(`manifest\\.plugin\\.${k} required`));
  }
});

test("V-02: plugin.id must match [a-z0-9][a-z0-9-]*", () => {
  for (const id of ["Demo", "-demo", "demo_plugin", "demo.plugin", "點點"]) {
    const m = base();
    (m.plugin as Record<string, unknown>).id = id;
    assert.match(fail(m), /manifest\.plugin\.id must match/);
  }
  for (const id of ["demo", "d", "0", "demo-plugin-2"]) {
    const m = base();
    (m.plugin as Record<string, unknown>).id = id;
    pass(m);
  }
});

// ─── V-03: plugin.url protocol (host policy stays bot-side) ────────────

test("V-03: plugin.url must parse and be http(s)", () => {
  const bad = base();
  (bad.plugin as Record<string, unknown>).url = "not a url";
  assert.match(fail(bad), /manifest\.plugin\.url is not a valid URL/);

  const ftp = base();
  (ftp.plugin as Record<string, unknown>).url = "ftp://demo.test";
  assert.match(fail(ftp), /manifest\.plugin\.url must be http\(s\)/);
});

test("V-03: host policy is NOT applied here — that is bot-side state", () => {
  // plugin-wire validates the wire contract only. Whether a target host
  // is reachable/allowed (SSRF guard) is bot policy and stays in the bot.
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://10.0.0.1",
    "http://plugin-example:3000",
  ]) {
    const m = base();
    (m.plugin as Record<string, unknown>).url = url;
    pass(m);
  }
});

// ─── V-04: array-typed top-level fields ────────────────────────────────

test("V-04: list fields must be arrays when present", () => {
  for (const k of [
    "rpc_methods_used",
    "plugin_commands",
    "guild_features",
    "capabilities",
    "events_subscribed_global",
  ]) {
    assert.match(
      fail({ ...base(), [k]: "nope" }),
      new RegExp(`manifest\\.${k} must be an array`),
    );
    pass({ ...base(), [k]: [] });
  }
});

// ─── capabilities[] ────────────────────────────────────────────────────

test(`capabilities are capped at ${MAX_PLUGIN_CAPABILITIES}`, () => {
  const cap = (i: number) => ({ key: `c${i}`, description: "d" });
  pass({
    ...base(),
    capabilities: Array.from({ length: MAX_PLUGIN_CAPABILITIES }, (_, i) => cap(i)),
  });
  assert.match(
    fail({
      ...base(),
      capabilities: Array.from(
        { length: MAX_PLUGIN_CAPABILITIES + 1 },
        (_, i) => cap(i),
      ),
    }),
    /at most 32 allowed \(got 33\)/,
  );
});

test("capability entries must be well-formed objects", () => {
  assert.match(
    fail({ ...base(), capabilities: ["nope"] }),
    /capabilities\[0\] must be an object/,
  );
  assert.match(
    fail({ ...base(), capabilities: [{ key: "Bad", description: "d" }] }),
    /capabilities\[0\]\.key "Bad" must match/,
  );
  assert.match(
    fail({ ...base(), capabilities: [{ key: "ok", description: "  " }] }),
    /capabilities\[ok\]\.description must be a non-empty string/,
  );
  assert.match(
    fail({
      ...base(),
      capabilities: [{ key: "ok", description: "x".repeat(201) }],
    }),
    /capabilities\[ok\]\.description must be ≤200 chars/,
  );
  assert.match(
    fail({
      ...base(),
      capabilities: [
        { key: "dup", description: "a" },
        { key: "dup", description: "b" },
      ],
    }),
    /capabilities\[dup\]\.key is declared more than once/,
  );
  // Dotted / dashed / underscored keys are legal.
  pass({
    ...base(),
    capabilities: [{ key: "a.b_c-d0", description: "ok" }],
  });
});

// ─── plugin_commands[]: V-05 ~ V-08, V-C1 ~ V-C3 ───────────────────────

function cmd(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ping",
    description: "Ping",
    scope: "guild",
    integration_types: ["guild_install"],
    contexts: ["Guild"],
    ...over,
  };
}

test("plugin_commands entries must be objects", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [null] }),
    /plugin_commands\[0\] must be an object/,
  );
});

test("V-05: description must be a non-empty string", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ description: "" })] }),
    /plugin_commands\[0\]\.description must be a non-empty string \(V-05\)/,
  );
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ description: "   " })] }),
    /V-05/,
  );
});

test("command name follows the Discord constraint and is unique", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ name: "Ping" })] }),
    /plugin_commands\[0\]\.name "Ping" invalid/,
  );
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ name: "a".repeat(33) })] }),
    /invalid/,
  );
  assert.match(
    fail({ ...base(), plugin_commands: [cmd(), cmd()] }),
    /plugin_commands\[1\]\.name "ping" is declared more than once/,
  );
});

test("V-06: scope must be guild or global", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ scope: "user" })] }),
    /plugin_commands\[ping\]\.scope must be "guild" or "global" \(V-06\)/,
  );
  pass({ ...base(), plugin_commands: [cmd({ scope: "guild" })] });
  pass({
    ...base(),
    plugin_commands: [
      cmd({ scope: "global", integration_types: ["user_install"] }),
    ],
  });
});

test("V-07: integration_types must be a non-empty valid subset", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ integration_types: [] })] }),
    /integration_types must be a non-empty array \(V-07\)/,
  );
  assert.match(
    fail({
      ...base(),
      plugin_commands: [cmd({ integration_types: "guild_install" })],
    }),
    /integration_types must be a non-empty array \(V-07\)/,
  );
  assert.match(
    fail({
      ...base(),
      plugin_commands: [cmd({ integration_types: ["app_install"] })],
    }),
    /integration_types contains invalid value "app_install" \(V-07\)/,
  );
});

test("V-08: contexts must be a non-empty valid subset", () => {
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ contexts: [] })] }),
    /contexts must be a non-empty array \(V-08\)/,
  );
  assert.match(
    fail({ ...base(), plugin_commands: [cmd({ contexts: ["DM"] })] }),
    /contexts contains invalid value "DM" \(V-08\)/,
  );
});

test("V-C1: scope=guild is incompatible with BotDM / PrivateChannel", () => {
  for (const ctx of ["BotDM", "PrivateChannel"]) {
    assert.match(
      fail({
        ...base(),
        plugin_commands: [cmd({ scope: "guild", contexts: ["Guild", ctx] })],
      }),
      /V-C1/,
    );
  }
});

test("V-C2: scope=guild is incompatible with user_install", () => {
  assert.match(
    fail({
      ...base(),
      plugin_commands: [
        cmd({
          scope: "guild",
          integration_types: ["guild_install", "user_install"],
        }),
      ],
    }),
    /V-C2/,
  );
});

test("V-C3: global + guild_install-only cannot carry DM contexts", () => {
  assert.match(
    fail({
      ...base(),
      plugin_commands: [
        cmd({
          scope: "global",
          integration_types: ["guild_install"],
          contexts: ["Guild", "BotDM"],
        }),
      ],
    }),
    /V-C3/,
  );
  // user_install present ⇒ DM contexts are legal.
  pass({
    ...base(),
    plugin_commands: [
      cmd({
        scope: "global",
        integration_types: ["guild_install", "user_install"],
        contexts: ["Guild", "BotDM", "PrivateChannel"],
      }),
    ],
  });
});

// ─── guild_features[] ──────────────────────────────────────────────────

test("guild features require key + name", () => {
  assert.match(
    fail({ ...base(), guild_features: [{ name: "No key" }] }),
    /every guild_feature requires key \+ name/,
  );
  assert.match(
    fail({ ...base(), guild_features: [{ key: "f" }] }),
    /every guild_feature requires key \+ name/,
  );
});

test("guild-feature commands need name + description and a legal name", () => {
  assert.match(
    fail({
      ...base(),
      guild_features: [{ key: "f", name: "F", commands: [{ name: "a" }] }],
    }),
    /guild_features\[f\]\.commands: name \+ description required/,
  );
  assert.match(
    fail({
      ...base(),
      guild_features: [
        { key: "f", name: "F", commands: [{ name: "Bad", description: "d" }] },
      ],
    }),
    /guild_features\[f\]\.commands: command\.name 'Bad' invalid/,
  );
});

test("guild-feature command names are unique across the whole manifest", () => {
  assert.match(
    fail({
      ...base(),
      guild_features: [
        { key: "a", name: "A", commands: [{ name: "dup", description: "d" }] },
        { key: "b", name: "B", commands: [{ name: "dup", description: "d" }] },
      ],
    }),
    /guild_features\[b\]\.commands: command\.name 'dup' is declared more than once/,
  );
});

// ─── config_schema (delegates to the config validator) ─────────────────

test("plugin-level config_schema is validated at register time", () => {
  assert.match(
    fail({
      ...base(),
      config_schema: [
        { key: "n", type: "number", label: "N", default: "not-a-number" },
      ],
    }),
    /config_schema\[n\]: default value type string does not match field type "number"/,
  );
});

test("guild-feature config_schema errors name their feature", () => {
  assert.match(
    fail({
      ...base(),
      guild_features: [
        {
          key: "f",
          name: "F",
          config_schema: [{ key: "p", type: "text", label: "P", pattern: "([" }],
        },
      ],
    }),
    /guild_features\[f\]\.config_schema\[p\]: pattern is not a valid regex/,
  );
});

// ─── web_ui ────────────────────────────────────────────────────────────

test("web_ui must be an object when present", () => {
  assert.match(fail({ ...base(), web_ui: "x" }), /manifest\.web_ui must be an object/);
  assert.match(fail({ ...base(), web_ui: [] }), /manifest\.web_ui must be an object/);
  pass({ ...base(), web_ui: {} });
  pass({ ...base(), web_ui: null });
});

test("web_ui.manage_path is a rooted, traversal-free path", () => {
  // A bare "/" is rejected too: the trailing-slash rule has no carve-out
  // for the root, and `<publicBaseUrl>/` is not a manage surface.
  for (const mp of ["manage", "/manage/", "/", "/man age", "/a//b", "/../etc", 7]) {
    assert.match(
      fail({ ...base(), web_ui: { manage_path: mp } }),
      /manifest\.web_ui\.manage_path/,
    );
  }
  for (const mp of ["/manage", "/a/b_c-d0"]) {
    pass({ ...base(), web_ui: { manage_path: mp } });
  }
});

// ─── Success shape ─────────────────────────────────────────────────────

test("a valid manifest is returned back, unmodified", () => {
  const input = {
    ...base(),
    sdk_version: "0.13.0",
    plugin_commands: [cmd()],
    capabilities: [{ key: "admin", description: "Admin things" }],
  };
  const v = validateManifestProtocol(input);
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.manifest, input);
});
