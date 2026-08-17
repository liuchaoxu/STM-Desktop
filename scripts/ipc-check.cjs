/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * End-to-end IPC check: boot the built app, then probe window.api from the
 * renderer to verify the preload bridge and every main-process handler.
 * Run with: npx electron scripts/ipc-check.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const out = path.join(__dirname, '..', 'out')
require(path.join(out, 'main', 'index.js')) // boots the app + registers IPC

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    let win = null
    for (let i = 0; i < 60; i++) {
      win = BrowserWindow.getAllWindows()[0] || null
      if (win) break
      await wait(100)
    }
    if (!win) throw new Error('no window created')

    // Poll until the renderer is ready to answer.
    let result = null
    for (let i = 0; i < 60; i++) {
      try {
        result = await win.webContents.executeJavaScript(
          `(async () => {
             const info = await window.api.app.info()
             const cfg = await window.api.config.get()
             const tunnels = await window.api.tunnel.list()
             const pathInfo = await window.api.config.getPath()
             const logs = await window.api.tunnel.logs('all', 10)
             return {
               ok: true,
               platform: info.platform,
               ssh: !!info.sshPath,
               plink: !!info.plinkPath,
               configPath: info.configPath,
               cfgDefaults: Object.keys(cfg.defaults).length,
               cfgGroups: cfg.groups.length,
               cfgTunnels: cfg.tunnels.length,
               tunnels: tunnels.length,
               logs: logs.length
             }
           })()`
        )
        if (result && result.ok) break
      } catch {
        result = null
      }
      await wait(250)
    }
    if (!result) throw new Error('renderer never answered')
    console.log('IPC CHECK OK ' + JSON.stringify(result))
    process.exitCode = 0
  } catch (error) {
    console.error('IPC CHECK FAILED: ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
