import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { issueManagePair } from "../src/manage-tokens.js";
import { setSticky } from "../src/sticky-state.js";
import { registerWebRoutes } from "../src/web-routes.js";

// EXAMPLE_DB_PATH=:memory: is set by the `test` script, so every db() call in
// this process shares one in-memory sqlite — no temp files, no cleanup.

const PLUGIN_KEY = "karyl-example";
const MANAGE_CAP = "manage";
const MANAGE_CAPABILITY = `plugin:${PLUGIN_KEY}:${MANAGE_CAP}`;

async function buildServer() {
  const app = Fastify();
  await registerWebRoutes(app, PLUGIN_KEY, MANAGE_CAP);
  await app.ready();
  return app;
}

function manageToken(guildId: string | null): string {
  return issueManagePair("admin-user", [MANAGE_CAPABILITY], guildId).accessToken;
}

test("GET /api/manage/stickies refuses a cross-guild ?guildId (IDOR)", async () => {
  setSticky("guild-B", "victim", "guild B private note");
  const app = await buildServer();
  try {
    // A manager whose token is scoped to guild-A asks for guild-B's stickies.
    // The manage capability is flat, so the cap check passes — only the
    // guild-binding stops the leak. Pre-fix this returned 200 + B's rows.
    const res = await app.inject({
      method: "GET",
      url: "/api/manage/stickies?guildId=guild-B",
      headers: { authorization: `Bearer ${manageToken("guild-A")}` },
    });
    assert.equal(res.statusCode, 403);
    assert.doesNotMatch(res.body, /guild B private note/);
  } finally {
    await app.close();
  }
});

test("GET /api/manage/stickies returns the caller's own guild stickies", async () => {
  setSticky("guild-A", "self", "guild A note");
  const app = await buildServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/manage/stickies?guildId=guild-A",
      headers: { authorization: `Bearer ${manageToken("guild-A")}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { stickies: Array<{ body: string }> };
    assert.ok(body.stickies.some((s) => s.body === "guild A note"));
  } finally {
    await app.close();
  }
});

test("GET /api/manage/stickies with no ?guildId falls back to the token's guild", async () => {
  setSticky("guild-A", "self", "guild A note");
  const app = await buildServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/manage/stickies",
      headers: { authorization: `Bearer ${manageToken("guild-A")}` },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("GET /api/manage/stickies rejects a guild-less (null) manage token", async () => {
  const app = await buildServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/manage/stickies?guildId=guild-A",
      headers: { authorization: `Bearer ${manageToken(null)}` },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});
