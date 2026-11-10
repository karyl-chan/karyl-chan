/**
 * The behavior reply model (#140): a webhook response is
 * `{ content?, embeds?, components?, ephemeral?, flags? }` — the plugin
 * `interactions.respond` body minus the token — and the old
 * `{ content, embeds }` is a subset of it. parseBehaviorReply turns an
 * untrusted response body into the reply the renderer posts, plus notes on
 * what it had to drop.
 */
import { describe, expect, it } from "vitest";
import {
  attachmentsProblem,
  hasVisibleReply,
  parseBehaviorReply,
  TRUNCATION_MARK,
} from "../src/modules/command-system/behavior-reply.js";

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

describe("parseBehaviorReply — phase-1 size limits", () => {
  it("cuts content over 2000 characters and marks the cut", () => {
    const { reply, notes } = parsed({ content: "a".repeat(2500) });
    expect(reply.content).toHaveLength(2000);
    expect(reply.content!.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(reply.content!.startsWith("a".repeat(2000 - TRUNCATION_MARK.length))).toBe(true);
    expect(notes).toEqual([{ kind: "content_truncated", length: 2500 }]);
  });

  it("leaves content of exactly 2000 characters alone", () => {
    const { reply, notes } = parsed({ content: "b".repeat(2000) });
    expect(reply.content).toBe("b".repeat(2000));
    expect(notes).toEqual([]);
  });

  it("drops the embeds that would take the total past 6000 characters", () => {
    const big = (title: string) => ({ title, description: "d".repeat(2500) });
    const { reply, notes } = parsed({ embeds: [big("1"), big("2"), big("3"), { title: "small" }] });
    // 2501 + 2501 = 5002; the third would make 7503, the small one still fits
    expect(reply.embeds!.map((e) => e.title)).toEqual(["1", "2", "small"]);
    expect(notes).toEqual([{ kind: "embeds_dropped", count: 1 }]);
  });

  it("counts malformed and surplus embeds as dropped", () => {
    const { reply, notes } = parsed({
      embeds: [null, "x", ...Array.from({ length: 11 }, (_, i) => ({ title: `e${i}` }))],
    });
    expect(reply.embeds).toHaveLength(10);
    expect(notes).toEqual([{ kind: "embeds_dropped", count: 3 }]);
  });

  it("ignores fields it does not know and names them", () => {
    const { reply, notes } = parsed({ content: "x", tts: true, files: [], version: 2 });
    expect(reply).toEqual({ content: "x" });
    expect(notes).toEqual([{ kind: "unknown_fields", fields: ["files", "tts", "version"] }]);
  });

  it("refuses a body that is not a JSON object", () => {
    for (const raw of [null, [], "text", 5]) {
      expect(parseBehaviorReply(raw)).toEqual({ ok: false, error: "response body is not a JSON object" });
    }
  });
});

describe("parseBehaviorReply — attachments (#156)", () => {
  it("keeps { name, path } entries, and nothing else of them", () => {
    const { reply, notes } = parsed({
      attachments: [
        { name: "chart.png", path: "/files/chart.png", extra: 1 },
        { name: "a.txt", path: "/a.txt?v=2" },
      ],
    });
    expect(reply.attachments).toEqual([
      { name: "chart.png", path: "/files/chart.png" },
      { name: "a.txt", path: "/a.txt?v=2" },
    ]);
    expect(notes).toEqual([]);
  });

  it("treats an empty list, or null, as none", () => {
    expect(parsed({ content: "x", attachments: [] }).reply).toEqual({ content: "x" });
    expect(parsed({ content: "x", attachments: null }).reply).toEqual({ content: "x" });
  });

  it("refuses the reply when the list is malformed, instead of dropping files", () => {
    for (const attachments of [
      "chart.png",
      { name: "a", path: "/a" },
      ["/a"],
      [{ name: "a" }],
      [{ path: "/a" }],
      [{ name: 1, path: "/a" }],
      [null],
    ]) {
      const out = parseBehaviorReply({ content: "x", attachments });
      expect(out.ok, JSON.stringify(attachments)).toBe(false);
      expect(!out.ok && out.error).toMatch(/^attachments: /);
    }
  });

  it("an attachments-only reply is a visible reply", () => {
    const { reply } = parsed({ attachments: [{ name: "a.png", path: "/a.png" }] });
    expect(hasVisibleReply(reply)).toBe(true);
    expect(hasVisibleReply({})).toBe(false);
  });
});

describe("attachmentsProblem — what may be fetched (#156)", () => {
  const one = (path: string, name = "f.png") => [{ name, path }];

  it("passes up to 5 files with paths on the receiver's origin", () => {
    expect(attachmentsProblem([])).toBeNull();
    expect(attachmentsProblem(one("/f.png"))).toBeNull();
    expect(attachmentsProblem(one("/dir/f.png?size=2&v=%20"))).toBeNull();
    expect(attachmentsProblem(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.png`, path: `/${i}` })))).toBeNull();
  });

  it("refuses more than 5 files", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, path: `/${i}` }));
    expect(attachmentsProblem(six)).toMatch(/at most 5/);
  });

  it("refuses a path that could leave the origin", () => {
    for (const path of [
      "https://evil.example/x.png",
      "http:/x.png",
      "//evil.example/x.png",
      "x.png",
      "",
      "/\\evil.example/x.png",
      "/a\\b.png",
      "/%2F%2Fevil.example/x.png",
      "/a%5cb.png",
      "/a b.png",
      "/a\tb.png",
      "/a\nb.png",
      "/" + "a".repeat(2048),
    ]) {
      expect(attachmentsProblem(one(path)), path).toMatch(/path/);
    }
  });

  it("refuses a name that is empty, too long, or names a directory", () => {
    for (const name of ["", " ", "a/b.png", "a\\b.png", "a\u0000.png", "x".repeat(201)]) {
      expect(attachmentsProblem(one("/f.png", name)), JSON.stringify(name)).toMatch(/name/);
    }
  });
});

describe("parseBehaviorReply — direct_messages (#157)", () => {
  const U1 = "111111111111111111";
  const U2 = "222222222222222222";

  it("reads each message with the reply's own rules", () => {
    const { reply, notes } = parsed({
      content: "done",
      direct_messages: [
        { user_id: U1, content: " hi ", attachments: [{ name: "a.png", path: "/a.png" }] },
        { user_id: U2, embeds: [{ title: "t" }], components: [linkRow("https://ok.example")], ephemeral: true },
      ],
    });
    expect(reply.direct_messages).toEqual([
      { user_id: U1, content: "hi", attachments: [{ name: "a.png", path: "/a.png" }] },
      { user_id: U2, embeds: [{ title: "t" }], components: [linkRow("https://ok.example")] },
    ]);
    expect(notes).toEqual([{ kind: "unknown_fields", fields: ["direct_messages[1].ephemeral"] }]);
  });

  it("names a dropped component under its message", () => {
    const { reply, notes } = parsed({
      direct_messages: [{ user_id: U1, content: "x", components: [linkRow("http://plain.example")] }],
    });
    expect(reply.direct_messages).toEqual([{ user_id: U1, content: "x" }]);
    expect(notes).toEqual([{ kind: "components_dropped", count: 1 }]);
  });

  it("an empty list, or null, is none; a reply of only DMs has nothing visible", () => {
    expect(parsed({ content: "x", direct_messages: [] }).reply).toEqual({ content: "x" });
    expect(parsed({ content: "x", direct_messages: null }).reply).toEqual({ content: "x" });
    expect(hasVisibleReply(parsed({ direct_messages: [{ user_id: U1, content: "x" }] }).reply)).toBe(false);
  });

  it("refuses the reply when the list can't be used, instead of dropping DMs", () => {
    const one = { user_id: U1, content: "x" };
    for (const [direct_messages, error] of [
      ["x", "direct_messages: must be an array"],
      [Array.from({ length: 6 }, () => one), "direct_messages: at most 5 messages, got 6"],
      [[null], "direct_messages: entry 1 is not an object"],
      [[{ content: "x" }], "direct_messages: entry 1: user_id must be a Discord user id"],
      [[{ user_id: "<@1>", content: "x" }], "direct_messages: entry 1: user_id must be a Discord user id"],
      [[one, { user_id: U2 }], "direct_messages: entry 2: content, embeds, components or attachments required"],
      [
        [{ user_id: U1, attachments: ["/a.png"] }],
        "direct_messages: entry 1: attachments: must be an array of { name, path } with string values",
      ],
    ] as const) {
      expect(parseBehaviorReply({ content: "x", direct_messages })).toEqual({ ok: false, error });
    }
  });
});
