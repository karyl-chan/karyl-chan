/**
 * SecretProvider abstraction + rotation-window verification (PR-5.1).
 *
 * Covers:
 *   - provider selection from SECRET_PROVIDER (default env, file, unknown)
 *   - InProcessSecretProvider env read + <ENV>_PREVIOUS rotation companion
 *   - FileSecretProvider file read, .previous file, env fallback, caching
 *   - verificationKeys() current-then-previous dedupe
 *   - verifyInboundSignatureWithKeys() dual-key acceptance + short-circuit
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InProcessSecretProvider,
  selectSecretProvider,
  verificationKeys,
  type SecretProvider,
  type RotatableSecret,
} from "../src/adapters/secret-provider.js";
// FileSecretProvider lives in its own module (keeps the fs import out of the
// abstraction).
import { FileSecretProvider } from "../src/adapters/file-secret-provider.js";
import {
  getSecretProvider,
  __resetAdaptersForTests,
} from "../src/adapters/registry.js";
import {
  signBody,
  verifyInboundSignatureWithKeys,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../src/utils/hmac.js";

const ENV_SNAPSHOT = {
  SECRET_PROVIDER: process.env.SECRET_PROVIDER,
  SECRET_DIR: process.env.SECRET_DIR,
  VOICE_HMAC_SECRET: process.env.VOICE_HMAC_SECRET,
  VOICE_HMAC_SECRET_PREVIOUS: process.env.VOICE_HMAC_SECRET_PREVIOUS,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  restoreEnv();
  __resetAdaptersForTests();
});

// ─── selection ────────────────────────────────────────────────────────────

describe("SecretProvider selection", () => {
  const createFile = (): SecretProvider => new FileSecretProvider();

  it("defaults to the in-process env provider when SECRET_PROVIDER is unset", () => {
    delete process.env.SECRET_PROVIDER;
    expect(selectSecretProvider(createFile)).toBeInstanceOf(
      InProcessSecretProvider,
    );
  });

  it("treats env / inprocess as the in-process provider", () => {
    process.env.SECRET_PROVIDER = "env";
    expect(selectSecretProvider(createFile)).toBeInstanceOf(
      InProcessSecretProvider,
    );
    process.env.SECRET_PROVIDER = "INPROCESS";
    expect(selectSecretProvider(createFile)).toBeInstanceOf(
      InProcessSecretProvider,
    );
  });

  it("selects the file provider for SECRET_PROVIDER=file", () => {
    process.env.SECRET_PROVIDER = "file";
    expect(selectSecretProvider(createFile)).toBeInstanceOf(FileSecretProvider);
  });

  it("throws on an unknown SECRET_PROVIDER", () => {
    process.env.SECRET_PROVIDER = "consul";
    expect(() => selectSecretProvider(createFile)).toThrow(
      /Unknown SECRET_PROVIDER/i,
    );
  });

  it("registry getSecretProvider memoises a single instance", () => {
    delete process.env.SECRET_PROVIDER;
    const a = getSecretProvider();
    const b = getSecretProvider();
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(InProcessSecretProvider);
  });
});

// ─── in-process provider ────────────────────────────────────────────────────

describe("InProcessSecretProvider", () => {
  it("reads the current value from the env var", () => {
    process.env.VOICE_HMAC_SECRET = "  cur  ";
    const p = new InProcessSecretProvider();
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("cur");
  });

  it("returns null for an unset / empty secret", () => {
    delete process.env.VOICE_HMAC_SECRET;
    const p = new InProcessSecretProvider();
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBeNull();
    process.env.VOICE_HMAC_SECRET = "   ";
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBeNull();
  });

  it("exposes <ENV>_PREVIOUS as the rotation-window previous value", () => {
    process.env.VOICE_HMAC_SECRET = "new";
    process.env.VOICE_HMAC_SECRET_PREVIOUS = "old";
    const r = new InProcessSecretProvider().getRotatable("VOICE_HMAC_SECRET");
    expect(r).toEqual({ current: "new", previous: "old" });
  });

  it("has a null previous when no rotation companion is set", () => {
    process.env.VOICE_HMAC_SECRET = "new";
    delete process.env.VOICE_HMAC_SECRET_PREVIOUS;
    const r = new InProcessSecretProvider().getRotatable("VOICE_HMAC_SECRET");
    expect(r).toEqual({ current: "new", previous: null });
  });
});

// ─── file provider ──────────────────────────────────────────────────────────

describe("FileSecretProvider", () => {
  function makeFs(files: Record<string, string>): (p: string) => string {
    return (p: string) => {
      const name = p.split("/").pop() as string;
      if (name in files) return files[name];
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
  }

  it("reads a secret from its file under the mount dir", () => {
    const p = new FileSecretProvider({
      dir: "/secrets",
      ttlMs: 0,
      readFile: makeFs({ VOICE_HMAC_SECRET: "from-file\n" }),
    });
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("from-file");
  });

  it("reads the .previous file for the rotation window", () => {
    const p = new FileSecretProvider({
      dir: "/secrets",
      ttlMs: 0,
      readFile: makeFs({
        VOICE_HMAC_SECRET: "cur",
        "VOICE_HMAC_SECRET.previous": "prev",
      }),
    });
    expect(p.getRotatable("VOICE_HMAC_SECRET")).toEqual({
      current: "cur",
      previous: "prev",
    });
  });

  it("falls back to env when the file is absent (partial migration)", () => {
    process.env.VOICE_HMAC_SECRET = "env-value";
    const p = new FileSecretProvider({
      dir: "/secrets",
      ttlMs: 0,
      readFile: makeFs({}),
    });
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("env-value");
  });

  it("caches file reads within the TTL and refreshes after it", () => {
    let reads = 0;
    const values: Record<string, string> = { VOICE_HMAC_SECRET: "v1" };
    let clock = 1000;
    const p = new FileSecretProvider({
      dir: "/secrets",
      ttlMs: 5000,
      now: () => clock,
      readFile: (path: string) => {
        reads++;
        const name = path.split("/").pop() as string;
        if (name in values) return values[name];
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("v1");
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("v1");
    expect(reads).toBe(1); // second call served from cache

    values.VOICE_HMAC_SECRET = "v2";
    clock += 6000; // advance past TTL
    expect(p.getSecret("VOICE_HMAC_SECRET")).toBe("v2");
    expect(reads).toBe(2);
  });
});

// ─── verificationKeys ───────────────────────────────────────────────────────

describe("verificationKeys", () => {
  const k = (s: RotatableSecret) => verificationKeys(s);

  it("returns [current] with no previous", () => {
    expect(k({ current: "a", previous: null })).toEqual(["a"]);
  });

  it("returns [current, previous] during a rotation window", () => {
    expect(k({ current: "new", previous: "old" })).toEqual(["new", "old"]);
  });

  it("dedupes when current === previous", () => {
    expect(k({ current: "same", previous: "same" })).toEqual(["same"]);
  });

  it("returns [] when the secret is entirely unset", () => {
    expect(k({ current: null, previous: null })).toEqual([]);
  });

  it("ignores an empty-string previous", () => {
    expect(k({ current: "a", previous: "" })).toEqual(["a"]);
  });
});

// ─── rotation-window verification (dual-key) ────────────────────────────────

describe("verifyInboundSignatureWithKeys (rotation window)", () => {
  const PATH = "/internal/voice/gateway-send";
  const BODY = JSON.stringify({ guildId: "g1" });

  function headersFor(secret: string, ts: string): Headers {
    const h = new Headers();
    h.set(TIMESTAMP_HEADER, ts);
    h.set(SIGNATURE_HEADER, signBody(secret, "POST", PATH, ts, null, BODY));
    return h;
  }

  const now = 1_000_000;
  const ts = now.toString();

  it("accepts a signature made with the current key", () => {
    const r = verifyInboundSignatureWithKeys(
      ["current", "previous"],
      headersFor("current", ts),
      BODY,
      now,
      "POST",
      PATH,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a signature made with the previous key (counterpart not yet rotated)", () => {
    const r = verifyInboundSignatureWithKeys(
      ["current", "previous"],
      headersFor("previous", ts),
      BODY,
      now,
      "POST",
      PATH,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a signature made with neither key", () => {
    const r = verifyInboundSignatureWithKeys(
      ["current", "previous"],
      headersFor("rogue", ts),
      BODY,
      now,
      "POST",
      PATH,
    );
    expect(r.ok).toBe(false);
  });

  it("single-key array matches the legacy single-key behaviour", () => {
    expect(
      verifyInboundSignatureWithKeys(
        ["only"],
        headersFor("only", ts),
        BODY,
        now,
        "POST",
        PATH,
      ).ok,
    ).toBe(true);
    expect(
      verifyInboundSignatureWithKeys(
        ["only"],
        headersFor("wrong", ts),
        BODY,
        now,
        "POST",
        PATH,
      ).ok,
    ).toBe(false);
  });

  it("fails closed when no key is configured", () => {
    const r = verifyInboundSignatureWithKeys(
      [],
      headersFor("anything", ts),
      BODY,
      now,
      "POST",
      PATH,
    );
    expect(r).toEqual({ ok: false, reason: "no verification key configured" });
  });

  it("short-circuits a replay-window failure without trying every key", () => {
    const stale = (now - 10_000).toString(); // outside the 300s window
    const r = verifyInboundSignatureWithKeys(
      ["current", "previous"],
      headersFor("current", stale),
      BODY,
      now,
      "POST",
      PATH,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/replay window/i);
  });
});
