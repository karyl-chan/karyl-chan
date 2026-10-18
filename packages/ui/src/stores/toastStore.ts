import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * Toast severity. `error` / `warn` are announced assertively
 * (role="alert"); `info` / `success` politely (role="status").
 */
export type ToastType = "error" | "warn" | "info" | "success";

export interface ToastOptions {
  /**
   * Auto-dismiss delay in ms. Default 4000. `0` makes the toast sticky:
   * it stays until the user closes it (close button) or `dismiss(id)`.
   */
  duration?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  /** Auto-dismiss delay in ms; `0` = sticky. Always set by `show()`. */
  duration?: number;
}

/** Default auto-dismiss delay, unchanged from the original store. */
export const DEFAULT_TOAST_DURATION = 4000;

let nextId = 0;

export const useToastStore = defineStore("toast", () => {
  const items = ref<ToastItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Show a toast. `type` defaults to `'error'` (the original behaviour).
   * Returns the toast id, usable with `dismiss(id)`.
   */
  function show(
    message: string,
    type: ToastType = "error",
    options: ToastOptions = {},
  ): number {
    const id = nextId++;
    const raw = options.duration ?? DEFAULT_TOAST_DURATION;
    const duration = Number.isFinite(raw) && raw > 0 ? raw : 0;
    items.value = [...items.value, { id, message, type, duration }];
    if (duration > 0) {
      timers.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    items.value = items.value.filter((t) => t.id !== id);
  }

  return { items, show, dismiss };
});
