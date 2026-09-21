<script setup lang="ts">
/**
 * Config page: an overview of cards (defaults + one card per group), drilling
 * into a group to edit its tunnels as individual cards.
 *
 * The page owns the draft config and all mutations; the cards are presentational
 * (see components/config/). Nothing is written to disk until 保存配置.
 */
import { computed, onMounted, ref, watch } from 'vue'
import AnimatedContent from '../components/bits/AnimatedContent.vue'
import Counter from '../components/bits/Counter.vue'
import Dock from '../components/bits/Dock.vue'
import type { DockItemData } from '../components/bits/DockItem.vue'
import GroupEditorModal from '../components/config/GroupEditorModal.vue'
import OptionsEditor from '../components/config/OptionsEditor.vue'
import SummaryCard from '../components/config/SummaryCard.vue'
import TunnelCard from '../components/config/TunnelCard.vue'
import { DEFAULT_FIELDS } from '../components/config/option-fields'
import { useToast } from '../composables/toast'
import { useTunnelStore } from '../composables/useTunnelStore'

const toast = useToast()
const { tunnels: liveTunnels } = useTunnelStore()

/** File operations live in a Dock; the label tracks the save state. */
const actionItems = computed<DockItemData[]>(() => [
  {
    icon: '💾',
    label: saving.value ? '保存中…' : dirty.value ? '保存配置' : '已保存',
    tone: 'primary',
    disabled: saving.value || !dirty.value,
    onClick: () => void save()
  },
  { icon: '🔄', label: '重新加载', disabled: loading.value, onClick: reloadConfig },
  { icon: '📂', label: '打开配置…', onClick: () => void openConfig() },
  { icon: '📤', label: '另存为…', onClick: () => void saveAs() },
  { icon: '📁', label: '打开配置目录', onClick: () => void revealConfig() },
  { icon: '♻️', label: '恢复默认模板', tone: 'danger', onClick: resetConfig }
])

/**
 * Counts roll with <Counter>, which sizes itself from the font it inherits, so a
 * number matches the chip text around it.
 */

/** A group as shown on the overview: declared ones plus implicit ones. */
interface GroupEntry {
  name: string
  declared: boolean
  values: Record<string, string>
  summary: string
  tunnels: TunnelDef[]
}

type View = { kind: 'overview' } | { kind: 'defaults' } | { kind: 'group'; name: string }

const cfg = ref<ConfigData>({ defaults: {}, groups: [], tunnels: [] })
const snapshot = ref('')
const configPath = ref('')
const error = ref('')
const saving = ref(false)
const loading = ref(false)
const confirmState = ref<{ message: string; onOk: () => void } | null>(null)

const activeView = ref<View>({ kind: 'overview' })
const direction = ref<'forward' | 'back'>('forward')
const expandedTunnel = ref<TunnelDef | null>(null)
const groupEditor = ref<{ name: string; original: GroupConfig | null } | null>(null)

const dirty = computed(() => JSON.stringify(cfg.value) !== snapshot.value)

const groupNames = computed(() => cfg.value.groups.map((group) => group.name))

/** Live status of the *saved* config, used to decorate matching cards. */
const liveByKey = computed(() => {
  const map = new Map<string, TunnelView>()
  for (const tunnel of liveTunnels.value) map.set(tunnel.key, tunnel)
  return map
})

const runningTotal = computed(
  () => liveTunnels.value.filter((tunnel) => tunnel.state === 'running').length
)

function liveFor(group: string, name: string): TunnelView | undefined {
  return liveByKey.value.get(`${group}/${name}`)
}

/**
 * Stable list key per tunnel object.
 *
 * Keying by name would remount the card on every keystroke of the name field
 * (losing focus), and an object cannot be used as a `key`; a per-object id keeps
 * the DOM — and the caret — in place while the user renames a tunnel.
 */
const tunnelIds = new WeakMap<TunnelDef, string>()
let nextTunnelId = 0

function tunnelKey(tunnel: TunnelDef): string {
  let id = tunnelIds.get(tunnel)
  if (!id) {
    id = `tunnel-${nextTunnelId++}`
    tunnelIds.set(tunnel, id)
  }
  return id
}

