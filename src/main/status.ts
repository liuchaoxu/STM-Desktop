/**
 * Main-process status loop.
 *
 * The renderer used to poll `tunnel:list` every 2 s. That put the loop in the wrong
 * place: every window woke up on its own timer, each call re-ran the whole status
 * projection (one process enumeration plus a TCP probe per live tunnel), and the
 * answer was usually identical to the previous one. Now the shell owns a single
 * loop, runs it only while a window is actually on screen, skips the push when
 * nothing changed, and pushes after mutations — so an idle or minimised app costs
 * nothing and a start/stop shows up in the UI immediately instead of up to 2 s
 * later.
 */
import { app, BrowserWindow } from 'electron'
import type { TunnelManager } from '../core/manager'
import type { TunnelView } from '../core/types'
import { TUNNEL_CHANGED } from '../shared/contract'

/** While a window is visible. */
const INTERVAL_MS = 2000
/** While every window is hidden or minimised: just enough to stay honest. */
const IDLE_INTERVAL_MS = 10000

export interface StatusBroadcaster {
  /** Project and send now (used after mutations and when a window comes back). */
  push: (force?: boolean) => Promise<void>
  stop: () => void
}

/** Cheap change detector: the fields the UI actually renders. */
function signatureOf(views: TunnelView[]): string {
  return views.map((v) => `${v.key}:${v.state}:${v.pid ?? '-'}:${v.enabled ? 1 : 0}`).join('|')
}

function liveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed()
  )
}

export function startStatusBroadcast(manager: TunnelManager): StatusBroadcaster {
  let stopped = false
  let projecting = false
  let lastSignature = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  async function push(force = false): Promise<void> {
    // One projection at a time: `manager.list()` is the expensive call here.
    if (stopped || projecting) return
    const targets = liveWindows()
    if (targets.length === 0) return

    projecting = true
    try {
      // Apply the auto-reconnect policy before projecting, so a reconnect that is
      // due shows up in the same push that reported the death.
      await manager.reconcile()
      const views = await manager.list()
      const signature = signatureOf(views)
      if (!force && signature === lastSignature) return
      lastSignature = signature
      for (const win of targets) win.webContents.send(TUNNEL_CHANGED, views)
    } catch {
      // A failing projection must not kill the loop (nor wipe the last good state).
    } finally {
      projecting = false
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    const visible = liveWindows().some((win) => win.isVisible() && !win.isMinimized())
    if (visible) await push()
    if (stopped) return
    timer = setTimeout(() => void tick(), visible ? INTERVAL_MS : IDLE_INTERVAL_MS)
  }

  // Coming back to the window is the moment the UI must be right.
  const onWake = (): void => void push()
  app.on('browser-window-focus', onWake)

  timer = setTimeout(() => void tick(), INTERVAL_MS)

  return {
    push,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      app.removeListener('browser-window-focus', onWake)
    }
  }
}
