/**
 * Tray presence, "start with the OS" and "keep running when the window closes".
 *
 * A tunnel keeper is a background service with a UI attached: the tunnels outlive the
 * window (they run detached on purpose), so quitting the whole app because someone
 * closed a window would silently drop nothing but would also stop the shell from
 * watching, reconnecting and reporting. Hence: the close button hides, the tray menu
 * is the only place that really quits, and the same menu owns the autostart switch
 * (persisted in `settings.json`, so a start-at-login launch can go straight to the
 * tray).
 */
import { app, BrowserWindow, Menu, Tray } from 'electron'
import icon from '../../resources/icon.png?asset'
import type { TunnelManager } from '../core/manager'
import { loadSettings, patchSettings } from './settings'

export interface TrayHandle {
  /** Rebuild the menu (labels change with the tunnel states). */
  refresh: () => void
  destroy: () => void
}

export interface TrayOptions {
  manager: TunnelManager
  /** Bring the main window back (recreating it if it was closed). */
  showWindow: () => void
  /** Really quit: used by the tray's exit item. */
  quit: () => void
  /** Called when the user toggles start-at-login, after it was persisted. */
  onAutostartChanged?: (enabled: boolean) => void
}

/**
 * Whether the app is allowed to hide instead of quitting.
 *
 * `closeToTray` defaults to *on* — that is the whole point of having a tray — but a
 * user who turned it off gets a normal close, and `app.quit()` always wins so the
 * "退出" item and the OS shutdown path are never blocked.
 */
export async function closeHidesToTray(): Promise<boolean> {
  const settings = await loadSettings()
  return settings.closeToTray !== false
}

export async function createTray(options: TrayOptions): Promise<TrayHandle> {
  const settings = await loadSettings()
  const tray = new Tray(icon)
  tray.setToolTip('STM Desktop')

  const build = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => options.showWindow() },
      { type: 'separator' },
      {
        label: '全部启动',
        click: () => void options.manager.run('start', 'all').catch(() => undefined)
      },
      {
        label: '全部停止',
        click: () => void options.manager.run('stop', 'all').catch(() => undefined)
      },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            // Start hidden: the tunnels come up, the window does not steal focus.
            args: item.checked ? ['--hidden'] : []
          })
          void patchSettings({ openAtLogin: item.checked })
          options.onAutostartChanged?.(item.checked)
          build()
        }
      },
      {
        label: '关闭窗口时留在托盘',
        type: 'checkbox',
        checked: settings.closeToTray !== false,
        click: (item) => {
          settings.closeToTray = item.checked
          void patchSettings({ closeToTray: item.checked })
          build()
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => options.quit() }
    ])
    tray.setContextMenu(menu)
  }

  build()

  // A left click on the icon is the fastest way back to the window on Windows,
  // where the platform does not show a context menu on click.
  tray.on('click', () => options.showWindow())

  return {
    refresh: build,
    destroy: () => tray.destroy()
  }
}

/** Apply the stored autostart preference at startup (it can drift from the OS). */
export async function syncAutostart(): Promise<boolean> {
  const settings = await loadSettings()
  const wanted = settings.openAtLogin === true
  const current = app.getLoginItemSettings().openAtLogin
  if (wanted !== current) {
    app.setLoginItemSettings({ openAtLogin: wanted, args: wanted ? ['--hidden'] : [] })
  }
  return wanted
}

/** True when the process was launched by the OS at login (or asked to start hidden). */
export function startHidden(): boolean {
  return process.argv.includes('--hidden')
}

/** Bring a window to the front, restoring it first when it was minimised. */
export function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