/** `user@host:port`, with defaults already merged in (as the engine sees it). */
function serverLineOf(values: Record<string, string>): string {
  const merged = { ...cfg.value.defaults, ...values }
  if (!merged.server) return ''
  const user = merged.username ? `${merged.username}@` : ''
  const port = merged.server_port && merged.server_port !== '22' ? `:${merged.server_port}` : ''
  return `${user}${merged.server}${port}`
}

/**
 * Declared groups in file order, followed by groups that only exist because a
 * tunnel names them (legacy `[隧道名]` sections land in an implicit `default`
 * group). Implicit groups must stay visible, otherwise their tunnels could not
 * be reached from the UI at all.
 */
const groupEntries = computed<GroupEntry[]>(() => {
  const declared = new Set(cfg.value.groups.map((group) => group.name.toLowerCase()))
  const entries: GroupEntry[] = cfg.value.groups.map((group) => ({
    name: group.name,
    declared: true,
    values: group.values,
    summary: serverLineOf(group.values),
    tunnels: cfg.value.tunnels.filter((tunnel) => tunnel.group === group.name)
  }))

  const implicit = new Map<string, TunnelDef[]>()
  for (const tunnel of cfg.value.tunnels) {
    if (declared.has(tunnel.group.toLowerCase())) continue
    const list = implicit.get(tunnel.group) ?? []
    list.push(tunnel)
    implicit.set(tunnel.group, list)
  }
  for (const [name, tunnels] of implicit) {
    entries.push({ name, declared: false, values: {}, summary: serverLineOf({}), tunnels })
  }
  return entries
})

const activeEntry = computed<GroupEntry | null>(() => {
  const view = activeView.value
  if (view.kind !== 'group') return null
  return groupEntries.value.find((entry) => entry.name === view.name) ?? null
})

/** Name of the group being viewed, or '' — keeps the template free of unions. */
const activeGroupName = computed(() => {
  const view = activeView.value
  return view.kind === 'group' ? view.name : ''
})

const viewKey = computed(() => {
  const view = activeView.value
  return view.kind === 'group' ? `group:${view.name}` : view.kind
})

function runningIn(entry: GroupEntry): number {
  return entry.tunnels.filter((tunnel) => liveFor(tunnel.group, tunnel.name)?.state === 'running')
    .length
}

// ---------------------------------------------------------------- navigation

function goTo(view: View, dir: 'forward' | 'back'): void {
  direction.value = dir
  activeView.value = view
  if (view.kind !== 'group') expandedTunnel.value = null
}

function openDefaults(): void {
  goTo({ kind: 'defaults' }, 'forward')
}

function openGroup(entry: GroupEntry): void {
  expandedTunnel.value = null
  goTo({ kind: 'group', name: entry.name }, 'forward')
}

function back(): void {
  goTo({ kind: 'overview' }, 'back')
}

// ------------------------------------------------------------ config plumbing

