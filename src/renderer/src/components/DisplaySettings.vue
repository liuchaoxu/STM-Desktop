<script setup lang="ts">
/**
 * DisplaySettings — 顶部工具栏右上角的「页面显示」设置入口。
 *
 * 一个齿轮按钮 + 贴着它向右展开的小面板，面板里是右上角两个可选内容的开关：
 * 作者信息（默认关）与 GitHub 项目链接（默认开）。两个偏好由主进程持久化在
 * `settings.json`，这里通过 `composables/ui-prefs` 的共享镜像读写，所以拨动
 * 开关会立刻反映到工具栏上，重启后依然生效。
 *
 * 面板是浮层：点面板外面或者按 Esc 都会关掉。监听 `pointerdown` 而不是
 * `click`，按下即收，不会出现「已经点了别处、面板还挂在那里」的滞后感。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { setUiPref, uiPrefs } from '../composables/ui-prefs'

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function close(): void {
  open.value = false
}

function onPointerDown(event: PointerEvent): void {
  if (open.value && !root.value?.contains(event.target as Node)) close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="ds-root">
    <button
      class="ds-trigger"
      :class="{ 'ds-trigger-open': open }"
      type="button"
      title="页面显示设置"
      aria-label="页面显示设置"
      aria-controls="display-settings-panel"
      :aria-expanded="open"
      @click="open = !open"
    >
      <!-- Material 的齿轮图标，与作者链接的圆钮同一套 24x24 / fill 画法 -->
      <svg class="ds-gear" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
        />
      </svg>
    </button>

    <Transition name="ds">
      <div
        v-if="open"
        id="display-settings-panel"
        class="ds-panel"
        role="group"
        aria-label="页面显示设置"
      >
        <p class="ds-title">页面显示</p>

        <label class="ds-row">
          <span class="ds-text">
            <span class="ds-label">作者信息</span>
            <span class="ds-hint">右上角的作者署名，点击打开项目主页</span>
          </span>
          <input
            class="ds-switch"
            type="checkbox"
            :checked="uiPrefs.showAuthorInfo"
            @change="setUiPref('showAuthorInfo', ($event.target as HTMLInputElement).checked)"
          />
        </label>

        <label class="ds-row">
          <span class="ds-text">
            <span class="ds-label">GitHub 项目链接</span>
            <span class="ds-hint">指向本项目仓库的图标按钮</span>
          </span>
          <input
            class="ds-switch"
            type="checkbox"
            :checked="uiPrefs.showGithubLink"
            @change="setUiPref('showGithubLink', ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/*
 * 右上角那一簇圆钮的样式与 AuthorLinks 保持一致（同样的 26px、面板底色、
 * 悬浮变蓝），这样齿轮不会显得是另一个界面的东西。
 */
.ds-root {
  position: relative;
  display: flex;
  align-items: center;
}

.ds-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    transform 0.15s;
}

.ds-trigger:hover,
.ds-trigger-open {
  color: var(--accent);
  border-color: var(--accent);
}

.ds-trigger:hover {
  transform: translateY(-1px);
}

.ds-gear {
  width: 14px;
  height: 14px;
  display: block;
}

.ds-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  width: 254px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  /* 与工具栏同一块玻璃：背后的丝带透一点出来，但文字仍然清晰。 */
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  backdrop-filter: blur(14px) saturate(140%);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}

.ds-title {
  margin: 2px 4px 6px;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ds-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s;
}

.ds-row:hover {
  background: var(--panel-2);
}

.ds-row + .ds-row {
  margin-top: 2px;
}

.ds-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ds-label {
  color: var(--text);
  font-size: 13px;
}

.ds-hint {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}

/* `appearance: none` 的复选框本身就是那条轨道，滑块是它的 ::after ——
   键盘焦点、空格切换都是原生行为，不用自己补。 */
.ds-switch {
  appearance: none;
  position: relative;
  flex: 0 0 auto;
  margin: 0;
  width: 34px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  cursor: pointer;
  transition:
    background 0.18s,
    border-color 0.18s;
}

.ds-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--muted);
  transition:
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    background 0.18s;
}

.ds-switch:checked {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.ds-switch:checked::after {
  transform: translateX(16px);
  background: var(--accent);
}

.ds-switch:focus-visible {
  outline: 2px solid var(--accent-soft);
  outline-offset: 2px;
}

.ds-enter-active,
.ds-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.ds-enter-from,
.ds-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .ds-enter-active,
  .ds-leave-active,
  .ds-switch,
  .ds-switch::after,
  .ds-trigger {
    transition: none;
  }

  .ds-trigger:hover {
    transform: none;
  }
}
</style>
