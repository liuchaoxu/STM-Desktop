<script setup lang="ts">
/**
 * One tunnel inside a group: a summary card that expands into its editor.
 *
 * The editor stays mounted while collapsed (see RevealPanel), so collapsing a
 * card never discards a half-finished edit. `name`, `group` and `values` are
 * models rather than prop mutations, keeping "props down, events up" intact.
 */
import { computed, useId } from 'vue'
import RevealPanel from '../bits/RevealPanel.vue'
import BorderGlow from '../bits/BorderGlow.vue'
import OptionsEditor from './OptionsEditor.vue'
import { TUNNEL_FIELDS } from './option-fields'

defineProps<{
  open: boolean
  state?: 'stopped' | 'connecting' | 'running'
  pid?: number | null
  index?: number
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'remove'): void
}>()

const name = defineModel<string>('name', { required: true })
const group = defineModel<string>('group', { required: true })
const values = defineModel<Record<string, string>>('values', { required: true })

/** Unique per card: several cards and the group modal can be mounted at once. */
const uid = useId()

const enabled = computed(() => values.value.enabled !== 'false')
const local = computed(
  () => `${values.value.local_bind || '127.0.0.1'}:${values.value.local_port || '?'}`
)
const remote = computed(
  () => `${values.value.remote_host || '?'}:${values.value.remote_port || '?'}`
)

const STATE_LABEL: Record<'stopped' | 'connecting' | 'running', string> = {
  running: '运行中',
  connecting: '连接中',
  stopped: '已停止'
}
const STATE_TONE: Record<'stopped' | 'connecting' | 'running', string> = {
  running: 'pill-green',
  connecting: 'pill-amber',
  stopped: 'pill-muted'
}

function toggle(): void {
  emit('toggle')
}
</script>

<template>
  <BorderGlow
    class="section-card tunnel-card"
    :class="{ 'is-open': open }"
    :style="{ '--i': index ?? 0 }"
    :edge-sensitivity="35"
    :glow-radius="26"
    :glow-intensity="0.85"
    :cone-spread="22"
  >
    <div
      class="section-body"
      role="button"
      tabindex="0"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <header class="section-head">
        <span class="dot" :class="`dot-${state ?? 'stopped'}`" />
        <span class="section-title">{{ name || '（未命名隧道）' }}</span>
        <span v-if="!enabled" class="pill pill-muted">已禁用</span>
        <span v-if="state" class="pill" :class="STATE_TONE[state]">{{ STATE_LABEL[state] }}</span>
        <span class="section-spacer" />
        <span class="chevron" :class="{ 'chevron-open': open }" aria-hidden="true">▾</span>
      </header>
      <div class="tunnel-map mono">
        <span class="map-local">{{ local }}</span>
        <span class="map-arrow">→</span>
        <span class="map-remote">{{ remote }}</span>
        <span v-if="pid" class="muted">PID {{ pid }}</span>
      </div>
    </div>

    <RevealPanel :open="open">
      <div class="card-body">
        <div class="form-grid">
          <div class="field">
            <label class="field-label" :for="`${uid}-name`">隧道名</label>
            <input
              :id="`${uid}-name`"
              v-model="name"
              class="input mono"
              spellcheck="false"
              placeholder="redis"
            />
          </div>
          <div class="field">
            <label class="field-label" :for="`${uid}-group`">所属组</label>
            <input
              :id="`${uid}-group`"
              v-model="group"
              class="input mono"
              list="group-options"
              spellcheck="false"
              placeholder="default"
            />
          </div>
        </div>
        <OptionsEditor v-model="values" :fields="TUNNEL_FIELDS" />
        <div class="card-actions">
          <button class="btn btn-sm btn-danger-ghost" @click="emit('remove')">删除隧道</button>
        </div>
      </div>
    </RevealPanel>
  </BorderGlow>
</template>
