<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTunnelStore } from '../composables/useTunnelStore'
import { useUi } from '../composables/ui'

const { tunnels, refresh } = useTunnelStore()
const { activeTab, logTarget } = useUi()

const payloads = ref<LogPayload[]>([])
const lines = ref(200)
const autoRefresh = ref(true)
const autoScroll = ref(true)
const fetching = ref(false)
const lastError = ref('')
const outBox = ref<HTMLElement | null>(null)
const errBox = ref<HTMLElement | null>(null)

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
    if (outBox.value) outBox.value.scrollTop = outBox.value.scrollHeight
    if (errBox.value) errBox.value.scrollTop = errBox.value.scrollHeight
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
          <option v-for="opt in options" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
        </select>
        <select v-model.number="lines" class="input input-select" @change="fetchLogs">
          <option :value="100">100 行</option>
          <option :value="200">200 行</option>
          <option :value="500">500 行</option>
          <option :value="1000">1000 行</option>
        </select>
        <button class="btn" :disabled="fetching" @click="fetchLogs">刷新</button>
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
          v-if="selected"
          class="meta-chip"
          :class="selected.running ? 'meta-green' : 'meta-muted'"
        >
          {{ selected.running ? '运行中' : '已停止' }}
        </span>
        <span class="meta-chip mono">{{ selected?.outPath ?? '—' }}</span>
      </div>
    </div>

    <div v-if="lastError" class="error-banner">错误：{{ lastError }}</div>
    <div v-if="!selected && !fetching" class="empty">
      <div class="empty-icon">📄</div>
      <p>没有可查看的日志</p>
      <p class="muted">请先在「配置」页添加隧道</p>
    </div>

    <div v-else class="log-grid">
      <section class="card log-card">
        <header class="card-header">
          <h2>
            标准输出 <span class="hint mono">{{ selected?.outPath }}</span>
          </h2>
        </header>
        <pre ref="outBox" class="log-box mono">{{ selected?.output }}</pre>
      </section>
      <section class="card log-card">
        <header class="card-header">
          <h2>
            标准错误 <span class="hint mono">{{ selected?.errPath }}</span>
          </h2>
        </header>
        <pre ref="errBox" class="log-box mono log-box-err">{{ selected?.error }}</pre>
      </section>
    </div>
  </div>
</template>
