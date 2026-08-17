<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import KeyValueEditor, { type CommonKey } from '../components/KeyValueEditor.vue'
import { useToast } from '../composables/toast'

const toast = useToast()

const cfg = ref<ConfigData>({ defaults: {}, groups: [], tunnels: [] })
const snapshot = ref('')
const configPath = ref('')
const error = ref('')
const saving = ref(false)
const loading = ref(false)
const confirmState = ref<{ message: string; onOk: () => void } | null>(null)

const dirty = computed(() => JSON.stringify(cfg.value) !== snapshot.value)

const DEFAULT_COMMON: CommonKey[] = [
  { key: 'client', label: 'SSH 客户端' },
  { key: 'server_port', label: 'SSH 端口' },
  { key: 'local_bind', label: '本地绑定地址' },
  { key: 'enabled', label: '默认启用' },
  { key: 'strict_host_key_checking', label: '主机密钥校验' }
]

const GROUP_COMMON: CommonKey[] = [
  { key: 'server', label: '服务器' },
  { key: 'username', label: '用户名' },
  { key: 'password', label: '密码' },
  { key: 'private_key', label: '私钥路径' },
  { key: 'hostkey', label: '主机指纹' },
  { key: 'client', label: 'SSH 客户端' },
  { key: 'server_port', label: 'SSH 端口' },
  { key: 'local_bind', label: '本地绑定地址' },
  { key: 'strict_host_key_checking', label: '主机密钥校验' },
  { key: 'remote_host', label: '远端主机' }
]

const TUNNEL_FORM_KEYS = new Set([
  'enabled',
  'local_port',
  'remote_host',
  'remote_port',
  'local_bind',
  'server_port',
  'client',
  'private_key',
  'password',
  'hostkey',
  'strict_host_key_checking'
])

const groupNames = computed(() => cfg.value.groups.map((g) => g.name))
const revealedPwd = ref<Set<number>>(new Set())

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
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value) return
  // quick client-side sanity checks before hitting the backend
  for (const t of cfg.value.tunnels) {
    if (!t.name.trim()) return showError('隧道名称不能为空')
    if (!t.group.trim()) return showError(`隧道 ${t.name} 的组不能为空`)
  }
  for (const g of cfg.value.groups) {
    if (!g.name.trim()) return showError('组名不能为空')
  }
  saving.value = true
  error.value = ''
  try {
    const saved = await window.api.config.save(cfg.value)
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

// ------------------------------------------------------------ defaults & groups

function addGroup(): void {
  let name = 'new-group'
  let i = 2
  while (cfg.value.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
    name = `new-group-${i++}`
  }
  cfg.value.groups.push({ name, values: {} })
}

function removeGroup(group: GroupConfig): void {
  const count = cfg.value.tunnels.filter((t) => t.group === group.name).length
  askConfirm(
    `确定删除组「${group.name}」？${count > 0 ? `组内 ${count} 个隧道将保留，但不再继承该组配置。` : ''}`,
    () => {
      cfg.value.groups = cfg.value.groups.filter((g) => g !== group)
    }
  )
}

function uniqueTunnelName(group: string): string {
  const taken = new Set(
    cfg.value.tunnels.filter((t) => t.group === group).map((t) => t.name.toLowerCase())
  )
  let name = 'new-tunnel'
  let i = 2
  while (taken.has(name.toLowerCase())) {
    name = `new-tunnel-${i++}`
  }
  return name
}

function addTunnel(): void {
  const group = groupNames.value[0] ?? 'default'
  cfg.value.tunnels.push({
    group,
    name: uniqueTunnelName(group),
    values: { enabled: 'true', local_port: '8080', remote_host: '127.0.0.1', remote_port: '8080' }
  })
}

function removeTunnel(t: TunnelDef): void {
  askConfirm(`确定删除隧道「${t.group}/${t.name}」？`, () => {
    cfg.value.tunnels = cfg.value.tunnels.filter((x) => x !== t)
  })
}

// Keep tunnels attached when a group is renamed.
watch(
  () => cfg.value.groups.map((g) => g.name),
  (names, old) => {
    names.forEach((name, index) => {
      const prev = old?.[index]
      if (prev && prev !== name && name.trim()) {
        for (const t of cfg.value.tunnels) {
          if (t.group === prev) t.group = name
        }
      }
    })
  }
)

function setEnabled(t: TunnelDef, event: Event): void {
  t.values.enabled = (event.target as HTMLInputElement).checked ? 'true' : 'false'
}

function advancedValues(t: TunnelDef): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.values)) {
    if (!TUNNEL_FORM_KEYS.has(k)) out[k] = v
  }
  return out
}

