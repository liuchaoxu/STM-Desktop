<script setup lang="ts">
/**
 * GooeyNav — ported from Vue Bits (<https://vue-bits.dev>), "GooeyNav".
 *
 * Adaptations for this project (the upstream snippet ships as a
 * TypeScript + Tailwind variant; this app has no Tailwind and does not want one):
 *
 * 1. Tailwind utility classes were rewritten as scoped CSS with the same layout
 *    and timing. Behaviour, particles and the gooey filter are unchanged.
 * 2. Rethemed for the dark UI: the pill stays white (the gooey filter needs a
 *    bright blob to threshold against the black mask backdrop) and the active
 *    label is near-black; `--color-1..4` are light tints defined in main.css.
 * 3. `activeIndex` became an optional controlled prop with `update:activeIndex`
 *    / `select` events, so the app's own tab state drives the pill (the upstream
 *    version keeps it internal and emits nothing). `initialActiveIndex` still
 *    works for uncontrolled use.
 * 4. Upstream bug fix: Enter/Space used to build a fake event whose
 *    `currentTarget` was the `<li>`, and `handleClick` then took *its*
 *    `parentElement` — positioning the pill over the whole list. Activation now
 *    takes the `<li>` directly.
 * 5. Particles are skipped under `prefers-reduced-motion: reduce`, and pending
 *    timers are cleared on unmount.
 */
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'

export interface GooeyNavItem {
  label: string
  href?: string | null
}

const props = withDefaults(
  defineProps<{
    items?: GooeyNavItem[]
    animationTime?: number
    particleCount?: number
    particleDistances?: [number, number]
    particleR?: number
    timeVariance?: number
    colors?: number[]
    initialActiveIndex?: number
    /** Controlled selection; leave undefined for the uncontrolled behaviour. */
    activeIndex?: number
  }>(),
  {
    items: () => [],
    animationTime: 600,
    particleCount: 15,
    particleDistances: () => [90, 10] as [number, number],
    particleR: 100,
    timeVariance: 300,
    colors: () => [1, 2, 3, 1, 2, 3, 1, 4],
    initialActiveIndex: 0,
    activeIndex: undefined
  }
)

const emit = defineEmits<{
  (e: 'update:activeIndex', value: number): void
  (e: 'select', value: number): void
}>()

const containerRef = useTemplateRef<HTMLDivElement>('containerRef')
const navRef = useTemplateRef<HTMLUListElement>('navRef')
const filterRef = useTemplateRef<HTMLSpanElement>('filterRef')
const textRef = useTemplateRef<HTMLSpanElement>('textRef')

const internalIndex = ref(props.initialActiveIndex)
const activeIndex = computed({
  get: () => props.activeIndex ?? internalIndex.value,
  set: (value: number) => {
    internalIndex.value = value
    emit('update:activeIndex', value)
    emit('select', value)
  }
})

let resizeObserver: ResizeObserver | null = null
const timers = new Set<ReturnType<typeof setTimeout>>()

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer)
    fn()
  }, ms)
  timers.add(timer)
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const noise = (n = 1): number => n / 2 - Math.random() * n

const getXY = (distance: number, pointIndex: number, totalPoints: number): [number, number] => {
  const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180)
  return [distance * Math.cos(angle), distance * Math.sin(angle)]
}

interface Particle {
  start: [number, number]
  end: [number, number]
  time: number
  scale: number
  color: number
  rotate: number
}

const createParticle = (i: number, t: number, d: [number, number], r: number): Particle => {
  const rotate = noise(r / 10)
  return {
    start: getXY(d[0], props.particleCount - i, props.particleCount),
    end: getXY(d[1] + noise(7), props.particleCount - i, props.particleCount),
    time: t,
    scale: 1 + noise(0.2),
    color: props.colors[Math.floor(Math.random() * props.colors.length)] ?? 1,
    rotate: rotate > 0 ? (rotate + r / 20) * 10 : (rotate - r / 20) * 10
  }
}

