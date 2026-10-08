/**
 * 顶部工具栏的显示偏好（右上角「设置」按钮里的两个开关）。
 *
 * 真值存放在主进程的 `settings.json` 里，这里只做一份共享的响应式镜像：
 * `App.vue` 挂载时读一次，开关改动时先改镜像再落盘，所以界面不会等 IPC
 * 往返。默认值必须与 `src/main/settings.ts` 的 `UI_PREF_DEFAULTS` 保持一致
 * ——这样首帧（还没读到磁盘设置时）就是正确的。
 */
import { ref } from 'vue'
import { useToast } from './toast'

/** 与主进程 `UI_PREF_DEFAULTS` 对齐：只有 GitHub 链接默认可见。 */
const DEFAULTS: UiPrefs = {
  showAuthorInfo: false,
  showGithubLink: true
}

export const uiPrefs = ref<UiPrefs>({ ...DEFAULTS })

/** 读取已保存的偏好；挂载时调用一次即可。 */
export async function loadUiPrefs(): Promise<void> {
  try {
    uiPrefs.value = await window.api.ui.getPrefs()
  } catch {
    // 读不到就沿用默认值：这只是显示偏好，不值得打断启动流程。
  }
}

/**
 * 写盘的串行队列。
 *
 * 主进程的 `patchPrefs` 是「读 - 改 - 写」，两次调用如果并行，后一次会把前一次
 * 刚写进去的字段覆盖掉（两次读到的都是同一份旧值）。开关挨着点两下是很自然的
 * 动作，所以这里排队，一次只发一个。
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * 切换一个开关。镜像立即更新（开关不该有延迟感），写入排在队列后面；
 * 写盘失败则只回滚这一项，并提示用户这次改动没有保存。
 */
export async function setUiPref(key: keyof UiPrefs, value: boolean): Promise<void> {
  const before = uiPrefs.value
  if (before[key] === value) return

  const patch: Partial<UiPrefs> = {}
  patch[key] = value
  uiPrefs.value = { ...before, ...patch }

  const run = queue.then(() => window.api.ui.patchPrefs(patch))
  queue = run.catch(() => undefined)

  try {
    // 用主进程返回的完整结果收尾，镜像与 settings.json 不会各说各话。
    uiPrefs.value = await run
  } catch {
    const rollback: Partial<UiPrefs> = {}
    rollback[key] = before[key]
    // 只回滚这一项：期间另一个开关的改动不该被一起撤掉。
    uiPrefs.value = { ...uiPrefs.value, ...rollback }
    useToast().error('显示设置没能保存')
  }
}