/**
 * Deep-copy to a plain JSON object. Vue reactive proxies cannot cross the
 * Electron IPC structured-clone boundary ("An object could not be cloned."),
 * so any object sent to the main process must be plain data first.
 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [data, pathInfo] = await Promise.all([
      window.api.config.get(),
      window.api.config.getPath()
    ])
    cfg.value = data
    snapshot.value = JSON.stringify(data)
    configPath.value = pathInfo.path
    goTo({ kind: 'overview' }, 'back')
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value) return
  // quick client-side sanity checks before hitting the backend
  for (const tunnel of cfg.value.tunnels) {
    if (!tunnel.name.trim()) return showError('隧道名称不能为空')
    if (!tunnel.group.trim()) return showError(`隧道 ${tunnel.name} 的组不能为空`)
  }
  for (const group of cfg.value.groups) {
    if (!group.name.trim()) return showError('组名不能为空')
  }
  saving.value = true
  error.value = ''
  try {
    const saved = await window.api.config.save(toPlain(cfg.value))
    snapshot.value = JSON.stringify(saved)
    toast.success('配置已保存')
  } catch (saveError) {
    showError(saveError instanceof Error ? saveError.message : String(saveError))
  } finally {
    saving.value = false
  }
}

function showError(message: string): void {
  error.value = message
  toast.error(message)
}

function askConfirm(message: string, onOk: () => void): void {
  confirmState.value = { message, onOk }
}

function confirmOk(): void {
  const action = confirmState.value?.onOk
  confirmState.value = null
  action?.()
}

// --------------------------------------------------------------------- groups

function addGroup(): void {
  let name = 'new-group'
  let i = 2
  while (groupNames.value.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    name = `new-group-${i++}`
  }
  groupEditor.value = { name, original: null }
}

function openGroupEditor(entry: GroupEntry | null): void {
  if (!entry) return
  const original = entry.declared
    ? (cfg.value.groups.find((group) => group.name === entry.name) ?? null)
    : null
  groupEditor.value = { name: entry.name, original }
}

function commitGroupEditor(draft: GroupConfig): void {
  const editor = groupEditor.value
  if (!editor) return
  const name = draft.name.trim()
  if (!name) {
    showError('组名不能为空')
    return
  }
  const clash = cfg.value.groups.find(
    (group) => group !== editor.original && group.name.toLowerCase() === name.toLowerCase()
  )
  if (clash) {
    showError(`组名「${name}」已存在`)
    return
  }

  if (editor.original) {
    // Mutate in place: the tunnel-rename watcher below tracks group names by
    // position, so replacing the object would detach its tunnels.
    editor.original.name = name
    editor.original.values = draft.values
    const view = activeView.value
    if (view.kind === 'group' && view.name === editor.name) {
      activeView.value = { kind: 'group', name }
    }
  } else {
    cfg.value.groups.push({ name, values: draft.values })
  }
  groupEditor.value = null
}

function removeGroup(entry: GroupEntry | null): void {
  if (!entry?.declared) return
  const target = cfg.value.groups.find((group) => group.name === entry.name)
  if (!target) return
  const count = entry.tunnels.length
  askConfirm(
    `确定删除组「${entry.name}」？${count > 0 ? `组内 ${count} 个隧道将保留，但不再继承该组配置。` : ''}`,
    () => {
      cfg.value.groups = cfg.value.groups.filter((group) => group !== target)
      groupEditor.value = null
      const view = activeView.value
      if (view.kind === 'group' && view.name === entry.name) goTo({ kind: 'overview' }, 'back')
    }
  )
}

/** Delete from inside the group editor, which may not be the group being viewed. */
function removeGroupFromEditor(): void {
  const editor = groupEditor.value
  if (!editor?.original) return
  const entry = groupEntries.value.find((item) => item.name === editor.original?.name) ?? null
  if (entry) removeGroup(entry)
}

// -------------------------------------------------------------------- tunnels

function uniqueTunnelName(group: string): string {
  const taken = new Set(
    cfg.value.tunnels
      .filter((tunnel) => tunnel.group === group)
      .map((tunnel) => tunnel.name.toLowerCase())
  )
  let name = 'new-tunnel'
  let i = 2
  while (taken.has(name.toLowerCase())) {
    name = `new-tunnel-${i++}`
  }
  return name
}

function addTunnel(group: string): void {
  const tunnel: TunnelDef = {
    group,
    name: uniqueTunnelName(group),
    values: { enabled: 'true', local_port: '8080', remote_host: '127.0.0.1', remote_port: '8080' }
  }
  cfg.value.tunnels.push(tunnel)
  expandedTunnel.value = tunnel // open it straight away for editing
}

function toggleTunnel(tunnel: TunnelDef): void {
  expandedTunnel.value = expandedTunnel.value === tunnel ? null : tunnel
}

function removeTunnel(tunnel: TunnelDef): void {
  askConfirm(`确定删除隧道「${tunnel.group}/${tunnel.name}」？`, () => {
    cfg.value.tunnels = cfg.value.tunnels.filter((existing) => existing !== tunnel)
    if (expandedTunnel.value === tunnel) expandedTunnel.value = null
  })
}

// Keep tunnels attached when a group is renamed.
watch(
  () => cfg.value.groups.map((group) => group.name),
  (names, previous) => {
    names.forEach((name, index) => {
      const before = previous?.[index]
      if (before && before !== name && name.trim()) {
        for (const tunnel of cfg.value.tunnels) {
          if (tunnel.group === before) tunnel.group = name
        }
      }
    })
  }
)

