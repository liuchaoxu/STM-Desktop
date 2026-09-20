<script setup lang="ts">
/**
 * BorderGlow — ported from Vue Bits (<https://vue-bits.dev/components/border-glow>).
 *
 * The three layers (mesh-gradient border, mesh-gradient fill, outer glow) and
 * the pointer maths are copied verbatim; this port only adapts it to the app:
 *
 * 1. **Theme-aware glow colour.** Upstream parses `glowColor` as a bare
 *    `H S L` triple, which would mean hard-coding the accent a second time. Here
 *    any CSS colour is resolved through the cascade, so `glow-color="var(--accent)"`
 *    works and the palette stays single-sourced (cached per colour).
 * 2. `backgroundColor` defaults to the app's `--panel` token.
 * 3. The `animated` sweep is cancellable: upstream schedules `setTimeout` +
 *    `requestAnimationFrame` chains that keep running after unmount.
 * 4. The sweep is skipped under `prefers-reduced-motion: reduce`.
 * 5. The slot wrapper clips to the card radius instead of scrolling.
 */
import { computed, onUnmounted, ref, useTemplateRef, watch } from 'vue'

interface Hsl {
  h: number
  s: number
  l: number
}

const props = withDefaults(
  defineProps<{
    className?: string
    /** How close to an edge the pointer must be before the border lights up (%). */
    edgeSensitivity?: number
    /** Any CSS colour, e.g. `var(--accent)`. */
    glowColor?: string
    backgroundColor?: string
    borderRadius?: number
    glowRadius?: number
    glowIntensity?: number
    coneSpread?: number
    animated?: boolean
    /** Mesh-gradient colours behind the border and fill. */
    colors?: string[]
    fillOpacity?: number
  }>(),
  {
    className: '',
    edgeSensitivity: 30,
    glowColor: 'var(--accent)',
    backgroundColor: 'var(--panel)',
    borderRadius: 10,
    glowRadius: 40,
    glowIntensity: 1,
    coneSpread: 25,
    animated: false,
    colors: () => ['#4f8cff', '#2563eb', '#38bdf8'],
    fillOpacity: 0.5
  }
)

const colorCache = new Map<string, Hsl>()

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return { h, s: s * 100, l: l * 100 }
}

/**
 * Resolve any CSS colour — including `var(--token)` — to HSL. The browser does
 * the parsing, so a token, a hex, an `hsl()` or an `rgb()` all work.
 */
function toHsl(color: string): Hsl {
  const cached = colorCache.get(color)
  if (cached) return cached

  const fallback: Hsl = { h: 219, s: 100, l: 65 }
  let result = fallback
  const probe = document.createElement('span')
  probe.style.color = color
  if (probe.style.color) {
    probe.style.cssText += ';position:absolute;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    try {
      const computed = getComputedStyle(probe).color
      const match = computed.match(/rgba?\(([^)]+)\)/)
      if (match) {
        const [r, g, b] = match[1]!
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number)
        if (r !== undefined && g !== undefined && b !== undefined) {
          result = rgbToHsl(r / 255, g / 255, b / 255)
        }
      }
    } finally {
      probe.remove()
    }
  }
  colorCache.set(color, result)
  return result
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = toHsl(glowColor)
  const base = `${h}deg ${s}% ${l}%`
  const layers: [number, number, number, number, number, boolean][] = [
    [0, 0, 0, 1, 100, true],
    [0, 0, 1, 0, 60, true],
    [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true],
    [0, 0, 15, 0, 30, true],
    [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true],
    [0, 0, 1, 0, 60, false],
    [0, 0, 3, 0, 50, false],
    [0, 0, 6, 0, 40, false],
    [0, 0, 15, 0, 30, false],
    [0, 0, 25, 2, 20, false],
    [0, 0, 50, 2, 10, false]
  ]
  return layers
    .map(([x, y, blur, spread, alpha, inset]) => {
      const a = Math.min(alpha * intensity, 100)
      return `${inset ? 'inset ' : ''}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`
    })
    .join(', ')
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3)
}
function easeInCubic(x: number): number {
  return x * x * x
}

interface AnimateOpts {
  start?: number
  end?: number
  duration?: number
  delay?: number
  ease?: (t: number) => number
  onUpdate: (v: number) => void
  onEnd?: () => void
}

