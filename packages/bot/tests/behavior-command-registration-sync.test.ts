/**
 * #136 — the rollback leg of a refused command registration. When Discord
 * refuses, the rows are restored; if restoring itself fails, the admin
 * still gets registration_failed — saying the change is still stored —
 * the failure is logged, and the write that stayed in the DB is audited
 * (registration failed, restore failed), instead of an anonymous 500.
 * Taking a command off Discord (no enabled leaf left) is checked the same
 * way: a removal Discord refused is a refused registration.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const record = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record },
}));
const restoreCommand = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/behavior/command-snapshot.js", () => ({ restoreCommand }));
const auditBehaviorWrite = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/behavior/behavior-audit.js", () => ({ auditBehaviorWrite }));

import { BehaviorApiError } from "../src/modules/behavior/behavior-api-error.js";
import {
  registerCommandWrite,
  type BehaviorCommandRegistrar,
} from "../src/modules/behavior/command-registration-sync.js";

const refused: BehaviorCommandRegistrar = {
  registerOne: vi.fn(async (key) => ({
    ok: false as const,
    key,
    reason: "registration_failed" as const,
    name: "nas",
    outcomes: [],
    error: "Missing Access",
  })),
  reconcileForBehaviorCommand: vi.fn(),
  releaseRegistration: vi.fn(),
};

const at = { name: "nas", target: "guild:123456789012345678" as const };
const snapshot = { commandId: 1, command: null, leaves: [] };

const pendingAudit = {
  request: { authUserId: "admin" } as never,
  action: "behavior.command.update" as const,
  target: "command:1",
  context: { changed: { description: { from: "a", to: "b" } } },
};

beforeEach(() => {
  record.mockClear();
  auditBehaviorWrite.mockClear();
  restoreCommand.mockReset();
});

describe("registerCommandWrite when Discord refuses", () => {
  it("restores the rows and says nothing was saved", async () => {
    restoreCommand.mockResolvedValue(undefined);
    const err = await registerCommandWrite(refused, 1, at, null, snapshot).catch((e: unknown) => e);
    expect(restoreCommand).toHaveBeenCalledWith(snapshot);
    expect(err).toBeInstanceOf(BehaviorApiError);
    expect(err).toMatchObject({
      code: "registration_failed",
      message: expect.stringContaining("not saved"),
    });
  });

  it("reports a restore that failed instead of throwing a 500", async () => {
    restoreCommand.mockRejectedValue(new Error("SQLITE_BUSY"));
    const err = await registerCommandWrite(refused, 1, at, null, snapshot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BehaviorApiError);
    expect(err).toMatchObject({
      code: "registration_failed",
      message: expect.stringContaining("still stored"),
    });
    expect(record).toHaveBeenCalledWith(
      "error",
      "bot",
      expect.stringContaining("SQLITE_BUSY"),
      expect.objectContaining({ commandId: 1 }),
    );
  });

  it("audits the write a failed restore left in the DB", async () => {
    restoreCommand.mockRejectedValue(new Error("SQLITE_BUSY"));
    await registerCommandWrite(refused, 1, at, null, snapshot, pendingAudit).catch(() => null);
    expect(auditBehaviorWrite).toHaveBeenCalledWith(
      pendingAudit.request,
      "behavior.command.update",
      "command:1",
      {
        changed: { description: { from: "a", to: "b" } },
        registration: "failed",
        restore: "failed",
      },
    );
  });

  it("audits nothing when the restore worked (nothing changed)", async () => {
    restoreCommand.mockResolvedValue(undefined);
    await registerCommandWrite(refused, 1, at, null, snapshot, pendingAudit).catch(() => null);
    expect(auditBehaviorWrite).not.toHaveBeenCalled();
  });
});

describe("registerCommandWrite with no enabled leaf left", () => {
  const notDesired = (removal: { ok: boolean; error?: string }): BehaviorCommandRegistrar => ({
    registerOne: vi.fn(async (key) => ({
      ok: false as const,
      key,
      reason: "not_desired" as const,
      error: "no enabled leaf",
    })),
    reconcileForBehaviorCommand: vi.fn(async () => ({
      source: "behavior" as const,
      sourceId: 1,
      action: "delete" as const,
      ...removal,
    })),
    releaseRegistration: vi.fn(async () => "removed" as const),
  });

  it("reports removed once Discord removed it", async () => {
    await expect(
      registerCommandWrite(notDesired({ ok: true }), 1, at, at, snapshot),
    ).resolves.toEqual({ status: "removed" });
  });

  it("defers when the bot cannot reach the command's guild", async () => {
    const registrar = notDesired({ ok: true });
    (registrar.reconcileForBehaviorCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: "behavior",
      sourceId: 1,
      ok: true,
      action: "delete",
      targets: [
        { target: "guild:123456789012345678", status: "skipped", reason: "guild_unavailable" },
      ],
    });
    await expect(registerCommandWrite(registrar, 1, at, at, snapshot)).resolves.toMatchObject({
      status: "deferred",
    });
    expect(restoreCommand).not.toHaveBeenCalled();
  });

  it("a removal Discord refused restores the rows and fails", async () => {
    restoreCommand.mockResolvedValue(undefined);
    const err = await registerCommandWrite(
      notDesired({ ok: false, error: "guild:123456789012345678: Missing Access" }),
      1,
      at,
      at,
      snapshot,
    ).catch((e: unknown) => e);
    expect(restoreCommand).toHaveBeenCalledWith(snapshot);
    expect(err).toBeInstanceOf(BehaviorApiError);
    expect(err).toMatchObject({
      code: "registration_failed",
      message: expect.stringContaining("Missing Access"),
    });
  });
});
