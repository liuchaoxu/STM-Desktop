import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer — typed in index.d.ts.
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

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
