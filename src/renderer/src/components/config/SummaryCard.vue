<script setup lang="ts">
/**
 * One card in the config overview (the defaults section, or a group).
 *
 * Clicking the body enters it; the footer actions edit or delete without
 * navigating away, which is why they stop propagation.
 */
import BorderGlow from '../bits/BorderGlow.vue'

withDefaults(
  defineProps<{
    name: string
    icon?: string
    subtitle?: string
    /** Render the subtitle in the monospace face (server lines). */
    mono?: boolean
    badge?: string
    badgeTone?: 'muted' | 'amber'
    /** Position in the staggered entrance. */
    index?: number
  }>(),
  { icon: '🖥️', subtitle: '', mono: false, badge: '', badgeTone: 'muted', index: 0 }
)

const emit = defineEmits<{ (e: 'open'): void }>()
</script>

<template>
  <BorderGlow
    class="section-card"
    :style="{ '--i': index }"
    :edge-sensitivity="35"
    :glow-radius="26"
    :glow-intensity="0.85"
    :cone-spread="22"
  >
    <div
      class="section-body"
      role="button"
      tabindex="0"
      @click="emit('open')"
      @keydown.enter.prevent="emit('open')"
      @keydown.space.prevent="emit('open')"
    >
      <header class="section-head">
        <span class="section-icon">{{ icon }}</span>
        <span class="section-title">{{ name }}</span>
        <span
          v-if="badge"
          class="pill"
          :class="badgeTone === 'amber' ? 'pill-amber' : 'pill-muted'"
        >
          {{ badge }}
        </span>
      </header>
      <p class="section-sub" :class="{ mono }">{{ subtitle || '—' }}</p>
      <div class="section-stats"><slot name="stats" /></div>
    </div>
    <footer v-if="$slots.actions" class="section-foot">
      <slot name="actions" />
    </footer>
  </BorderGlow>
</template>
