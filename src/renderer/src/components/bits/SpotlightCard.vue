<script setup lang="ts">
/**
 * Card with a pointer-following highlight, in the spirit of vue-bits'
 * "Spotlight Card". The highlight is a pointer-events-free pseudo element, so
 * the card's own content stays fully interactive.
 *
 * Pointer updates are coalesced into one animation frame: reading
 * getBoundingClientRect() on every mousemove would force a layout flush at
 * pointer frequency and make the whole list feel heavy.
 */
import { onUnmounted, ref } from 'vue'

const host = ref<HTMLElement | null>(null)
let pending: MouseEvent | null = null
let frame = 0

function apply(): void {
  frame = 0
  const node = host.value
  const event = pending
  pending = null
  if (!node || !event) return
  const rect = node.getBoundingClientRect()
  node.style.setProperty('--spot-x', `${event.clientX - rect.left}px`)
  node.style.setProperty('--spot-y', `${event.clientY - rect.top}px`)
  node.style.setProperty('--spot-opacity', '1')
}

function onMove(event: MouseEvent): void {
  pending = event
  if (frame === 0) frame = requestAnimationFrame(apply)
}

function onLeave(): void {
  pending = null
  if (frame !== 0) {
    cancelAnimationFrame(frame)
    frame = 0
  }
  host.value?.style.setProperty('--spot-opacity', '0')
}

onUnmounted(() => {
  if (frame !== 0) cancelAnimationFrame(frame)
})
</script>

<template>
  <div ref="host" class="spotlight-card" @mousemove="onMove" @mouseleave="onLeave">
    <slot />
  </div>
</template>

<style scoped>
.spotlight-card {
  position: relative;
}

.spotlight-card::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: var(--spot-opacity, 0);
  transition: opacity 0.3s ease;
  background: radial-gradient(
    260px circle at var(--spot-x, 50%) var(--spot-y, 50%),
    rgba(79, 140, 255, 0.16),
    transparent 68%
  );
}

@media (prefers-reduced-motion: reduce) {
  .spotlight-card::after {
    display: none;
  }
}
</style>
