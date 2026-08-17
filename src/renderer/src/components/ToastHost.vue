<script setup lang="ts">
import { useToast } from '../composables/toast'

const { toasts, remove } = useToast()
</script>

<template>
  <div class="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast-${t.type}`"
        @click="remove(t.id)"
      >
        <span class="toast-icon">{{
          t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'
        }}</span>
        <span class="toast-text">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>
