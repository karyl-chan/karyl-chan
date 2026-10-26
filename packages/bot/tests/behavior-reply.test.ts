/**
 * The behavior reply model (#140): a webhook response is
 * `{ content?, embeds?, components?, ephemeral?, flags? }` — the plugin
 * `interactions.respond` body minus the token — and the old
 * `{ content, embeds }` is a subset of it. parseBehaviorReply turns an
 * untrusted response body into the reply the renderer posts, plus notes on
 * what it had to drop.
 */
import { describe, expect, it } from "vitest";
import { parseBehaviorReply } from "../src/modules/command-system/behavior-reply.js";

function parsed(raw: unknown) {
  const out = parseBehaviorReply(raw);
  if (!out.ok) throw new Error(`expected ok, got ${out.error}`);
  return out;
}

const linkRow = (url: string, label = "Open") => ({
  type: 1,
  components: [{ type: 2, style: 5, url, label }],
});

describe("parseBehaviorReply — the v1 shape", () => {
  it("accepts the old { content, embeds } unchanged", () => {
    const { reply, notes } = parsed({ content: " hi ", embeds: [{ title: "t" }] });
    expect(reply).toEqual({ content: "hi", embeds: [{ title: "t" }] });
    expect(notes).toEqual([]);
  });

  it("carries ephemeral and https link buttons", () => {
    const { reply, notes } = parsed({
      content: "x",
      ephemeral: false,
      components: [linkRow("https://nas.example/login?otp=1", "Log in")],
    });
    expect(reply.ephemeral).toBe(false);
    expect(reply.components).toEqual([
      { type: 1, components: [{ type: 2, style: 5, url: "https://nas.example/login?otp=1", label: "Log in" }] },
    ]);
    expect(notes).toEqual([]);
  });

  it("drops buttons that are not https link buttons, and rows left empty", () => {
    const { reply, notes } = parsed({
      content: "x",
      components: [
        linkRow("http://nas.example/plain-http"),
        { type: 1, components: [{ type: 2, style: 1, custom_id: "kc:x", label: "Click" }] },
        { type: 1, components: [{ type: 3, custom_id: "menu", options: [] }] },
        { type: 1, components: [{ type: 2, style: 5, url: "https://ok.example", label: "" }] },
        linkRow("https://ok.example", "Fine"),
        "garbage",
      ],
    });
    expect(reply.components).toEqual([linkRow("https://ok.example", "Fine")]);
    expect(notes).toEqual([{ kind: "components_dropped", count: 5 }]);
  });

  it("keeps at most 5 rows of 5 buttons", () => {
    const row = {
      type: 1,
      components: Array.from({ length: 7 }, (_, i) => ({
        type: 2,
        style: 5,
        url: `https://x.example/${i}`,
        label: `b${i}`,
      })),
    };
    const { reply, notes } = parsed({ content: "x", components: Array.from({ length: 6 }, () => row) });
    expect(reply.components).toHaveLength(5);
    expect(reply.components!.every((r) => r.components.length === 5)).toBe(true);
    expect(notes).toEqual([{ kind: "components_dropped", count: 6 * 7 - 25 }]);
  });

  it("keeps only the SuppressEmbeds and SuppressNotifications flags", () => {
    expect(parsed({ content: "x", flags: 4 | 4096 }).reply.flags).toBe(4 | 4096);
    const { reply, notes } = parsed({ content: "x", flags: 64 | 4 });
    expect(reply.flags).toBe(4);
    expect(notes).toEqual([{ kind: "flags_dropped", flags: 64 }]);
  });

  it("ignores a known field of the wrong type and says so", () => {
    const { reply, notes } = parsed({ content: 5, ephemeral: "yes", embeds: "no", flags: "4" });
    expect(reply).toEqual({});
    expect(notes).toEqual([
      { kind: "invalid_field", field: "content" },
      { kind: "invalid_field", field: "embeds" },
      { kind: "invalid_field", field: "ephemeral" },
      { kind: "invalid_field", field: "flags" },
    ]);
  });

  it("an empty object is an empty reply", () => {
    expect(parsed({})).toEqual({ ok: true, reply: {}, notes: [] });
  });
});
