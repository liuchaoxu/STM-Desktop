<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Dock from '../components/bits/Dock.vue'
import ElectricBorder from '../components/bits/ElectricBorder.vue'
import type { DockItemData } from '../components/bits/DockItem.vue'
import { useTunnelStore } from '../composables/useTunnelStore'
import { useUi } from '../composables/ui'

const { tunnels, refresh } = useTunnelStore()
const { activeTab, logTarget } = useUi()

/** The only action in this row is a refresh; the rest are inputs, which stay
 *  outside the dock (a magnifying pill around a `<select>` helps nobody). */
const refreshItems = computed<DockItemData[]>(() => [
  {
    icon: '🔄',
    label: fetching.value ? '刷新中…' : '刷新',
    disabled: fetching.value,
    onClick: () => void fetchLogs()
  }
])

const payloads = ref<LogPayload[]>([])
const lines = ref(200)
const autoRefresh = ref(true)
const autoScroll = ref(true)
const fetching = ref(false)
const lastError = ref('')
const outBox = ref<HTMLElement[]>([])
const errBox = ref<HTMLElement[]>([])

const options = computed(() =>
  tunnels.value.map((t) => ({ key: t.key, label: `${t.group}/${t.name}` }))
)

const target = computed({
  get: () => logTarget.value,
  set: (v: string) => {
    logTarget.value = v
  }
})

const selected = computed(
  () => payloads.value.find((p) => p.key === target.value) ?? payloads.value[0] ?? null
)
const visiblePayloads = computed(() =>
  target.value === 'all' ? payloads.value : selected.value ? [selected.value] : []
)

// Keep the selected target valid when the tunnel list changes.
watch(
  () => options.value.map((o) => o.key),
  (keys) => {
    if (target.value !== 'all' && !keys.includes(target.value)) {
      target.value = keys[0] ?? 'all'
    }
  }
)

let timer: ReturnType<typeof setInterval> | undefined

async function fetchLogs(): Promise<void> {
  if (fetching.value) return
  fetching.value = true
  try {
    payloads.value = await window.api.tunnel.logs(target.value || 'all', lines.value)
    lastError.value = ''
  } catch (error) {
    lastError.value = error instanceof Error ? error.message : String(error)
  } finally {
    fetching.value = false
  }
}

function startPolling(): void {
  stopPolling()
  timer = setInterval(() => {
    if (autoRefresh.value && activeTab.value === 'logs' && !document.hidden) void fetchLogs()
  }, 1500)
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}

function scrollIfNeeded(): void {
  if (!autoScroll.value) return
  void nextTick(() => {
    for (const box of outBox.value) box.scrollTop = box.scrollHeight
    for (const box of errBox.value) box.scrollTop = box.scrollHeight
  })
}

watch([selected, () => lines.value], () => scrollIfNeeded(), { deep: false })

onMounted(() => {
  void refresh().then(() => void fetchLogs())
  startPolling()
})

onUnmounted(() => stopPolling())
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <div class="toolbar-left">
        <select v-model="target" class="input input-select" @change="fetchLogs">
          <option value="all">全部隧道</option>
          <option v-for="opt in options" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
        </select>
        <select v-model.number="lines" class="input input-select" @change="fetchLogs">
          <option :value="100">100 行</option>
          <option :value="200">200 行</option>
          <option :value="500">500 行</option>
          <option :value="1000">1000 行</option>
        </select>
        <Dock :items="refreshItems" />
        <label class="check">
          <input v-model="autoRefresh" type="checkbox" />
          自动刷新
        </label>
        <label class="check">
          <input v-model="autoScroll" type="checkbox" />
          自动滚动
        </label>
      </div>
      <div class="toolbar-right">
        <span
          v-if="selected && target !== 'all'"
          class="meta-chip"
          :class="selected.running ? 'meta-green' : 'meta-muted'"
        >
          {{ selected.running ? '运行中' : '已停止' }}
        </span>
        <span class="meta-chip mono">{{
          target === 'all' ? '全部隧道' : (selected?.outPath ?? '—')
        }}</span>
      </div>
    </div>

    <div v-if="lastError" class="error-banner">错误：{{ lastError }}</div>
    <div v-if="visiblePayloads.length === 0 && !fetching" class="empty">
      <div class="empty-icon">📄</div>
      <p>没有可查看的日志</p>
      <p class="muted">请先在「配置」页添加隧道</p>
    </div>

    <div v-else class="log-grid">
      <template v-for="payload in visiblePayloads" :key="payload.key">
        <section class="card log-card">
          <header class="card-header">
            <h2>
              {{ payload.key }} · 标准输出 <span class="hint mono">{{ payload.outPath }}</span>
            </h2>
          </header>
          <ElectricBorder
            :active="Boolean(payload.output)"
            :color="fetching ? '#4f8cff' : '#2fbf71'"
            :chaos="0.1"
            :border-radius="10"
            :max-samples="360"
          >
            <pre ref="outBox" class="log-box mono">{{ payload.output }}</pre>
          </ElectricBorder>
        </section>
        <section class="card log-card">
          <header class="card-header">
            <h2>
              {{ payload.key }} · 标准错误 <span class="hint mono">{{ payload.errPath }}</span>
            </h2>
          </header>
          <ElectricBorder
            :active="Boolean(payload.error)"
            :color="fetching ? '#4f8cff' : '#e5484d'"
            :chaos="0.1"
            :border-radius="10"
            :max-samples="360"
          >
            <pre ref="errBox" class="log-box mono log-box-err">{{ payload.error }}</pre>
          </ElectricBorder>
        </section>
      </template>
    </div>
  </div>
</template>
