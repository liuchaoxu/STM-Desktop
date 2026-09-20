<script setup lang="ts">
/**
 * LogoLoop — ported from Vue Bits (<https://vue-bits.dev/components/logo-loop>).
 *
 * An infinite marquee: the sequence is duplicated enough times to fill the
 * viewport, then translated with a smoothed velocity. The measurement, copy
 * count and easing maths are copied verbatim.
 *
 * Adaptations for this app (a header status strip rather than a partner-logo
 * band):
 *
 * 1. **Measurement.** Upstream measures the first copy through a template ref set
 *    from an inline arrow (`seqRef = el`), which cannot type-check against
 *    `useTemplateRef`'s read-only ref. Every copy is identical, so the first
 *    child of the track is measured instead — no per-copy ref at all.
 * 2. **Lifecycle.** The upstream `setTimeout(…, 10)` that starts everything is
 *    never cleared, so unmounting inside that window leaves callbacks running
 *    against a detached DOM. It is tracked and cleared here, along with the
 *    resize observer, image listeners and the animation frame.
 * 3. Pauses while the window is hidden (the app polls and runs shader backdrops).
 * 4. `fadeOutColor` is meant to be passed explicitly here: the upstream
 *    `--logoloop-fadeColorAuto` relies on a Tailwind `dark:` variant, which this
 *    project does not configure.
 * 5. `speed: 0` (with the default hover-pause) paints one static strip instead of
 *    starting a frame loop that can only ever compute a zero offset.
 * 6. `fitContent` (not in upstream) sizes the container to exactly one copy of the
 *    sequence. The track is seqSize-periodic, so a window that wide can never show
 *    the same item twice — without it, a short sequence in a wide slot renders 2–3
 *    identical copies side by side, which reads as a bug rather than a marquee.
 */
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
  type CSSProperties
} from 'vue'

export interface LogoItemNode {
  /** Trusted markup string (rendered with `v-html`). */
  node: string
  href?: string
  title?: string
  ariaLabel?: string
}

export interface LogoItemImage {
  src: string
  alt?: string
  href?: string
  title?: string
  srcSet?: string
  sizes?: string
  width?: number
  height?: number
}

export type LogoLoopItem = LogoItemNode | LogoItemImage

const ANIMATION_CONFIG = {
  SMOOTH_TAU: 0.25,
  MIN_COPIES: 2,
  COPY_HEADROOM: 2
} as const

const props = withDefaults(
  defineProps<{
    logos: LogoLoopItem[]
    /** px per second; the marquee eases toward it. */
    speed?: number
    direction?: 'left' | 'right' | 'up' | 'down'
    width?: number | string
    logoHeight?: number
    gap?: number
    pauseOnHover?: boolean
    hoverSpeed?: number
    fadeOut?: boolean
    fadeOutColor?: string
    scaleOnHover?: boolean
    /** Size the strip to exactly one copy of the sequence (no visible repeats). */
    fitContent?: boolean
    ariaLabel?: string
    class?: string
    style?: CSSProperties
  }>(),
  {
    speed: 120,
    direction: 'left',
    width: '100%',
    logoHeight: 28,
    gap: 32,
    pauseOnHover: undefined,
    hoverSpeed: undefined,
    fadeOut: false,
    scaleOnHover: false,
    fitContent: false,
    ariaLabel: 'Logo loop'
  }
)

const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const trackRef = useTemplateRef<HTMLDivElement>('trackRef')

const seqSize = ref(0)
const copyCount = ref<number>(ANIMATION_CONFIG.MIN_COPIES)
const isHovered = ref(false)

let rafId: number | null = null
let lastTimestamp: number | null = null
let offset = 0
let velocity = 0

const isVertical = computed(() => props.direction === 'up' || props.direction === 'down')

const effectiveHoverSpeed = computed<number | undefined>(() => {
  if (props.hoverSpeed !== undefined) return props.hoverSpeed
  if (props.pauseOnHover === true) return 0
  if (props.pauseOnHover === false) return undefined
  return 0 // default: pause on hover
})

