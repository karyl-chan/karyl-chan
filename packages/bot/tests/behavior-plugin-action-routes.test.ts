/**
 * #203 — a behavior's action may be a plugin action instead of a webhook,
 * through the same write routes:
 *
 *   - a message trigger and a command leaf bind `{ pluginKey, actionKey }`
 *     (POST /api/behaviors, POST /api/behavior-commands, POST …/leaves)
 *   - the binding is checked against the plugin's current manifest: an
 *     action it does not declare, or a plugin that declares none, is
 *     refused on the field
 *   - a body gives exactly one action: neither or both is refused
 *   - PATCH converts between sources: the other kind's row goes and
 *     actionSource follows; a webhook given anew issues a new secret
 *   - GET /api/behaviors/plugin-actions lists the installed plugins'
 *     declared actions (the admin UI's picker)
 *   - the served schema carries pluginAction, and no longer requires webhook
 *
 * The catalog is the production one over the same SQLite (plugin rows
 * with manifests), injected as module-routes.ts does.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { sequelize } from "../src/db.js";
import { registerBehaviorRoutes } from "../src/modules/behavior/behavior-routes.js";
import { listAudit } from "../src/modules/admin/admin-audit.service.js";
import { CommandNamespace } from "../src/modules/command-system/command-namespace.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import { pluginBehaviorActionCatalog } from "../src/modules/plugin-system/plugin-behavior-actions.js";
import { BehaviorPluginAction } from "../src/modules/behavior/models/behavior-plugin-action.model.js";
import { BehaviorWebhookAction } from "../src/modules/behavior/models/behavior-webhook-action.model.js";
import { clearBehaviors } from "./behavior-fixtures.js";
import { restoreCommand, snapshotCommand } from "../src/modules/behavior/command-snapshot.js";

const HOOK = "https://203.0.113.10/hook";

let server: FastifyInstance;

async function seedPlugin(
  pluginKey: string,
  actions: Array<{ key: string; name: string; description: string }>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await Plugin.create({
    pluginKey,
    name: `${pluginKey} plugin`,
    version: "1.0.0",
    url: `http://${pluginKey}:3000`,
    manifestJson: JSON.stringify({
      schema_version: "1",
      plugin: { id: pluginKey, name: `${pluginKey} plugin`, version: "1.0.0", url: `http://${pluginKey}:3000` },
      ...(actions.length > 0 ? { behavior_actions: actions } : {}),
    }),
    status: "active",
    enabled: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  server = Fastify({ logger: false });
  server.addHook("onRequest", async (request) => {
    request.authUserId = "admin";
    request.authCapabilities = new Set(["behavior.manage"]) as never;
  });
  await registerBehaviorRoutes(server, {
    namespace: new CommandNamespace(),
    plugins: pluginBehaviorActionCatalog,
  });
  await server.ready();
});

beforeEach(async () => {
  await clearBehaviors();
  await Plugin.destroy({ where: {} });
  await seedPlugin("dice", [
    { key: "roll", name: "Roll dice", description: "Rolls the dice in the message" },
    { key: "flip", name: "Flip a coin", description: "Heads or tails" },
  ]);
});

const ROLL = { pluginKey: "dice", actionKey: "roll" };

const dmTrigger = {
  title: "roll",
  surface: "bot_dm",
  patternKind: "startswith",
  patternValue: "!roll",
};

function inject(method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>) {
  return server.inject({ method, url, ...(payload ? { payload } : {}) });
}

describe("binding a plugin action", () => {
  it("creates a message trigger bound to a declared action, with no webhook", async () => {
    const res = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: ROLL });
    expect(res.statusCode).toBe(201);
    const { behavior } = res.json();
    expect(behavior).toMatchObject({ actionSource: "plugin", pluginAction: ROLL, webhook: null });
    expect(res.json()).not.toHaveProperty("secret");
    expect(await BehaviorWebhookAction.count()).toBe(0);
    const audit = (await listAudit({ limit: 1 }))[0]!;
    expect(audit.context).toMatchObject({ pluginAction: ROLL });
  });

  it("creates a command whose leaf is bound to a declared action", async () => {
    const res = await inject("POST", "/api/behavior-commands", {
      name: "roll",
      description: "Roll dice",
      registration: "global",
      leaves: [{ title: "Roll", pluginAction: ROLL }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().command.leaves[0]).toMatchObject({ actionSource: "plugin", pluginAction: ROLL, webhook: null });
  });

  it("adds a subcommand bound to a plugin action beside a webhook one", async () => {
    const created = await inject("POST", "/api/behavior-commands", {
      name: "tools",
      description: "Tools",
      registration: "global",
      leaves: [{ subcommand: "hook", title: "Hook", webhook: { url: HOOK } }],
    });
    const commandId = created.json().command.id as number;
    const res = await inject("POST", `/api/behavior-commands/${commandId}/leaves`, {
      subcommand: "flip",
      title: "Flip",
      pluginAction: { pluginKey: "dice", actionKey: "flip" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().behavior).toMatchObject({ actionSource: "plugin", pluginAction: { actionKey: "flip" } });
    expect(res.json().command.leaves.map((l: { actionSource: string }) => l.actionSource)).toEqual(["webhook", "plugin"]);
  });

  it("refuses an action the plugin does not declare, on the field", async () => {
    const res = await inject("POST", "/api/behaviors", {
      ...dmTrigger,
      pluginAction: { pluginKey: "dice", actionKey: "explode" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "validation_failed", field: "pluginAction.actionKey" });
    expect(await BehaviorPluginAction.count()).toBe(0);
  });

  it("refuses a plugin that is not installed or declares no actions", async () => {
    await seedPlugin("quiet", []);
    for (const pluginKey of ["nope", "quiet"]) {
      const res = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: { pluginKey, actionKey: "roll" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: "validation_failed", field: "pluginAction.pluginKey" });
    }
  });

  it("allows a disabled plugin's declared action: being offline is a run-time failure", async () => {
    await seedPlugin("sleepy", [{ key: "nap", name: "Nap", description: "zzz" }], { enabled: false, status: "inactive" });
    const res = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: { pluginKey: "sleepy", actionKey: "nap" } });
    expect(res.statusCode).toBe(201);
  });

  it("refuses a leaf's undeclared action at its own path", async () => {
    const res = await inject("POST", "/api/behavior-commands", {
      name: "roll",
      description: "Roll dice",
      registration: "global",
      leaves: [{ title: "Roll", pluginAction: { pluginKey: "dice", actionKey: "nope" } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.field).toBe("leaves.0.pluginAction.actionKey");
  });

  it("takes exactly one action: neither or both is refused", async () => {
    const neither = await inject("POST", "/api/behaviors", dmTrigger);
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error.field).toBe("webhook");
    const both = await inject("POST", "/api/behaviors", { ...dmTrigger, webhook: { url: HOOK }, pluginAction: ROLL });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.field).toBe("pluginAction");
  });

  it("refuses a malformed binding through the schema", async () => {
    const res = await inject("POST", "/api/behaviors", {
      ...dmTrigger,
      pluginAction: { pluginKey: "dice", actionKey: "Roll Dice", extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("converting between sources (PATCH)", () => {
  it("webhook → plugin action: the webhook row goes, actionSource follows", async () => {
    const created = await inject("POST", "/api/behaviors", { ...dmTrigger, webhook: { url: HOOK, authMode: "hmac" } });
    const id = created.json().behavior.id as number;
    const res = await inject("PATCH", `/api/behaviors/${id}`, { pluginAction: ROLL });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior).toMatchObject({ actionSource: "plugin", pluginAction: ROLL, webhook: null });
    expect(await BehaviorWebhookAction.count()).toBe(0);
    const audit = (await listAudit({ limit: 1 }))[0]!;
    expect(audit.context).toMatchObject({ actionSource: { from: "webhook", to: "plugin" }, pluginAction: ROLL });
  });

  it("plugin action → webhook: a new secret is issued, the binding goes", async () => {
    const created = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: ROLL });
    const id = created.json().behavior.id as number;
    const res = await inject("PATCH", `/api/behaviors/${id}`, { webhook: { url: HOOK, authMode: "hmac" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior).toMatchObject({ actionSource: "webhook", pluginAction: null, webhook: { url: HOOK, secretSet: true } });
    expect(res.json().secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await BehaviorPluginAction.count()).toBe(0);
  });

  it("re-binds a command leaf to another action, re-checked against the manifest", async () => {
    const created = await inject("POST", "/api/behavior-commands", {
      name: "roll",
      description: "Roll dice",
      registration: "global",
      leaves: [{ title: "Roll", webhook: { url: HOOK } }],
    });
    const leafId = created.json().command.leaves[0].id as number;
    const bad = await inject("PATCH", `/api/behaviors/${leafId}`, { pluginAction: { pluginKey: "dice", actionKey: "nope" } });
    expect(bad.statusCode).toBe(400);
    const res = await inject("PATCH", `/api/behaviors/${leafId}`, { pluginAction: { pluginKey: "dice", actionKey: "flip" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().behavior).toMatchObject({ actionSource: "plugin", pluginAction: { actionKey: "flip" }, webhook: null });
  });

  it("an edit that leaves the action alone keeps the binding", async () => {
    const created = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: ROLL });
    const id = created.json().behavior.id as number;
    const res = await inject("PATCH", `/api/behaviors/${id}`, { title: "roll it" });
    expect(res.json().behavior).toMatchObject({ title: "roll it", actionSource: "plugin", pluginAction: ROLL });
  });

  it("deleting the behavior removes its binding", async () => {
    const created = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: ROLL });
    const id = created.json().behavior.id as number;
    const res = await server.inject({ method: "DELETE", url: `/api/behaviors/${id}` });
    expect(res.statusCode).toBe(204);
    expect(await BehaviorPluginAction.count()).toBe(0);
  });

  it("test-fire refuses a plugin action (it has no webhook)", async () => {
    const created = await inject("POST", "/api/behaviors", { ...dmTrigger, pluginAction: ROLL });
    const res = await inject("POST", `/api/behaviors/${created.json().behavior.id}/test`);
    expect(res.statusCode).toBe(400);
  });
});

describe("a refused command write's restore", () => {
  it("puts a leaf's plugin action binding back", async () => {
    const created = await inject("POST", "/api/behavior-commands", {
      name: "roll",
      description: "Roll dice",
      registration: "global",
      leaves: [{ title: "Roll", pluginAction: ROLL }],
    });
    const command = created.json().command as { id: number; leaves: Array<{ id: number }> };
    const snapshot = await snapshotCommand(command.id);
    await inject("PATCH", `/api/behaviors/${command.leaves[0]!.id}`, { webhook: { url: HOOK } });
    expect(await BehaviorPluginAction.count()).toBe(0);

    await restoreCommand(snapshot);

    expect(await BehaviorPluginAction.count()).toBe(1);
    expect(await BehaviorWebhookAction.count()).toBe(0);
  });
});

describe("GET /api/behaviors/plugin-actions", () => {
  it("lists installed plugins that declare actions, disabled ones too, with their state", async () => {
    await seedPlugin("quiet", []);
    await seedPlugin("sleepy", [{ key: "nap", name: "Nap", description: "zzz" }], { enabled: false, status: "inactive" });
    const res = await inject("GET", "/api/behaviors/plugin-actions");
    expect(res.statusCode).toBe(200);
    expect(res.json().plugins).toEqual([
      {
        pluginKey: "dice",
        pluginName: "dice plugin",
        enabled: true,
        status: "active",
        actions: [
          { key: "roll", name: "Roll dice", description: "Rolls the dice in the message" },
          { key: "flip", name: "Flip a coin", description: "Heads or tails" },
        ],
      },
      { pluginKey: "sleepy", pluginName: "sleepy plugin", enabled: false, status: "inactive", actions: [{ key: "nap", name: "Nap", description: "zzz" }] },
    ]);
  });
});

describe("GET /api/behaviors/schema", () => {
  it("serves pluginAction beside webhook, neither required", async () => {
    const { messageTrigger, command, commandLeaf } = (await inject("GET", "/api/behaviors/schema")).json();
    for (const schema of [messageTrigger, command.properties.leaves.items, commandLeaf]) {
      expect(schema.properties.pluginAction.required).toEqual(["pluginKey", "actionKey"]);
      expect(schema.required).not.toContain("webhook");
    }
  });
});
