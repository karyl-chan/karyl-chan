/**
 * en.json is the source-of-truth schema for translation keys (the
 * TypeScript hook in `src/types/i18n.d.ts` derives the TranslationKey
 * union from it). zh-TW and zh-CN must mirror the same key structure
 * or runtime lookups will fall back to en silently.
 *
 * The bot's `handleMissingKey` throws in `NODE_ENV=test`, so any test
 * that hits a missing key would already fail — but most tests don't
 * exercise the full set. This test does, explicitly, by flattening
 * each JSON to dot-paths and asserting parity.
 */
import { describe, expect, it } from "vitest";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import zhTW from "../src/i18n/locales/zh-TW.json" with { type: "json" };
import zhCN from "../src/i18n/locales/zh-CN.json" with { type: "json" };

function flatKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flatKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

const enKeys = new Set(flatKeys(en));

describe("i18n locale completeness", () => {
  it("zh-TW has every key en has (no fallback in production)", () => {
    const missing = [...enKeys].filter(
      (k) => !flatKeys(zhTW).includes(k),
    );
    expect(missing).toEqual([]);
  });

  it("zh-CN has every key en has", () => {
    const missing = [...enKeys].filter(
      (k) => !flatKeys(zhCN).includes(k),
    );
    expect(missing).toEqual([]);
  });

  it("zh-TW has no extra keys not in en (en is source of truth)", () => {
    const extra = flatKeys(zhTW).filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });

  it("zh-CN has no extra keys not in en", () => {
    const extra = flatKeys(zhCN).filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });
});
