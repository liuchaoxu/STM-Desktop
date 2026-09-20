<script setup lang="ts">
/**
 * ElectricBorder — ported from Vue Bits (<https://vue-bits.dev/components/electric-border>).
 *
 * Draws a crackling rounded-rect on a 2D canvas: a point is walked around the
 * perimeter and displaced by two octaved value-noise fields, with three blurred
 * border layers underneath for the glow. The noise, octave and perimeter maths
 * are copied verbatim; the lifecycle around them is not.
 *
 * Adaptations for this app:
 *
 * 1. **Canvas transform leak (upstream bug).** `updateSize()` ends with
 *    `ctx.scale(dpr, dpr)`, and the ResizeObserver calls it outside the per-frame
 *    `setTransform(…, 1, 0, 0, 1, 0, 0)` reset — so every resize multiplied the
 *    transform again and the drawn border crept inward. The reset now happens
 *    inside `updateSize()` as well.
 * 2. **Cleanup.** Upstream registers one rAF and one observer, and its watcher
 *    schedules a `requestAnimationFrame(setupCanvas)` that is never cancelled:
 *    unmounting inside that window leaves a frame loop drawing into a detached
 *    canvas (the same class of bug as SpecularButton). Everything is tracked and
 *    cancelled here.
 * 3. **Idle cost.** `octavedNoise()` is 10 octaves × 10 `Math.sin` per sample, per
 *    axis, per frame — a tunnel row would pay for it forever. The loop is stopped
 *    (not merely skipped) while the window is hidden, while the element is
 *    off-screen (IntersectionObserver) and on unmount; `maxSamples` caps the
 *    perimeter resolution, which upstream ties to the perimeter length alone.
 * 4. **Any CSS colour.** Upstream builds the glow layers with `hexToRgba()`, which
 *    only understands hex literals, so passing `var(--green)` silently produced
 *    `rgba(0,0,0,…)` — a black border. `color-mix()` is used instead, so design
 *    tokens work.
 * 5. **No props watcher.** Every prop is read inside the draw call, so a colour or
 *    radius change takes effect on the next frame; only the element's *size* needs
 *    re-measuring.
 * 6. `className` is dropped (Vue merges `class` as a normal attribute), and
 *    `prefers-reduced-motion` paints a single static frame instead of animating.
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  useTemplateRef,
  watch,
  type CSSProperties
} from 'vue'

const props = withDefaults(
  defineProps<{
    /** Any CSS colour, including `var(--token)`. */
    color?: string
    /** Time multiplier for the noise field. */
    speed?: number
    /** Displacement amplitude; larger means wilder crackle. */
    chaos?: number
    borderRadius?: number
    /** Perimeter resolution cap — the cost is linear in this number. */
    maxSamples?: number
    /**
     * A live border costs a canvas, two observers and a frame loop. Callers that
     * wrap every list row (so the DOM stays stable) switch it off per row instead
     * of duplicating the markup: an inactive instance sets nothing up at all.
     */
    active?: boolean
    /** Extra classes for the wrapper holding the slot (e.g. `contents`). */
    contentClass?: string
    style?: CSSProperties
  }>(),
  {
    color: '#2fbf71',
    speed: 1,
    chaos: 0.12,
    borderRadius: 10,
    maxSamples: 400,
    active: true,
    contentClass: ''
  }
)

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvasRef')
const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const wrapperStyle = computed<CSSProperties>(() => ({
  '--electric-border-color': props.color,
  borderRadius: `${props.borderRadius}px`,
  ...props.style
}))

function random(x: number): number {
  return (Math.sin(x * 12.9898) * 43758.5453) % 1
}

function noise2D(x: number, y: number): number {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j

  const a = random(i + j * 57)
  const b = random(i + 1 + j * 57)
  const c = random(i + (j + 1) * 57)
  const d = random(i + 1 + (j + 1) * 57)

  const ux = fx * fx * (3.0 - 2.0 * fx)
  const uy = fy * fy * (3.0 - 2.0 * fy)

  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy
}

function octavedNoise(
  x: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  baseAmplitude: number,
  baseFrequency: number,
  time: number,
  seed: number,
  baseFlatness: number
): number {
  let y = 0
  let amplitude = baseAmplitude
  let frequency = baseFrequency

  for (let i = 0; i < octaves; i++) {
    let octaveAmplitude = amplitude
    if (i === 0) {
      octaveAmplitude *= baseFlatness
    }
    y += octaveAmplitude * noise2D(frequency * x + seed * 100, time * frequency * 0.3)
    frequency *= lacunarity
    amplitude *= gain
  }

  return y
}