function setAdvanced(t: TunnelDef, advanced: Record<string, string>): void {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.values)) {
    if (TUNNEL_FORM_KEYS.has(k)) merged[k] = v
  }
  t.values = { ...merged, ...advanced }
}

// ------------------------------------------------------------ file operations

async function openConfig(): Promise<void> {
  try {
    const result = await window.api.config.open()
    if (!result) return
    cfg.value = result.config
    snapshot.value = JSON.stringify(result.config)
    configPath.value = result.path
    error.value = ''
    toast.success(`已切换到配置文件：${result.path}`)
  } catch (openError) {
    showError(openError instanceof Error ? openError.message : String(openError))
  }
}

async function saveAs(): Promise<void> {
  try {
    const result = await window.api.config.saveAs()
    if (result) toast.success(`已导出到：${result.path}`)
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
  <div class="view">
    <div class="toolbar">
      <div class="toolbar-left">
        <button class="btn btn-primary" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : dirty ? '💾 保存配置' : '💾 已保存' }}
        </button>
        <button class="btn btn-ghost" :disabled="loading" @click="reloadConfig">重新加载</button>
        <button class="btn btn-ghost" @click="openConfig">打开配置…</button>
        <button class="btn btn-ghost" @click="saveAs">另存为…</button>
        <button class="btn btn-ghost" @click="revealConfig">打开配置目录</button>
        <button class="btn btn-danger-ghost" @click="resetConfig">恢复默认模板</button>
      </div>
      <div class="toolbar-right">
        <span class="meta-chip mono config-path" :title="configPath">{{ configPath }}</span>
      </div>
    </div>

    <div v-if="error" class="error-banner"><strong>错误：</strong>{{ error }}</div>

    <div v-if="loading" class="muted pad">加载中…</div>

    <template v-else>
      <section class="card">
        <header class="card-header">
          <h2>默认设置 <span class="hint">[defaults] — 所有隧道的默认值，可被组/隧道覆盖</span></h2>
        </header>
        <KeyValueEditor
          v-model="cfg.defaults"
          :common-keys="DEFAULT_COMMON"
          placeholder-key="例如 client"
        />
      </section>

      <section class="card">
        <header class="card-header">
          <h2>组 <span class="hint">[group:名称] — 组内隧道共享的 SSH 服务器与认证信息</span></h2>
          <button class="btn btn-sm btn-primary" @click="addGroup">＋ 添加组</button>
        </header>
        <div v-if="cfg.groups.length === 0" class="muted pad">
          （暂无组 — 所有隧道都归入 default 组）
        </div>
        <div v-for="group in cfg.groups" :key="group.name" class="group-editor">
          <div class="group-editor-head">
            <input
              v-model="group.name"
              class="input input-group-name mono"
              spellcheck="false"
              placeholder="组名"
            />
            <span class="pill pill-muted"
              >{{ cfg.tunnels.filter((t) => t.group === group.name).length }} 个隧道</span
            >
            <button class="btn btn-sm btn-danger" @click="removeGroup(group)">删除组</button>
          </div>
          <KeyValueEditor
            v-model="group.values"
            :common-keys="GROUP_COMMON"
            placeholder-key="例如 server"
          />
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>隧道 <span class="hint">[tunnel:组:名称] — 单个端口转发</span></h2>
          <button class="btn btn-sm btn-primary" @click="addTunnel">＋ 添加隧道</button>
        </header>
        <div v-if="cfg.tunnels.length === 0" class="muted pad">
          （暂无隧道 — 点击右上角「添加隧道」开始配置）
        </div>

        <div
          v-for="(t, index) in cfg.tunnels"
          :key="`${t.group}/${t.name}/${index}`"
          class="tunnel-editor"
        >
          <div class="tunnel-editor-head">
            <span class="tunnel-editor-title mono">{{ t.group }}/{{ t.name }}</span>
            <label class="check">
              <input
                type="checkbox"
                :checked="t.values.enabled !== 'false'"
                @change="setEnabled(t, $event)"
              />
              启用
            </label>
            <button class="btn btn-sm btn-danger" @click="removeTunnel(t)">删除隧道</button>
          </div>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">组</span>
              <input
                v-model="t.group"
                class="input mono"
                list="group-options"
                spellcheck="false"
                placeholder="default"
              />
            </label>
            <label class="field">
              <span class="field-label">隧道名</span>
              <input v-model="t.name" class="input mono" spellcheck="false" placeholder="redis" />
            </label>
            <label class="field">
              <span class="field-label">本地端口 *</span>
              <input
                v-model="t.values.local_port"
                class="input mono"
                inputmode="numeric"
                spellcheck="false"
                placeholder="6379"
              />
            </label>
            <label class="field">
              <span class="field-label">远端主机 *</span>
              <input
                v-model="t.values.remote_host"
                class="input mono"
                spellcheck="false"
                placeholder="127.0.0.1"
              />
            </label>
            <label class="field">
              <span class="field-label">远端端口 *</span>
              <input
                v-model="t.values.remote_port"
                class="input mono"
                inputmode="numeric"
                spellcheck="false"
                placeholder="6379"
              />
            </label>
            <label class="field">
              <span class="field-label">本地绑定地址</span>
              <input
                v-model="t.values.local_bind"
                class="input mono"
                spellcheck="false"
                placeholder="127.0.0.1"
              />
            </label>
            <label class="field">
              <span class="field-label">SSH 端口</span>
              <input
                v-model="t.values.server_port"
                class="input mono"
                inputmode="numeric"
                spellcheck="false"
                placeholder="22"
              />
            </label>
            <label class="field">
              <span class="field-label">SSH 客户端</span>
              <input
                v-model="t.values.client"
                class="input mono"
                list="client-options"
                spellcheck="false"
                placeholder="auto"
              />
            </label>
            <label class="field field-wide">
              <span class="field-label">私钥路径</span>
              <input
                v-model="t.values.private_key"
                class="input mono"
                spellcheck="false"
                placeholder="~/.ssh/id_ed25519 或绝对路径"
              />
            </label>
            <label class="field field-wide">
              <span class="field-label"
                >密码 <span class="hint">（Windows 下自动使用 plink.exe）</span></span
              >
              <span class="secret-wrap">
                <input
                  v-model="t.values.password"
                  class="input mono"
                  :type="revealedPwd.has(index) ? 'text' : 'password'"
                  autocomplete="new-password"
                  spellcheck="false"
                  placeholder="仅在使用密码认证时填写"
                />
                <button
                  class="btn btn-icon"
                  @click="
                    revealedPwd.has(index) ? revealedPwd.delete(index) : revealedPwd.add(index)
                  "
                >
                  {{ revealedPwd.has(index) ? '🙈' : '👁' }}
                </button>
              </span>
            </label>
            <label class="field field-wide">
              <span class="field-label"
                >主机指纹 hostkey <span class="hint">（Plink 推荐）</span></span
              >
              <input
                v-model="t.values.hostkey"
                class="input mono"
                spellcheck="false"
                placeholder="SHA256:…"
              />
            </label>
            <label class="field">
              <span class="field-label">主机密钥校验</span>
              <select v-model="t.values.strict_host_key_checking" class="input">
                <option value="accept-new">accept-new（推荐）</option>
                <option value="yes">yes（严格）</option>
                <option value="no">no（不安全）</option>
              </select>
            </label>
          </div>
          <details class="advanced">
            <summary>高级 / 其他选项</summary>
            <KeyValueEditor
              :model-value="advancedValues(t)"
              placeholder-key="其他键名"
              @update:model-value="setAdvanced(t, $event)"
            />
          </details>
        </div>
      </section>
    </template>

    <datalist id="group-options">
      <option v-for="name in groupNames" :key="name" :value="name" />
    </datalist>
    <datalist id="client-options">
      <option value="auto" />
      <option value="ssh" />
      <option value="plink.exe" />
      <option value="plink" />
    </datalist>

    <div v-if="confirmState" class="modal-mask" @click.self="confirmState = null">
      <div class="modal">
        <p class="modal-text">{{ confirmState.message }}</p>
        <div class="modal-actions">
          <button class="btn" @click="confirmState = null">取消</button>
          <button class="btn btn-danger" @click="confirmOk">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>
