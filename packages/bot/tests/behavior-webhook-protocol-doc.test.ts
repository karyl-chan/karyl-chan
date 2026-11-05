/**
 * docs/features/behavior-webhook-protocol.md, checked against the protocol
 * so the document cannot drift from it:
 *
 *   - the header names, payload keys and reply limits it states match
 *     `CONTRACT_FIXTURES` (@karyl-chan/plugin-wire);
 *   - its reference receiver is run exactly as published — the
 *     `// receiver.mjs` code block is cut out of the Markdown and imported
 *     — against the golden vectors, and against the bot's real
 *     WebhookForwarder over a real socket (the host policy is stubbed to
 *     vouch for 127.0.0.1, which it otherwise refuses).
 *
 * The prose and the wiring example are not checked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/utils/host-policy.js", () => ({
  resolveWebhookTarget: vi.fn(async (u: string | URL) => ({
    url: new URL(u),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  })),
  HostPolicyError: class HostPolicyError extends Error {},
}));

import { CONTRACT_FIXTURES, type HmacGoldenVector } from "@karyl-chan/plugin-wire";
import {
  PREVIOUS_SIGNATURE_HEADER,
  PREVIOUS_TOKEN_HEADER,
  WebhookForwarder,
} from "../src/modules/command-system/webhook-forwarder.service.js";
import { encryptSecret } from "../src/utils/crypto.js";
import type { BehaviorWebhookActionRow } from "../src/modules/behavior/models/behavior-webhook-action.model.js";

// ── the published receiver ───────────────────────────────────────────────────

type Headers = Record<string, string | undefined>;
type Verdict = { ok: true; test: boolean; nonce: string } | { ok: false; reason: string };
interface Receiver {
  verifyRequest(input: {
    mode: "hmac" | "token";
    secret: string;
    path: string;
    headers: Headers;
    body: string;
    seen: Map<string, number>;
    now?: number;
  }): Verdict;
  signResponse(input: {
    secret: string;
    path: string;
    nonce: string;
    test: boolean;
    body: string;
    now?: number;
  }): Record<string, string>;
  createReceiver(options: {
    mode: "hmac" | "token";
    secret: string;
    path: string;
    answer: (payload: Record<string, unknown>, ctx: { test: boolean }) => unknown;
  }): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

const DOC = fileURLToPath(new URL("../docs/features/behavior-webhook-protocol.md", import.meta.url));

function publishedMarkdown(): string {
  return readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
}

/** One `## heading` section of the protocol document. */
function docSection(heading: string): string {
  const markdown = publishedMarkdown();
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`no "## ${heading}" in ${DOC}`);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

/** The `// receiver.mjs` code block of the protocol document, verbatim. */
function publishedReceiverSource(): string {
  const markdown = publishedMarkdown();
  const blocks = [...markdown.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const source = blocks.find((b) => b.startsWith("// receiver.mjs"));
  if (!source) throw new Error(`no "// receiver.mjs" js block in ${DOC}`);
  return source;
}

let receiver: Receiver;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "karyl-receiver-"));
  const file = path.join(tempDir, "receiver.mjs");
  writeFileSync(file, publishedReceiverSource());
  receiver = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Receiver;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const contract = CONTRACT_FIXTURES.behaviorWebhook;
const signing = contract.signing;

// ── what the page states ────────────────────────────────────────────────────

describe("the protocol document, against the contract fixtures", () => {
  it("names exactly the headers the bot sends", () => {
    const named = new Set(
      // `X-Name` or `X-Name: value`
      [...publishedMarkdown().matchAll(/`(X-[A-Za-z-]+)(?::[^`]*)?`/g)].map((m) =>
        m[1]!.toLowerCase(),
      ),
    );
    const sent = new Set([
      ...signing.requestHeaders.hmac,
      ...signing.requestHeaders.token,
      signing.testHeader,
      signing.testTokenHeader,
      signing.testPreviousTokenHeader,
      PREVIOUS_TOKEN_HEADER,
      PREVIOUS_SIGNATURE_HEADER,
    ]);
    expect([...named].sort()).toEqual([...sent].sort());
  });

  it("lists every payload key", () => {
    const section = docSection("The request");
    for (const key of contract.request.topLevelKeys) expect(section).toContain(`\`${key}\``);
    for (const key of [...contract.request.patternMetaKeys, ...contract.request.slashMetaKeys]) {
      expect(section, key).toContain(`\`_meta.${key}\``);
    }
    expect(section).toContain(`{ ${contract.request.userKeys.join(", ")} }`);
    expect(section).toContain(`[{ ${contract.request.attachmentKeys.join(", ")} }]`);
  });

  it("states the reply fields and limits the fixtures define", () => {
    const section = docSection("The reply (contract v1)");
    const r = contract.response;
    for (const field of r.fields) expect(section, field).toContain(`| \`${field}\` |`);
    for (const field of r.embedWhitelist) expect(section, field).toContain(`\`${field}\``);
    expect(section).toContain(`Over ${r.maxContentLength} characters`);
    expect(section).toContain(`at most ${r.maxFields} fields`);
    expect(section).toContain(`At most ${r.maxEmbeds} embeds and ${r.maxEmbedTotalLength} characters`);
    expect(section).toContain(`At most ${r.maxComponentRows} rows of ${r.maxButtonsPerRow} buttons`);
    expect(section).toContain(`**${r.maxBodyBytes / 1024} KiB**`);
    for (const flag of r.allowedFlags) expect(section).toContain(`(${flag})`);
  });
});