function getCornerPoint(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  arcLength: number,
  progress: number
): { x: number; y: number } {
  const angle = startAngle + progress * arcLength
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle)
  }
}

function getRoundedRectPoint(
  t: number,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number
): { x: number; y: number } {
  const straightWidth = width - 2 * radius
  const straightHeight = height - 2 * radius
  const cornerArc = (Math.PI * radius) / 2
  const totalPerimeter = 2 * straightWidth + 2 * straightHeight + 4 * cornerArc
  const distance = t * totalPerimeter

  let accumulated = 0

  if (distance <= accumulated + straightWidth) {
    const progress = (distance - accumulated) / straightWidth
    return { x: left + radius + progress * straightWidth, y: top }
  }
  accumulated += straightWidth

  if (distance <= accumulated + cornerArc) {
    const progress = (distance - accumulated) / cornerArc
    return getCornerPoint(
      left + width - radius,
      top + radius,
      radius,
      -Math.PI / 2,
      Math.PI / 2,
      progress
    )
  }
  accumulated += cornerArc

  if (distance <= accumulated + straightHeight) {
    const progress = (distance - accumulated) / straightHeight
    return { x: left + width, y: top + radius + progress * straightHeight }
  }
  accumulated += straightHeight

  if (distance <= accumulated + cornerArc) {
    const progress = (distance - accumulated) / cornerArc
    return getCornerPoint(
      left + width - radius,
      top + height - radius,
      radius,
      0,
      Math.PI / 2,
      progress
    )
  }
  accumulated += cornerArc

  if (distance <= accumulated + straightWidth) {
    const progress = (distance - accumulated) / straightWidth
    return { x: left + width - radius - progress * straightWidth, y: top + height }
  }
  accumulated += straightWidth

  if (distance <= accumulated + cornerArc) {
    const progress = (distance - accumulated) / cornerArc
    return getCornerPoint(
      left + radius,
      top + height - radius,
      radius,
      Math.PI / 2,
      Math.PI / 2,
      progress
    )
  }
  accumulated += cornerArc

  if (distance <= accumulated + straightHeight) {
    const progress = (distance - accumulated) / straightHeight
    return { x: left, y: top + height - radius - progress * straightHeight }
  }
  accumulated += straightHeight

  const progress = (distance - accumulated) / cornerArc
  return getCornerPoint(left + radius, top + radius, radius, Math.PI, Math.PI / 2, progress)
}

function resolveBorderRadius(
  borderRadius: CSSProperties['borderRadius'] | number | undefined,
  maxRadius: number,
  width: number,
  height: number
): number {
  if (typeof borderRadius === 'number') {
    return Math.min(borderRadius, maxRadius)
  }

  if (typeof borderRadius === 'string') {
    const parsed = Number.parseFloat(borderRadius)
    if (Number.isFinite(parsed)) {
      if (borderRadius.includes('%')) {
        return Math.min(maxRadius, (parsed / 100) * Math.min(width, height))
      }

      return Math.min(parsed, maxRadius)
    }
  }

  return Math.min(props.borderRadius, maxRadius)
}

const OCTAVES = 10
const LACUNARITY = 1.6
const GAIN = 0.7
const FREQUENCY = 10
const BASE_FLATNESS = 0
const DISPLACEMENT = 60
/** The canvas is drawn this much larger than the element on every side, so the
 * displacement never runs out of room. */
const BORDER_OFFSET = 60

let rafId: number | null = null
let lastFrame = 0
let time = 0
let onScreen = true

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

