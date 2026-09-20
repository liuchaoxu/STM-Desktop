<script setup lang="ts">
/**
 * Direction-aware content swap, in the spirit of vue-bits' "Animated Content".
 *
 * Implemented with a plain Vue `<Transition>` plus two CSS class sets, so there
 * is no runtime dependency and `prefers-reduced-motion` collapses it to an
 * instant swap.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Change this to trigger the transition. */
    viewKey: string
    /** `forward` slides in from the right, `back` from the left. */
    direction?: 'forward' | 'back'
  }>(),
  { direction: 'forward' }
)

const name = computed(() => (props.direction === 'back' ? 'slide-back' : 'slide-forward'))
</script>

<template>
  <Transition :name="name" mode="out-in">
    <div :key="viewKey" class="animated-content">
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.animated-content {
  display: block;
}
</style>
