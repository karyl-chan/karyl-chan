/**
 * S2 (#133)：deriveRegistrationCall / commandNeedsPatch 支援
 * defaultMemberPermissions，並能把指令定義組成子指令樹。
 */

import { describe, it, expect } from "vitest";
import {
  ApplicationCommandOptionType,
  type ApplicationCommand,
  type ApplicationCommandData,
} from "discord.js";
import {
  commandNeedsPatch,
  deriveRegistrationCall,
  type CommandDefinition,
} from "../src/modules/command-system/command-registration.js";
import { RejectionError } from "../src/modules/command-system/types.js";

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

describe("deriveRegistrationCall — command leaves (subcommand tree)", () => {
  type Sub = {
    type: number;
    name: string;
    description: string;
    options?: Array<{ type: number; name: string }>;
  };
  const optionsOf = (data: ApplicationCommandData) =>
    ((data as { options?: Sub[] }).options ?? []) as Sub[];

  it("a single root leaf becomes a plain command with the leaf's parameters", () => {
    const { data } = deriveRegistrationCall(
      {
        ...base,
        leaves: [
          {
            path: [],
            description: "ignored for root",
            options: [{ type: "string", name: "who", required: true }],
          },
        ],
      },
      "global",
    );
    expect(optionsOf(data)).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.String,
        name: "who",
        required: true,
      }),
    ]);
  });

  it("subcommand leaves become sub_command options carrying their own parameters", () => {
    const { data } = deriveRegistrationCall(
      {
        ...base,
        name: "nas",
        leaves: [
          { path: ["login"], description: "log in" },
          {
            path: ["status"],
            description: "show status",
            options: [{ type: "boolean", name: "verbose" }],
          },
        ],
      },
      "guild:g1",
    );
    const subs = optionsOf(data);
    expect(subs.map((s) => [s.type, s.name, s.description])).toEqual([
      [ApplicationCommandOptionType.Subcommand, "login", "log in"],
      [ApplicationCommandOptionType.Subcommand, "status", "show status"],
    ]);
    expect(subs[1]!.options).toEqual([
      expect.objectContaining({
        type: ApplicationCommandOptionType.Boolean,
        name: "verbose",
      }),
    ]);
  });

  it("rejects a root leaf alongside subcommands (Discord can't invoke the root then)", () => {
    expect(() =>
      deriveRegistrationCall(
        {
          ...base,
          leaves: [
            { path: [], description: "root" },
            { path: ["sub"], description: "sub" },
          ],
        },
        "global",
      ),
    ).toThrow(RejectionError);
  });

  it("rejects duplicate leaf paths", () => {
    expect(() =>
      deriveRegistrationCall(
        {
          ...base,
          leaves: [
            { path: ["a"], description: "a" },
            { path: ["a"], description: "again" },
          ],
        },
        "global",
      ),
    ).toThrow(RejectionError);
  });

  it("rejects subcommand groups for now (phase 1 supports one level)", () => {
    expect(() =>
      deriveRegistrationCall(
        { ...base, leaves: [{ path: ["grp", "sub"], description: "x" }] },
        "global",
      ),
    ).toThrow(RejectionError);
  });

  it("rejects a command without leaves, and more than 25 subcommands", () => {
    expect(() =>
      deriveRegistrationCall({ ...base, leaves: [] }, "global"),
    ).toThrow(RejectionError);
    const many = Array.from({ length: 26 }, (_, i) => ({
      path: [`s${i}`],
      description: `s${i}`,
    }));
    expect(() =>
      deriveRegistrationCall({ ...base, leaves: many }, "global"),
    ).toThrow(RejectionError);
  });

  it("rejects nested sub_command parameters inside a leaf", () => {
    expect(() =>
      deriveRegistrationCall(
        {
          ...base,
          leaves: [
            {
              path: ["a"],
              description: "a",
              options: [{ type: "sub_command", name: "nested" }],
            },
          ],
        },
        "global",
      ),
    ).toThrow(RejectionError);
  });
});