// Recover when the section being viewed disappears (reload, reset, delete).
watch(groupEntries, (entries) => {
  const view = activeView.value
  if (view.kind !== 'group') return
  if (!entries.some((entry) => entry.name === view.name)) goTo({ kind: 'overview' }, 'back')
})

// ------------------------------------------------------------ file operations

async function openConfig(): Promise<void> {
  try {
    const result = await window.api.config.open()
    if (!result) return
    cfg.value = result.config
    snapshot.value = JSON.stringify(result.config)
    configPath.value = result.path
    error.value = ''
    goTo({ kind: 'overview' }, 'back')
    toast.success(`已切换到配置文件：${result.path}`)
  } catch (openError) {
    showError(openError instanceof Error ? openError.message : String(openError))
  }
}

async function saveAs(): Promise<void> {
  try {
    const result = await window.api.config.saveAs()
    if (result) toast.success(`已导出（不含密码）：${result.path}`)
  } catch (saveAsError) {
    showError(saveAsError instanceof Error ? saveAsError.message : String(saveAsError))
  }
}

async function revealConfig(): Promise<void> {
  try {
    await window.api.config.reveal()
  } catch (revealError) {
    showError(revealError instanceof Error ? revealError.message : String(revealError))
  }
}

function resetConfig(): void {
  askConfirm('确定恢复为默认配置模板？当前配置将被覆盖。', async () => {
    try {
      const data = await window.api.config.reset()
      cfg.value = data
      snapshot.value = JSON.stringify(data)
      error.value = ''
      goTo({ kind: 'overview' }, 'back')
      toast.success('已恢复默认配置')
    } catch (resetError) {
      showError(resetError instanceof Error ? resetError.message : String(resetError))
    }
  })
}