// ── golden vectors ──────────────────────────────────────────────────────────
// a behavior webhook is always a POST; the shared scheme's GET vector is a plugin RPC's
const requestGolden = CONTRACT_FIXTURES.hmac.golden.filter((v) => v.method === "POST");

function hmacHeaders(v: HmacGoldenVector, extra: Headers = {}): Headers {
  return {
    "x-karyl-timestamp": v.ts,
    "x-karyl-nonce": v.nonce,
    "x-karyl-signature": v.expectedHex,
    ...extra,
  };
}

function verify(
  v: HmacGoldenVector,
  headers: Headers,
  seen = new Map<string, number>(),
  now = Number(v.ts),
) {
  return receiver.verifyRequest({
    mode: "hmac",
    secret: v.secret,
    path: v.path,
    headers,
    body: v.body,
    seen,
    now,
  });
}

describe("the published reference receiver, against the golden vectors", () => {
  it("accepts a real request signed like the golden vectors", () => {
    expect(requestGolden.length).toBeGreaterThan(0);
    for (const v of requestGolden) {
      expect(verify(v, hmacHeaders(v)), v.name).toEqual({ ok: true, test: false, nonce: v.nonce });
    }
  });

  it("accepts a test-fire only under the test scheme", () => {
    for (const v of signing.testGolden) {
      expect(verify(v, hmacHeaders(v, { [signing.testHeader]: "1" }))).toEqual({
        ok: true,
        test: true,
        nonce: v.nonce,
      });
      // the same signature without the marker is not a real request
      expect(verify(v, hmacHeaders(v)).ok).toBe(false);
    }
    // nor does a real signature pass as a test
    const real = requestGolden[0]!;
    expect(verify(real, hmacHeaders(real, { [signing.testHeader]: "1" })).ok).toBe(false);
  });

  it("accepts the previous secret's signature during a rotation", () => {
    const v = requestGolden[0]!;
    const headers = hmacHeaders(v, {
      "x-karyl-signature": "0".repeat(64),
      "x-karyl-signature-previous": v.expectedHex,
    });
    expect(verify(v, headers).ok).toBe(true);
  });

  it("refuses a header that differs in byte length only, without throwing", () => {
    // as many characters as the real value, more bytes: timingSafeEqual on
    // the two buffers would throw a RangeError
    const v = requestGolden[0]!;
    const wide = "é".repeat(v.expectedHex.length);
    expect(verify(v, hmacHeaders(v, { "x-karyl-signature": wide })).ok).toBe(false);
    const token = receiver.verifyRequest({
      mode: "token",
      secret: "t0ken",
      path: "/hook",
      headers: { "x-plugin-webhook-token": "é".repeat("t0ken".length) },
      body: "{}",
      seen: new Map(),
    });
    expect(token.ok).toBe(false);
  });

  it("refuses a replayed nonce, a stale timestamp and a changed body", () => {
    const v = requestGolden[0]!;
    const seen = new Map<string, number>();
    expect(verify(v, hmacHeaders(v), seen).ok).toBe(true);
    expect(verify(v, hmacHeaders(v), seen)).toEqual({ ok: false, reason: "replayed nonce" });

    expect(verify(v, hmacHeaders(v), new Map(), Number(v.ts) + 301).ok).toBe(false);
    expect(verify({ ...v, body: `${v.body} ` }, hmacHeaders(v)).ok).toBe(false);
  });

  it("signs a response over the request's nonce, as the response vectors do", () => {
    for (const [vectors, test] of [
      [signing.responseGolden, false],
      [signing.testResponseGolden, true],
    ] as const) {
      for (const v of vectors) {
        const headers = receiver.signResponse({
          secret: v.secret,
          path: v.path,
          nonce: v.nonce,
          test,
          body: v.body,
          now: Number(v.ts),
        });
        expect(headers, v.name).toEqual({
          "x-karyl-timestamp": v.ts,
          "x-karyl-signature": v.expectedHex,
        });
      }
    }
  });
});

