<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ToastHost from './components/ToastHost.vue'
import TunnelsView from './views/TunnelsView.vue'
import ConfigView from './views/ConfigView.vue'
import LogsView from './views/LogsView.vue'
import { useTunnelStore } from './composables/useTunnelStore'
import { useUi } from './composables/ui'
import { useToast } from './composables/toast'

const { busy, busyLabel, refresh, startPolling } = useTunnelStore()
const { activeTab } = useUi()
const toast = useToast()

const info = ref<AppInfo | null>(null)

const tabs = [
  { id: 'tunnels' as const, label: '隧道' },
  { id: 'config' as const, label: '配置' },
  { id: 'logs' as const, label: '日志' }
]

function revealConfig(): void {
  window.api.config.reveal().catch((e: Error) => toast.error(e.message))
}

onMounted(() => {
  void refresh()
  startPolling(2000)
  window.api.app
    .info()
    .then((i) => (info.value = i))
    .catch(() => undefined)
})
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="brand-icon">🔌</span>
        <span class="brand-title">STM Desktop</span>
        <span class="brand-sub">SSH 隧道管理器</span>
        <button
          class="chip chip-path mono"
          :title="`打开配置目录：${info?.configPath ?? ''}`"
          @click="revealConfig"
        >
          {{ info?.configPath ?? '…' }}
        </button>
      </div>
      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="env">
        <span v-if="info" class="meta-chip" :class="info.sshPath ? 'meta-green' : 'meta-red'">
          SSH {{ info.sshPath ? '可用' : '未找到' }}
        </span>
        <span v-if="info" class="meta-chip" :class="info.plinkPath ? 'meta-green' : 'meta-muted'">
          Plink {{ info.plinkPath ? '可用' : '未内置' }}
        </span>
        <span v-if="busy" class="busy-chip">⏳ {{ busyLabel }}</span>
      </div>
    </header>

    <main class="app-main">
      <TunnelsView v-if="activeTab === 'tunnels'" />
      <ConfigView v-else-if="activeTab === 'config'" />
      <LogsView v-else />
    </main>

    <ToastHost />
  </div>
</template>
