import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  TUNNEL_CHANGED,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
  type StmApi,
  type TunnelView
} from '../shared/contract'

/**
 * One typed hop to main. The channel name, its arguments and its result all come
 * from the shared contract, so the bridge cannot drift from the handlers: both are
 * generic over the same `IpcContract` map.
 */
function invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResult<K>> {
  return ipcRenderer.invoke(channel, ...args)
}

/**
 * The renderer's entire surface, typed in `src/shared/contract.ts`.
 *
 * This script must stay dependency-free: it runs sandboxed, where `require()` can
 * only resolve Electron's own modules. A third-party import here (such as
 * `@electron-toolkit/preload`, which used to expose an unused `window.electron`)
 * fails to resolve and silently takes the whole bridge down with it. Importing our
 * own bundled modules is fine — electron-vite inlines them.
 */
const api: StmApi = {
  tunnel: {
    list: () => invoke(CHANNELS.tunnelList),
    start: (target) => invoke(CHANNELS.tunnelStart, target),
    stop: (target) => invoke(CHANNELS.tunnelStop, target),
    restart: (target) => invoke(CHANNELS.tunnelRestart, target),
    validate: (target) => invoke(CHANNELS.tunnelValidate, target),
    logs: (target, lines = 200) => invoke(CHANNELS.tunnelLogs, target, lines),
    onChanged: (handler) => {
      const listener = (_event: IpcRendererEvent, tunnels: TunnelView[]): void => handler(tunnels)
      ipcRenderer.on(TUNNEL_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(TUNNEL_CHANGED, listener)
      }
    }
  },
  config: {
    get: () => invoke(CHANNELS.configGet),
    save: (cfg) => invoke(CHANNELS.configSave, cfg),
    reload: () => invoke(CHANNELS.configReload),
    getPath: () => invoke(CHANNELS.configPathGet),
    setPath: (path) => invoke(CHANNELS.configPathSet, path),
    open: () => invoke(CHANNELS.configOpen),
    saveAs: () => invoke(CHANNELS.configSaveAs),
    reveal: () => invoke(CHANNELS.configReveal),
    reset: () => invoke(CHANNELS.configReset)
  },
  app: {
    info: () => invoke(CHANNELS.appInfo)
  }
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('failed to expose window.api', error)
}
