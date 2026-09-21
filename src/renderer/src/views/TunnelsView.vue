<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useTunnelStore } from '../composables/useTunnelStore'
import { useUi } from '../composables/ui'
import BorderGlow from '../components/bits/BorderGlow.vue'
import Counter from '../components/bits/Counter.vue'
import Dock from '../components/bits/Dock.vue'
import ElectricBorder from '../components/bits/ElectricBorder.vue'
import type { DockItemData } from '../components/bits/DockItem.vue'

const { tunnels, busy, execute, refresh } = useTunnelStore()
const { show, logTarget } = useUi()

const validating = ref(false)
const showValidate = ref(false)
const validateItems = ref<ValidateItem[]>([])

/** Batch actions live in a Dock: items grow as the pointer sweeps across them. */
const actionItems = computed<DockItemData[]>(() => [
  {
    icon: '▶',
    label: '全部启动',
    tone: 'primary',
    disabled: busy.value,
    onClick: () => void execute('start', 'all')
  },
  {
    icon: '⏹',
    label: '全部停止',
    disabled: busy.value,
    onClick: () => void execute('stop', 'all')
  },
  {
    icon: '⟳',
    label: '全部重启',
    disabled: busy.value,
    onClick: () => void execute('restart', 'all')
  },
  {
    icon: '✓',
    label: validating.value ? '校验中…' : '校验配置',
    disabled: validating.value,
    onClick: runValidate
  }
])

/**
 * Counts roll with <Counter>, which sizes itself from the font it inherits — so a
 * number always matches the chip (12px) or pill (11.5px) it sits in.
 */

const groups = computed(() => {
  const map = new Map<string, TunnelView[]>()
  for (const t of tunnels.value) {
    if (!map.has(t.group)) map.set(t.group, [])
    map.get(t.group)!.push(t)
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }))
})

const summary = computed(() => {
  const all = tunnels.value
  return {
    total: all.length,
    enabled: all.filter((t) => t.enabled).length,
    running: all.filter((t) => t.state === 'running').length,
    connecting: all.filter((t) => t.state === 'connecting').length
  }
})

function groupServer(group: TunnelView[]): string {
  const v = group[0]?.values ?? {}
  return v.server
    ? `${v.username ?? '?'}@${v.server}${v.server_port && v.server_port !== '22' ? ':' + v.server_port : ''}`
    : ''
}

async function runValidate(): Promise<void> {
  validating.value = true
  showValidate.value = true
  try {
    validateItems.value = await window.api.tunnel.validate('all')
  } catch (error) {
    validateItems.value = [
      { key: 'config', ok: false, message: error instanceof Error ? error.message : String(error) }
    ]
  } finally {
    validating.value = false
  }
}

function onShowLogs(key: string): void {
  logTarget.value = key
  show('logs')
}

/**
 * Where the row's 🌐 button points.
 *
 * Default: the tunnel's own local endpoint — `local_bind` as-is, except that a
 * wildcard bind (`0.0.0.0`, `::`) is opened as 127.0.0.1 because that is what a
 * browser on the same machine can reach — plus `local_port` and `web_path`.
 * `web_url` overrides the whole thing for cases where the path/port cannot be
 * derived (the OS still only ever receives http/https, see `url-policy`).
 */
function webUrl(t: TunnelView): string | null {
  const values = t.values ?? {}
  const override = (values.web_url ?? '').trim()
  if (override) return override

  const port = (values.local_port ?? '').trim()
  if (!port) return null

  const bind = (values.local_bind ?? '').trim()
  const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind

  const raw = (values.web_path ?? '').trim()
  const path = !raw || raw === '/' ? '/' : raw.startsWith('/') ? raw : `/${raw}`

  return `http://${host}:${port}${path}`
}

/** Disabled buttons still explain themselves on hover. */
function webTitle(t: TunnelView): string {
  const url = webUrl(t)
  if (!url) return '未设置本地端口，无法推断要打开的地址'
  if (t.state !== 'running') return `隧道${stateLabel[t.state]}时才能打开 ${url}`
  return `在浏览器中打开 ${url}`
}

function openWeb(t: TunnelView): void {
  const url = webUrl(t)
  // The shell's window-open handler validates the protocol and hands it to the OS.
  if (url) window.open(url, '_blank')
}