function makeParticles(element: HTMLElement): void {
  if (reducedMotion()) return
  const d: [number, number] = props.particleDistances
  const r = props.particleR
  const bubbleTime = props.animationTime * 2 + props.timeVariance
  element.style.setProperty('--time', `${bubbleTime}ms`)

  for (let i = 0; i < props.particleCount; i++) {
    const t = props.animationTime * 2 + noise(props.timeVariance * 2)
    const p = createParticle(i, t, d, r)
    element.classList.remove('active')
    later(() => {
      const particle = document.createElement('span')
      const point = document.createElement('span')
      particle.classList.add('particle')
      particle.style.setProperty('--start-x', `${p.start[0]}px`)
      particle.style.setProperty('--start-y', `${p.start[1]}px`)
      particle.style.setProperty('--end-x', `${p.end[0]}px`)
      particle.style.setProperty('--end-y', `${p.end[1]}px`)
      particle.style.setProperty('--time', `${p.time}ms`)
      particle.style.setProperty('--scale', `${p.scale}`)
      particle.style.setProperty('--color', `var(--color-${p.color}, white)`)
      particle.style.setProperty('--rotate', `${p.rotate}deg`)
      point.classList.add('point')
      particle.appendChild(point)
      element.appendChild(particle)
      requestAnimationFrame(() => element.classList.add('active'))
      later(() => {
        try {
          element.removeChild(particle)
        } catch {
          /* already gone */
        }
      }, t)
    }, 30)
  }
}

function updateEffectPosition(element: HTMLElement): void {
  if (!containerRef.value || !filterRef.value || !textRef.value) return
  const containerRect = containerRef.value.getBoundingClientRect()
  const pos = element.getBoundingClientRect()
  const styles = {
    left: `${pos.x - containerRect.x}px`,
    top: `${pos.y - containerRect.y}px`,
    width: `${pos.width}px`,
    height: `${pos.height}px`
  }
  Object.assign(filterRef.value.style, styles)
  Object.assign(textRef.value.style, styles)
  textRef.value.innerText = element.innerText
}

/** Move the pill to `li` and fire the transition. Takes the `<li>` directly. */
function activate(index: number, li: HTMLElement | null): void {
  if (!li) return
  if (activeIndex.value === index) return
  activeIndex.value = index
  updateEffectPosition(li)

  if (filterRef.value) {
    for (const particle of filterRef.value.querySelectorAll('.particle')) {
      filterRef.value.removeChild(particle)
    }
  }
  if (textRef.value) {
    textRef.value.classList.remove('active')
    void textRef.value.offsetWidth // restart the color transition
    textRef.value.classList.add('active')
  }
  if (filterRef.value) makeParticles(filterRef.value)
}

function onItemClick(event: MouseEvent, index: number): void {
  if (!props.items[index]?.href) event.preventDefault()
  activate(index, (event.currentTarget as HTMLElement).parentElement)
}

function onItemKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate(index, (event.currentTarget as HTMLElement).parentElement)
}

function currentLi(): HTMLElement | null {
  const list = navRef.value?.querySelectorAll('li')[activeIndex.value]
  return list ?? null
}

watch(activeIndex, () => {
  const li = currentLi()
  if (!li) return
  updateEffectPosition(li)
  textRef.value?.classList.add('active')
})

onMounted(() => {
  const li = currentLi()
  if (li) {
    updateEffectPosition(li)
    textRef.value?.classList.add('active')
  }
  if (!containerRef.value) return
  resizeObserver = new ResizeObserver(() => {
    const current = currentLi()
    if (current) updateEffectPosition(current)
  })
  resizeObserver.observe(containerRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
})
</script>

<template>
  <div class="inline-block">
    <div ref="containerRef" class="relative">
      <nav class="relative flex" :style="{ transform: 'translate3d(0,0,0.01px)' }">
        <ul
          ref="navRef"
          class="relative z-[3] m-0 flex list-none px-1 py-0 text-ink"
          :style="{ textShadow: '0 1px 1px hsl(205deg 30% 10% / 0.2)' }"
        >
          <li
            v-for="(item, index) in items"
            :key="index"
            class="gooey-item relative cursor-pointer rounded-full shadow-[0_0_0.5px_1.5px_transparent] transition-[background-color,color,box-shadow] duration-300 ease-in-out"
            :class="{ active: activeIndex === index }"
          >
            <a
              :href="item.href || undefined"
              :role="item.href ? undefined : 'button'"
              :tabindex="item.href ? undefined : 0"
              class="gooey-link inline-block px-[0.95em] py-[0.5em] whitespace-nowrap outline-none"
              @click="onItemClick($event, index)"
              @keydown="onItemKeydown($event, index)"
            >
              {{ item.label }}
            </a>
          </li>
        </ul>
      </nav>

      <span ref="filterRef" class="effect filter" />
      <span ref="textRef" class="effect text" />
    </div>
  </div>
</template>

<style scoped>
/*
 * Layout, spacing, colour and typography come from the Tailwind utilities in the
 * template. Note `m-0 list-none px-1 py-0` on the <ul>: Preflight is not
 * imported app-wide, so the user-agent list defaults have to be reset here.
 *
 * What stays in CSS is what utilities cannot express: the active pill
 * (pseudo-element), the anchor reset, focus-visible, and the gooey filter with
 * its particles.
 */

.gooey-link {
  color: inherit;
  text-decoration: none;
}

/* `position/radius/cursor/transition/box-shadow` for the item, and the link's
   inline-block + padding, come from the utilities in the template. */

/* Cheap, non-gooey pill: keeps the active item obviously selected even if the
   filter layer is skipped (reduced motion, or a very old compositor). */
.gooey-item::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: 999px;
  background: #fff;
  opacity: 0;
  transform: scale(0.9);
  transition: all 0.3s ease;
}

