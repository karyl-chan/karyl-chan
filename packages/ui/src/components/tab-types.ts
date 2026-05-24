/** Single source of truth for the `TabDef` shape consumed by both
 *  `AppTabs` (button-only) and `AppTabsRouted` (vue-router-aware). */
export interface TabDef {
  key: string;
  label: string;
  /** Optional iconify icon name shown next to the label. */
  icon?: string;
  disabled?: boolean;
}