const targetVelocity = computed(() => {
  const magnitude = Math.abs(props.speed)
  const directionMultiplier = isVertical.value
    ? props.direction === 'up'
      ? 1
      : -1
    : props.direction === 'left'
      ? 1
      : -1
  return magnitude * directionMultiplier * (props.speed < 0 ? -1 : 1)
})

const cssVariables = computed(() => ({
  '--logoloop-gap': `${props.gap}px`,
  '--logoloop-logoHeight': `${props.logoHeight}px`,
  ...(props.fadeOutColor ? { '--logoloop-fadeColor': props.fadeOutColor } : {})
}))

const rootClasses = computed(() =>
  [
    'logoloop relative',
    // Both axes are clipped on purpose. `overflow-x: hidden` alone computes
    // `overflow-y` to `auto`, which turned the few pixels an inline chip bleeds
    // below the line box into a vertical scrollbar across the header.
    isVertical.value ? 'inline-block h-full overflow-hidden' : 'overflow-hidden',
    props.scaleOnHover && 'py-[calc(var(--logoloop-logoHeight)*0.1)]',
    props.class
  ].filter(Boolean)
)

const containerStyle = computed<CSSProperties>(() => {
  const width = typeof props.width === 'number' ? `${props.width}px` : props.width
  return {
    // `fitContent` leaves the width to updateDimensions, which knows the sequence.
    ...(props.fitContent
      ? {}
      : isVertical.value
        ? width && width !== '100%'
          ? { width }
          : {}
        : { width: width ?? '100%' }),
    ...cssVariables.value,
    ...(props.style ?? {})
  }
})

const fadeColor = computed(() => props.fadeOutColor ?? 'transparent')

/** The first copy is the measuring stick; every copy is identical. */
function sequence(): HTMLElement | null {
  return (trackRef.value?.firstElementChild as HTMLElement | null) ?? null
}

function updateDimensions(): void {
  const container = containerRef.value
  const seq = sequence()
  if (!container || !seq) return

  const rect = seq.getBoundingClientRect()
  if (isVertical.value) {
    const parentHeight = container.parentElement?.clientHeight ?? 0
    if (parentHeight > 0) container.style.height = `${Math.ceil(parentHeight)}px`
    if (rect.height > 0) {
      seqSize.value = Math.ceil(rect.height)
      const viewport = container.clientHeight || parentHeight || rect.height
      copyCount.value = Math.max(
        ANIMATION_CONFIG.MIN_COPIES,
        Math.ceil(viewport / rect.height) + ANIMATION_CONFIG.COPY_HEADROOM
      )
    }
  } else if (rect.width > 0) {
    seqSize.value = Math.ceil(rect.width)
    // The parent is the sizing authority in `fitContent` mode: the container's own
    // clientWidth is derived from the track, so using it here would be circular.
    const available = container.parentElement?.clientWidth || container.clientWidth
    const viewport = props.fitContent
      ? Math.min(seqSize.value, available || seqSize.value)
      : container.clientWidth
    if (props.fitContent) container.style.width = `${Math.floor(viewport)}px`
    copyCount.value = Math.max(
      ANIMATION_CONFIG.MIN_COPIES,
      Math.ceil(viewport / rect.width) + ANIMATION_CONFIG.COPY_HEADROOM
    )
  }
}

function applyTransform(): void {
  const track = trackRef.value
  if (!track || seqSize.value <= 0) return
  track.style.transform = isVertical.value
    ? `translate3d(0, ${-offset}px, 0)`
    : `translate3d(${-offset}px, 0, 0)`
}

