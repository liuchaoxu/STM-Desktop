<script setup lang="ts">
/**
 * MetallicPaint — ported from Vue Bits
 * (<https://vue-bits.dev/components/metallic-paint>).
 *
 * A WebGL2 shader paints an image as liquid metal: the image is converted to a
 * depth field on the CPU, then refracted/tinted per channel in the shader. Both
 * the shader and the depth-field solver are copied verbatim.
 *
 * Adaptations for this app:
 *
 * 1. **Template bug.** Upstream writes `className="block h-full w-full
 *    object-contain"` on a Vue element; `className` is a React-ism and lands as a
 *    meaningless attribute, so the canvas keeps its 1000×1000 intrinsic size.
 *    Fixed to a real `class`.
 * 2. **Resolution is bounded, and driven by the element.** Upstream hardcodes a
 *    1000×1000×dpr canvas and a `u_ratio` of `1`. The depth solver is
 *    O(iterations × pixels) — at 1000² that is ~2×10⁸ inner-loop steps, i.e.
 *    seconds of blocking main thread on load — and the fragment shader then
 *    shades a megapixel per frame. Here the canvas matches the element's box and
 *    the solver runs at `resolution` px (default 256), which is plenty for a
 *    wordmark; `u_ratio` is computed from the real canvas aspect instead of being
 *    assumed square.
 * 3. **Lifecycle.** One `dispose()` (rAF, observer, listener, texture, context);
 *    upstream splits cleanup across a `watch` side effect, a discarded closure
 *    and `onBeforeUnmount`.
 * 4. Pauses while the window is hidden, and renders a single static frame under
 *    `prefers-reduced-motion`.
 * 5. `lightColor` / `darkColor` / `tintColor` accept any CSS colour, including
 *    `var(--token)` (upstream only parses 6-digit hex).
 */
import { onMounted, onUnmounted, useTemplateRef, watch } from 'vue'

interface MetallicPaintProps {
  imageSrc: string
  seed?: number
  scale?: number
  refraction?: number
  blur?: number
  liquid?: number
  speed?: number
  brightness?: number
  contrast?: number
  angle?: number
  fresnel?: number
  lightColor?: string
  darkColor?: string
  patternSharpness?: number
  waveAmplitude?: number
  noiseScale?: number
  chromaticSpread?: number
  mouseAnimation?: boolean
  distortion?: number
  contour?: number
  tintColor?: string
  /** Longest edge of the working texture. Lower = faster load, softer metal. */
  resolution?: number
  /** Jacobi iterations for the depth field. Cost is linear in this. */
  iterations?: number
}

const vertexShader = `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 vP;
void main(){vP=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`

