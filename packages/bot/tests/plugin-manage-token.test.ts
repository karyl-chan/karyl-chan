/**
 * `mintPluginManageToken` — the authorization rule behind a plugin's
 * manage WebUI.
 *
 * Two call sites share it (the plugin-facing `auth.session` RPC and the
 * admin-UI manage-link endpoint) precisely so the rule lives in one
 * place, and until now neither path had a test: the function was moved
 * to its own module by #46 with zero coverage behind it. What it
 * promises is a capability gate plus a capability *subset* — the token
 * must never carry another plugin's grants — and the subsetting is the
 * part worth pinning, since a leak there hands one plugin's WebUI a
 * token that authorizes against another's.
 *
 * Driven at the module rather than through `server.inject`: the
 * manage-link route additionally needs the admin session stack and a
 * configured public base URL, which is coverage the route's own ticket
 * should bring. This pins the rule the move carried.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
});

const resolveUserCapabilities = vi.fn<(userId: string) => Promise<Set<string>>>();

vi.mock("../src/modules/admin/authorized-user.service.js", () => ({
  resolveUserCapabilities: (userId: string) =>
    resolveUserCapabilities(userId),
}));

let mintPluginManageToken: typeof import("../src/modules/plugin-system/plugin-manage-token.js").mintPluginManageToken;

beforeAll(async () => {
  ({ mintPluginManageToken } = await import(
    "../src/modules/plugin-system/plugin-manage-token.js"
  ));
});

beforeEach(() => {
  resolveUserCapabilities.mockReset();
});

/** Read a JWT's payload without verifying it — we assert on contents. */
function payloadOf(token: string): Record<string, unknown> {
  const [, body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
}

describe("mintPluginManageToken", () => {
  it("refuses a user holding neither admin nor the plugin's manage capability", async () => {
    resolveUserCapabilities.mockResolvedValue(
      new Set(["plugin:other-plugin:manage", "some.unrelated.capability"]),
    );
    const minted = await mintPluginManageToken("demo", "user-1");
    expect(minted.allowed).toBe(false);
  });

  it("mints for a user holding the plugin's manage capability", async () => {
    resolveUserCapabilities.mockResolvedValue(
      new Set(["plugin:demo:manage"]),
    );
    const minted = await mintPluginManageToken("demo", "user-1");
    expect(minted.allowed).toBe(true);
    if (!minted.allowed) return;
    expect(minted.token.length).toBeGreaterThan(0);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
  });

  it("treats admin as a superuser, with no hand-rolled check at the call site", async () => {
    resolveUserCapabilities.mockResolvedValue(new Set(["admin"]));
    const minted = await mintPluginManageToken("demo", "user-1");
    expect(minted.allowed).toBe(true);
  });

  it("carries only this plugin's grants — never another plugin's", async () => {
    resolveUserCapabilities.mockResolvedValue(
      new Set([
        "admin",
        "plugin:demo:manage",
        "plugin:demo:configure",
        "plugin:rival:manage",
        "plugin:rival:secrets",
        "guilds.read",
      ]),
    );
    const minted = await mintPluginManageToken("demo", "user-1");
    expect(minted.allowed).toBe(true);
    if (!minted.allowed) return;

    const caps = payloadOf(minted.token).capabilities as string[];
    expect([...caps].sort()).toEqual([
      "admin",
      "plugin:demo:configure",
      "plugin:demo:manage",
    ]);
    // The point of the subsetting: nothing belonging to another plugin,
    // and no unrelated admin capability, rides along.
    expect(caps.some((c) => c.startsWith("plugin:rival:"))).toBe(false);
    expect(caps).not.toContain("guilds.read");
  });

  it("honours the caller's ttl", async () => {
    resolveUserCapabilities.mockResolvedValue(new Set(["admin"]));
    const before = Date.now();
    const minted = await mintPluginManageToken("demo", "user-1", 60_000);
    expect(minted.allowed).toBe(true);
    if (!minted.allowed) return;
    expect(minted.expiresAt).toBeGreaterThanOrEqual(before + 55_000);
    expect(minted.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});
