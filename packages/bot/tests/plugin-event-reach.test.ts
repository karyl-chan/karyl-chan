/**
 * PM-8 — dispatch-time event reach enforcement.
 *
 * The bridge must deliver a feature-scoped subscription only to guilds
 * where the owning feature is effectively enabled, deliver approved
 * global subscriptions regardless of guild, withhold unapproved global
 * subscriptions entirely (no route at index build), and never match a
 * feature route on a guild-less (DM) event. DB-backed via sqlite
 * :memory; HTTP fan-out path observed by spying on the dispatch pool
 * (the bridge posts via undici, not fetch; host-policy mocked open so
 * the gate is the only thing standing between event and POST).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
});

// Open the SSRF gate so postEventToPlugin reaches the fetch spy.
vi.mock("../src/modules/plugin-system/plugin-dispatch-util.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    preflightPluginTarget: vi.fn().mockResolvedValue({ ok: true }),
  };
});

import { sequelize } from "../src/db.js";
import { Plugin } from "../src/modules/plugin-system/models/plugin.model.js";
import {
  PluginGuildFeature,
  upsertFeatureRow,
} from "../src/modules/feature-toggle/models/plugin-guild-feature.model.js";
import { PluginFeatureDefault } from "../src/modules/feature-toggle/models/plugin-feature-default.model.js";
import { featureReachResolver } from "../src/modules/feature-toggle/feature-reach-resolver.js";
import {
  rebuildEventIndex,
  dispatchEventToPlugins,
  __resetEventBusForTests,
  __getDispatchPoolForTests,
} from "../src/modules/plugin-system/plugin-event-bridge.service.js";
import type { PluginManifest } from "../src/modules/plugin-system/plugin-sdk-types.js";

const GUILD_ON = "900000000000000111";
const GUILD_OFF = "900000000000000222";

async function seedPlugin(opts: {
  id: number;
  key: string;
  manifest: Partial<PluginManifest>;
  approvedGlobalEventSubs?: string[];
}): Promise<void> {
  const manifest: PluginManifest = {
    schema_version: "1",
    plugin: {
      id: opts.key,
      name: opts.key,
      version: "1.0.0",
      url: `http://${opts.key}.invalid`,
    },
    ...opts.manifest,
  } as PluginManifest;
  await Plugin.create({
    id: opts.id,
    pluginKey: opts.key,
    name: opts.key,
    version: "1.0.0",
    url: `http://${opts.key}.invalid`,
    enabled: true,
    status: "active",
    manifestJson: JSON.stringify(manifest),
    setupSecretHash: "h",
    tokenHash: null,
    dispatchHmacKey: "k",
    lastHeartbeatAt: null,
    approvedGlobalEventSubs: JSON.stringify(opts.approvedGlobalEventSubs ?? []),
  } as Record<string, unknown>);
}

let postSpy: ReturnType<typeof vi.spyOn>;

function dispatchedUrls(): string[] {
  return postSpy.mock.calls.map((c) => String(c[1]));
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Plugin.destroy({ where: {}, truncate: true });
  await PluginGuildFeature.destroy({ where: {} });
  await PluginFeatureDefault.destroy({ where: {} });
  featureReachResolver.clear();
  __resetEventBusForTests();
  postSpy = vi
    .spyOn(__getDispatchPoolForTests(), "post")
    .mockResolvedValue({ ok: true, status: 204, bodyText: "" });
});

afterEach(() => {
  postSpy.mockRestore();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

describe("PM-8 dispatch reach gate (HTTP fan-out)", () => {
  it("delivers a feature-scoped event only where the owning feature is enabled", async () => {
    await seedPlugin({
      id: 1,
      key: "feat-plugin",
      manifest: {
        guild_features: [
          {
            key: "watcher",
            name: "watcher",
            enabled_by_default: false,
            events_subscribed: ["guild.message_create"],
          },
        ],
      },
    });
    await upsertFeatureRow({
      pluginId: 1,
      guildId: GUILD_ON,
      featureKey: "watcher",
      enabled: true,
    });
    await rebuildEventIndex();

    dispatchEventToPlugins("guild.message_create", { guild_id: GUILD_ON }, GUILD_ON);
    await settle();
    expect(dispatchedUrls().some((u) => u.includes("feat-plugin"))).toBe(true);

    postSpy.mockClear();
    dispatchEventToPlugins("guild.message_create", { guild_id: GUILD_OFF }, GUILD_OFF);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("manifest enabled_by_default=true reaches guilds with no explicit row", async () => {
    await seedPlugin({
      id: 1,
      key: "default-on",
      manifest: {
        guild_features: [
          {
            key: "watcher",
            name: "watcher",
            enabled_by_default: true,
            events_subscribed: ["guild.message_create"],
          },
        ],
      },
    });
    await rebuildEventIndex();
    dispatchEventToPlugins("guild.message_create", { guild_id: GUILD_OFF }, GUILD_OFF);
    await settle();
    expect(postSpy).toHaveBeenCalled();
  });

  it("a feature route never matches a guild-less (DM) event", async () => {
    await seedPlugin({
      id: 1,
      key: "feat-plugin",
      manifest: {
        guild_features: [
          {
            key: "watcher",
            name: "watcher",
            enabled_by_default: true,
            events_subscribed: ["dm.message_create"],
          },
        ],
      },
    });
    await rebuildEventIndex();
    dispatchEventToPlugins("dm.message_create", { hi: 1 }, null);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("approved global subscriptions deliver regardless of guild; unapproved get nothing", async () => {
    // Auto-approve is ON by default in tests — flip it off via the
    // persisted column path by seeding with/without approval and
    // stubbing config? The config is boot-frozen; instead assert the
    // auto-approve=true semantics here (declared = granted) and the
    // route-level filtering in event-index tests (collectEventRoutes).
    await seedPlugin({
      id: 1,
      key: "global-plugin",
      manifest: {
        events_subscribed_global: ["dm.message_create"],
      },
    });
    await rebuildEventIndex();
    dispatchEventToPlugins("dm.message_create", { hi: 1 }, null);
    await settle();
    expect(dispatchedUrls().some((u) => u.includes("global-plugin"))).toBe(
      true,
    );
  });

  it("feature toggle changes take effect after resolver invalidation", async () => {
    await seedPlugin({
      id: 1,
      key: "feat-plugin",
      manifest: {
        guild_features: [
          {
            key: "watcher",
            name: "watcher",
            enabled_by_default: false,
            events_subscribed: ["guild.message_create"],
          },
        ],
      },
    });
    await rebuildEventIndex();
    dispatchEventToPlugins("guild.message_create", { guild_id: GUILD_ON }, GUILD_ON);
    await settle();
    expect(postSpy).not.toHaveBeenCalled();

    // Admin enables the feature → mutation route would call
    // invalidateGuild; simulate the same sequence.
    await upsertFeatureRow({
      pluginId: 1,
      guildId: GUILD_ON,
      featureKey: "watcher",
      enabled: true,
    });
    featureReachResolver.invalidateGuild(1, GUILD_ON);
    dispatchEventToPlugins("guild.message_create", { guild_id: GUILD_ON }, GUILD_ON);
    await settle();
    expect(postSpy).toHaveBeenCalled();
  });
});
