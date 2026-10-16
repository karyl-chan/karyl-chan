/**
 * Shared WAI-ARIA tabs keyboard model for `AppTabs` and `AppTabsRouted`:
 * roving tabindex + ArrowLeft/ArrowRight (ArrowUp/ArrowDown on vertical
 * lists) / Home / End, skipping disabled tabs and wrapping at the ends.
 * Activation is automatic — moving focus selects the tab.
 */
import type { TabDef } from "./tab-types";

export type TabOrientation = "horizontal" | "vertical";

/** Key of the tab that should be in the Tab sequence (tabindex=0). */
export function rovingTabKey(
  tabs: readonly TabDef[],
  selected: string | undefined,
): string | undefined {
  if (selected !== undefined && tabs.some((t) => t.key === selected && !t.disabled)) {
    return selected;
  }
  return tabs.find((t) => !t.disabled)?.key;
}

/**
 * Key of the tab a navigation key moves to, or null when the key isn't a
 * tab-navigation key (or there is nowhere to go).
 */
export function nextTabKey(
  tabs: readonly TabDef[],
  current: string | undefined,
  key: string,
  orientation: TabOrientation = "horizontal",
): string | null {
  const enabled = tabs.filter((t) => !t.disabled);
  if (enabled.length === 0) return null;

  const forward =
    key === "ArrowRight" || (orientation === "vertical" && key === "ArrowDown");
  const backward =
    key === "ArrowLeft" || (orientation === "vertical" && key === "ArrowUp");

  if (key === "Home") return enabled[0].key;
  if (key === "End") return enabled[enabled.length - 1].key;
  if (!forward && !backward) return null;

  const idx = enabled.findIndex((t) => t.key === current);
  if (idx === -1) return forward ? enabled[0].key : enabled[enabled.length - 1].key;
  const step = forward ? 1 : -1;
  return enabled[(idx + step + enabled.length) % enabled.length].key;
}

/**
 * keydown handler for a `role="tablist"` element whose tabs carry
 * `data-tab-key`. Moves focus to the target tab and calls `activate`.
 */
export function onTablistKeydown(
  event: KeyboardEvent,
  tabs: readonly TabDef[],
  activate: (key: string) => void,
  orientation: TabOrientation = "horizontal",
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabEl = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    '[role="tab"]',
  );
  if (!tabEl) return;
  const current = tabEl.dataset.tabKey;
  const next = nextTabKey(tabs, current, event.key, orientation);
  if (next === null) return;
  event.preventDefault();
  const list = event.currentTarget as HTMLElement;
  const target = Array.from(
    list.querySelectorAll<HTMLElement>('[role="tab"]'),
  ).find((el) => el.dataset.tabKey === next);
  target?.focus();
  if (next !== current) activate(next);
}
