<script setup lang="ts">
/**
 * SpecularButton — ported from Vue Bits
 * (<https://vue-bits.dev/components/specular-button>).
 *
 * A WebGL2 shader draws a specular streak along the button's rounded-rectangle
 * SDF; the light steers toward the pointer and only lights up within
 * `proximity` pixels of the button. The shader, the SDF maths and the pointer
 * steering are copied verbatim.
 *
 * Adaptations for this app:
 *
 * 1. **Lifecycle.** Upstream registers `onUnmounted` *inside* `onMounted`. Vue 3
 *    only collects lifecycle hooks while a component instance is current, and
 *    one is not guaranteed while a mounted hook runs — if it is missed, nothing
 *    ever runs cleanup, so the rAF loop, resize observer, window listener and
 *    WebGL context leak per button. Cleanup is registered at setup scope here.
 * 2. **Theme-aware colours.** `ogl`'s `Color.set()` only understands hex/array
 *    values, so `lineColor` / `baseColor` are resolved through the cascade
 *    instead (cached), which means `var(--accent)` works and the palette stays
 *    single-sourced.
 * 3. **Idle cost.** The GL work is skipped while the shine is invisible (and the
 *    frame is cleared once), and the loop pauses while the window is hidden —
 *    the app already runs a backdrop shader.
 * 4. Reduced motion drops the autonomous idle sweep; the shine still follows the
 *    pointer, so the button keeps its feedback.
 * 5. An `xs` size was added for dense toolbars, and the base styling is tuned to
 *    this app's dark, compact controls.
 */
