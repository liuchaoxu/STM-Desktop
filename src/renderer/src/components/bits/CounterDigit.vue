<script setup lang="ts">
/**
 * CounterDigit — one digit column of <Counter>, ported from Vue Bits
 * (<https://vue-bits.dev/text-animations/counter>).
 *
 * Ten glyphs are stacked in a `1ch`-wide, one-digit-tall window and translated so
 * that the wanted face sits in view; the translation is driven by a spring, which is
 * what makes the digits *roll* through the intermediate values instead of jumping.
 * The wheel maths (offset, the `offset > 5` wrap-around shortcut) is copied
 * verbatim.
 *
 * Adaptations for this app:
 *
 * 1. The digits are plain spans whose `transform` is written on each spring tick,
 *    instead of ten `motion.span` components per column. A count chip can hold a
 *    dozen columns and most of them never move, so this keeps the idle cost at a
 *    single subscription per column.
 * 2. `prefers-reduced-motion` swaps the spring for a near-instant one.
 * 3. `place` only ever sees the last digit of the value, so a change of 9 → 10 rolls
 *    one column instead of re-mounting both (the parent keys by place).
 */
import { onBeforeUnmount, onMounted, useTemplateRef, watch, type CSSProperties } from 'vue'
import { useSpring } from 'motion-v'

const props = withDefaults(
  defineProps<{
    /** 1, 10, 100 … — which digit of `value` this column shows. */
    place: number
    value: number
    /** Height of one cell in px; also the roll distance. */
    height: number
    color?: string
    fontWeight?: CSSProperties['fontWeight']
    digitStyle?: CSSProperties
    /** Swap the spring for a snap. */
    reduced?: boolean
    spring?: { stiffness?: number; damping?: number; mass?: number }
  }>(),
  {
    color: 'inherit',
    fontWeight: 'inherit',
    digitStyle: undefined,
    reduced: false,
    spring: () => ({ stiffness: 300, damping: 30 })
  }
)

const rootRef = useTemplateRef<HTMLSpanElement>('rootRef')
let digits: HTMLElement[] = []

/** 2.9999999996 must read as 3: float error, not a real digit boundary. */
function normalizeNearInteger(num: number): number {
  const nearest = Math.round(num)
  const tolerance = 1e-9 * Math.max(1, Math.abs(num))
  return Math.abs(num - nearest) < tolerance ? nearest : num
}

function digitAt(value: number, place: number): number {
  return Math.floor(normalizeNearInteger(value / place))
}

const spring = useSpring(
  digitAt(props.value, props.place),
  props.reduced ? { stiffness: 12000, damping: 120 } : props.spring
)

function paint(latest: number): void {
  // Fractional while the spring is in flight — that is the roll.
  const placeValue = ((latest % 10) + 10) % 10
  for (let i = 0; i < digits.length; i++) {
    let offset = (10 + i - placeValue) % 10
    let y = offset * props.height
    // Coming back the other way (9 → 0) is shorter through the top.
    if (offset > 5) y -= 10 * props.height
    digits[i].style.transform = `translateY(${y}px)`
  }
}

const unsubscribe = spring.on('change', paint)

watch(
  () => [props.value, props.place],
  () => spring.set(digitAt(props.value, props.place))
)

watch(
  () => props.height,
  () => paint(spring.get())
)

onMounted(() => {
  digits = Array.from(rootRef.value?.querySelectorAll<HTMLElement>('[data-digit]') ?? [])
  paint(spring.get())
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <span
    ref="rootRef"
    class="counter-digit"
    :style="{ height: `${height}px`, color, fontWeight }"
    aria-hidden="true"
  >
    <span v-for="i in 10" :key="i - 1" data-digit class="counter-digit-face" :style="digitStyle">{{
      i - 1
    }}</span>
  </span>
</template>

<style scoped>
/*
 * `inline-flex` + `overflow: hidden` is the rolling window: one digit wide, one
 * digit tall. `tabular-nums` keeps a mono-spaced advance for the `1ch` width so the
 * counter does not jitter as digits change.
 */
.counter-digit {
  position: relative;
  display: inline-flex;
  width: 1ch;
  overflow: hidden;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.counter-digit-face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: transform;
}
</style>
