<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div class="denied">
    <h2>Access denied</h2>
    <p>{{ message }}</p>
  </div>
</template>

<style scoped>
.denied {
  padding: 2.5rem 1.5rem;
  max-width: 540px;
  margin: 0 auto;
  text-align: center;
}
.denied h2 {
  color: var(--text-strong);
  margin-bottom: 0.5rem;
}
.denied p {
  color: var(--text-muted);
}
</style>
