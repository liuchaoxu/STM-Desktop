<script setup lang="ts">
/**
 * Counter — ported from Vue Bits (<https://vue-bits.dev/text-animations/counter>).
 *
 * A number whose digits roll into place when it changes. The place derivation (and
 * the negative-exponent trick for decimals) is copied verbatim; the layout is not.
 *
 * Adaptations for this app — everything here exists so the counter can sit *inside a
 * sentence* next to ordinary text without disturbing it:
 *
 * 1. **The counter is a text line box, not a fixed-size widget.** Upstream renders
 *    `font-size: 100px` with its own padding, and its height (`fontSize + padding`)
 *    is what the digit window uses. Here the root is an `inline-flex` whose first
 *    child is an invisible zero-width strut, so the box takes the *surrounding*
 *    line height and shares the surrounding baseline. `fontSize` is optional: when
 *    it is omitted the counter **measures the font size it inherited** and sizes its
 *    digit windows to it, so a number always matches the words it sits in (chips are
 *    12px, pills 11.5px, and nobody has to keep those numbers in sync by hand).
 * 2. **No gradients by default.** Upstream fades `black` into the top and bottom of
 *    its 100px box; at 12px that is a smudge, so `gradient` is opt-in.
 * 3. Literal characters (`.`, `-`) are rendered as static cells — upstream derives a
 *    place for `-` and therefore shows a rolling column where the sign should be.
 * 4. `role="img"` + `aria-label` on the root, `aria-hidden` on the wheels: upstream
 *    exposes ten stacked digits per column to assistive tech.
 * 5. `prefers-reduced-motion` is decided once here and passed down (the digits snap).
 * 6. `value` may be fractional (upstream handles it); counts are integers.
 */
import { computed, onMounted, ref, useTemplateRef, type CSSProperties } from 'vue'
import CounterDigit from './CounterDigit.vue'

const props = withDefaults(
  defineProps<{
    value: number
    /** Digit size in px; omit to inherit the surrounding text size. */
    fontSize?: number
    /** Override the derived places; strings (`.`/`-`) render literally. */
    places?: (number | string)[]
    /** Gap between digit columns, in px. */
    gap?: number
    /** Extra cell height, i.e. tracking. Upstream calls this `padding`. */
    padding?: number
    color?: string
    fontWeight?: CSSProperties['fontWeight']
    digitStyle?: CSSProperties
    /** Optional fade at the top/bottom of the digit window. */
    gradient?: boolean
    gradientHeight?: number
    gradientFrom?: string
    gradientTo?: string
    /** Announced value; defaults to the number itself. */
    ariaLabel?: string
    spring?: { stiffness?: number; damping?: number; mass?: number }
    style?: CSSProperties
  }>(),
  {
    fontSize: undefined,
    places: undefined,
    gap: 0,
    padding: 0,
    color: 'inherit',
    fontWeight: 'inherit',
    digitStyle: undefined,
    gradient: false,
    gradientHeight: 6,
    gradientFrom: 'rgba(0, 0, 0, 0.45)',
    gradientTo: 'transparent',
    ariaLabel: undefined,
    spring: () => ({ stiffness: 300, damping: 30 }),
    style: undefined
  }
)

const rootRef = useTemplateRef<HTMLSpanElement>('rootRef')
/** Resolved from the inherited font size on mount when `fontSize` is not given. */
const inheritedFontSize = ref<number | null>(null)
const effectiveFontSize = computed(() => props.fontSize ?? inheritedFontSize.value ?? 12)

const reduced =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const cellHeight = computed(() => effectiveFontSize.value + props.padding)

onMounted(() => {
  if (props.fontSize !== undefined) return
  const root = rootRef.value
  if (!root) return
  const measured = Number.parseFloat(window.getComputedStyle(root).fontSize)
  if (Number.isFinite(measured) && measured > 0) inheritedFontSize.value = measured
})

function derivePlaces(value: number): (number | string)[] {
  const text = String(value)
  const dotIndex = text.indexOf('.')
  const places: (number | string)[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char < '0' || char > '9') {
      places.push(char)
      continue
    }
    const exponent =
      dotIndex === -1 ? text.length - i - 1 : i < dotIndex ? dotIndex - i - 1 : -(i - dotIndex)
    places.push(10 ** exponent)
  }
  return places
}

const places = computed<(number | string)[]>(() => props.places ?? derivePlaces(props.value))

const rootStyle = computed<CSSProperties>(() => ({
  display: 'inline-flex',
  // Centres the digit windows inside the inherited line box.
  alignItems: 'center',
  gap: `${props.gap}px`,
  position: 'relative',
  // Only pinned when asked for: otherwise the surrounding size is inherited.
  ...(props.fontSize === undefined ? {} : { fontSize: `${props.fontSize}px` }),
  lineHeight: 'inherit',
  whiteSpace: 'nowrap',
  ...props.style
}))

const strutStyle: CSSProperties = {
  // Zero width, so it only contributes its baseline and line box — the trick that
  // makes the counter align with the words around it.
  width: 0,
  visibility: 'hidden'
}

const literalStyle = computed<CSSProperties>(() => ({
  width: '1ch',
  textAlign: 'center',
  color: props.color,
  fontWeight: props.fontWeight,
  lineHeight: 1
}))

const gradientLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  pointerEvents: 'none'
}

const topGradientStyle = computed<CSSProperties>(() => ({
  height: `${props.gradientHeight}px`,
  background: `linear-gradient(to bottom, ${props.gradientFrom}, ${props.gradientTo})`
}))

const bottomGradientStyle = computed<CSSProperties>(() => ({
  height: `${props.gradientHeight}px`,
  background: `linear-gradient(to top, ${props.gradientFrom}, ${props.gradientTo})`
}))
</script>

<template>
  <span
    ref="rootRef"
    class="counter"
    :style="rootStyle"
    role="img"
    :aria-label="ariaLabel ?? String(value)"
    :data-value="value"
  >
    <!-- Establishes the baseline and the line-box height. Never painted, no width. -->
    <span class="counter-strut" :style="strutStyle" aria-hidden="true">0</span>
    <template
      v-for="(place, index) in places"
      :key="typeof place === 'number' ? place : `${place}-${index}`"
    >
      <span v-if="typeof place === 'string'" class="counter-literal" :style="literalStyle">{{
        place
      }}</span>
      <CounterDigit
        v-else
        :place="place"
        :value="value"
        :height="cellHeight"
        :color="color"
        :font-weight="fontWeight"
        :digit-style="digitStyle"
        :reduced="reduced"
        :spring="spring"
      />
    </template>
    <span v-if="gradient" class="counter-gradient" :style="gradientLayerStyle" aria-hidden="true">
      <span :style="topGradientStyle" />
      <span :style="bottomGradientStyle" />
    </span>
  </span>
</template>
