/**
 * validateManifest 的 SSRF guard（V-03 bot half）：host policy 的拒絕
 * （HostPolicyError，DNS 失敗也是）變成 `{ ok: false }`，訊息原樣帶出；
 * 其他錯誤是 bug，直接 rethrow，不偽裝成「目標不被允許」（#183）。
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

vi.mock("../src/utils/host-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/host-policy.js")>()),
  assertPluginTarget: vi.fn(),
}));

import {
  assertPluginTarget,
  HostPolicyError,
} from "../src/utils/host-policy.js";
import { validateManifest } from "../src/modules/plugin-system/plugin-registry.service.js";

const mockedAssert = vi.mocked(assertPluginTarget);

function manifest(url: string) {
  return {
    schema_version: "1",
    plugin: { id: "p1", name: "P1", version: "1.0.0", url },
    rpc_methods_used: [],
  };
}

describe("validateManifest — plugin.url host policy", () => {
  beforeEach(() => {
    mockedAssert.mockReset();
  });

  it("vets the URL's host at its effective port", async () => {
    mockedAssert.mockResolvedValue(undefined);
    const result = await validateManifest(manifest("https://p1.internal/x"));
    expect(result.ok).toBe(true);
    expect(mockedAssert).toHaveBeenCalledWith("p1.internal", 443);
  });

  it("turns a HostPolicyError into { ok: false } with its message", async () => {
    mockedAssert.mockRejectedValue(new HostPolicyError("無法解析主機名稱"));
    const result = await validateManifest(manifest("http://p1.internal:3000"));
    expect(result).toEqual({
      ok: false,
      error: "manifest.plugin.url: 無法解析主機名稱",
    });
    expect(mockedAssert).toHaveBeenCalledWith("p1.internal", 3000);
  });

  it("rethrows anything that is not a HostPolicyError", async () => {
    const bug = new TypeError("boom");
    mockedAssert.mockRejectedValue(bug);
    await expect(
      validateManifest(manifest("http://p1.internal:3000")),
    ).rejects.toBe(bug);
  });
});
