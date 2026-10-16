/**
 * Focus helpers for dialog-style overlays (focus-in on open, Tab trap,
 * focus restore on close).
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

function isVisible(el: HTMLElement): boolean {
  if (el.closest("[hidden], [inert]")) return false;
  // `checkVisibility` covers display:none / visibility:hidden ancestors.
  // Environments without it (older engines, jsdom) count it as visible.
  const check = (el as HTMLElement & { checkVisibility?: () => boolean })
    .checkVisibility;
  return typeof check === "function" ? check.call(el) : true;
}

/** Tabbable descendants of `container`, in DOM order. */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.tabIndex >= 0 && isVisible(el));
}

/**
 * Keep Tab / Shift+Tab cycling inside `container`. Call from the
 * container's keydown handler; returns true when it handled the key.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement): boolean {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  const items = getFocusable(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && container.contains(active);
  if (event.shiftKey) {
    if (!inside || active === first || active === container) {
      event.preventDefault();
      last.focus();
      return true;
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
