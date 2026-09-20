<script setup lang="ts">
/**
 * Text with a slow specular sweep, in the spirit of vue-bits' "Shiny Text".
 * Pure CSS: a moving gradient clipped to the glyphs.
 */
withDefaults(defineProps<{ text: string; speed?: number }>(), { speed: 4 })
</script>

<template>
  <span class="shiny-text" :style="{ '--shiny-duration': `${speed}s` }">{{ text }}</span>
</template>

<style scoped>
.shiny-text {
  background-image: linear-gradient(100deg, var(--text) 38%, #ffffff 50%, var(--text) 62%);
  background-size: 260% 100%;
  background-position: 120% 0;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: shiny-sweep var(--shiny-duration, 4s) linear infinite;
}

@keyframes shiny-sweep {
  0% {
    background-position: 120% 0;
  }
  55%,
  100% {
    background-position: -120% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .shiny-text {
    animation: none;
    background-image: none;
    color: var(--text);
  }
}
</style>