/** Cancellable version of the upstream animation helper. */
const running = new Set<() => void>()

function animateValue(opts: AnimateOpts): void {
  const {
    start = 0,
    end = 100,
    duration = 1000,
    delay = 0,
    ease = easeOutCubic,
    onUpdate,
    onEnd
  } = opts

  let raf = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    if (raf) cancelAnimationFrame(raf)
    if (timer) clearTimeout(timer)
    running.delete(cancel)
  }
  running.add(cancel)

  const t0 = performance.now() + delay
  const tick = (): void => {
    if (cancelled) return
    const t = Math.min((performance.now() - t0) / duration, 1)
    onUpdate(start + (end - start) * ease(t))
    if (t < 1) {
      raf = requestAnimationFrame(tick)
    } else {
      running.delete(cancel)
      onEnd?.()
    }
  }
  timer = setTimeout(() => requestAnimationFrame(tick), delay)
}

const GRADIENT_POSITIONS = [
  '80% 55%',
  '69% 34%',
  '8% 6%',
  '41% 38%',
  '86% 85%',
  '82% 18%',
  '51% 4%'
]
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1]

function buildMeshGradients(colors: string[]): string[] {
  const gradients: string[] = []
  for (let i = 0; i < 7; i++) {
    const color = colors[Math.min(COLOR_MAP[i]!, colors.length - 1)] ?? colors[0] ?? '#4f8cff'
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${color} 0px, transparent 50%)`)
  }
  gradients.push(`linear-gradient(${colors[0] ?? '#4f8cff'} 0 100%)`)
  return gradients
}

const cardRef = useTemplateRef<HTMLDivElement>('cardRef')
const isHovered = ref(false)
const cursorAngle = ref(45)
const edgeProximity = ref(0)
const sweepActive = ref(false)

function getCenterOfElement(el: HTMLElement): [number, number] {
  const { width, height } = el.getBoundingClientRect()
  return [width / 2, height / 2]
}

function getEdgeProximity(el: HTMLElement, x: number, y: number): number {
  const [cx, cy] = getCenterOfElement(el)
  const dx = x - cx
  const dy = y - cy
  let kx = Infinity
  let ky = Infinity
  if (dx !== 0) kx = cx / Math.abs(dx)
  if (dy !== 0) ky = cy / Math.abs(dy)
  return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1)
}

function getCursorAngle(el: HTMLElement, x: number, y: number): number {
  const [cx, cy] = getCenterOfElement(el)
  const dx = x - cx
  const dy = y - cy
  if (dx === 0 && dy === 0) return 0
  const radians = Math.atan2(dy, dx)
  let degrees = radians * (180 / Math.PI) + 90
  if (degrees < 0) degrees += 360
  return degrees
}

function handlePointerMove(event: PointerEvent): void {
  const card = cardRef.value
  if (!card) return
  const rect = card.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  edgeProximity.value = getEdgeProximity(card, x, y)
  cursorAngle.value = getCursorAngle(card, x, y)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function runSweep(): void {
  if (!props.animated || prefersReducedMotion()) return
  const angleStart = 110
  const angleEnd = 465
  sweepActive.value = true
  cursorAngle.value = angleStart

  animateValue({ duration: 500, onUpdate: (v) => (edgeProximity.value = v / 100) })
  animateValue({
    ease: easeInCubic,
    duration: 1500,
    end: 50,
    onUpdate: (v) => {
      cursorAngle.value = (angleEnd - angleStart) * (v / 100) + angleStart
    }
  })
  animateValue({
    ease: easeOutCubic,
    delay: 1500,
    duration: 2250,
    start: 50,
    end: 100,
    onUpdate: (v) => {
      cursorAngle.value = (angleEnd - angleStart) * (v / 100) + angleStart
    }
  })
  animateValue({
    ease: easeInCubic,
    delay: 2500,
    duration: 1500,
    start: 100,
    end: 0,
    onUpdate: (v) => (edgeProximity.value = v / 100),
    onEnd: () => (sweepActive.value = false)
  })
}

watch(() => props.animated, runSweep, { immediate: true })

onUnmounted(() => {
  for (const cancel of [...running]) cancel()
  running.clear()
})

const colorSensitivity = computed(() => props.edgeSensitivity + 20)
const isVisible = computed(() => isHovered.value || sweepActive.value)
const borderOpacity = computed(() =>
  isVisible.value
    ? Math.max(
        0,
        (edgeProximity.value * 100 - colorSensitivity.value) / (100 - colorSensitivity.value)
      )
    : 0
)
const glowOpacity = computed(() =>
  isVisible.value
    ? Math.max(
        0,
        (edgeProximity.value * 100 - props.edgeSensitivity) / (100 - props.edgeSensitivity)
      )
    : 0
)

const meshGradients = computed(() => buildMeshGradients(props.colors))
const borderBg = computed(() => meshGradients.value.map((g) => `${g} border-box`))
const fillBg = computed(() => meshGradients.value.map((g) => `${g} padding-box`))
const angleDeg = computed(() => `${cursorAngle.value.toFixed(3)}deg`)
</script>

<template>
  <div
    ref="cardRef"
    :class="`relative grid isolate border border-white/15 ${className}`"
    :style="{
      background: backgroundColor,
      borderRadius: borderRadius + 'px',
      transform: 'translate3d(0, 0, 0.01px)',
      boxShadow:
        'rgba(0,0,0,0.1) 0 1px 2px, rgba(0,0,0,0.1) 0 2px 4px, rgba(0,0,0,0.1) 0 4px 8px, rgba(0,0,0,0.1) 0 8px 16px, rgba(0,0,0,0.1) 0 16px 32px, rgba(0,0,0,0.1) 0 32px 64px'
    }"
    @pointermove="handlePointerMove"
    @pointerenter="isHovered = true"
    @pointerleave="isHovered = false"
  >
    <!-- mesh gradient border -->
    <div
      class="absolute inset-0 -z-[1] rounded-[inherit]"
      :style="{
        border: '1px solid transparent',
        background: [
          `linear-gradient(${backgroundColor} 0 100%) padding-box`,
          'linear-gradient(rgb(255 255 255 / 0%) 0% 100%) border-box',
          ...borderBg
        ].join(', '),
        opacity: borderOpacity,
        maskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${
          coneSpread + 15
        }%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
        WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black ${coneSpread}%, transparent ${
          coneSpread + 15
        }%, transparent ${100 - coneSpread - 15}%, black ${100 - coneSpread}%)`,
        transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out'
      }"
    />

    <!-- mesh gradient fill -->
    <div
      class="absolute inset-0 -z-[1] rounded-[inherit]"
      :style="{
        border: '1px solid transparent',
        background: fillBg.join(', '),
        maskImage: [
          'linear-gradient(to bottom, black, black)',
          'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
          'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
          `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`
        ].join(', '),
        WebkitMaskImage: [
          'linear-gradient(to bottom, black, black)',
          'radial-gradient(ellipse at 50% 50%, black 40%, transparent 65%)',
          'radial-gradient(ellipse at 66% 66%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 33% 33%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 66% 33%, black 5%, transparent 40%)',
          'radial-gradient(ellipse at 33% 66%, black 5%, transparent 40%)',
          `conic-gradient(from ${angleDeg} at center, transparent 5%, black 15%, black 85%, transparent 95%)`
        ].join(', '),
        maskComposite: 'subtract, add, add, add, add, add',
        WebkitMaskComposite:
          'source-out, source-over, source-over, source-over, source-over, source-over',
        opacity: borderOpacity * fillOpacity,
        mixBlendMode: 'soft-light',
        transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out'
      }"
    />

    <!-- outer glow -->
    <span
      class="pointer-events-none absolute z-[1] rounded-[inherit]"
      :style="{
        inset: `-${glowRadius}px`,
        maskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
        WebkitMaskImage: `conic-gradient(from ${angleDeg} at center, black 2.5%, transparent 10%, transparent 90%, black 97.5%)`,
        opacity: glowOpacity,
        mixBlendMode: 'plus-lighter',
        transition: isVisible ? 'opacity 0.25s ease-out' : 'opacity 0.75s ease-in-out'
      }"
    >
      <span
        class="absolute rounded-[inherit]"
        :style="{
          inset: `${glowRadius}px`,
          boxShadow: buildBoxShadow(glowColor, glowIntensity)
        }"
      />
    </span>

    <!-- content -->
    <div class="relative z-[1] flex flex-col overflow-hidden rounded-[inherit]">
      <slot />
    </div>
  </div>
</template>
