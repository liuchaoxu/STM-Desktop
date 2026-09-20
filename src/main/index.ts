import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createManager, registerIpc } from './ipc'
import { hardenWebContents, SECURE_WEB_PREFERENCES } from './security'

function createWindow(): void {
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
    mainWindow.show()
  })

  // Deny navigation, popups and permissions unless they belong to the app.
  hardenWebContents(mainWindow.webContents)

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.stm.desktop')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Tunnel manager + IPC surface.
    const manager = createManager()
    await registerIpc(manager)

    createWindow()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
