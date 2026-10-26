/**
 * #136 — Command Leaves: POST /api/behavior-commands/:id/leaves adds a
 * subcommand, PATCH / DELETE /api/behaviors/:id edit or remove a leaf, and
 * POST /api/behavior-commands/:id/convert-to-subcommands turns a command's
 * root leaf into its first subcommand. The root leaf and subcommands never
 * coexist (invalid_tree); every change is re-registered with Discord, and
 * a refused registration restores the previous leaves.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import type { Client } from "discord.js";
import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { ReconcilerOwnedCommand } from "../src/modules/command-system/models/reconciler-owned-command.model.js";
import { CommandReconciler } from "../src/modules/command-system/reconcile.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { clearBehaviors, seedCommand, seedLeaf } from "./behavior-fixtures.js";

const HOOK = "https://203.0.113.10/hook";
const GUILD = "123456789012345678";

interface Option {
  type: number;
  name: string;
  description: string;
  options?: Option[];
}
interface CmdStub {
  id: string;
  name: string;
  description: string;
  options?: Option[];
}

class FakeCollection extends Map<string, CmdStub> {
  find(fn: (v: CmdStub) => boolean): CmdStub | undefined {
    for (const v of this.values()) if (fn(v)) return v;
    return undefined;
  }
}

const store = new Map<string, CmdStub>();
let refuse: string | null = null;
let idc = 0;
const guildCmds = {
  fetch: vi.fn(async () => new FakeCollection(store)),
  create: vi.fn(async (data: CmdStub) => {
    if (refuse) throw new Error(refuse);
    const cmd = { ...data, id: `c${++idc}` };
    store.set(cmd.id, cmd);
    return cmd;
  }),
  edit: vi.fn(async (id: string, data: CmdStub) => {
    if (refuse) throw new Error(refuse);
    store.set(id, { ...data, id });
    return store.get(id);
  }),
  delete: vi.fn(async (id: string) => {
    store.delete(id);
  }),
};
const reconciler = new CommandReconciler(
  () =>
    ({
      application: { commands: { ...guildCmds, fetch: async () => new FakeCollection() } },
      guilds: { cache: new Map([[GUILD, { id: GUILD, commands: guildCmds }]]) },
    }) as unknown as Client,
);

/** The registered command's subcommands as `name: description`. */
function registered(): string[] | "root" | null {
  const cmd = [...store.values()].find((c) => c.name === "nas");
  if (!cmd) return null;
  const subs = (cmd.options ?? []).filter((o) => o.type === 1);
  return subs.length === 0 ? "root" : subs.map((o) => `${o.name}: ${o.description}`);
}

let server: FastifyInstance;

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, { reconciler, namespace: new CommandNamespace() });
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
  await ReconcilerOwnedCommand.destroy({ where: {} });
  store.clear();
  refuse = null;
});

const leaf = (subcommand: string, extra: Record<string, unknown> = {}) => ({
  subcommand,
  title: subcommand || "Root",
  webhook: { url: HOOK },
  ...extra,
});

async function createCommand(leaves: Array<Record<string, unknown>>) {
  const res = await server.inject({
    method: "POST",
    url: "/api/behavior-commands",
    payload: { name: "nas", description: "NAS", registration: "guild", guildId: GUILD, leaves },
  });
  expect(res.statusCode).toBe(201);
  const command = res.json().command as { id: number; leaves: Array<{ id: number; subcommand: string }> };
  const leafId = (sub: string) => command.leaves.find((l) => l.subcommand === sub)!.id;
  return { id: command.id, leafId };
}

function addLeaf(commandId: number, payload: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: `/api/behavior-commands/${commandId}/leaves`,
    payload,
  });
}

function patchLeaf(id: number, payload: Record<string, unknown>) {
  return server.inject({ method: "PATCH", url: `/api/behaviors/${id}`, payload });
}

function deleteLeaf(id: number) {
  return server.inject({ method: "DELETE", url: `/api/behaviors/${id}` });
}