// ── against the bot's own forwarder ─────────────────────────────────────────

describe("the published reference receiver, against the bot's WebhookForwarder", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function serve(mode: "hmac" | "token", secret: string): Promise<string> {
    server = createServer(
      receiver.createReceiver({
        mode,
        secret,
        path: "/hook",
        answer: (payload, { test }) =>
          test ? { content: "test ok" } : { content: `hello ${String(payload.username)}` },
      }),
    );
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://receiver.test:${(server.address() as AddressInfo).port}/hook`;
  }

  function action(
    url: string,
    authMode: "hmac" | "token",
    secret: string,
    previous: string | null = null,
  ): BehaviorWebhookActionRow {
    return {
      behaviorId: 1,
      url: encryptSecret(url),
      secret: encryptSecret(secret),
      authMode,
      previousSecret: previous === null ? null : encryptSecret(previous),
      previousSecretExpiresAt: previous === null ? null : new Date(Date.now() + 60_000),
    };
  }

  const payload = { content: "!hi", username: "mika", avatar_url: "", _meta: {} };

  it("answers a real hmac request with a response the bot verifies", async () => {
    const url = await serve("hmac", "s3cret");
    const result = await new WebhookForwarder().forward(action(url, "hmac", "s3cret"), payload);
    expect(result).toMatchObject({ ok: true, verified: "hmac", reply: { content: "hello mika" } });
  });

  it("tells a test-fire apart and still signs it acceptably", async () => {
    const url = await serve("hmac", "s3cret");
    const result = await new WebhookForwarder().forward(action(url, "hmac", "s3cret"), payload, {
      test: true,
    });
    expect(result).toMatchObject({ ok: true, verified: "hmac", reply: { content: "test ok" } });
  });

  it("keeps working on the old secret through a rotation's grace period", async () => {
    const url = await serve("hmac", "old-secret");
    const result = await new WebhookForwarder().forward(
      action(url, "hmac", "new-secret", "old-secret"),
      payload,
    );
    expect(result).toMatchObject({ ok: true, verified: "hmac", reply: { content: "hello mika" } });
  });

  it("keeps working on the old token through a rotation's grace period", async () => {
    const url = await serve("token", "old-t0ken");
    const forwarder = new WebhookForwarder();
    const rotated = action(url, "token", "new-t0ken", "old-t0ken");
    expect(await forwarder.forward(rotated, payload)).toMatchObject({
      ok: true,
      verified: "token",
      reply: { content: "hello mika" },
    });
    expect(await forwarder.forward(rotated, payload, { test: true })).toMatchObject({
      ok: true,
      verified: "token",
      reply: { content: "test ok" },
    });
  });

  it("works in token mode, response signature included", async () => {
    const url = await serve("token", "t0ken");
    const forwarder = new WebhookForwarder();
    expect(await forwarder.forward(action(url, "token", "t0ken"), payload)).toMatchObject({
      ok: true,
      verified: "token",
      reply: { content: "hello mika" },
    });
    expect(
      await forwarder.forward(action(url, "token", "t0ken"), payload, { test: true }),
    ).toMatchObject({ ok: true, reply: { content: "test ok" } });
  });

  /** A raw POST, so a test can send what the bot never would. */
  function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
    const { port, pathname } = new URL(url);
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: pathname, method: "POST", headers },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("answers a malformed request with an error status instead of crashing", async () => {
    const url = await serve("token", "t0ken");
    // non-ASCII characters, as many as the token has
    expect(await rawPost(url, { "x-plugin-webhook-token": "é".repeat(5) }, "{}")).toBe(401);
    // an authenticated body that is not JSON
    expect(await rawPost(url, { "x-plugin-webhook-token": "t0ken" }, "not json")).toBe(400);
    // and the receiver is still up
    expect(
      await new WebhookForwarder().forward(action(url, "token", "t0ken"), payload),
    ).toMatchObject({ ok: true });
  });

  it("is refused by the receiver when the secret is wrong", async () => {
    const url = await serve("hmac", "s3cret");
    const result = await new WebhookForwarder().forward(action(url, "hmac", "other"), payload);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});
