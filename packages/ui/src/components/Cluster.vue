<script setup lang="ts">
/**
 * Cluster — a horizontal group that wraps, owning the gap between items.
 *
 * For toolbars, tag/badge rows, button groups — anywhere items flow
 * horizontally and should wrap rather than overflow. Defaults to
 * vertically-centered, wrapping items. Pair with <Spacer /> to push a
 * trailing item to the end instead of a one-off `margin-left:auto`:
 *
 *   <Cluster>
 *     <h2>Title</h2>
 *     <Spacer />
 *     <AppButton>Action</AppButton>
 *   </Cluster>
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
    gap?: string | number;
    align?: Align;
    justify?: Justify;
    /** Wrap onto multiple lines when items don't fit. On by default —
     *  that's the whole point of a cluster. */
    wrap?: boolean;
  }>(),
  {
    gap: 3,
    align: "center",
    justify: "start",
    wrap: true,
  },
);

const style = computed<CSSProperties>(() => ({
  display: "flex",
  flexWrap: props.wrap ? "wrap" : "nowrap",
  gap: resolveSpace(props.gap),
  alignItems: ALIGN_ITEMS[props.align],
  justifyContent: JUSTIFY_CONTENT[props.justify],
}));
</script>

<template>
  <div class="ui-cluster" :style="style"><slot /></div>
</template>

<style scoped>
.ui-cluster { min-width: 0; }
</style>
