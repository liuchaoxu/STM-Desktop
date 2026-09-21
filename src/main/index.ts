import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createManager, registerIpc } from './ipc'
import { hardenWebContents, SECURE_WEB_PREFERENCES } from './security'
import { startStatusBroadcast } from './status'
import {
  closeHidesToTray,
  createTray,
  focusWindow,
  startHidden,
  syncAutostart,
  type TrayHandle
} from './tray'

/** Set while the app is on its way out, so the close handler stops hiding. */
let quitting = false

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'STM Desktop',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...SECURE_WEB_PREFERENCES
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Launched by the OS at login: the tunnels come up, the window stays away.
    if (!startHidden()) mainWindow.show()
  })

  // Closing the window must not take the tunnel supervision with it; the tray menu
  // owns "退出" (and `quitting` covers every other real exit path, e.g. app.quit()).
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void closeHidesToTray().then((hide) => {
      if (hide) mainWindow.hide()
      else {
        quitting = true
        app.quit()
      }
    })
  })

  // Deny navigation, popups and permissions unless they belong to the app.
  hardenWebContents(mainWindow.webContents)

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/**
 * Only one instance may run: a second copy would take over the same PID state
 * files, log files and local ports as the first, and the two would then fight
 * over start/stop decisions for the same tunnels.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone launched the app again (or clicked a shortcut): show the window we
    // already have instead of starting a second supervisor.
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) focusWindow(existing)
    else createWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.stm.desktop')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Tunnel manager + IPC surface. The status broadcaster owns the refresh loop
    // for every window (see `status.ts`), including the pushes after mutations.
    const manager = createManager()
    const status = startStatusBroadcast(manager)
    await registerIpc(manager, status)

    createWindow()

    // The tray is what keeps the app alive once the window is closed, so it is
    // created after the window exists (its menu shows/quits the app) and rebuilt
    // whenever a preference changes.
    await syncAutostart()
    let tray: TrayHandle | null = null
    try {
      tray = await createTray({
        manager,
        showWindow: () => {
          const [existing] = BrowserWindow.getAllWindows()
          if (existing) focusWindow(existing)
          else createWindow()
        },
        quit: () => {
          quitting = true
          app.quit()
        }
      })
    } catch (error) {
      // A tray is a convenience; a headless session (CI, some Linux desktops) must
      // still be able to run the app.
      console.error('tray unavailable', error)
    }

    app.on('activate', function () {
      const [existing] = BrowserWindow.getAllWindows()
      if (existing) focusWindow(existing)
      else createWindow()
    })

    app.on('before-quit', () => {
      quitting = true
      status.stop()
      tray?.destroy()
    })
  })
}

app.on('window-all-closed', () => {
  // No window is not "no app": the tray (and the tunnels it supervises) stay until
  // the user quits. macOS never quits here either, for the same reason plus its own
  // conventions.
  if (process.platform === 'darwin') return
  void closeHidesToTray().then((hide) => {
    if (!hide) app.quit()
  })
})