function startAnimation(): () => void {
  const track = trackRef.value
  if (!track) return () => undefined

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

  if (seqSize.value > 0) {
    offset = ((offset % seqSize.value) + seqSize.value) % seqSize.value
    applyTransform()
  }

  if (reduced) {
    track.style.transform = 'translate3d(0, 0, 0)'
    return () => {
      lastTimestamp = null
    }
  }

  // A zero target with no hover override means the strip never moves: painting
  // the static transform above is enough, and running a frame loop that can
  // only ever compute zero is pure idle cost.
  if (
    targetVelocity.value === 0 &&
    (effectiveHoverSpeed.value === undefined || effectiveHoverSpeed.value === 0)
  ) {
    return () => {
      lastTimestamp = null
    }
  }

  const animate = (timestamp: number): void => {
    rafId = requestAnimationFrame(animate)
    if (document.hidden) {
      lastTimestamp = timestamp
      return
    }
    if (lastTimestamp === null) lastTimestamp = timestamp
    const delta = Math.max(0, timestamp - lastTimestamp) / 1000
    lastTimestamp = timestamp

    const target =
      isHovered.value && effectiveHoverSpeed.value !== undefined
        ? effectiveHoverSpeed.value
        : targetVelocity.value
    velocity += (target - velocity) * (1 - Math.exp(-delta / ANIMATION_CONFIG.SMOOTH_TAU))

    if (seqSize.value > 0) {
      offset = (((offset + velocity * delta) % seqSize.value) + seqSize.value) % seqSize.value
      applyTransform()
    }
  }

  rafId = requestAnimationFrame(animate)

  return () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    lastTimestamp = null
  }
}

let cleanupResize: (() => void) | undefined
let cleanupImages: (() => void) | undefined
let cleanupAnimation: (() => void) | undefined
let startTimer: ReturnType<typeof setTimeout> | undefined

function setupResizeObserver(): () => void {
  const seq = sequence()
  if (!window.ResizeObserver) {
    window.addEventListener('resize', updateDimensions)
    updateDimensions()
    return () => window.removeEventListener('resize', updateDimensions)
  }
  const observer = new ResizeObserver(() => updateDimensions())
  if (containerRef.value) observer.observe(containerRef.value)
  if (seq) observer.observe(seq)
  updateDimensions()
  return () => observer.disconnect()
}

function setupImageLoader(): () => void {
  const images = sequence()?.querySelectorAll('img') ?? []
  if (images.length === 0) {
    updateDimensions()
    return () => undefined
  }
  let remaining = images.length
  const handleLoad = (): void => {
    remaining -= 1
    if (remaining === 0) updateDimensions()
  }
  images.forEach((image) => {
    const htmlImage = image as HTMLImageElement
    if (htmlImage.complete) handleLoad()
    else {
      htmlImage.addEventListener('load', handleLoad, { once: true })
      htmlImage.addEventListener('error', handleLoad, { once: true })
    }
  })
  return () => {
    images.forEach((image) => {
      image.removeEventListener('load', handleLoad)
      image.removeEventListener('error', handleLoad)
    })
  }
}

function restartAnimation(): void {
  cleanupAnimation?.()
  cleanupAnimation = startAnimation()
}

async function bootstrap(): Promise<void> {
  await nextTick()
  cleanupResize?.()
  cleanupImages?.()
  cleanupResize = setupResizeObserver()
  cleanupImages = setupImageLoader()
  restartAnimation()
}

onMounted(() => {
  // One tick of slack so the container has its final layout before measuring.
  startTimer = setTimeout(() => void bootstrap(), 10)
})

onUnmounted(() => {
  if (startTimer) clearTimeout(startTimer)
  cleanupResize?.()
  cleanupImages?.()
  cleanupAnimation?.()
})

watch(
  [() => props.logos, () => props.gap, () => props.logoHeight, () => props.direction],
  () => void bootstrap(),
  { deep: true }
)

watch(
  [() => props.speed, () => props.direction, () => props.hoverSpeed, () => props.pauseOnHover],
  () => {
    restartAnimation()
  }
)

function isNodeItem(item: LogoLoopItem): item is LogoItemNode {
  return 'node' in item
}

function itemAriaLabel(item: LogoLoopItem): string | undefined {
  return isNodeItem(item) ? (item.ariaLabel ?? item.title) : (item.alt ?? item.title)
}

function onEnter(): void {
  if (effectiveHoverSpeed.value !== undefined) isHovered.value = true
}

function onLeave(): void {
  if (effectiveHoverSpeed.value !== undefined) isHovered.value = false
}
</script>

