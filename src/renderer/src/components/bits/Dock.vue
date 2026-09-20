<script setup lang="ts">
/**
 * Dock — ported from Vue Bits (<https://vue-bits.dev/components/dock>).
 *
 * A row of items that grow as the pointer sweeps across them, on spring physics.
 * The magnification maths lives in `DockItem`; this component owns the panel, the
 * pointer position and the reduced-motion fallback.
 *
 * Adaptations for a **top** toolbar (upstream is a bottom macOS-style dock):
 *
 * 1. Items are anchored to the top of the panel and grow **downward**, and the
 *    panel reserves the magnified height up front. If the sticky bar changed
 *    height on hover it would push the whole page down and back on every pass of
 *    the pointer.
 * 2. `variant="pill"` (default) keeps each action's label visible; upstream's
 *    icon-only squares are still available with `variant="icon"`, which is when
 *    the tooltip earns its place.
 * 3. `prefers-reduced-motion` pins every item at its base size.
 */
import { useMotionValue } from 'motion-v'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import DockItem, { type DockItemData } from './DockItem.vue'

const props = withDefaults(
  defineProps<{
    items: DockItemData[]
    variant?: 'pill' | 'icon'
    /** Item height (pill) or side (icon) at rest. */
    baseSize?: number
    /** Size an item grows to directly under the pointer. */
    magnification?: number
    /** How far the growth reaches, in px. */
    distance?: number
    gap?: number
    spring?: { mass?: number; stiffness?: number; damping?: number }
  }>(),
  {
    variant: 'pill',
    baseSize: 28,
    magnification: 38,
    distance: 110,
    gap: 5,
    spring: () => ({ mass: 0.1, stiffness: 170, damping: 14 })
  }
)

const mouseX = useMotionValue(Infinity)
const reducedMotion = ref(false)

onMounted(() => {
  reducedMotion.value = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
})

onUnmounted(() => mouseX.set(Infinity))

const effectiveMagnification = computed(() =>
  reducedMotion.value ? props.baseSize : props.magnification
)

/** Reserved so the sticky bar never changes height while the pointer moves. */
const panelHeight = computed(() => effectiveMagnification.value + 8)

const panelStyle = computed(() => ({
  height: `${panelHeight.value}px`,
  gap: `${props.gap}px`,
  padding: '4px'
}))

function handleMouseMove(event: MouseEvent): void {
  // `clientX` pairs with the `getBoundingClientRect().x` used per item; upstream
  // mixes in `pageX`, which only agrees while the document itself never scrolls.
  mouseX.set(event.clientX)
}

function handleMouseLeave(): void {
  mouseX.set(Infinity)
}
</script>

<template>
  <div
    class="dock-panel"
    role="toolbar"
    :style="panelStyle"
    @mousemove="handleMouseMove"
    @mouseleave="handleMouseLeave"
  >
    <DockItem
      v-for="(item, index) in items"
      :key="index"
      :item="item"
      :variant="variant"
      :mouse-x="mouseX"
      :distance="distance"
      :base-size="baseSize"
      :magnification="effectiveMagnification"
      :spring="spring"
    />
  </div>
</template>

<style scoped>
.dock-panel {
  display: flex;
  /* Top-anchored: items grow downward from a fixed top edge. */
  align-items: flex-start;
  width: fit-content;
  max-width: 100%;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  backdrop-filter: blur(6px);
}
</style>
