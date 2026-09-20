import { contextBridge, ipcRenderer } from 'electron'

/**
 * The renderer's entire surface, typed in `api.d.ts`.
 *
 * This script must stay dependency-free: it runs sandboxed, where `require()`
 * can only resolve Electron's own modules. A third-party import here (such as
 * `@electron-toolkit/preload`, which used to expose an unused `window.electron`)
 * fails to resolve and silently takes the whole bridge down with it.
 */
const api = {
  tunnel: {
    list: (): Promise<TunnelView[]> => ipcRenderer.invoke('tunnel:list'),
    start: (target: string): Promise<ActionResult> => ipcRenderer.invoke('tunnel:start', target),
    stop: (target: string): Promise<ActionResult> => ipcRenderer.invoke('tunnel:stop', target),
    restart: (target: string): Promise<ActionResult> =>
      ipcRenderer.invoke('tunnel:restart', target),
    validate: (target: string): Promise<ValidateItem[]> =>
      ipcRenderer.invoke('tunnel:validate', target),
    logs: (target: string, lines?: number): Promise<LogPayload[]> =>
      ipcRenderer.invoke('tunnel:logs', target, lines ?? 200)
  },
  config: {
    get: (): Promise<ConfigData> => ipcRenderer.invoke('config:get'),
    save: (cfg: ConfigData): Promise<ConfigData> => ipcRenderer.invoke('config:save', cfg),
    reload: (): Promise<ConfigData> => ipcRenderer.invoke('config:reload'),
    getPath: (): Promise<{ path: string }> => ipcRenderer.invoke('config:path:get'),
    setPath: (path: string): Promise<ConfigData> => ipcRenderer.invoke('config:path:set', path),
    open: (): Promise<{ path: string; config: ConfigData } | null> =>
      ipcRenderer.invoke('config:open'),
    saveAs: (): Promise<{ path: string } | null> => ipcRenderer.invoke('config:save-as'),
    reveal: (): Promise<{ path: string }> => ipcRenderer.invoke('config:reveal'),
    reset: (): Promise<ConfigData> => ipcRenderer.invoke('config:reset')
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  }
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('failed to expose window.api', error)
}
