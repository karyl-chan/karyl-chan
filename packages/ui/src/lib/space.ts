/**
 * Spacing helpers for the layout primitives (Stack / Cluster / Spacer).
 *
 * `gap` and friends take a spacing-scale STEP (0–8, as a number or
 * string) which maps to the corresponding `--space-*` token defined in
 * tokens.css, or a raw CSS length (e.g. `"2px"`, `"1.5rem"`) as an
 * escape hatch. Keeping the scale in tokens.css means the whole app
 * shares one rhythm instead of 200 hand-picked gap values.
 */

/** Steps that exist as `--space-N` tokens in tokens.css. */
const STEPS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);

/** Resolve a gap/space prop to a CSS length: a scale step → `var(--space-N)`,
 *  anything else → the value verbatim (raw CSS length escape hatch). */
export function resolveSpace(
  value: string | number | undefined,
  fallback = "0",
): string {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value);
  return STEPS.has(s) ? `var(--space-${s})` : s;
}

export type Align = "start" | "center" | "end" | "stretch" | "baseline";
export type Justify = "start" | "center" | "end" | "between" | "around";

/** Friendly `align` prop → CSS `align-items` value. */
export const ALIGN_ITEMS: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

/** Friendly `justify` prop → CSS `justify-content` value. */
export const JUSTIFY_CONTENT: Record<Justify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
};
