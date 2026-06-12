import { describe, expect, it } from "vitest";
import { pluginInstallState } from "./plugin-install-state";
import {
  composeServiceStub,
  rootEnvLine,
  secretEnvName,
} from "./plugin-install-snippets";

const base = {
  version: "1.2.3",
  status: "active" as const,
  enabled: true,
  pendingRpcScopes: [] as string[],
};

describe("pluginInstallState", () => {
  it("flags a setup-secret placeholder as awaiting registration regardless of status", () => {
    // Fresh placeholder is born status=active…
    expect(
      pluginInstallState({ ...base, version: "0.0.0", enabled: false }),
    ).toBe("awaiting-registration");
    // …and stays awaiting-registration after the reaper flips it inactive.
    expect(
      pluginInstallState({
        ...base,
        version: "0.0.0",
        status: "inactive",
        enabled: false,
      }),
    ).toBe("awaiting-registration");
  });

  it("distinguishes offline (registered before) from never-registered", () => {
    expect(pluginInstallState({ ...base, status: "inactive" })).toBe("offline");
  });

  it("surfaces pending scope approval before the enabled check", () => {
    expect(
      pluginInstallState({
        ...base,
        enabled: false,
        pendingRpcScopes: ["kv.guild.get"],
      }),
    ).toBe("scope-pending");
  });

  it("flags registered-but-not-enabled, and ok when the journey is complete", () => {
    expect(pluginInstallState({ ...base, enabled: false })).toBe("not-enabled");
    expect(pluginInstallState(base)).toBe("ok");
    // Missing pendingRpcScopes (older API payloads) must not throw.
    expect(
      pluginInstallState({ ...base, pendingRpcScopes: undefined }),
    ).toBe("ok");
  });
});

describe("install snippets", () => {
  it("uppercases and underscores the plugin key for the root .env name", () => {
    expect(secretEnvName("quest-game")).toBe(
      "KARYL_PLUGIN_SETUP_SECRET_QUEST_GAME",
    );
    expect(rootEnvLine("radio", "abc123")).toBe(
      "KARYL_PLUGIN_SETUP_SECRET_RADIO=abc123",
    );
  });

  it("emits a compose stub with matching container name, PLUGIN_URL and env interpolation", () => {
    const stub = composeServiceStub("quest-game");
    expect(stub).toContain("karyl-plugin-quest-game:");
    expect(stub).toContain("container_name: karyl-plugin-quest-game");
    expect(stub).toContain("PLUGIN_URL: http://karyl-plugin-quest-game:3000");
    expect(stub).toContain(
      "KARYL_PLUGIN_SETUP_SECRET: ${KARYL_PLUGIN_SETUP_SECRET_QUEST_GAME:-}",
    );
  });
});