import { Mesh, Program, Renderer, Triangle } from 'ogl'
import { computed, onMounted, onUnmounted, useTemplateRef, type CSSProperties } from 'vue'

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface SpecularButtonProps {
  size?: ButtonSize
  radius?: number
  tint?: string
  tintOpacity?: number
  blur?: number
  textColor?: string
  lineColor?: string
  baseColor?: string
  intensity?: number
  shineSize?: number
  shineFade?: number
  thickness?: number
  speed?: number
  followMouse?: boolean
  proximity?: number
  autoAnimate?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

const PAD = 20

const SIZES: Record<ButtonSize, string> = {
  xs: 'text-[13px] px-3 py-[5px] font-medium',
  sm: 'text-[0.85rem] px-[22px] py-[10px]',
  md: 'text-[1rem] px-[30px] py-[14px]',
  lg: 'text-[1.15rem] px-10 py-[18px]'
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;

out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float shapeSDF(vec2 p) { return sdRoundedRect(p, uHalfSize, uRadius); }

float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = shapeSDF(p);
  vec2 L = vec2(cos(uAngle), sin(uAngle));

  // Dark base stroke hugging the edge for a sense of thickness
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;

  // Symmetric specular: the edges facing toward/away from the light both
  // catch a streak. The angular window (size + fade) is measured with an
  // elliptical normal so it varies continuously along straight edges.
  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float line = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float hi = line * rim * edgeClamp * uIntensity;

  vec3 col = uBaseColor * base + uLineColor * hi;
  float a = clamp(base + hi, 0.0, 1.0);
  fragColor = vec4(col, a);
}
`

const props = withDefaults(defineProps<SpecularButtonProps>(), {
  size: 'xs',
  radius: 7,
  tint: '#ffffff',
  tintOpacity: 0,
  blur: 0,
  textColor: 'var(--text)',
  lineColor: '#dbe9ff',
  baseColor: '#3a4250',
  intensity: 1,
  shineSize: 14,
  shineFade: 38,
  thickness: 1,
  speed: 0.15,
  followMouse: true,
  proximity: 220,
  autoAnimate: false,
  disabled: false,
  type: 'button'
})

const rgbCache = new Map<string, [number, number, number]>()

/** Resolve any CSS colour — including `var(--token)` — to 0..1 RGB. */
function resolveRgb(color: string): [number, number, number] {
  const cached = rgbCache.get(color)
  if (cached) return cached

  let result: [number, number, number] = [1, 1, 1]
  const probe = document.createElement('span')
  probe.style.color = color
  if (probe.style.color) {
    probe.style.cssText += ';position:absolute;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    try {
      const match = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/)
      if (match) {
        const parts = match[1]!
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number)
        if (parts.length >= 3) {
          result = [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255]
        }
      }
    } finally {
      probe.remove()
    }
  }
  rgbCache.set(color, result)
  return result
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const btnRef = useTemplateRef<HTMLButtonElement>('btnRef')
const fxRef = useTemplateRef<HTMLSpanElement>('fxRef')

const sizeClass = computed(() => SIZES[props.size] ?? SIZES.xs)

const buttonStyle = computed<CSSProperties>(() => ({
  borderRadius: `${props.radius}px`,
  color: props.textColor,
  background: `color-mix(in srgb, ${props.tint} ${props.tintOpacity * 100}%, transparent)`,
  backdropFilter: props.blur > 0 ? `blur(${props.blur}px)` : undefined
}))

let dispose: (() => void) | null = null

onMounted(() => {
  const btn = btnRef.value
  const fx = fxRef.value
  if (!btn || !fx) return

  let renderer: Renderer
  try {
    renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      dpr: window.devicePixelRatio || 1
    })
  } catch (error) {
    // No WebGL: the button must still work, just without the light.
    console.warn('SpecularButton: WebGL unavailable, skipping the shine', error)
    return
  }

  const dpr = window.devicePixelRatio || 1
  const gl = renderer.gl
  gl.clearColor(0, 0, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  const geometry = new Triangle(gl)
  if (geometry.attributes.uv) delete geometry.attributes.uv

  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    uniforms: {
      uCenter: { value: [0, 0] },
      uHalfSize: { value: [1, 1] },
      uRadius: { value: 0 },
      uAngle: { value: 2.4 },
      uPx: { value: dpr },
      uLineColor: { value: [1, 1, 1] },
      uBaseColor: { value: [0.32, 0.32, 0.32] },
      uIntensity: { value: 1 },
      uShineSize: { value: 0.17 },
      uShineFade: { value: 0.7 },
      uThickness: { value: 1 },
      uBaseWidth: { value: dpr }
    }
  })

  const mesh = new Mesh(gl, { geometry, program })
  fx.appendChild(gl.canvas)

  const sizeRef = { w: 1, h: 1 }
  const resize = (): void => {
    // Fractional size + explicit center keep the SDF pinned to the exact CSS
    // border instead of drifting up to a pixel from offsetWidth rounding.
    const rect = btn.getBoundingClientRect()
    sizeRef.w = rect.width
    sizeRef.h = rect.height
    renderer.setSize(rect.width + PAD * 2, rect.height + PAD * 2)
    program.uniforms.uCenter.value = [(PAD + rect.width / 2) * dpr, (PAD + rect.height / 2) * dpr]
    program.uniforms.uHalfSize.value = [(rect.width / 2) * dpr, (rect.height / 2) * dpr]
  }
  const observer = new ResizeObserver(resize)
  observer.observe(btn)
  resize()

  // Light angle steers toward the pointer and falls back to a slow sweep until
  // the pointer has moved at least once.
  let pointerAngle: number | null = null
  let proximityT = 0
  const onPointerMove = (event: PointerEvent): void => {
    const rect = btn.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right)
    const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom)
    const dist = Math.hypot(dx, dy)
    // Over the button itself the light settles on the diagonal (framing the
    // corners) and gently sways with the cursor position within the button.
    if (dist === 0) {
      const nx = (event.clientX - cx) / (rect.width / 2)
      const ny = (cy - event.clientY) / (rect.height / 2)
      pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + nx * 0.3 + ny * 0.15
    } else {
      pointerAngle = Math.atan2(cy - event.clientY, event.clientX - cx)
    }
    const t = Math.max(0, 1 - dist / Math.max(props.proximity, 1))
    proximityT = t * t * (3 - 2 * t)
  }
  window.addEventListener('pointermove', onPointerMove)

  let angle = 2.4
  let idleAngle = 2.4
  let bright = 0
  // The shader always paints the dark base stroke that hugs the edge, so the
  // last "shine at rest" frame is kept on the canvas and only re-rendered when
  // the pointer comes back — otherwise the button would lose its resting edge.
  let resting = false
  let last = performance.now()
  let raf = 0
  const idleSpeed = prefersReducedMotion() ? 0 : props.speed

  const update = (now: number): void => {
    raf = requestAnimationFrame(update)
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    if (document.hidden) return

    idleAngle += idleSpeed * dt
    const steer =
      props.followMouse && pointerAngle != null && (!props.autoAnimate || proximityT > 0)
    const target = steer ? pointerAngle! : idleAngle
    const diff = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    angle += diff * (1 - Math.exp(-dt * 7))

    // Shine fades in with pointer proximity unless autoAnimate keeps it on
    const brightTarget = props.autoAnimate ? 1 : proximityT
    bright += (brightTarget - bright) * (1 - Math.exp(-dt * 8))

    program.uniforms.uAngle.value = angle
    program.uniforms.uRadius.value =
      Math.min(props.radius, Math.min(sizeRef.w, sizeRef.h) / 2) * dpr
    program.uniforms.uLineColor.value = resolveRgb(props.lineColor)
    program.uniforms.uBaseColor.value = resolveRgb(props.baseColor)
    program.uniforms.uIntensity.value = props.intensity * bright
    program.uniforms.uShineSize.value = (props.shineSize * Math.PI) / 180
    program.uniforms.uShineFade.value = (props.shineFade * Math.PI) / 180
    program.uniforms.uThickness.value = props.thickness * dpr

    const shining = bright > 0.002
    if (shining || !resting) {
      renderer.render({ scene: mesh })
      resting = !shining
    }
  }
  raf = requestAnimationFrame(update)

  dispose = (): void => {
    cancelAnimationFrame(raf)
    observer.disconnect()
    window.removeEventListener('pointermove', onPointerMove)
    if (gl.canvas.parentNode === fx) fx.removeChild(gl.canvas)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    dispose = null
  }
})

onUnmounted(() => dispose?.())
</script>

<template>
  <button
    ref="btnRef"
    :type="type"
    :disabled="disabled"
    class="specular-btn relative m-0 inline-flex cursor-pointer items-center justify-center border-none leading-none outline-none transition-transform duration-150 active:scale-[0.97] disabled:cursor-default disabled:opacity-55 disabled:active:scale-100"
    :class="sizeClass"
    :style="buttonStyle"
  >
    <span ref="fxRef" aria-hidden="true" class="pointer-events-none absolute -inset-5 z-[1]" />
    <span class="relative z-[2] whitespace-nowrap"><slot /></span>
  </button>
</template>

<style scoped>
/* The canvas is created imperatively, so it needs `:deep()` to pick up the
   scope; ogl sizes it inline to the wrapper's box. */
.specular-btn :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.specular-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
</style>
