<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ToastHost from './components/ToastHost.vue'
import AuthorLinks from './components/AuthorLinks.vue'
import DisplaySettings from './components/DisplaySettings.vue'
import LogoLoop from './components/bits/LogoLoop.vue'
import type { LogoLoopItem } from './components/bits/LogoLoop.vue'
import MetallicPaint from './components/bits/MetallicPaint.vue'
import Silk from './components/bits/Silk.vue'
import SpecularButton from './components/bits/SpecularButton.vue'
import { textToDataUrl } from './components/bits/text-image'
import TunnelsView from './views/TunnelsView.vue'
import ConfigView from './views/ConfigView.vue'
import LogsView from './views/LogsView.vue'
import { useTunnelStore } from './composables/useTunnelStore'
import { useUi } from './composables/ui'
import { loadUiPrefs, uiPrefs } from './composables/ui-prefs'

const { busy, busyLabel, refresh, startLiveUpdates, stopLiveUpdates } = useTunnelStore()
const { activeTab } = useUi()

const info = ref<AppInfo | null>(null)

/** The wordmark is rasterized once, then painted by the metallic shader. */
const brandImage = textToDataUrl('Stm', { fontSize: 120, fontWeight: 700, padding: 10 })

/** Chips fade into the header's own background at the edges of the marquee. */
const headerFade = 'var(--bg-soft)'

