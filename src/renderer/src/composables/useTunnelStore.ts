import { ref } from 'vue'
import { useToast } from './toast'

type Action = 'start' | 'stop' | 'restart'

const tunnels = ref<TunnelView[]>([])
const loading = ref(false)
const lastUpdated = ref(0)
const loadError = ref('')
const busy = ref(false)
const busyLabel = ref('')

let timer: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined

/**
 * Safety net only: the shell pushes the projection (see `src/main/status.ts`), so
 * this exists to heal a window that somehow missed an update — not to drive the UI.
 */
const FALLBACK_POLL_MS = 15000

export function useTunnelStore(): {
  tunnels: typeof tunnels
  loading: typeof loading
  lastUpdated: typeof lastUpdated
  loadError: typeof loadError
  busy: typeof busy
  busyLabel: typeof busyLabel
  refresh: () => Promise<void>
  startLiveUpdates: (ms?: number) => void
  stopLiveUpdates: () => void
  execute: (action: Action, target: string) => Promise<ActionResult | null>
} {
  const toast = useToast()

  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      tunnels.value = await window.api.tunnel.list()
      loadError.value = ''
      lastUpdated.value = Date.now()
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    } finally {
      loading.value = false
    }
  }

  /** Subscribes to the shell's pushes and arms the fallback poll. */
  function startLiveUpdates(ms = FALLBACK_POLL_MS): void {
    stopLiveUpdates()
    unsubscribe = window.api.tunnel.onChanged((views) => {
      tunnels.value = views
      lastUpdated.value = Date.now()
      loadError.value = ''
    })
    timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, ms)
  }

  function stopLiveUpdates(): void {
    unsubscribe?.()
    unsubscribe = undefined
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  async function execute(action: Action, target: string): Promise<ActionResult | null> {
    if (busy.value) return null
    busy.value = true
    busyLabel.value = `${action} ${target}`
    try {
      const result = await window.api.tunnel[action](target)
      if (result.ok && result.messages.length > 0) {
        toast.success(result.messages.slice(0, 3).join('；'))
      } else if (result.ok) {
        toast.info(`${action} ${target} 完成（没有可操作的隧道）`)
      }
      if (result.errors.length > 0) {
        toast.error(result.errors.slice(0, 4).join('；'))
      }
      await refresh()
      return result
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      busy.value = false
      busyLabel.value = ''
    }
  }

  return {
    tunnels,
    loading,
    lastUpdated,
    loadError,
    busy,
    busyLabel,
    refresh,
    startLiveUpdates,
    stopLiveUpdates,
    execute
  }
}
