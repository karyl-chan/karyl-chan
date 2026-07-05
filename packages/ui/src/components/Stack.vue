<script setup lang="ts">
/**
 * Stack — a flex layout that OWNS the gap between its children.
 *
 * Reach for this instead of hand-authoring `display:flex; flex-direction:
 * column; gap:…` (or per-element margins) in a view's scoped CSS — that
 * pattern appears hundreds of times across the app and is exactly the
 * responsibility a layout primitive should carry, not each component.
 * Because the parent Stack owns the spacing, the components inside it
 * never need (or should have) outer margins of their own.
 *
 *   <Stack gap="4">           vertical, 1rem gaps (--space-4)
 *     <VoiceCard />
 *     <AppTabs ... />
 *     <section>…</section>
 *   </Stack>
 *
 * `gap` takes a spacing-scale step (0–8 → --space-*) or a raw CSS length.
 */
import { computed, type CSSProperties } from "vue";
import {
  resolveSpace,
  ALIGN_ITEMS,
  JUSTIFY_CONTENT,
  type Align,
  type Justify,
} from "../lib/space";

const props = withDefaults(
  defineProps<{
    /** Gap between children: a scale step (0–8) or a raw CSS length. */
    gap?: string | number;
    /** Main-axis direction. Default vertical. */
    direction?: "column" | "row";
    align?: Align;
    justify?: Justify;
    /** Allow children to wrap onto multiple lines. */
    wrap?: boolean;
    /** Render as inline-flex (shrink-to-content) instead of flex. */
    inline?: boolean;
  }>(),
  {
    gap: 4,
    direction: "column",
    align: "stretch",
    justify: "start",
    wrap: false,
    inline: false,
  },
);

const style = computed<CSSProperties>(() => ({
  display: props.inline ? "inline-flex" : "flex",
  flexDirection: props.direction,
  gap: resolveSpace(props.gap),
  alignItems: ALIGN_ITEMS[props.align],
  justifyContent: JUSTIFY_CONTENT[props.justify],
  flexWrap: props.wrap ? "wrap" : "nowrap",
}));
</script>

<template>
  <div class="ui-stack" :style="style"><slot /></div>
</template>

<style scoped>
/* min-width:0 lets a column stack's children (e.g. text) truncate instead
   of forcing the stack wider than its parent. */
.ui-stack { min-width: 0; }
</style>