<template>
  <div
    ref="containerRef"
    :class="rootClasses"
    :style="containerStyle"
    role="region"
    :aria-label="ariaLabel"
  >
    <template v-if="fadeOut">
      <div v-if="isVertical" aria-hidden="true" class="logoloop-fade logoloop-fade-top" />
      <div v-if="isVertical" aria-hidden="true" class="logoloop-fade logoloop-fade-bottom" />
      <div v-if="!isVertical" aria-hidden="true" class="logoloop-fade logoloop-fade-left" />
      <div v-if="!isVertical" aria-hidden="true" class="logoloop-fade logoloop-fade-right" />
    </template>

    <div
      ref="trackRef"
      class="logoloop-track relative z-0 flex will-change-transform select-none motion-reduce:transform-none"
      :class="isVertical ? 'h-max w-full flex-col' : 'w-max flex-row'"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <ul
        v-for="copyIndex in copyCount"
        :key="`copy-${copyIndex - 1}`"
        class="flex items-center"
        :class="{ 'flex-col': isVertical }"
        role="list"
        :aria-hidden="copyIndex > 1 ? true : undefined"
      >
        <li
          v-for="(item, itemIndex) in logos"
          :key="`${copyIndex - 1}-${itemIndex}`"
          class="logoloop-item flex-none leading-none"
          :class="{ 'is-vertical': isVertical }"
          role="listitem"
        >
          <slot name="renderItem" :item="item" :index="`${copyIndex - 1}-${itemIndex}`">
            <a
              v-if="item.href"
              class="inline-flex items-center no-underline"
              :href="item.href"
              :aria-label="itemAriaLabel(item) ?? 'link'"
              target="_blank"
              rel="noreferrer noopener"
            >
              <span v-if="isNodeItem(item)" v-html="item.node" />
              <img
                v-else
                class="block h-[var(--logoloop-logoHeight)] w-auto object-contain"
                :src="item.src"
                :srcset="item.srcSet"
                :sizes="item.sizes"
                :width="item.width"
                :height="item.height"
                :alt="item.alt ?? ''"
                :title="item.title"
                loading="lazy"
                decoding="async"
                draggable="false"
              />
            </a>
            <template v-else>
              <span v-if="isNodeItem(item)" v-html="item.node" />
              <img
                v-else
                class="block h-[var(--logoloop-logoHeight)] w-auto object-contain"
                :src="item.src"
                :srcset="item.srcSet"
                :sizes="item.sizes"
                :width="item.width"
                :height="item.height"
                :alt="item.alt ?? ''"
                :title="item.title"
                loading="lazy"
                decoding="async"
                draggable="false"
              />
            </template>
          </slot>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/*
 * The gap and the item size are written here rather than as
 * `mr-[var(--logoloop-gap)]`: in this project's Tailwind setup that arbitrary-value
 * utility is emitted but never wins (see the roadmap note), so the marquee rendered
 * with every chip touching. A scoped rule is unlayered and cannot be outranked.
 */
.logoloop-item {
  margin-right: var(--logoloop-gap);
  font-size: var(--logoloop-logoHeight);
}

.logoloop-item.is-vertical {
  margin-right: 0;
  margin-bottom: var(--logoloop-gap);
}

.logoloop-fade {
  position: absolute;
  z-index: 10;
  pointer-events: none;
}

.logoloop-fade-left,
.logoloop-fade-right {
  top: 0;
  bottom: 0;
  width: clamp(24px, 8%, 120px);
}

.logoloop-fade-left {
  left: 0;
  background: linear-gradient(to right, v-bind('fadeColor'), rgba(0, 0, 0, 0));
}

.logoloop-fade-right {
  right: 0;
  background: linear-gradient(to left, v-bind('fadeColor'), rgba(0, 0, 0, 0));
}

.logoloop-fade-top,
.logoloop-fade-bottom {
  left: 0;
  right: 0;
  height: clamp(24px, 8%, 120px);
}

.logoloop-fade-top {
  top: 0;
  background: linear-gradient(to bottom, v-bind('fadeColor'), rgba(0, 0, 0, 0));
}

.logoloop-fade-bottom {
  bottom: 0;
  background: linear-gradient(to top, v-bind('fadeColor'), rgba(0, 0, 0, 0));
}
</style>
