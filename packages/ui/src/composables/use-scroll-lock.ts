import { onBeforeUnmount, watch, type Ref } from "vue";

/**
 * Ref-counted `<body>` scroll lock shared by every overlay that wants the
 * page behind it frozen (AppModal today). Stacked modals each take a
 * lock; the body is only restored when the LAST holder releases, so
 * closing the top modal of two doesn't unfreeze the page under the one
 * still open.
 *
 * While locked, `overflow: hidden` is set on <body> and the vanished
 * scrollbar's width is added to its right padding so content doesn't
 * jump sideways. The original inline values are restored on release.
 */
let holders = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function acquire() {
  if (typeof document === "undefined") return;
  holders++;
  if (holders > 1) return;
  const body = document.body;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;
  const scrollbar =
    window.innerWidth - document.documentElement.clientWidth;
  if (scrollbar > 0) {
    const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + scrollbar}px`;
  }
  body.style.overflow = "hidden";
}

function release() {
  if (typeof document === "undefined" || holders === 0) return;
  holders--;
  if (holders > 0) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPaddingRight;
}

/**
 * Hold a body scroll lock while `active` is true. Released automatically
 * when `active` turns false or the owning component unmounts.
 */
export function useBodyScrollLock(active: Ref<boolean>): void {
  let held = false;
  const set = (on: boolean) => {
    if (on === held) return;
    held = on;
    if (on) acquire();
    else release();
  };
  watch(active, set, { immediate: true });
  onBeforeUnmount(() => set(false));
}

/** Test-only: current number of lock holders. */
export function _scrollLockHolders(): number {
  return holders;
}