function reloadConfig(): void {
  if (dirty.value) {
    askConfirm('当前有未保存的修改，重新加载将丢弃这些修改。继续？', () => void load())
  } else {
    void load()
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="view config-view">
    <div class="toolbar">
      <div class="toolbar-left">
        <Dock :items="actionItems" />
      </div>
      <div class="toolbar-right">
        <span v-if="dirty" class="meta-chip meta-amber">有未保存的修改</span>
        <span class="meta-chip mono config-path" :title="configPath">{{ configPath }}</span>
      </div>
    </div>

    <div v-if="error" class="error-banner"><strong>错误：</strong>{{ error }}</div>

    <div v-if="loading" class="muted pad">加载中…</div>

    <AnimatedContent v-else :view-key="viewKey" :direction="direction">
      <!-- 概览：默认设置 + 每个组各一张卡片 -->
      <div v-if="activeView.kind === 'overview'" class="config-overview">
        <TransitionGroup name="stagger" tag="div" class="card-grid" appear>
          <SummaryCard
            key="defaults"
            :index="0"
            icon="⚙️"
            name="默认设置"
            subtitle="所有隧道的默认值，可被组 / 隧道覆盖"
            @open="openDefaults"
          >
            <template #stats>
              <span class="meta-chip"> 共 <Counter :value="cfg.tunnels.length" /> 个隧道 </span>
              <span class="meta-chip meta-green">
                <Counter :value="runningTotal" />
                运行中
              </span>
            </template>
            <template #actions>
              <span class="muted section-hint">[defaults]</span>
              <button class="btn btn-sm section-action-end" @click="openDefaults">编辑</button>
            </template>
          </SummaryCard>

          <SummaryCard
            v-for="(entry, index) in groupEntries"
            :key="entry.name"
            :index="index + 1"
            :icon="entry.declared ? '🖥️' : '❓'"
            :name="entry.name"
            :mono="!!entry.summary"
            :subtitle="entry.summary || '未设置 server / username'"
            :badge="entry.declared ? '' : '未定义'"
            badge-tone="amber"
            @open="openGroup(entry)"
          >
            <template #stats>
              <span class="meta-chip"> <Counter :value="entry.tunnels.length" /> 个隧道 </span>
              <span class="meta-chip meta-green">
                <Counter :value="runningIn(entry)" />
                运行中
              </span>
            </template>
            <template #actions>
              <button class="btn btn-sm" @click.stop="openGroupEditor(entry)">
                {{ entry.declared ? '编辑组' : '创建组配置' }}
              </button>
              <button
                v-if="entry.declared"
                class="btn btn-sm btn-danger-ghost section-action-end"
                @click.stop="removeGroup(entry)"
              >
                删除组
              </button>
            </template>
          </SummaryCard>

          <button
            key="add-group"
            class="card add-card"
            :style="{ '--i': groupEntries.length + 1 }"
            @click="addGroup"
          >
            <span class="add-icon">＋</span>
            <span>新增组</span>
          </button>
        </TransitionGroup>
      </div>

      <!-- 默认设置详情 -->
      <div v-else-if="activeView.kind === 'defaults'" class="config-detail">
        <header class="detail-head">
          <button class="btn btn-sm" @click="back">← 返回</button>
          <h2>默认设置 <span class="hint mono">[defaults]</span></h2>
        </header>
        <section class="card">
          <div class="card-body">
            <OptionsEditor v-model="cfg.defaults" :fields="DEFAULT_FIELDS" />
          </div>
        </section>
      </div>

      <!-- 组详情：组内每个隧道各一张卡片 -->
      <div v-else class="config-detail">
        <header class="detail-head">
          <button class="btn btn-sm" @click="back">← 返回</button>
          <h2>{{ activeGroupName }}</h2>
          <span v-if="activeEntry?.declared" class="hint mono">[group:{{ activeGroupName }}]</span>
          <span v-if="activeEntry && !activeEntry.declared" class="pill pill-amber">未定义</span>
          <span v-if="activeEntry?.summary" class="hint mono">{{ activeEntry.summary }}</span>
          <span class="detail-spacer" />
          <button class="btn btn-sm" @click="openGroupEditor(activeEntry)">编辑组</button>
          <button class="btn btn-sm btn-primary" @click="addTunnel(activeGroupName)">
            ＋ 新增隧道
          </button>
        </header>

        <p v-if="activeEntry && !activeEntry.declared" class="muted detail-note">
          这个组还没有 <code>[group:{{ activeGroupName }}]</code> 配置段，隧道只继承默认设置 —
          点「编辑组」补上服务器与认证信息。
        </p>

        <TransitionGroup name="stagger" tag="div" class="card-grid" appear>
          <TunnelCard
            v-for="(tunnel, index) in activeEntry?.tunnels ?? []"
            :key="tunnelKey(tunnel)"
            v-model:name="tunnel.name"
            v-model:group="tunnel.group"
            v-model:values="tunnel.values"
            :index="index"
            :state="liveFor(tunnel.group, tunnel.name)?.state"
            :pid="liveFor(tunnel.group, tunnel.name)?.pid ?? null"
            :open="expandedTunnel === tunnel"
            @toggle="toggleTunnel(tunnel)"
            @remove="removeTunnel(tunnel)"
          />

          <button
            key="add-tunnel"
            class="card add-card"
            :style="{ '--i': (activeEntry?.tunnels.length ?? 0) + 1 }"
            @click="addTunnel(activeGroupName)"
          >
            <span class="add-icon">＋</span>
            <span>新增隧道</span>
          </button>
        </TransitionGroup>

        <p v-if="(activeEntry?.tunnels.length ?? 0) === 0" class="muted detail-note">
          这个组还没有隧道 — 点「新增隧道」开始配置。
        </p>
      </div>
    </AnimatedContent>

    <datalist id="group-options">
      <option v-for="name in groupNames" :key="name" :value="name" />
    </datalist>
    <datalist id="client-options">
      <option value="auto" />
      <option value="ssh" />
      <option value="plink.exe" />
      <option value="plink" />
    </datalist>

    <Transition name="modal">
      <GroupEditorModal
        v-if="groupEditor"
        :name="groupEditor.name"
        :original="groupEditor.original"
        @commit="commitGroupEditor"
        @close="groupEditor = null"
        @remove="removeGroupFromEditor"
      />
    </Transition>

    <Transition name="modal">
      <div v-if="confirmState" class="modal-mask" @click.self="confirmState = null">
        <div class="modal">
          <p class="modal-text">{{ confirmState.message }}</p>
          <div class="modal-actions">
            <button class="btn" @click="confirmState = null">取消</button>
            <button class="btn btn-danger" @click="confirmOk">确定</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