/** Status chips are plain markup, so they can be handed to the loop as nodes. */
function statusChip(text: string, tone: string, title?: string): LogoLoopItem {
  // The loop renders nodes with v-html, and tooltips may carry an OS-supplied
  // path, so the attribute is escaped rather than hand-quoted.
  const safeTitle = escapeAttr(title ?? text)
  return {
    node: `<span class="meta-chip glass-chip ${tone}" title="${safeTitle}">${text}</span>`,
    title
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `win32` reads badly in a chip; the platform is only ever cosmetic. */
const PLATFORM_LABELS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

const statusItems = computed<LogoLoopItem[]>(() => {
  const current = info.value
  if (!current) return []
  return [
    statusChip(
      current.sshPath ? 'SSH 可用' : 'SSH 未找到',
      current.sshPath ? 'meta-green' : 'meta-red',
      current.sshPath ?? '未在 PATH 中找到 ssh 可执行文件'
    ),
    statusChip(
      current.plinkPath ? 'Plink 可用' : 'Plink 未内置',
      current.plinkPath ? 'meta-green' : 'meta-muted',
      current.plinkPath ?? '未随应用提供 plink.exe，密码登录需要 ssh'
    ),
    statusChip(
      current.secretsEncrypted ? '密码已加密' : '密码明文',
      current.secretsEncrypted ? 'meta-green' : 'meta-amber',
      current.secretsEncrypted
        ? '密码经系统凭据库加密存储，配置文件中不含明文'
        : '当前系统没有可用的凭据库，密码以明文保存在配置文件中'
    ),
    // Keeps the marquee from being three chips on repeat, and puts the runtime
    // versions one hover away.
    statusChip(
      PLATFORM_LABELS[current.platform] ?? current.platform,
      'meta-muted',
      `Electron ${current.versions.electron} · Node ${current.versions.node} · Chrome ${current.versions.chrome}`
    )
  ]
})

const tabs = [
  { id: 'tunnels' as const, label: '隧道' },
  { id: 'config' as const, label: '配置' },
  { id: 'logs' as const, label: '日志' }
]

const activeTabIndex = computed(() => {
  const index = tabs.findIndex((tab) => tab.id === activeTab.value)
  return index < 0 ? 0 : index
})

/**
 * The nav is controlled by the app's tab state, so switching tabs
 * programmatically (e.g. a tunnel card's 日志 button) animates the pill too.
 */
function selectTab(index: number): void {
  const tab = tabs[index]
  if (tab) activeTab.value = tab.id
}

/**
 * Ambient backdrop (vue-bits "Silk") for the 隧道 / 配置 pages. One instance for
 * the whole session, so switching tabs does not re-create the WebGL context and
 * the shader keeps flowing; the loop stops on the 日志 tab.
 */
const showBackdrop = computed(() => activeTab.value !== 'logs')

onMounted(() => {
  void refresh()
  // The shell owns the refresh loop and pushes changes; this only subscribes.
  startLiveUpdates()
  // Top-right display switches (author badge off, GitHub link on by default).
  void loadUiPrefs()
  window.api.app
    .info()
    .then((i) => (info.value = i))
    .catch(() => undefined)
})

onUnmounted(() => {
  stopLiveUpdates()
})
</script>

<template>
  <div class="app relative isolate">
    <!-- Sits behind the content but inside the app's own stacking context, so
         `-z-10` cannot fall behind the window background. -->
    <div v-show="showBackdrop" class="silk-backdrop pointer-events-none absolute inset-0 -z-10">
      <Silk
        :active="showBackdrop"
        class="h-full w-full"
        color="#16202e"
        :speed="3.5"
        :scale="1.6"
        :noise-intensity="1.1"
      />
      <div class="silk-veil absolute inset-0" />
    </div>

    <header
      class="app-header relative z-40 flex items-center gap-4 border-b border-line bg-canvas-soft px-4 py-2.5"
    >
      <MetallicPaint
        class="brand-mark block h-[26px] w-[34px] shrink-0"
        :image-src="brandImage"
        :resolution="220"
        :iterations="140"
        :scale="3.4"
        :brightness="1.7"
        :contrast="0.55"
        :liquid="0.7"
        :speed="0.24"
        :refraction="0.012"
        :blur="0.02"
        :chromatic-spread="1.5"
        :distortion="0.85"
        light-color="#e6efff"
        dark-color="#151b24"
        tint-color="#ffffff"
      />
      <nav class="ml-auto flex items-center gap-1" aria-label="页面">
        <SpecularButton
          v-for="(tab, index) in tabs"
          :key="tab.id"
          :aria-current="activeTabIndex === index ? 'page' : undefined"
          :tint="activeTabIndex === index ? 'var(--accent)' : '#ffffff'"
          :tint-opacity="activeTabIndex === index ? 0.14 : 0"
          :text-color="activeTabIndex === index ? 'var(--accent)' : 'var(--muted)'"
          :proximity="200"
          :shine-size="16"
          :shine-fade="34"
          @click="selectTab(index)"
        >
          {{ tab.label }}
        </SpecularButton>
      </nav>
      <div class="status-slot flex min-w-0 flex-1 items-center justify-center gap-2">
        <Transition name="busy">
          <span v-if="busy" class="shrink-0 text-xs text-warn">⏳ {{ busyLabel }}</span>
        </Transition>
        <!-- `fit-content` sizes the strip to exactly one copy of the sequence, so
             four short chips never appear twice side by side. -->
        <LogoLoop
          :logos="statusItems"
          :speed="26"
          :gap="26"
          :logo-height="18"
          fit-content
          fade-out
          :fade-out-color="headerFade"
          aria-label="环境状态"
        />
      </div>
      <!-- 右上角：作者信息 / GitHub 链接（由「页面显示设置」里的开关控制）+ 设置入口。
           顺序固定为「内容在前、齿轮最后」，开关拨动时齿轮不会跟着左右跳。 -->
      <AuthorLinks :show-author="uiPrefs.showAuthorInfo" :show-links="uiPrefs.showGithubLink" />
      <DisplaySettings />
    </header>

    <main class="app-main">
      <Transition name="view" mode="out-in">
        <TunnelsView v-if="activeTab === 'tunnels'" key="tunnels" />
        <ConfigView v-else-if="activeTab === 'config'" key="config" />
        <LogsView v-else key="logs" />
      </Transition>
    </main>

    <ToastHost />
  </div>
</template>

<style scoped>
/*
 * A light scrim over the Silk backdrop. The cards are opaque, but the toolbar
 * and the chips sit straight on the background — this keeps them legible while
 * letting the silk glow through. Tune the percentages (or delete the layer) to
 * taste; `color` / `speed` / `scale` / `noiseIntensity` on <Silk> are the other
 * knobs.
 */
.silk-veil {
  background:
    radial-gradient(
      120% 70% at 50% 0%,
      transparent 15%,
      color-mix(in srgb, var(--bg) 55%, transparent)
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--bg) 35%, transparent),
      color-mix(in srgb, var(--bg) 75%, transparent)
    );
}
</style>
