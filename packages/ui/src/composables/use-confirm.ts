import { ref } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: "primary" | "danger";
  cancelLabel?: string;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

const pending = ref<PendingConfirm | null>(null);

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Only one global confirm can be on screen. A newer request
      // supersedes the old one — settle the old promise as "not
      // confirmed" so its awaiter doesn't hang forever.
      const superseded = pending.value;
      pending.value = { options: opts, resolve };
      superseded?.resolve(false);
    });
  }

  function handleConfirm() {
    pending.value?.resolve(true);
    pending.value = null;
  }

  function handleClose() {
    pending.value?.resolve(false);
    pending.value = null;
  }

  return { pending, confirm, handleConfirm, handleClose };
}
