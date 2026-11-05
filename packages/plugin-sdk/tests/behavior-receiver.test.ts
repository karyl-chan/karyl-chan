/**
 * `@karyl-chan/plugin-sdk/behavior-receiver`, against the behavior webhook
 * golden vectors it publishes (`BEHAVIOR_WEBHOOK_FIXTURES`, vendored from
 * plugin-wire's CONTRACT_FIXTURES). The bot replays the same vectors
 * through its own signer, and runs this module against its real
 * WebhookForwarder (packages/bot/tests/behavior-webhook-protocol-doc.test.ts),
 * so the two sides meet at the fixtures.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import {
  BEHAVIOR_WEBHOOK_FIXTURES as fixtures,
  createNonceStore,
  createReceiver,
  signResponse,
  verifyRequest,
  type NonceStore,
  type RequestHeaders,
} from "../src/behavior-receiver/index.js";

const signing = fixtures.signing;
type Vector = (typeof signing.requestGolden)[number];

function hmacHeaders(v: Vector, extra: RequestHeaders = {}): RequestHeaders {
  return {
    [signing.timestampHeader]: v.ts,
    [signing.nonceHeader]: v.nonce,
    [signing.signatureHeader]: v.expectedHex,
    ...extra,
  };
}

function verifyHmac(
  v: Vector,
  headers: RequestHeaders,
  options: { now?: number; nonceStore?: NonceStore } = {},
) {
  const now = options.now ?? Number(v.ts);
  return verifyRequest({
    mode: "hmac",
    secret: v.secret,
    path: v.path,
    headers,
    body: v.body,
    nonceStore: options.nonceStore ?? createNonceStore({ now: () => now }),
    now,
  });
}

describe("verifyRequest, hmac mode", () => {
  it("accepts a real request signed like the golden vectors", async () => {
    assert.ok(signing.requestGolden.length > 0);
    for (const v of signing.requestGolden) {
      assert.deepEqual(await verifyHmac(v, hmacHeaders(v)), {
        ok: true,
        test: false,
        nonce: v.nonce,
        secret: v.secret,
      });
    }
  });
});

describe("verifyRequest, hmac mode: what it refuses", () => {
  const v = signing.requestGolden[0]!;

  it("accepts a test-fire only under the test scheme", async () => {
    for (const t of signing.testGolden) {
      assert.deepEqual(
        await verifyHmac(t, hmacHeaders(t, { [signing.testHeader]: "1" })),
        {
          ok: true,
          test: true,
          nonce: t.nonce,
          secret: t.secret,
        },
      );
      // the same signature without the marker is not a real request
      assert.deepEqual(await verifyHmac(t, hmacHeaders(t)), {
        ok: false,
        reason: "signature mismatch",
      });
    }
    // nor does a real signature pass as a test
    assert.equal(
      (await verifyHmac(v, hmacHeaders(v, { [signing.testHeader]: "1" }))).ok,
      false,
    );
  });

  it("accepts the previous secret's signature during a rotation", async () => {
    const headers = hmacHeaders(v, {
      [signing.signatureHeader]: "0".repeat(64),
      [signing.previousSignatureHeader]: v.expectedHex,
    });
    assert.equal((await verifyHmac(v, headers)).ok, true);
  });

  it("refuses a replayed nonce, a stale timestamp and a changed body", async () => {
    const nonceStore = createNonceStore({ now: () => Number(v.ts) });
    assert.equal(
      (await verifyHmac(v, hmacHeaders(v), { nonceStore })).ok,
      true,
    );
    assert.deepEqual(await verifyHmac(v, hmacHeaders(v), { nonceStore }), {
      ok: false,
      reason: "replayed nonce",
    });

    const window = signing.replayWindowSeconds;
    assert.deepEqual(
      await verifyHmac(v, hmacHeaders(v), { now: Number(v.ts) + window + 1 }),
      {
        ok: false,
        reason: "stale timestamp",
      },
    );
    assert.equal(
      (await verifyHmac(v, hmacHeaders(v), { now: Number(v.ts) - window })).ok,
      true,
    );
    assert.equal(
      (await verifyHmac({ ...v, body: `${v.body} ` }, hmacHeaders(v))).ok,
      false,
    );
  });

  it("verifies the body's bytes as received", async () => {
    const result = await verifyRequest({
      mode: "hmac",
      secret: v.secret,
      path: v.path,
      headers: hmacHeaders(v),
      body: new TextEncoder().encode(v.body),
      nonceStore: createNonceStore(),
      now: Number(v.ts),
    });
    assert.equal(result.ok, true);
  });

  it("refuses missing or malformed signature headers", async () => {
    for (const drop of [
      signing.timestampHeader,
      signing.nonceHeader,
      signing.signatureHeader,
    ]) {
      const headers = { ...hmacHeaders(v), [drop]: undefined };
      assert.equal((await verifyHmac(v, headers)).ok, false, drop);
    }
    const notANumber = hmacHeaders(v, { [signing.timestampHeader]: "soon" });
    assert.deepEqual(await verifyHmac(v, notANumber), {
      ok: false,
      reason: "missing signature headers",
    });
  });

  it("refuses a header that differs in byte length only, without throwing", async () => {
    // as many characters as the real value, more bytes
    const wide = "é".repeat(v.expectedHex.length);
    assert.deepEqual(
      await verifyHmac(v, hmacHeaders(v, { [signing.signatureHeader]: wide })),
      {
        ok: false,
        reason: "signature mismatch",
      },
    );
  });

  it("reads header names in any case", async () => {
    const upper = Object.fromEntries(
      Object.entries(hmacHeaders(v)).map(([k, value]) => [
        k.toUpperCase(),
        value,
      ]),
    );
    assert.equal((await verifyHmac(v, upper)).ok, true);
  });

  it("tries each of the receiver's secrets and reports the one that verified", async () => {
    const result = await verifyRequest({
      mode: "hmac",
      secrets: ["not-it", v.secret],
      path: v.path,
      headers: hmacHeaders(v),
      body: v.body,
      nonceStore: createNonceStore(),
      now: Number(v.ts),
    });
    assert.deepEqual(result, {
      ok: true,
      test: false,
      nonce: v.nonce,
      secret: v.secret,
    });
  });
});

describe("verifyRequest, with a store of your own", () => {
  const v = signing.requestGolden[0]!;
  const options = (nonceStore: NonceStore) => ({
    mode: "hmac" as const,
    secret: v.secret,
    path: v.path,
    headers: hmacHeaders(v),
    body: v.body,
    nonceStore,
    now: Number(v.ts),
  });

  it("awaits an async store, and keeps a nonce as long as its timestamp is fresh", async () => {
    const kept = new Map<string, number>();
    const store: NonceStore = {
      has: async (n) => kept.has(n),
      set: async (n, expiresAt) => void kept.set(n, expiresAt),
    };
    assert.equal((await verifyRequest(options(store))).ok, true);
    assert.equal(kept.get(v.nonce), Number(v.ts) + signing.replayWindowSeconds);
    assert.deepEqual(await verifyRequest(options(store)), {
      ok: false,
      reason: "replayed nonce",
    });
  });

  it("takes a set that reports false as a replay (an atomic insert lost the race)", async () => {
    const store: NonceStore = { has: () => false, set: async () => false };
    assert.deepEqual(await verifyRequest(options(store)), {
      ok: false,
      reason: "replayed nonce",
    });
  });

  it("touches no store until the signature verifies", async () => {
    const touched: string[] = [];
    const store: NonceStore = {
      has: (n) => {
        touched.push(`has ${n}`);
        return false;
      },
      set: (n) => touched.push(`set ${n}`),
    };
    const forged = {
      ...options(store),
      headers: hmacHeaders(v, { [signing.signatureHeader]: "0".repeat(64) }),
    };
    assert.equal((await verifyRequest(forged)).ok, false);
    assert.deepEqual(touched, []);
  });
});

describe("verifyRequest, token mode", () => {
  const token = "t0ken";
  const verifyToken = (headers: RequestHeaders) =>
    verifyRequest({
      mode: "token",
      secret: token,
      path: "/hook",
      headers,
      body: "{}",
      nonceStore: createNonceStore(),
    });

  it("accepts the token, and passes the request nonce on", async () => {
    assert.deepEqual(
      await verifyToken({
        [signing.tokenHeader]: token,
        [signing.nonceHeader]: "n1",
      }),
      { ok: true, test: false, nonce: "n1", secret: token },
    );
  });

  it("accepts a test-fire's token only in the test header", async () => {
    const test = { [signing.testHeader]: "1" };
    assert.equal(
      (await verifyToken({ ...test, [signing.testTokenHeader]: token })).ok,
      true,
    );
    assert.equal(
      (await verifyToken({ ...test, [signing.tokenHeader]: token })).ok,
      false,
    );
    // a test token is not a real request's
    assert.equal(
      (await verifyToken({ [signing.testTokenHeader]: token })).ok,
      false,
    );
  });

  it("accepts the previous token during a rotation, real and test alike", async () => {
    const real = {
      [signing.tokenHeader]: "new",
      [signing.previousTokenHeader]: token,
    };
    assert.equal((await verifyToken(real)).ok, true);
    const test = {
      [signing.testHeader]: "1",
      [signing.testTokenHeader]: "new",
      [signing.testPreviousTokenHeader]: token,
    };
    assert.equal((await verifyToken(test)).ok, true);
  });

  it("refuses a header that differs in byte length only, without throwing", async () => {
    assert.deepEqual(
      await verifyToken({ [signing.tokenHeader]: "é".repeat(token.length) }),
      {
        ok: false,
        reason: "token mismatch",
      },
    );
    assert.equal(
      (await verifyToken({ [signing.tokenHeader]: [token, token] })).ok,
      false,
    );
  });
});

describe("an empty secret", () => {
  it("never verifies: anyone can send an empty token or sign with an empty key", async () => {
    const v = signing.requestGolden[0]!;
    const emptyKeyed = createHmac("sha256", "")
      .update(`POST:${v.path}:${v.ts}:${v.nonce}:${v.body}`)
      .digest("hex");
    const hmac = await verifyRequest({
      mode: "hmac",
      secret: "",
      path: v.path,
      headers: hmacHeaders(v, { [signing.signatureHeader]: emptyKeyed }),
      body: v.body,
      nonceStore: createNonceStore({ now: () => Number(v.ts) }),
      now: Number(v.ts),
    });
    assert.equal(hmac.ok, false);
    const token = await verifyRequest({
      mode: "token",
      secrets: ["", "t0ken"],
      path: "/hook",
      headers: { [signing.tokenHeader]: "" },
      body: "{}",
      nonceStore: createNonceStore(),
    });
    assert.equal(token.ok, false);
  });

  it("is refused when a receiver is built", () => {
    const answer = () => null;
    assert.throws(
      () =>
        createReceiver({ mode: "token", secret: "", path: "/hook", answer }),
      TypeError,
    );
    assert.throws(
      () =>
        createReceiver({ mode: "hmac", secrets: [], path: "/hook", answer }),
      TypeError,
    );
  });
});

describe("verifyRequest, mode none", () => {
  it("accepts anything, and still tells a test-fire apart", async () => {
    const result = await verifyRequest({
      mode: "none",
      path: "/hook",
      headers: { [signing.testHeader]: "1" },
      body: "{}",
    });
    assert.deepEqual(result, {
      ok: true,
      test: true,
      nonce: null,
      secret: null,
    });
  });
});

describe("createNonceStore", () => {
  it("forgets the oldest nonce once full", () => {
    const store = createNonceStore({ maxEntries: 2, now: () => 0 });
    for (const n of ["a", "b", "c"]) assert.equal(store.set(n, 100), true);
    assert.equal(store.size, 2);
    assert.equal(store.has("a"), false);
    assert.equal(store.has("b"), true);
    assert.equal(store.has("c"), true);
  });

  it("keeps a nonce through its expiry second, and refuses a live one twice", () => {
    let t = 0;
    const store = createNonceStore({ now: () => t });
    assert.equal(store.set("a", 10), true);
    assert.equal(store.set("a", 10), false);
    t = 10;
    assert.equal(store.has("a"), true);
    t = 11;
    assert.equal(store.has("a"), false);
    assert.equal(store.set("b", 20), true);
    assert.equal(store.size, 1);
  });

  it("refuses a size cap that is not a positive integer", () => {
    for (const maxEntries of [0, -1, 1.5]) {
      assert.throws(() => createNonceStore({ maxEntries }), RangeError);
    }
  });
});

describe("signResponse", () => {
  it("signs over the request's nonce, as the response vectors do", () => {
    for (const [vectors, test] of [
      [signing.responseGolden, false],
      [signing.testResponseGolden, true],
    ] as const) {
      assert.ok(vectors.length > 0);
      for (const v of vectors) {
        const headers = signResponse({
          secret: v.secret,
          path: v.path,
          nonce: v.nonce,
          test,
          body: v.body,
          now: Number(v.ts),
        });
        assert.deepEqual(
          headers,
          {
            [signing.timestampHeader]: v.ts,
            [signing.signatureHeader]: v.expectedHex,
          },
          v.name,
        );
      }
    }
  });
});

describe("createReceiver, over a socket", () => {
  const secret = "s3cret";
  const path = "/hook";
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function serve(
    receiver: Parameters<typeof createServer>[1],
  ): Promise<number> {
    server = createServer(receiver);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  /** The bot's side of the scheme, written out from the protocol page. */
  const hmac = (key: string, text: string) =>
    createHmac("sha256", key).update(text).digest("hex");

  function signedHeaders(
    body: string,
    opts: { test?: boolean; key?: string } = {},
  ) {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const prefix = opts.test ? signing.testPrefix : "";
    return {
      [signing.timestampHeader]: ts,
      [signing.nonceHeader]: nonce,
      [signing.signatureHeader]: hmac(
        opts.key ?? secret,
        `${prefix}POST:${path}:${ts}:${nonce}:${body}`,
      ),
      ...(opts.test ? { [signing.testHeader]: "1" } : {}),
    };
  }

  interface Answer {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }

  function post(
    port: number,
    headers: Record<string, string>,
    body: string,
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  /** True when `answer` is signed over the request nonce, as the bot checks it. */
  function signedOver(answer: Answer, nonce: string, test = false): boolean {
    const ts = answer.headers[signing.timestampHeader];
    const prefix = test ? signing.testPrefix : "";
    return (
      typeof ts === "string" &&
      answer.headers[signing.signatureHeader] ===
        hmac(secret, `${prefix}POST:${path}:${ts}:${nonce}:${answer.body}`)
    );
  }

  const payload = JSON.stringify({
    content: "!hi",
    username: "mika",
    avatar_url: "",
    _meta: {},
  });

  it("answers a verified request with a reply signed over its nonce", async () => {
    const seen: unknown[] = [];
    const port = await serve(
      createReceiver({
        mode: "hmac",
        secret,
        path,
        answer: (p, ctx) => {
          seen.push([p.username, ctx.test]);
          return { content: ctx.test ? "test ok" : `hello ${p.username}` };
        },
      }),
    );
    for (const test of [false, true]) {
      const headers = signedHeaders(payload, { test });
      const answer = await post(port, headers, payload);
      assert.equal(answer.status, 200);
      assert.deepEqual(JSON.parse(answer.body), {
        content: test ? "test ok" : "hello mika",
      });
      assert.ok(
        signedOver(answer, headers[signing.nonceHeader]!, test),
        `test=${test}`,
      );
    }
    assert.deepEqual(seen, [
      ["mika", false],
      ["mika", true],
    ]);
  });

  it("signs an empty body when the answer is no reply", async () => {
    const port = await serve(
      createReceiver({ mode: "hmac", secret, path, answer: () => null }),
    );
    const headers = signedHeaders(payload);
    const answer = await post(port, headers, payload);
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "");
    assert.ok(signedOver(answer, headers[signing.nonceHeader]!));
  });

  it("refuses an unverified request with 401, without calling answer", async () => {
    let called = false;
    const port = await serve(
      createReceiver({
        mode: "hmac",
        secret,
        path,
        answer: () => ((called = true), null),
      }),
    );
    const answer = await post(
      port,
      signedHeaders(payload, { key: "other" }),
      payload,
    );
    assert.equal(answer.status, 401);
    assert.equal(called, false);
  });

  it("answers what it cannot handle with an error status, and stays up", async () => {
    const port = await serve(
      createReceiver({
        mode: "hmac",
        secret,
        path,
        maxBodyBytes: 1024,
        answer: (p) => {
          if (p.content === "boom") throw new Error("boom");
          return { content: "ok" };
        },
      }),
    );
    // authenticated, but not JSON
    assert.equal(
      (await post(port, signedHeaders("not json"), "not json")).status,
      400,
    );
    // over the size cap
    const big = JSON.stringify({ content: "x".repeat(2048) });
    assert.equal((await post(port, signedHeaders(big), big)).status, 413);
    // answer throws
    const boom = JSON.stringify({ content: "boom" });
    assert.equal((await post(port, signedHeaders(boom), boom)).status, 500);
    // and still up
    assert.equal(
      (await post(port, signedHeaders(payload), payload)).status,
      200,
    );
  });

  /**
   * A body sent in many chunks, with or without a content-length, and how
   * the request ended: the status, or the client-side error (a reset).
   */
  function postInChunks(
    port: number,
    chunks: number,
    chunkBytes: number,
    declareLength: boolean,
  ): Promise<number | string> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = declareLength
        ? { "content-length": String(chunks * chunkBytes) }
        : { "transfer-encoding": "chunked" };
      const req = request(
        { host: "127.0.0.1", port, path, method: "POST", headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", (err: NodeJS.ErrnoException) =>
        resolve(err.code ?? err.message),
      );
      const chunk = Buffer.alloc(chunkBytes, "x");
      let sent = 0;
      const writeMore = () => {
        while (sent < chunks) {
          sent += 1;
          if (!req.write(chunk)) return void req.once("drain", writeMore);
        }
        req.end();
      };
      writeMore();
    });
  }

  it("answers a body over the cap with 413, never a reset", async () => {
    const port = await serve(
      createReceiver({
        mode: "hmac",
        secret,
        path,
        maxBodyBytes: 1024,
        answer: () => null,
      }),
    );
    // 8 MiB in 64 KiB chunks: far more than one read
    assert.equal(
      await postInChunks(port, 128, 64 * 1024, true),
      413,
      "content-length",
    );
    assert.equal(
      await postInChunks(port, 128, 64 * 1024, false),
      413,
      "chunked",
    );
    // and still up
    assert.equal(
      (await post(port, signedHeaders(payload), payload)).status,
      200,
    );
  });

  it("answers unsigned in mode none", async () => {
    const port = await serve(
      createReceiver({ mode: "none", path, answer: () => ({ content: "hi" }) }),
    );
    const answer = await post(port, {}, payload);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers[signing.signatureHeader], undefined);
  });
});
