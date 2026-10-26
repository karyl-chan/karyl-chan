/**
 * S2 (#133)：deriveRegistrationCall / commandNeedsPatch 支援
 * defaultMemberPermissions。
 */

import { describe, it, expect } from "vitest";
import {
  type ApplicationCommand,
  type ApplicationCommandData,
} from "discord.js";
import {
  commandNeedsPatch,
  deriveRegistrationCall,
  type CommandDefinition,
} from "../src/modules/command-system/command-registration.js";

const base: CommandDefinition = {
  name: "ping",
  description: "ping",
  integrationTypes: ["guild_install"],
  contexts: ["Guild"],
};

/** 模擬 Discord 回來的現況：與 desired 一致，只差 defaultMemberPermissions。 */
function existingFrom(
  data: ApplicationCommandData,
  perms: bigint | null | undefined,
): ApplicationCommand {
  const d = data as unknown as Record<string, unknown>;
  return {
    id: "c1",
    name: d["name"],
    description: d["description"],
    contexts: d["contexts"],
    integrationTypes: d["integrationTypes"],
    options: [],
    ...(perms === undefined
      ? {}
      : {
          defaultMemberPermissions:
            perms === null ? null : { bitfield: perms },
        }),
  } as unknown as ApplicationCommand;
}

describe("deriveRegistrationCall — defaultMemberPermissions", () => {
  it("passes the permission bitfield through to the registration data", () => {
    const spec = deriveRegistrationCall(
      { ...base, defaultMemberPermissions: "32" },
      "guild:g1",
    );
    expect(
      (spec.data as { defaultMemberPermissions?: unknown })
        .defaultMemberPermissions,
    ).toBe("32");
  });

  it("sends an explicit null when unset, so a patch can clear a previous restriction", () => {
    const spec = deriveRegistrationCall(base, "global");
    expect(spec.data).toHaveProperty("defaultMemberPermissions", null);
  });
});

describe("commandNeedsPatch — defaultMemberPermissions", () => {
  it("no patch when the permission matches", () => {
    const { data } = deriveRegistrationCall(
      { ...base, defaultMemberPermissions: "32" },
      "global",
    );
    expect(commandNeedsPatch(existingFrom(data, 32n), data)).toBe(false);
  });

  it("patch when the permission changed", () => {
    const { data } = deriveRegistrationCall(
      { ...base, defaultMemberPermissions: "8" },
      "global",
    );
    expect(commandNeedsPatch(existingFrom(data, 32n), data)).toBe(true);
  });

  it("patch when a restriction is added or removed", () => {
    const open = deriveRegistrationCall(base, "global").data;
    const restricted = deriveRegistrationCall(
      { ...base, defaultMemberPermissions: "8" },
      "global",
    ).data;
    expect(commandNeedsPatch(existingFrom(open, null), restricted)).toBe(true);
    expect(commandNeedsPatch(existingFrom(restricted, 8n), open)).toBe(true);
  });

  it("no patch when neither side restricts (existing field absent or null)", () => {
    const open = deriveRegistrationCall(base, "global").data;
    expect(commandNeedsPatch(existingFrom(open, null), open)).toBe(false);
    expect(commandNeedsPatch(existingFrom(open, undefined), open)).toBe(false);
  });
});
