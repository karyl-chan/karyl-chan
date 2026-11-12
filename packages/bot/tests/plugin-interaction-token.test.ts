/**
 * The sealed interaction token a plugin receives in its dispatch payload
 * (#215): AES-256-GCM under an HKDF subkey of ENCRYPTION_KEY, carrying the
 * Discord token, the plugin it was dispatched to and a 15-minute expiry.
 * Stateless — any process holding the same ENCRYPTION_KEY opens it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INTERACTION_TOKEN_TTL_MS,
  sealInteractionToken,
  unsealInteractionToken,
} from "../src/modules/plugin-system/plugin-interaction-token.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const RAW = "aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDpkaXNjb3JkLXRva2Vu";
const NOW = 1_800_000_000_000;

describe("sealed interaction token", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved;
  });

  it("hides the Discord token and opens back to it for its own plugin", () => {
    const sealed = sealInteractionToken(RAW, 7, NOW);
    expect(sealed).not.toContain(RAW);
    expect(unsealInteractionToken(sealed, 7, NOW)).toEqual({ ok: true, token: RAW });
  });

  it("seals the same token differently each time (fresh IV)", () => {
    expect(sealInteractionToken(RAW, 7, NOW)).not.toBe(
      sealInteractionToken(RAW, 7, NOW),
    );
  });

  it("refuses another plugin", () => {
    const sealed = sealInteractionToken(RAW, 7, NOW);
    expect(unsealInteractionToken(sealed, 8, NOW)).toEqual({
      ok: false,
      reason: "wrong_plugin",
    });
  });

  it("is good for 15 minutes after dispatch and no longer", () => {
    expect(INTERACTION_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    const sealed = sealInteractionToken(RAW, 7, NOW);
    expect(unsealInteractionToken(sealed, 7, NOW + INTERACTION_TOKEN_TTL_MS).ok).toBe(true);
    expect(unsealInteractionToken(sealed, 7, NOW + INTERACTION_TOKEN_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a tampered token", () => {
    const sealed = sealInteractionToken(RAW, 7, NOW);
    const parts = sealed.split(".");
    // flip one character of the ciphertext segment
    const ct = parts[parts.length - 1]!;
    parts[parts.length - 1] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(unsealInteractionToken(parts.join("."), 7, NOW)).toEqual({
      ok: false,
      reason: "unsealable",
    });
  });

  it("refuses a raw Discord token and other malformed strings", () => {
    for (const bad of [RAW, "", "s1.", "s1.x.y.z", "s1.abcd1234.!!.!!.!!"]) {
      expect(unsealInteractionToken(bad, 7, NOW)).toMatchObject({ ok: false });
    }
    expect(unsealInteractionToken(RAW, 7, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a token sealed under a different ENCRYPTION_KEY", () => {
    const sealed = sealInteractionToken(RAW, 7, NOW);
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(unsealInteractionToken(sealed, 7, NOW)).toEqual({
      ok: false,
      reason: "unsealable",
    });
  });

  it("keeps opening tokens sealed before a key rotation", () => {
    const sealed = sealInteractionToken(RAW, 7, NOW);
    // rotation: a new key is prepended, the old one still listed
    process.env.ENCRYPTION_KEY = `${KEY_B},${KEY_A}`;
    expect(unsealInteractionToken(sealed, 7, NOW)).toEqual({ ok: true, token: RAW });
  });

  it("opens in a fresh process that shares only ENCRYPTION_KEY (restart)", async () => {
    const sealed = sealInteractionToken(RAW, 7, Date.now());
    vi.resetModules();
    const fresh = await import(
      "../src/modules/plugin-system/plugin-interaction-token.js"
    );
    expect(fresh.unsealInteractionToken(sealed, 7)).toEqual({ ok: true, token: RAW });
  });
});