function setupCanvas(): () => void {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return () => undefined

  const ctx = canvas.getContext('2d')
  if (!ctx) return () => undefined

  let dpr = Math.min(window.devicePixelRatio || 1, 2)
  let width = 0
  let height = 0

  const updateSize = (): void => {
    const rect = container.getBoundingClientRect()
    width = rect.width + BORDER_OFFSET * 2
    height = rect.height + BORDER_OFFSET * 2

    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    // Reset first: without it every resize stacks another scale on the context.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
  }

  updateSize()

  const paint = (advance: number): void => {
    if (width < 2 || height < 2) return

    time += advance

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(dpr, dpr)

    ctx.strokeStyle = props.color
    ctx.lineWidth = 1
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const left = BORDER_OFFSET
    const top = BORDER_OFFSET
    const borderWidth = width - 2 * BORDER_OFFSET
    const borderHeight = height - 2 * BORDER_OFFSET
    if (borderWidth <= 0 || borderHeight <= 0) return

    const maxRadius = Math.min(borderWidth, borderHeight) / 2
    const radius = resolveBorderRadius(
      props.style?.borderRadius ?? props.borderRadius,
      maxRadius,
      borderWidth,
      borderHeight
    )

    const perimeter = 2 * (borderWidth + borderHeight) + 2 * Math.PI * radius
    const sampleCount = Math.max(24, Math.min(props.maxSamples, Math.floor(perimeter / 2)))

    ctx.beginPath()

    for (let i = 0; i <= sampleCount; i++) {
      const progress = i / sampleCount
      const point = getRoundedRectPoint(progress, left, top, borderWidth, borderHeight, radius)

      const xNoise = octavedNoise(
        progress * 8,
        OCTAVES,
        LACUNARITY,
        GAIN,
        props.chaos,
        FREQUENCY,
        time,
        0,
        BASE_FLATNESS
      )
      const yNoise = octavedNoise(
        progress * 8,
        OCTAVES,
        LACUNARITY,
        GAIN,
        props.chaos,
        FREQUENCY,
        time,
        1,
        BASE_FLATNESS
      )

      const displacedX = point.x + xNoise * DISPLACEMENT
      const displacedY = point.y + yNoise * DISPLACEMENT

      if (i === 0) ctx.moveTo(displacedX, displacedY)
      else ctx.lineTo(displacedX, displacedY)
    }

    ctx.closePath()
    ctx.stroke()
  }

  const active = (): boolean => !document.hidden && onScreen && !reducedMotion()

  const frame = (now: number): void => {
    if (!active()) {
      rafId = null
      return
    }
    // A zero `lastFrame` (first frame after a resume) must not advance the clock
    // by the whole page lifetime.
    const advance = lastFrame === 0 ? 0 : Math.min((now - lastFrame) / 1000, 0.1)
    lastFrame = now
    paint(advance * props.speed)
    rafId = requestAnimationFrame(frame)
  }

  const resume = (): void => {
    if (rafId !== null || !active()) return
    lastFrame = 0
    rafId = requestAnimationFrame(frame)
  }

  const pause = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    updateSize()
    paint(0)
  })
  resizeObserver.observe(container)

  const intersectionObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting)
          if (onScreen) resume()
          else pause()
        })
  intersectionObserver?.observe(container)

  const onVisibilityChange = (): void => {
    if (document.hidden) pause()
    else resume()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Reduced motion: one static frame, no loop at all.
  if (reducedMotion()) paint(0)
  else resume()

  return () => {
    pause()
    resizeObserver.disconnect()
    intersectionObserver?.disconnect()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

let cleanup: (() => void) | undefined

function start(): void {
  if (cleanup || !props.active) return
  cleanup = setupCanvas()
}

function stop(): void {
  cleanup?.()
  cleanup = undefined
  // A stopped loop leaves the last painted frame on the canvas, so wipe it: with
  // `active` off the row must look exactly like a plain row.
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
}

onMounted(start)

watch(
  () => props.active,
  (isActive) => {
    if (isActive) start()
    else stop()
  }
)

onBeforeUnmount(() => {
  stop()
  rafId = null
  lastFrame = 0
  time = 0
  onScreen = true
})
</script>

<template>
  <div
    ref="containerRef"
    class="electric-border relative isolate overflow-visible"
    :class="{ 'is-active': active }"
    :style="wrapperStyle"
  >
    <div
      class="pointer-events-none absolute top-1/2 left-1/2 z-[2] -translate-x-1/2 -translate-y-1/2"
    >
      <canvas ref="canvasRef" class="block" />
    </div>

    <div v-if="active" class="pointer-events-none absolute inset-0 z-0 rounded-[inherit]">
      <div
        class="pointer-events-none absolute inset-0 rounded-[inherit]"
        :style="{
          border: `2px solid color-mix(in srgb, ${color} 60%, transparent)`,
          filter: 'blur(1px)'
        }"
      />
      <div
        class="pointer-events-none absolute inset-0 rounded-[inherit]"
        :style="{ border: `2px solid ${color}`, filter: 'blur(4px)' }"
      />
      <div
        class="pointer-events-none absolute inset-0 scale-110 rounded-[inherit] opacity-30"
        :style="{
          zIndex: -1,
          filter: 'blur(32px)',
          background: `linear-gradient(-30deg, ${color}, transparent, ${color})`
        }"
      />
    </div>

    <div :class="['relative z-[1] rounded-[inherit]', contentClass]">
      <slot />
    </div>
  </div>
</template>
