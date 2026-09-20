<script setup lang="ts">
/**
 * Animated number, in the spirit of vue-bits' "Count Up".
 * Reimplemented in pure Vue + CSS so the renderer keeps its zero-dependency,
 * Tailwind-free, offline-packaging-friendly setup.
 */
import { onUnmounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    value: number
    /** Animation length in ms; 0 renders the value immediately. */
    duration?: number
  }>(),
  { duration: 650 }
)

const shown = ref(props.value)
let frame = 0
let from = props.value
let startedAt = 0

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function step(now: number): void {
  const progress = Math.min(1, (now - startedAt) / props.duration)
  const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
  shown.value = from + (props.value - from) * eased
  if (progress < 1) {
    frame = requestAnimationFrame(step)
  } else {
    shown.value = props.value
    frame = 0
  }
}

watch(
  () => props.value,
  (next) => {
    cancelAnimationFrame(frame)
    if (props.duration <= 0 || reducedMotion()) {
      shown.value = next
      return
    }
    from = shown.value
    startedAt = performance.now()
    frame = requestAnimationFrame(step)
  }
)

onUnmounted(() => cancelAnimationFrame(frame))
</script>

<template>
  <span class="count-up">{{ Math.round(shown) }}</span>
</template>

<style scoped>
.count-up {
  font-variant-numeric: tabular-nums; /* stop the chip width from jittering */
  display: inline-block;
  min-width: 1ch;
}
</style>