const fragmentShader = `#version 300 es
precision highp float;
in vec2 vP;
out vec4 oC;
uniform sampler2D u_tex;
uniform float u_time,u_ratio,u_imgRatio,u_seed,u_scale,u_refract,u_blur,u_liquid;
uniform float u_bright,u_contrast,u_angle,u_fresnel,u_sharp,u_wave,u_noise,u_chroma;
uniform float u_distort,u_contour;
uniform vec3 u_lightColor,u_darkColor,u_tint;

vec3 sC,sM;

vec3 pW(vec3 v){
  vec3 i=floor(v),f=fract(v),s=sign(fract(v*.5)-.5),h=fract(sM*i+i.yzx),c=f*(f-1.);
  return s*c*((h*16.-4.)*c-1.);
}

vec3 aF(vec3 b,vec3 c){return pW(b+c.zxy-pW(b.zxy+c.yzx)+pW(b.yzx+c.xyz));}
vec3 lM(vec3 s,vec3 p){return(p+aF(s,p))*.5;}

vec2 fA(){
  vec2 c=vP-.5;
  c.x*=u_ratio>u_imgRatio?u_ratio/u_imgRatio:1.;
  c.y*=u_ratio>u_imgRatio?1.:u_imgRatio/u_ratio;
  return vec2(c.x+.5,.5-c.y);
}

vec2 rot(vec2 p,float r){float c=cos(r),s=sin(r);return vec2(p.x*c+p.y*s,p.y*c-p.x*s);}

float bM(vec2 c,float t){
  vec2 l=smoothstep(vec2(0.),vec2(t),c),u=smoothstep(vec2(0.),vec2(t),1.-c);
  return l.x*l.y*u.x*u.y;
}

float mG(float hi,float lo,float t,float sh,float cv){
  sh*=(2.-u_sharp);
  float ci=smoothstep(.15,.85,cv),r=lo;
  float e1=.08/u_scale;
  r=mix(r,hi,smoothstep(0.,sh*1.5,t));
  r=mix(r,lo,smoothstep(e1-sh,e1+sh,t));
  float e2=e1+.05/u_scale*(1.-ci*.35);
  r=mix(r,hi,smoothstep(e2-sh,e2+sh,t));
  float e3=e2+.025/u_scale*(1.-ci*.45);
  r=mix(r,lo,smoothstep(e3-sh,e3+sh,t));
  float e4=e1+.1/u_scale;
  r=mix(r,hi,smoothstep(e4-sh,e4+sh,t));
  float rm=1.-e4,gT=clamp((t-e4)/rm,0.,1.);
  r=mix(r,mix(hi,lo,smoothstep(0.,1.,gT)),smoothstep(e4-sh*.5,e4+sh*.5,t));
  return r;
}

void main(){
  sC=fract(vec3(.7548,.5698,.4154)*(u_seed+17.31))+.5;
  sM=fract(sC.zxy-sC.yzx*1.618);
  vec2 sc=vec2(vP.x*u_ratio,1.-vP.y);
  float angleRad=u_angle*3.14159/180.;
  sc=rot(sc-.5,angleRad)+.5;
  sc=clamp(sc,0.,1.);
  float sl=sc.x-sc.y,an=u_time*.001;
  vec2 iC=fA();
  vec4 texSample=texture(u_tex,iC);
  float dp=texSample.r;
  float shapeMask=texSample.a;
  vec3 hi=u_lightColor*u_bright;
  vec3 lo=u_darkColor*(2.-u_bright);
  lo.b+=smoothstep(.6,1.4,sc.x+sc.y)*.08;
  vec2 fC=sc-.5;
  float rd=length(fC+vec2(0.,sl*.15));
  vec2 ag=rot(fC,(.22-sl*.18)*3.14159);
  float cv=1.-pow(rd*1.65,1.15);
  cv*=pow(sc.y,.35);
  float vs=shapeMask;
  vs*=bM(iC,.01);
  float fr=pow(1.-cv,u_fresnel)*.3;
  vs=min(vs+fr*vs,1.);
  float mT=an*.0625;
  vec3 wO=vec3(-1.05,1.35,1.55);
  vec3 wA=aF(vec3(31.,73.,56.),mT+wO)*.22*u_wave;
  vec3 wB=aF(vec3(24.,64.,42.),mT-wO.yzx)*.22*u_wave;
  vec2 nC=sc*45.*u_noise;
  nC+=aF(sC.zxy,an*.17*sC.yzx-sc.yxy*.35).xy*18.*u_wave;
  vec3 tC=vec3(.00041,.00053,.00076)*mT+wB*nC.x+wA*nC.y;
  tC=lM(sC,tC);
  tC=lM(sC+1.618,tC);
  float tb=sin(tC.x*3.14159)*.5+.5;
  tb=tb*2.-1.;
  float noiseVal=pW(vec3(sc*8.+an,an*.5)).x;
  float edgeFactor=smoothstep(0.,.5,dp)*smoothstep(1.,.5,dp);
  float lD=dp+(1.-dp)*u_liquid*tb;
  lD+=noiseVal*u_distort*.15*edgeFactor;
  float rB=clamp(1.-cv,0.,1.);
  float fl=ag.x+sl;
  fl+=noiseVal*sl*u_distort*edgeFactor;
  fl*=mix(1.,1.-dp*.5,u_contour);
  fl-=dp*u_contour*.8;
  float eI=smoothstep(0.,1.,lD)*smoothstep(1.,0.,lD);
  fl-=tb*sl*1.8*eI;
  float cA=cv*clamp(pow(sc.y,.12),.25,1.);
  fl*=.12+(1.05-lD)*cA;
  fl*=smoothstep(1.,.65,lD);
  float vA1=smoothstep(.08,.18,sc.y)*smoothstep(.38,.18,sc.y);
  float vA2=smoothstep(.08,.18,1.-sc.y)*smoothstep(.38,.18,1.-sc.y);
  fl+=vA1*.16+vA2*.025;
  fl*=.45+pow(sc.y,2.)*.55;
  fl*=u_scale;
  fl-=an;
  float rO=rB+cv*tb*.025;
  float vM1=smoothstep(-.12,.18,sc.y)*smoothstep(.48,.08,sc.y);
  float cM1=smoothstep(.35,.55,cv)*smoothstep(.95,.35,cv);
  rO+=vM1*cM1*4.5;
  rO-=sl;
  float bO=rB*1.25;
  float vM2=smoothstep(-.02,.35,sc.y)*smoothstep(.75,.08,sc.y);
  float cM2=smoothstep(.35,.55,cv)*smoothstep(.75,.35,cv);
  bO+=vM2*cM2*.9;
  bO-=lD*.18;
  rO*=u_refract*u_chroma;
  bO*=u_refract*u_chroma;
  float sf=u_blur;
  float rP=fract(fl+rO);
  float rC=mG(hi.r,lo.r,rP,sf+.018+u_refract*cv*.025,cv);
  float gP=fract(fl);
  float gC=mG(hi.g,lo.g,gP,sf+.008/max(.01,1.-sl),cv);
  float bP=fract(fl-bO);
  float bC=mG(hi.b,lo.b,bP,sf+.008,cv);
  vec3 col=vec3(rC,gC,bC);
  col=(col-.5)*u_contrast+.5;
  col=clamp(col,0.,1.);
  col=mix(col,1.-min(vec3(1.),(1.-col)/max(u_tint,vec3(.001))),length(u_tint-1.)*.5);
  col=clamp(col,0.,1.);
  oC=vec4(col*vs,vs);
}`

