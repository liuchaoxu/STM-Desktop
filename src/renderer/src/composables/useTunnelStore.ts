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

export function useTunnelStore(): {
  tunnels: typeof tunnels
  loading: typeof loading
  lastUpdated: typeof lastUpdated
  loadError: typeof loadError
  busy: typeof busy
  busyLabel: typeof busyLabel
  refresh: () => Promise<void>
  startPolling: (ms?: number) => void
  stopPolling: () => void
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

  function startPolling(ms = 2000): void {
    stopPolling()
    timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, ms)
  }

  function stopPolling(): void {
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
    startPolling,
    stopPolling,
    execute
  }
}
