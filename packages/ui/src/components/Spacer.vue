<script setup lang="ts">
/**
 * Spacer — an empty flex-grow filler that pushes its siblings apart
 * inside a Stack / Cluster (or any flex container), replacing the
 * one-off `margin-left:auto` / `margin-top:auto` idiom:
 *
 *   <Cluster>
 *     <Title />
 *     <Spacer />   <!-- eats the free space -->
 *     <Actions />
 *   </Cluster>
 *
 * Purely presentational, so it's hidden from the accessibility tree.
 */
</script>

<template>
  <div class="ui-spacer" aria-hidden="true"></div>
</template>

<style scoped>
.ui-spacer { flex: 1 1 auto; }
</style>