const props = withDefaults(defineProps<MetallicPaintProps>(), {
  seed: 42,
  scale: 4,
  refraction: 0.01,
  blur: 0.015,
  liquid: 0.75,
  speed: 0.3,
  brightness: 2,
  contrast: 0.5,
  angle: 0,
  fresnel: 1,
  lightColor: '#ffffff',
  darkColor: '#000000',
  patternSharpness: 1,
  waveAmplitude: 1,
  noiseScale: 0.5,
  chromaticSpread: 2,
  mouseAnimation: false,
  distortion: 1,
  contour: 0.2,
  tintColor: '#feb3ff',
  resolution: 256,
  iterations: 200
})

const rgbCache = new Map<string, [number, number, number]>()

/** Resolve any CSS colour (hex, rgb(), `var(--token)`) to 0..1 RGB. */
function toRgb(color: string): [number, number, number] {
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

/**
 * Turn the image into a depth field (RGB) + shape mask (alpha).
 *
 * The solver is copied from upstream; only the sizing rule changed — it caps the
 * longest edge at `maxSize` and never upscales, because the iteration count is
 * paid per pixel.
 */
function processImage(
  img: HTMLImageElement,
  maxSize: number,
  iterations: number
): ImageData | null {
  const naturalWidth = img.naturalWidth || img.width
  const naturalHeight = img.naturalHeight || img.height
  if (!naturalWidth || !naturalHeight) return null

  const shrink = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(2, Math.round(naturalWidth * shrink))
  const height = Math.max(2, Math.round(naturalHeight * shrink))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data
  const size = width * height
  const alphaValues = new Float32Array(size)
  const shapeMask = new Uint8Array(size)
  const boundaryMask = new Uint8Array(size)

  for (let i = 0; i < size; i++) {
    const idx = i * 4
    const r = data[idx]!,
      g = data[idx + 1]!,
      b = data[idx + 2]!,
      a = data[idx + 3]!
    const isBackground = (r > 250 && g > 250 && b > 250 && a === 255) || a < 5
    alphaValues[i] = isBackground ? 0 : a / 255
    shapeMask[i] = alphaValues[i]! > 0.1 ? 1 : 0
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!shapeMask[idx]) continue
      if (
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        !shapeMask[idx - 1] ||
        !shapeMask[idx + 1] ||
        !shapeMask[idx - width] ||
        !shapeMask[idx + width]
      ) {
        boundaryMask[idx] = 1
      }
    }
  }

  const u = new Float32Array(size)
  const C = 0.01
  const omega = 1.85

  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x
        if (!shapeMask[idx] || boundaryMask[idx]) continue
        const sum =
          (shapeMask[idx + 1] ? u[idx + 1]! : 0) +
          (shapeMask[idx - 1] ? u[idx - 1]! : 0) +
          (shapeMask[idx + width] ? u[idx + width]! : 0) +
          (shapeMask[idx - width] ? u[idx - width]! : 0)
        const newVal = (C + sum) / 4
        u[idx] = omega * newVal + (1 - omega) * u[idx]!
      }
    }
  }

  let maxVal = 0
  for (let i = 0; i < size; i++) if (u[i]! > maxVal) maxVal = u[i]!
  if (maxVal === 0) maxVal = 1

  const outData = ctx.createImageData(width, height)
  for (let i = 0; i < size; i++) {
    const px = i * 4
    const depth = u[i]! / maxVal
    const gray = Math.round(255 * (1 - depth * depth))
    outData.data[px] = outData.data[px + 1] = outData.data[px + 2] = gray
    outData.data[px + 3] = Math.round(alphaValues[i]! * 255)
  }

  return outData
}

