// @karyl-chan/ui — shared Vue UI for karyl-chan bot frontend and plugin webuis.
//
// Side-effect CSS imports must be done separately by the consumer (so they
// can choose order and avoid double-importing):
//   import "@karyl-chan/ui/tokens.css";
//   import "@karyl-chan/ui/reset.css";
//   import "@karyl-chan/ui/use-drawer.css";
//   import "@karyl-chan/ui/use-popover.css";

// ── Components ───────────────────────────────────────────────────────────
export { default as AppButton } from "./components/AppButton.vue";
export { default as AppConfirmDialog } from "./components/AppConfirmDialog.vue";
export { default as AppMenu } from "./components/AppMenu.vue";
export { default as AppMenuItem } from "./components/AppMenuItem.vue";
export { default as AppModal } from "./components/AppModal.vue";
export { default as AppPopover } from "./components/AppPopover.vue";
export { default as AppSelect } from "./components/AppSelect.vue";
export { default as AppSelectField } from "./components/AppSelectField.vue";
export type { SelectOption } from "./components/AppSelectField.vue";
export { default as AppTabs } from "./components/AppTabs.vue";
export type { TabDef } from "./components/AppTabs.vue";
// AppTabsRouted carries a vue-router dependency. Importing it from a
// plugin SPA that doesn't have vue-router installed will fail at build
// time — that's the intended boundary. The non-routed AppTabs above
// has no such dependency.
export { default as AppTabsRouted } from "./components/AppTabsRouted.vue";
export { default as AppToast } from "./components/AppToast.vue";
export { default as Draggable } from "./components/Draggable.vue";
export { default as GlobalConfirmDialog } from "./components/GlobalConfirmDialog.vue";
export { default as UnreadPill } from "./components/UnreadPill.vue";

// ── Composables ──────────────────────────────────────────────────────────
export {
  useAppShell,
  provideAppShell,
  useFlushMain,
  useOverlayExtras,
} from "./composables/use-app-shell";
export type { AppShellContext, OverlayView } from "./composables/use-app-shell";
export { useBreakpoint } from "./composables/use-breakpoint";
export { useClickOutsideStack } from "./composables/use-click-outside-stack";
export { useConfirm } from "./composables/use-confirm";
export type { ConfirmOptions } from "./composables/use-confirm";
export { useDrawer } from "./composables/use-drawer";
export type { DrawerPlacement, UseDrawerOptions } from "./composables/use-drawer";
export { useEscapeStack } from "./composables/use-escape-stack";
export { useFileDrop } from "./composables/use-file-drop";
export type { FileDropHandlers } from "./composables/use-file-drop";
export { useLongPress } from "./composables/use-long-press";
export { usePopover } from "./composables/use-popover";
export type { Placement, UsePopoverOptions } from "./composables/use-popover";
export { useShiftKey } from "./composables/use-shift-key";

// ── Stores ───────────────────────────────────────────────────────────────
export { useToastStore } from "./stores/toastStore";
export type { ToastItem } from "./stores/toastStore";
