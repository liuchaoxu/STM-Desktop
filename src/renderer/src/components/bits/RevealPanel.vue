<script setup lang="ts">
/**
 * Height-agnostic reveal, the "expand in place" motion used by vue-bits'
 * accordions and animated lists.
 *
 * Uses `grid-template-rows: 0fr -> 1fr` instead of measuring `scrollHeight` in
 * JavaScript: it animates smoothly at any content height, needs no listeners,
 * and — importantly — keeps its content mounted, so a half-edited form is never
 * thrown away when the panel collapses.
 */
withDefaults(defineProps<{ open?: boolean }>(), { open: false })
</script>

<template>
  <div class="reveal" :class="{ 'reveal-open': open }">
    <div class="reveal-clip">
      <div class="reveal-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.reveal-open {
  grid-template-rows: 1fr;
}

.reveal-clip {
  overflow: hidden;
  min-height: 0;
}

.reveal-body {
  opacity: 0;
  transform: translateY(-6px);
  transition:
    opacity 0.22s ease 0.05s,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1) 0.05s;
}

.reveal-open .reveal-body {
  opacity: 1;
  transform: none;
}
</style>