.gooey-item.active {
  color: #0e1013;
  text-shadow: none;
}

.gooey-item.active::after {
  opacity: 1;
  transform: scale(1);
}

.gooey-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 999px;
}

.effect {
  position: absolute;
  opacity: 1;
  pointer-events: none;
  display: grid;
  place-items: center;
  z-index: 1;
}

.effect.text {
  color: #fff;
  transition: color 0.3s ease;
}

.effect.text.active {
  color: #000;
}

.effect.filter {
  filter: blur(7px) contrast(100) blur(0);
  mix-blend-mode: lighten;
}

.effect.filter::before {
  content: '';
  position: absolute;
  inset: -75px;
  z-index: -2;
  background: #000;
}

.effect.filter::after {
  content: '';
  position: absolute;
  inset: 0;
  background: #fff;
  transform: scale(0);
  opacity: 0;
  z-index: -1;
  border-radius: 999px;
}

.effect.active::after {
  animation: gooey-pill 0.3s ease both;
}

@keyframes gooey-pill {
  to {
    transform: scale(1);
    opacity: 1;
  }
}

/* The particles are created imperatively with `document.createElement`, so they
   carry no scope attribute of their own — `:deep()` anchors them to the
   `.effect` layer that *is* rendered by the template. */
.effect :deep(.particle),
.effect :deep(.point) {
  display: block;
  opacity: 0;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  transform-origin: center;
}

.effect :deep(.particle) {
  --time: 5s;
  position: absolute;
  top: calc(50% - 8px);
  left: calc(50% - 8px);
  animation: gooey-particle calc(var(--time)) ease 1 -350ms;
}

.effect :deep(.point) {
  background: var(--color);
  opacity: 1;
  animation: gooey-point calc(var(--time)) ease 1 -350ms;
}

@keyframes gooey-particle {
  0% {
    transform: rotate(0deg) translate(var(--start-x), var(--start-y));
    opacity: 1;
    animation-timing-function: cubic-bezier(0.55, 0, 1, 0.45);
  }
  70% {
    transform: rotate(calc(var(--rotate) * 0.5))
      translate(calc(var(--end-x) * 1.2), calc(var(--end-y) * 1.2));
    opacity: 1;
    animation-timing-function: ease;
  }
  85% {
    transform: rotate(calc(var(--rotate) * 0.66)) translate(var(--end-x), var(--end-y));
    opacity: 1;
  }
  100% {
    transform: rotate(calc(var(--rotate) * 1.2))
      translate(calc(var(--end-x) * 0.5), calc(var(--end-y) * 0.5));
    opacity: 1;
  }
}

@keyframes gooey-point {
  0% {
    transform: scale(0);
    opacity: 0;
    animation-timing-function: cubic-bezier(0.55, 0, 1, 0.45);
  }
  25% {
    transform: scale(calc(var(--scale) * 0.25));
  }
  38% {
    opacity: 1;
  }
  65% {
    transform: scale(var(--scale));
    opacity: 1;
    animation-timing-function: ease;
  }
  85% {
    transform: scale(var(--scale));
    opacity: 1;
  }
  100% {
    transform: scale(0);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .effect.filter {
    display: none;
  }

  .effect :deep(.particle) {
    display: none;
  }
}
</style>
