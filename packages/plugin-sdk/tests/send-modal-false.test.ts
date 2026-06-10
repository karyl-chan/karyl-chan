/**
 * ctx.sendModal() is documented (and typed Promise<boolean>) to "surface
 * a bot rejection as false" — e.g. the interaction already expired or was
 * deferred (common during a bot restart). callBotRpc THROWS on any non-2xx
 * (it never returns null), so the old `if (res !== null) … return false`
 * made `return false` dead code: a rejection propagated as a throw, which
 * skipped the handler's post-sendModal code and logged a misleading
 * "command handler threw" error. This locks the documented false-on-reject
 * contract.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createPluginServer } from "../src/server.js";
import { sign, TIMESTAMP_HEADER,
  NONCE_HEADER,
  generateNonce, SIGNATURE_HEADER } from "../src/hmac.js";
import { definePluginCommand } from "../src/plugin.js";

const SECRET = "dispatch-secret";

describe("ctx.sendModal returns false when the bot rejects the modal", () => {
  it("surfaces a 4xx send_modal as false (not a throw)", async () => {
    let resolveSent!: (v: boolean | "THREW") => void;
    const sentP = new Promise<boolean | "THREW">((r) => {
      resolveSent = r;
    });

    const cmd = definePluginCommand({
      name: "openmodal",
      description: "opens a modal",
      scope: "guild",
      integrationTypes: ["guild_install"],
      contexts: ["Guild"],
      modal: true,
      handler: async (ctx) => {
        // The test observes what sendModal does: with the fix it returns
        // false; on main it throws (caught here as "THREW").
        try {
          const sent = await ctx.sendModal({
            custom_id: "m",
            title: "T",
            components: [],
          });
          resolveSent(sent);
        } catch {
          resolveSent("THREW");
        }
        return "";
      },
    });

    const realFetch = globalThis.fetch;
    // send_modal → 400 so callBotRpc throws; any other RPC → 204.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      url: string | URL,
    ) => {
      if (String(url).includes("interactions.send_modal")) {
        return new Response("rejected", { status: 400 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const server = createPluginServer({
      pluginKey: "p",
      botUrl: "http://bot",
      getToken: () => "tok",
      getDispatchHmacKey: () => SECRET,
      pluginCommands: [cmd],
    });

    try {
      await server.ready();

      const body = JSON.stringify({
        command_name: "openmodal",
        interaction_id: "i1",
        interaction_token: "t1",
        user: { id: "u1" },
        member: { capabilities: [] },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = generateNonce();
      const path = "/commands/openmodal";
      const res = await server.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: ts,
          [NONCE_HEADER]: nonce,
          [SIGNATURE_HEADER]: sign(SECRET, "POST", path, ts, nonce, body),
        },
        payload: body,
      });
      // The dispatch route 204s immediately; the handler runs after.
      assert.equal(res.statusCode, 204);

      const sent = await Promise.race([
        sentP,
        new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 3000)),
      ]);
      // Fixed: false. On main: "THREW" (sendModal propagated the BotRpcError).
      assert.equal(sent, false);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
      await server.close();
    }
  });
});