describe("POST /api/behavior-commands/:id/leaves", () => {
  it("adds a subcommand and registers it", async () => {
    const { id } = await createCommand([leaf("wake")]);
    const res = await addLeaf(id, leaf("status", { leafDescription: "Show status" }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      behavior: { subcommand: "status", leafDescription: "Show status" },
      command: { id },
      registration: { status: "registered" },
    });
    expect(registered()).toEqual(["wake: wake", "status: Show status"]);
  });

  it("returns a generated secret once", async () => {
    const { id } = await createCommand([leaf("wake")]);
    const res = await addLeaf(id, leaf("status", { webhook: { url: HOOK, authMode: "hmac" } }));
    expect(res.json().secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a subcommand next to a root leaf", async () => {
    const { id } = await createCommand([leaf("")]);
    const res = await addLeaf(id, leaf("status"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_tree");
    expect(registered()).toBe("root");
  });

  it("refuses a subcommand that exists", async () => {
    const { id } = await createCommand([leaf("wake")]);
    const res = await addLeaf(id, leaf("wake"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "subcommand" });
  });

  it("refuses a 26th subcommand", async () => {
    const { id } = await createCommand(Array.from({ length: 25 }, (_, i) => leaf(`s${i}`)));
    const res = await addLeaf(id, leaf("one-more"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "leaves" });
  });

  it("refuses a root leaf (subcommand is required here)", async () => {
    const { id } = await createCommand([leaf("wake")]);
    const res = await addLeaf(id, leaf(""));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "subcommand" });
  });

  it("saves nothing when Discord refuses", async () => {
    const { id } = await createCommand([leaf("wake")]);
    refuse = "Invalid Form Body";
    const res = await addLeaf(id, leaf("status"));
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("registration_failed");
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.json().commands[0].leaves.map((l: { subcommand: string }) => l.subcommand)).toEqual(["wake"]);
  });

  it("refuses the system command and unknown commands", async () => {
    const sys = await seedCommand({ name: "login", isSystem: true });
    await seedLeaf(sys, { systemKey: "admin-login", actionSource: "builtin" }, null);
    const res = await addLeaf(sys, leaf("x"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
    expect((await addLeaf(9999, leaf("x"))).statusCode).toBe(404);
  });
});

describe("PATCH /api/behaviors/:id (command leaf)", () => {
  it("re-registers a changed subcommand", async () => {
    const { leafId } = await createCommand([leaf("wake"), leaf("status")]);
    const res = await patchLeaf(leafId("wake"), {
      subcommand: "boot",
      leafDescription: "Boot a host",
      options: [{ type: "string", name: "host", description: "Host" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      behavior: { subcommand: "boot", leafDescription: "Boot a host" },
      registration: { status: "registered" },
    });
    expect(registered()).toEqual(["boot: Boot a host", "status: status"]);
  });

  it("a disabled subcommand leaves Discord; the last one takes the command with it", async () => {
    const { leafId } = await createCommand([leaf("wake"), leaf("status")]);
    await patchLeaf(leafId("wake"), { enabled: false });
    expect(registered()).toEqual(["status: status"]);
    const res = await patchLeaf(leafId("status"), { enabled: false });
    expect(res.json().registration).toMatchObject({ status: "removed" });
    expect(registered()).toBeNull();
  });

  it("disabling the last leaf fails when Discord does not remove the command", async () => {
    const { leafId } = await createCommand([leaf("wake")]);
    guildCmds.delete.mockRejectedValueOnce(new Error("Missing Access"));
    const res = await patchLeaf(leafId("wake"), { enabled: false });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "registration_failed",
      message: expect.stringContaining("Missing Access"),
    });
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.json().commands[0].leaves[0]).toMatchObject({ enabled: true });
    expect(registered()).toEqual(["wake: wake"]);
  });

  it("an edit Discord does not see is not re-registered", async () => {
    const { leafId } = await createCommand([leaf("wake")]);
    guildCmds.edit.mockClear();
    const res = await patchLeaf(leafId("wake"), { description: "admin note" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("registration");
    expect(guildCmds.edit).not.toHaveBeenCalled();
  });

  it("restores the leaf when Discord refuses", async () => {
    const { leafId } = await createCommand([leaf("wake")]);
    refuse = "Missing Access";
    const res = await patchLeaf(leafId("wake"), { leafDescription: "Changed" });
    expect(res.statusCode).toBe(502);
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.json().commands[0].leaves[0]).toMatchObject({ leafDescription: null });
  });

  it.each([
    ["the root leaf becoming a subcommand", [""], "", { subcommand: "x" }],
    ["a subcommand becoming the root leaf", ["a", "b"], "a", { subcommand: "" }],
  ])("refuses %s", async (_what, subs, target, change) => {
    const { leafId } = await createCommand(subs.map((s) => leaf(s)));
    const res = await patchLeaf(leafId(target), change);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "subcommand" });
  });

  it("refuses renaming onto a sibling", async () => {
    const { leafId } = await createCommand([leaf("a"), leaf("b")]);
    const res = await patchLeaf(leafId("a"), { subcommand: "b" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "invalid_tree", field: "subcommand" });
  });

  it("refuses message trigger fields on a leaf", async () => {
    const { leafId } = await createCommand([leaf("a")]);
    const res = await patchLeaf(leafId("a"), { patternValue: "!x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "patternValue" });
  });

  it("refuses an invalid option list on its field", async () => {
    const { leafId } = await createCommand([leaf("a")]);
    const res = await patchLeaf(leafId("a"), {
      options: [
        { type: "string", name: "x", description: "x" },
        { type: "string", name: "y", description: "y", required: true },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "options.1.required" });
  });

  it("the system command's leaf is immutable", async () => {
    const sys = await seedCommand({ name: "login", isSystem: true });
    const id = await seedLeaf(sys, { systemKey: "admin-login", actionSource: "builtin" }, null);
    const res = await patchLeaf(id, { title: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("system_immutable");
  });
});

describe("DELETE /api/behaviors/:id (command leaf)", () => {
  it("removes a subcommand from Discord", async () => {
    const { leafId } = await createCommand([leaf("wake"), leaf("status")]);
    const res = await deleteLeaf(leafId("wake"));
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toMatchObject({ status: "registered" });
    expect(registered()).toEqual(["status: status"]);
  });

  it("refuses to remove the last leaf (delete the command instead)", async () => {
    const { leafId } = await createCommand([leaf("wake")]);
    const res = await deleteLeaf(leafId("wake"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_tree");
  });

  it("keeps the leaf when Discord refuses", async () => {
    const { leafId } = await createCommand([leaf("wake"), leaf("status")]);
    refuse = "rate limited";
    expect((await deleteLeaf(leafId("wake"))).statusCode).toBe(502);
    const list = await server.inject({ method: "GET", url: "/api/behaviors" });
    expect(list.json().commands[0].leaves).toHaveLength(2);
  });
});

describe("POST /api/behavior-commands/:id/convert-to-subcommands", () => {
  function convert(id: number, payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: `/api/behavior-commands/${id}/convert-to-subcommands`,
      payload,
    });
  }

  it("turns the root leaf into the first subcommand", async () => {
    const { id, leafId } = await createCommand([leaf("", { title: "Wake the NAS" })]);
    const rootId = leafId("");
    const res = await convert(id, { subcommand: "wake" });
    expect(res.statusCode).toBe(200);
    expect(res.json().command.leaves).toEqual([
      expect.objectContaining({ id: rootId, subcommand: "wake" }),
    ]);
    expect(registered()).toEqual(["wake: Wake the NAS"]);
    // and now subcommands can be added
    expect((await addLeaf(id, leaf("status"))).statusCode).toBe(201);
  });

  it("refuses a command that already has subcommands", async () => {
    const { id } = await createCommand([leaf("wake")]);
    const res = await convert(id, { subcommand: "other" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_tree");
  });

  it("refuses an invalid subcommand name", async () => {
    const { id } = await createCommand([leaf("")]);
    const res = await convert(id, { subcommand: "Bad" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "subcommand" });
  });
});

describe("audit", () => {
  it("records leaf writes and the conversion", async () => {
    const { id, leafId } = await createCommand([leaf("")]);
    await server.inject({
      method: "POST",
      url: `/api/behavior-commands/${id}/convert-to-subcommands`,
      payload: { subcommand: "wake" },
    });
    const added = (await addLeaf(id, leaf("status"))).json().behavior.id;
    await patchLeaf(added, { leafDescription: "Status" });
    await deleteLeaf(added);
    const entries = (await listAudit({ limit: 4 })).reverse();
    expect(entries.map((e) => [e.action, e.target])).toEqual([
      ["behavior.command.convert", `command:${id}`],
      ["behavior.create", `behavior:${added}`],
      ["behavior.update", `behavior:${added}`],
      ["behavior.delete", `behavior:${added}`],
    ]);
    expect(entries[0]!.context).toMatchObject({ behaviorId: leafId(""), subcommand: "wake" });
    expect(entries[2]!.context).toMatchObject({
      kind: "command_leaf",
      changed: { leafDescription: { from: null, to: "Status" } },
      registration: "registered",
    });
  });
});
