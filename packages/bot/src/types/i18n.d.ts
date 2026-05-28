/**
 * TypeScript hook for i18next: feed it the en.json schema as the
 * resource type so `t("key")` autocompletes + compile-time-rejects
 * misspelled keys. `en.json` is the source of truth — zh-TW/zh-CN
 * must match its shape (enforced by `tests/i18n-completeness.test.ts`).
 */
import type en from "../i18n/locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
