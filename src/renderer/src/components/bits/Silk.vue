<script setup lang="ts">
/**
 * Silk — ported from Vue Bits (<https://vue-bits.dev/backgrounds/silk>).
 *
 * A WebGL fragment-shader backdrop (`ogl` + the shader below, copied verbatim).
 *
 * Adaptations for this app:
 *
 * 1. **Lifecycle fixes.** Upstream registers
 *    `window.addEventListener('resize', resize)` inside `initSilk()` and only
 *    removes it in the cleanup function that `onMounted` discards — so after
 *    unmount, every window resize ran `renderer!.setSize()` on a null renderer
 *    and threw. Here there is one `dispose()`, the handler is guarded, and
 *    resizing is driven by a `ResizeObserver` on the container.
 * 2. **`active` prop** — the app keeps a single instance mounted behind the
 *    page for the whole session, so the loop must stop when the backdrop is not
 *    on screen instead of shading off-screen pixels forever.
 * 3. Renders one static frame when `prefers-reduced-motion: reduce`, and pauses
 *    while the window is hidden.
 * 4. A WebGL failure (no GPU, blocked context) is caught: the page keeps
 *    working without the backdrop instead of blowing up.
 */
import { onMounted, onUnmounted, useTemplateRef, watch, type CSSProperties } from 'vue'
import { Camera, Mesh, Plane, Program, Renderer } from 'ogl'

const props = withDefaults(
  defineProps<{
    speed?: number
    scale?: number
    color?: string
    noiseIntensity?: number
    rotation?: number
    className?: string
    style?: CSSProperties
    /** When false the render loop stops (last frame stays on screen). */
    active?: boolean
  }>(),
  {
    speed: 5,
    scale: 1,
    color: '#7B7481',
    noiseIntensity: 1.5,
    rotation: 0,
    className: '',
    style: () => ({}),
    active: true
  }
)

const containerRef = useTemplateRef<HTMLDivElement>('containerRef')

const hexToNormalizedRGB = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  return [r, g, b]
}

const vertexShader = `
attribute vec2 uv;
attribute vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vPosition = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = `
precision highp float;

varying vec2 vUv;
varying vec3 vPosition;

uniform float uTime;
uniform vec3 uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2 r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float rnd = noise(gl_FragCoord.xy);
  vec2 uv = rotateUvs(vUv * uScale, uRotation);
  vec2 tex = uv * uScale;
  float tOffset = uSpeed * uTime;

  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

  float pattern = 0.6 +
                  0.4 * sin(5.0 * (tex.x + tex.y +
                                   cos(3.0 * tex.x + 5.0 * tex.y) +
                                   0.02 * tOffset) +
                           sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));

  vec4 col = vec4(uColor, 1.0) * vec4(pattern) - rnd / 15.0 * uNoiseIntensity;
  col.a = 1.0;
  gl_FragColor = col;
}
`

let renderer: Renderer | null = null
let mesh: Mesh | null = null
let program: Program | null = null
let camera: Camera | null = null
let observer: ResizeObserver | null = null
let rafId = 0
let lastTime = 0
let disposed = false

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function resize(): void {
  const container = containerRef.value
  if (!container || !renderer || !camera) return

  // The backdrop is absolutely positioned, so fall back to the viewport when the
  // container has no box yet (hidden tab, first paint).
  const width = Math.max(container.offsetWidth || window.innerWidth, 300)
  const height = Math.max(container.offsetHeight || window.innerHeight, 300)

  renderer.setSize(width, height)
  camera.perspective({ aspect: width / height })

  if (mesh) {
    const distance = camera.position.z ?? 1
    const fov = camera.fov * (Math.PI / 180)
    const planeHeight = 2 * Math.tan(fov / 2) * distance
    mesh.scale.set(planeHeight * (width / height), planeHeight, 1)
  }
}

/** Push the current props into the uniforms and draw one frame. */
function draw(deltaSeconds: number): void {
  if (!renderer || !program || !mesh || !camera) return
  program.uniforms.uTime.value += 0.1 * deltaSeconds
  program.uniforms.uSpeed.value = props.speed
  program.uniforms.uScale.value = props.scale
  program.uniforms.uNoiseIntensity.value = props.noiseIntensity
  program.uniforms.uColor.value = hexToNormalizedRGB(props.color)
  program.uniforms.uRotation.value = props.rotation
  renderer.render({ scene: mesh, camera })
}

function tick(time: number): void {
  rafId = requestAnimationFrame(tick)
  const delta = lastTime ? (time - lastTime) / 1000 : 0
  lastTime = time
  draw(delta)
}

function start(): void {
  if (disposed || rafId || reducedMotion()) return
  lastTime = 0
  rafId = requestAnimationFrame(tick)
}

function stop(): void {
  if (!rafId) return
  cancelAnimationFrame(rafId)
  rafId = 0
}

/** Run only while the backdrop is on screen, the window is visible, and the user
 *  has not asked for reduced motion. */
function syncLoop(): void {
  if (props.active && !document.hidden && !reducedMotion()) start()
  else stop()
}

function init(): void {
  const container = containerRef.value
  if (!container) return

  renderer = new Renderer({ alpha: true, antialias: true })
  const gl = renderer.gl
  gl.clearColor(0, 0, 0, 0)

  camera = new Camera(gl, { fov: 75 })
  camera.position.z = 1

  const geometry = new Plane(gl, { width: 1, height: 1 })
  program = new Program(gl, {
    vertex: vertexShader,
    fragment: fragmentShader,
    uniforms: {
      uSpeed: { value: props.speed },
      uScale: { value: props.scale },
      uNoiseIntensity: { value: props.noiseIntensity },
      uColor: { value: hexToNormalizedRGB(props.color) },
      uRotation: { value: props.rotation },
      uTime: { value: 0 }
    }
  })
  mesh = new Mesh(gl, { geometry, program })

  const canvas = gl.canvas
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  canvas.style.position = 'absolute'
  canvas.style.top = '0'
  canvas.style.left = '0'
  container.appendChild(canvas)

  resize()
  observer = new ResizeObserver(() => resize())
  observer.observe(container)
  document.addEventListener('visibilitychange', syncLoop)

  if (reducedMotion()) {
    // One calm, static frame instead of motion.
    program.uniforms.uTime.value = 8
    draw(0)
  } else {
    syncLoop()
  }
}

function dispose(): void {
  disposed = true
  stop()
  observer?.disconnect()
  observer = null
  document.removeEventListener('visibilitychange', syncLoop)
  const canvas = renderer?.gl.canvas
  if (canvas?.parentNode) canvas.parentNode.removeChild(canvas)
  renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext()
  renderer = null
  mesh = null
  program = null
  camera = null
}

onMounted(() => {
  try {
    init()
  } catch (error) {
    // No GPU / blocked WebGL context: the page must still work.
    console.warn('Silk: WebGL unavailable, skipping the backdrop', error)
    dispose()
  }
})

watch(() => props.active, syncLoop)

onUnmounted(dispose)
</script>

<template>
  <div ref="containerRef" class="h-full w-full" :class="className" :style="style" />
</template>

<style scoped>
:deep(canvas) {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
</style>