const stateLabel: Record<TunnelView['state'], string> = {
  running: '运行中',
  connecting: '连接中',
  stopped: '已停止'
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="view">
    <div class="toolbar">
      <div class="toolbar-left">
        <Dock :items="actionItems" />
      </div>
      <div class="toolbar-right">
        <span class="meta-chip">共 <Counter :value="summary.total" /> 个隧道</span>
        <span class="meta-chip meta-green">
          <Counter :value="summary.running" />
          运行
        </span>
        <span class="meta-chip meta-amber">
          <Counter :value="summary.connecting" />
          连接中
        </span>
        <span class="meta-chip">启用 <Counter :value="summary.enabled" /></span>
      </div>
    </div>

    <div v-if="showValidate" class="validate-panel">
      <div class="validate-header">
        <strong>配置校验结果</strong>
        <button class="btn btn-icon" @click="showValidate = false">✕</button>
      </div>
      <div v-if="validateItems.length === 0 && !validating" class="muted">
        （无隧道可校验 — 请先在「配置」页添加隧道）
      </div>
      <div v-for="item in validateItems" :key="item.key" class="validate-row">
        <span class="pill" :class="item.ok ? 'pill-green' : 'pill-red'">{{
          item.ok ? '通过' : '失败'
        }}</span>
        <code class="mono">{{ item.key }}</code>
        <span class="validate-msg">{{ item.message }}</span>
      </div>
    </div>

    <div v-if="tunnels.length === 0 && !busy" class="empty">
      <div class="empty-icon">🔌</div>
      <p>尚未配置任何隧道</p>
      <p class="muted">前往「配置」页添加隧道，或使用「打开配置…」导入已有的 tunnel.conf</p>
      <button class="btn btn-primary" @click="show('config')">去配置</button>
    </div>

    <TransitionGroup v-else name="card" tag="div" class="groups">
      <BorderGlow
        v-for="group in groups"
        :key="group.name"
        class="group-card"
        :edge-sensitivity="35"
        :glow-radius="24"
        :glow-intensity="0.85"
        :cone-spread="22"
      >
        <header class="group-header">
          <div class="group-title">
            <span class="group-name">{{ group.name }}</span>
            <span v-if="groupServer(group.items)" class="group-server mono">{{
              groupServer(group.items)
            }}</span>
            <span class="pill pill-muted"><Counter :value="group.items.length" /> 个隧道</span>
            >
          </div>
          <div class="group-actions">
            <button class="btn btn-sm" :disabled="busy" @click="execute('start', group.name)">
              ▶ 启动组
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="execute('stop', group.name)">
              ⏹ 停止组
            </button>
            <button class="btn btn-sm" :disabled="busy" @click="execute('restart', group.name)">
              ⟳ 重启组
            </button>
          </div>
        </header>

        <TransitionGroup name="row" tag="div" class="tunnel-table">
          <div class="tunnel-row tunnel-head">
            <span class="col-status">状态</span>
            <span class="col-name">隧道</span>
            <span class="col-pid">PID</span>
            <span class="col-map">本地 → 远端</span>
            <span class="col-actions">操作</span>
          </div>
          <ElectricBorder
            v-for="t in group.items"
            :key="t.key"
            :active="t.state === 'running' || t.state === 'connecting'"
            :color="t.state === 'running' ? '#2fbf71' : '#e8a13c'"
            :chaos="0.08"
            :border-radius="8"
            :max-samples="320"
            class="tunnel-row"
            content-class="electric-contents"
            :class="{ 'row-disabled': !t.enabled }"
          >
            <span class="col-status">
              <span class="dot" :class="`dot-${t.state}`"></span>
              <span class="pill" :class="`pill-${t.state}`">{{ stateLabel[t.state] }}</span>
            </span>
            <span class="col-name">
              <span class="tunnel-name">{{ t.name }}</span>
              <span v-if="!t.enabled" class="pill pill-muted">已禁用</span>
            </span>
            <span class="col-pid mono">{{ t.pid ?? '-' }}</span>
            <span class="col-map mono">
              <span class="map-local">{{ t.local }}</span>
              <span class="map-arrow">→</span>
              <span class="map-remote">{{ t.remote }}</span>
              <button
                class="btn btn-icon map-open"
                :disabled="t.state !== 'running' || !webUrl(t)"
                :title="webTitle(t)"
                aria-label="在浏览器中打开"
                @click="openWeb(t)"
              >
                🌐
              </button>
            </span>
            <span class="col-actions">
              <button
                class="btn btn-sm btn-primary"
                :disabled="busy || t.state === 'running'"
                @click="execute('start', t.key)"
              >
                启动
              </button>
              <button
                class="btn btn-sm"
                :disabled="busy || t.state === 'stopped'"
                @click="execute('stop', t.key)"
              >
                停止
              </button>
              <button class="btn btn-sm" :disabled="busy" @click="execute('restart', t.key)">
                重启
              </button>
              <button class="btn btn-sm btn-ghost" @click="onShowLogs(t.key)">日志</button>
            </span>
          </ElectricBorder>
        </TransitionGroup>
      </BorderGlow>
    </TransitionGroup>
  </div>
</template>