const canvasRef = useTemplateRef<HTMLCanvasElement>('canvasRef')

let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let uniforms: Record<string, WebGLUniformLocation | null> = {}
let texture: WebGLTexture | null = null
let observer: ResizeObserver | null = null
let raf = 0
let animTime = 0
let lastTime = 0
let disposed = false
const mouse = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 }

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function compile(source: string, type: number): WebGLShader | null {
  if (!gl) return null
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('MetallicPaint: shader failed to compile', gl.getShaderInfoLog(shader))
    return null
  }
  return shader
}

function initGL(): boolean {
  const canvas = canvasRef.value
  if (!canvas) return false
  // Without a box (no size utilities applied) there is nothing meaningful to
  // render: the aspect would be arbitrary and the contain-fit would collapse.
  if (canvas.clientWidth < 2 || canvas.clientHeight < 2) {
    console.warn('MetallicPaint: the canvas has no layout box — give it a size')
    return false
  }
  gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true })
  if (!gl) return false

  const vs = compile(vertexShader, gl.VERTEX_SHADER)
  const fs = compile(fragmentShader, gl.FRAGMENT_SHADER)
  if (!vs || !fs) return false

  const prog = gl.createProgram()
  if (!prog) return false
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('MetallicPaint: program failed to link', gl.getProgramInfoLog(prog))
    return false
  }

  const found: Record<string, WebGLUniformLocation | null> = {}
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)
    if (info) found[info.name] = gl.getUniformLocation(prog, info.name)
  }

  const buffer = gl.createBuffer()
  if (!buffer) return false
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  gl.useProgram(prog)
  const position = gl.getAttribLocation(prog, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  gl.clearColor(0, 0, 0, 0)

  program = prog
  uniforms = found
  return true
}

function resize(): void {
  const canvas = canvasRef.value
  if (!canvas || !gl) return
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr))
  if (canvas.width === width && canvas.height === height) return
  canvas.width = width
  canvas.height = height
  gl.viewport(0, 0, width, height)
  gl.uniform1f(uniforms.u_ratio ?? null, width / height)
}

function upload(imgData: ImageData): void {
  if (!gl) return
  if (texture) gl.deleteTexture(texture)
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    imgData.width,
    imgData.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    imgData.data
  )
  gl.uniform1i(uniforms.u_tex ?? null, 0)
  gl.uniform1f(uniforms.u_imgRatio ?? null, imgData.width / imgData.height)
  texture = tex
}

async function loadImage(): Promise<void> {
  if (!props.imageSrc || !gl) return
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve) => {
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = props.imageSrc
  })
  if (disposed || !gl) return
  const data = processImage(img, props.resolution, props.iterations)
  if (data) upload(data)
}

