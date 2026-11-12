/**
 * mintLoginLink signs single-use login links (#216): every link carries
 * its own `jti`, which /api/auth/exchange uses up on the first exchange.
 */
import { vi, describe, it, expect } from "vitest";

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));
vi.mock("../src/modules/admin/authorized-user.service.js", () => ({
  resolveLoginRole: vi.fn(async () => "owner"),
}));

import { mintLoginLink } from "../src/modules/admin/admin-login.service.js";
import { jwtService } from "../src/modules/web-core/jwt.service.js";

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("login link has no token");
  return token;
}

describe("mintLoginLink", () => {
  it("gives every login link its own jti", async () => {
    const ctx = { guildId: null, channelId: "dm-1", messageId: "m-1" };
    const a = await mintLoginLink("owner-1", ctx);
    const b = await mintLoginLink("owner-1", ctx);
    if (!a.ok || !b.ok) throw new Error("expected both links to be minted");
    const jtiA = jwtService.verify(tokenOf(a.url), { purpose: "login" })?.jti;
    const jtiB = jwtService.verify(tokenOf(b.url), { purpose: "login" })?.jti;
    expect(typeof jtiA).toBe("string");
    expect(jtiA).not.toBe("");
    expect(jtiB).not.toBe(jtiA);
  });
});
