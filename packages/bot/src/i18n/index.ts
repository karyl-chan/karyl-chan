/**
 * Backend i18n for Discord-facing replies.
 *
 * Locale resolution: `interaction.locale` → `interaction.guildLocale`
 * → `"en"`. Each step is validated against `SUPPORTED_LOCALES`;
 * anything outside the set falls through to the next step. Discord
 * sends tags like `zh-TW`, `en-US`, `ja` — we map them to `en` /
 * `zh-TW` / `zh-CN`.
 *
 * Frontend has its own vue-i18n setup at `frontend/src/i18n/`.
 * Backend keeps an independent copy of the resolver + JSON files
 * because the bot doesn't import frontend code at runtime.
 */
import i18next, { type ParseKeys, type TFunction } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import zhTW from "./locales/zh-TW.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import type { LocalizationMap } from "discord.js";

export const SUPPORTED_LOCALES = ["en", "zh-TW", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: SupportedLocale = "en";

/** All translation keys i18next knows about, derived from en.json's shape. */
export type TranslationKey = ParseKeys;

// i18next maps each Discord locale tag onto its own resource bundle.
// Discord uses `en-US` / `en-GB` etc.; we collapse to `en`.
void i18next.init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  resources: {
    en: { translation: en },
    "zh-TW": { translation: zhTW },
    "zh-CN": { translation: zhCN },
  },
  interpolation: { escapeValue: false },
  // Loud-fail in tests; warn in prod. The `missingKey` handler is
  // wired in `installMissingKeyHandler()` below because pino is loaded
  // lazily on first call (avoids a boot-order loop with logger.ts).
  saveMissing: true,
  missingKeyHandler: handleMissingKey,
});

function handleMissingKey(
  lngs: readonly string[],
  _ns: string,
  key: string,
): void {
  // Tests: hard fail so missing translations don't ship undetected.
  if (process.env.NODE_ENV === "test") {
    throw new Error(`i18n: missing key "${key}" for locale "${lngs[0]}"`);
  }
  // Prod / dev: warn through console (logger module would create a
  // circular import — i18n module loads very early in the boot path).
  // eslint-disable-next-line no-console
  console.warn(
    `[i18n] missing key "${key}" for locale "${lngs[0]}" — falling back to ${DEFAULT_LOCALE}`,
  );
}

function isSupportedLocale(tag: string): tag is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

/**
 * Map an arbitrary BCP-47 tag (Discord sends `en-US`, `zh-TW`, `ja`,
 * etc.) to one of our supported locales. Script subtags (Hant/Hans)
 * are honored before region heuristics.
 */
function normalizeTag(tag: string | null | undefined): SupportedLocale | null {
  if (!tag) return null;
  if (isSupportedLocale(tag)) return tag;
  const n = tag.toLowerCase();
  if (n.startsWith("en")) return "en";
  if (n.startsWith("zh")) {
    if (n.includes("hant") || /-(tw|hk|mo)\b/.test(n)) return "zh-TW";
    if (n.includes("hans") || /-(cn|sg|my)\b/.test(n)) return "zh-CN";
    // Bare "zh" — default to Simplified (more common globally).
    return "zh-CN";
  }
  return null;
}

/**
 * Resolve a discord.js Interaction (or any object exposing `locale` +
 * optional `guildLocale`) to one of our supported locales.
 *
 * Fallback chain:
 *   1. interaction.locale (user's Discord client locale)
 *   2. interaction.guildLocale (server preferred locale, when present)
 *   3. "en"
 */
export function resolveLocale(interaction: {
  locale?: string | null;
  guildLocale?: string | null;
}): SupportedLocale {
  const fromUser = normalizeTag(interaction.locale);
  if (fromUser) return fromUser;
  const fromGuild = normalizeTag(interaction.guildLocale);
  if (fromGuild) return fromGuild;
  return DEFAULT_LOCALE;
}

/**
 * Translate `key` to `locale`. `vars` is the i18next `{{var}}`
 * interpolation bag. Returns the key itself on miss (i18next default).
 */
export function t(
  locale: SupportedLocale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  // Force the (key, options) overload — passing vars as the second
  // positional makes TS pick (key, defaultValue: string) instead.
  return i18next.getFixedT(locale)(key, { ...vars });
}

/**
 * Convenience: resolve locale + translate in one call. Use when you
 * have the interaction directly.
 */
export function tForInteraction(
  interaction: { locale?: string | null; guildLocale?: string | null },
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  return t(resolveLocale(interaction), key, vars);
}

/**
 * Build a Discord `LocalizationMap` for `key` covering every supported
 * locale. Use in `registerInProcessCommand({ data: { description_localizations: localizedDescriptions("…") } })`.
 * Discord uses `en-US` (not `en`) as its English key, so we expand on
 * the way out.
 */
export function localizedDescriptions(
  key: TranslationKey,
  vars?: Record<string, string | number>,
): LocalizationMap {
  return {
    "en-US": t("en", key, vars),
    "zh-TW": t("zh-TW", key, vars),
    "zh-CN": t("zh-CN", key, vars),
  } as LocalizationMap;
}

/**
 * Canonical English string for `key` — paired with
 * `localizedDescriptions` so the same i18n source feeds both the
 * `description` (canonical) and `description_localizations` (map)
 * fields of a Discord ApplicationCommandData.
 */
export function describeEn(
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  return t("en", key, vars);
}

// Re-export the TFunction type for handlers that prefer to receive a
// pre-bound translator from the dispatcher (uncommon — most handlers
// just call `tForInteraction(interaction, key)`).
export type { TFunction };