function draw(): void {
  if (!gl || !program) return
  const light = toRgb(props.lightColor)
  const dark = toRgb(props.darkColor)
  const tint = toRgb(props.tintColor)

  gl.uniform1f(uniforms.u_time ?? null, animTime)
  gl.uniform1f(uniforms.u_seed ?? null, props.seed)
  gl.uniform1f(uniforms.u_scale ?? null, props.scale)
  gl.uniform1f(uniforms.u_refract ?? null, props.refraction)
  gl.uniform1f(uniforms.u_blur ?? null, props.blur)
  gl.uniform1f(uniforms.u_liquid ?? null, props.liquid)
  gl.uniform1f(uniforms.u_bright ?? null, props.brightness)
  gl.uniform1f(uniforms.u_contrast ?? null, props.contrast)
  gl.uniform1f(uniforms.u_angle ?? null, props.angle)
  gl.uniform1f(uniforms.u_fresnel ?? null, props.fresnel)
  gl.uniform1f(uniforms.u_sharp ?? null, props.patternSharpness)
  gl.uniform1f(uniforms.u_wave ?? null, props.waveAmplitude)
  gl.uniform1f(uniforms.u_noise ?? null, props.noiseScale)
  gl.uniform1f(uniforms.u_chroma ?? null, props.chromaticSpread)
  gl.uniform1f(uniforms.u_distort ?? null, props.distortion)
  gl.uniform1f(uniforms.u_contour ?? null, props.contour)
  gl.uniform3f(uniforms.u_lightColor ?? null, light[0], light[1], light[2])
  gl.uniform3f(uniforms.u_darkColor ?? null, dark[0], dark[1], dark[2])
  gl.uniform3f(uniforms.u_tint ?? null, tint[0], tint[1], tint[2])
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

function frame(time: number): void {
  raf = requestAnimationFrame(frame)
  if (!gl || !texture) return
  const delta = lastTime ? time - lastTime : 0
  lastTime = time
  if (document.hidden) return

  if (props.mouseAnimation) {
    mouse.x += (mouse.targetX - mouse.x) * 0.08
    mouse.y += (mouse.targetY - mouse.y) * 0.08
    animTime = mouse.x * 3000 + mouse.y * 1500
  } else {
    animTime += delta * props.speed
  }
  draw()
}

function start(): void {
  if (raf || disposed || !gl) return
  if (reducedMotion()) {
    // One static frame instead of motion.
    animTime = 1200
    draw()
    return
  }
  lastTime = 0
  raf = requestAnimationFrame(frame)
}

function stop(): void {
  if (!raf) return
  cancelAnimationFrame(raf)
  raf = 0
}

function onPointerMove(event: MouseEvent): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  mouse.targetX = (event.clientX - rect.left) / rect.width
  mouse.targetY = (event.clientY - rect.top) / rect.height
}

function dispose(): void {
  disposed = true
  stop()
  observer?.disconnect()
  observer = null
  const canvas = canvasRef.value
  canvas?.removeEventListener('mousemove', onPointerMove)
  if (texture && gl) gl.deleteTexture(texture)
  texture = null
  program = null
  uniforms = {}
  if (gl) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    gl = null
  }
}

onMounted(async () => {
  if (!initGL()) {
    console.warn('MetallicPaint: WebGL2 unavailable, skipping the effect')
    return
  }
  const canvas = canvasRef.value
  canvas?.addEventListener('mousemove', onPointerMove)
  resize()
  if (canvas) {
    observer = new ResizeObserver(() => resize())
    observer.observe(canvas)
  }
  await loadImage()
  if (!disposed) start()
})

watch(
  () => props.imageSrc,
  () => {
    void loadImage()
  }
)

watch(
  () => props.mouseAnimation,
  (enabled) => {
    lastTime = 0
    if (enabled) mouse.targetX = mouse.targetY = 0.5
  }
)

onUnmounted(dispose)
</script>

<template>
  <!--
    The canvas is deliberately left unsized: the caller sets the box (e.g.
    `class="h-[26px] w-[34px]"`). A hardcoded `h-full w-full` here would fight the
    caller's utilities — Tailwind resolves that by source order, not specificity —
    and a canvas far wider than the image makes the shader's contain-fit shrink
    the artwork to a sliver in the middle.
  -->
  <canvas ref="canvasRef" class="block" />
</template>
