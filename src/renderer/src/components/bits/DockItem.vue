<script setup lang="ts">
/**
 * One Dock item: grows as the pointer approaches, driven by spring physics.
 *
 * The magnification maths is upstream's (`mouseDistance` -> `targetSize` ->
 * spring). Two things differ, both deliberate:
 *
 * 1. Upstream sets `ref: 'itemRef'` inside a render function. Vue 3 does not
 *    populate string refs there, so `itemRef.value` stayed undefined and the
 *    distance fell back to `x: 0` — every item magnified around the wrong origin.
 *    A real template ref is used here.
 * 2. `'pill'` keeps the label inline (our toolbars need readable actions) and
 *    animates the height + a damped font size, so growing items never overlap
 *    their neighbours. `'icon'` is upstream's square item and does grow in both
 *    axes, which is what pushes the neighbours apart in a classic dock.
 */
import { useMotionValue, useSpring, useTransform } from 'motion-v'
import { computed, onUnmounted, ref, useTemplateRef } from 'vue'
export interface DockItemData {
  /** Glyph shown before the label (an emoji is fine). */
  icon?: string
  label: string
  onClick: () => void
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
}

const props = defineProps<{
  item: DockItemData
  variant: 'pill' | 'icon'
  mouseX: ReturnType<typeof useMotionValue<number>>
  distance: number
  baseSize: number
  magnification: number
  spring: { mass?: number; stiffness?: number; damping?: number }
}>()

const itemRef = useTemplateRef<HTMLElement>('itemRef')
const hovered = ref(false)
const size = ref(props.baseSize)

const mouseDistance = useTransform(props.mouseX, (value: number) => {
  const rect = itemRef.value?.getBoundingClientRect()
  // Unknown position (first frame): treat as far away so nothing jumps.
  if (!rect) return props.distance * 2
  return value - rect.x - rect.width / 2
})

const targetSize = useTransform(mouseDistance, (dist: number) => {
  const clamped = Math.max(-props.distance, Math.min(props.distance, dist))
  const t = 1 - Math.abs(clamped) / props.distance
  return props.baseSize + (props.magnification - props.baseSize) * t
})

const springSize = useSpring(targetSize, props.spring)
const unsubscribe = springSize.on('change', (latest: number) => {
  size.value = latest
})

onUnmounted(() => unsubscribe?.())

/** Pills scale the glyph/label only slightly, so the text stays crisp. */
const fontScale = computed(() => 1 + (size.value / props.baseSize - 1) * 0.4)

const itemStyle = computed(() => {
  const value = `${Math.round(size.value * 100) / 100}px`
  if (props.variant === 'icon') {
    return { width: value, height: value, fontSize: `${Math.round(18 * fontScale.value)}px` }
  }
  return { height: value, fontSize: `${Math.round(13 * fontScale.value * 100) / 100}px` }
})

function activate(): void {
  if (props.item.disabled) return
  props.item.onClick()
}
</script>

<template>
  <button
    ref="itemRef"
    type="button"
    class="dock-item"
    :class="[
      `dock-item-${variant}`,
      `dock-item-${item.tone ?? 'default'}`,
      { 'dock-item-open': hovered }
    ]"
    :style="itemStyle"
    :disabled="item.disabled"
    :title="item.label"
    @click="activate"
    @mouseenter="hovered = true"
    @focus="hovered = true"
    @mouseleave="hovered = false"
    @blur="hovered = false"
  >
    <span v-if="item.icon" class="dock-glyph" aria-hidden="true">{{ item.icon }}</span>
    <span v-if="variant === 'pill'" class="dock-label">{{ item.label }}</span>

    <!-- The icon variant hides the label, so it has to be revealed somehow. -->
    <Transition name="dock-tip">
      <span v-if="variant === 'icon' && hovered" class="dock-tooltip" role="tooltip">
        {{ item.label }}
      </span>
    </Transition>
  </button>
</template>

<style scoped>
.dock-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  /* Height/font-size are driven by the spring; keep the horizontal metrics in
     `em` so a pill grows proportionally instead of clipping its label. */
  padding: 0 0.85em;
  line-height: 1;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    color 0.18s ease;
}

.dock-item-icon {
  padding: 0;
}

.dock-item:hover:not(:disabled),
.dock-item-open:not(:disabled) {
  border-color: var(--muted);
}

.dock-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.dock-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dock-item-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.dock-item-danger {
  color: var(--red);
}

.dock-glyph {
  font-size: 0.95em;
}

.dock-label {
  font-weight: 500;
}

.dock-tooltip {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}

.dock-tip-enter-active,
.dock-tip-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.dock-tip-enter-from,
.dock-tip-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
</style>
