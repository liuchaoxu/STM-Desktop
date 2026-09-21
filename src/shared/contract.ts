/**
 * The renderer ↔ main contract.
 *
 * Channel names, argument/result types and the renderer-facing API shape live here
 * once. The preload bridge is typed as `StmApi`, the main process registers its
 * handlers through helpers generic over `IpcContract`, and the renderer consumes
 * `window.api` — so a renamed channel, a changed payload or a forgotten handler is a
 * compile error instead of a runtime `undefined`.
 *
 * Only `CHANNELS` and `TUNNEL_CHANGED` exist at runtime (the types are erased), which
 * keeps the sandboxed preload bundle dependency-free.
 */
import type { ActionResult, ConfigData, LogPayload, TunnelView, ValidateItem } from '../core/types'

/** Every `invoke` channel, in one place. */
export const CHANNELS = {
  tunnelList: 'tunnel:list',
  tunnelStart: 'tunnel:start',
  tunnelStop: 'tunnel:stop',
  tunnelRestart: 'tunnel:restart',
  tunnelValidate: 'tunnel:validate',
  tunnelLogs: 'tunnel:logs',
  configGet: 'config:get',
  configSave: 'config:save',
  configReload: 'config:reload',
  configPathGet: 'config:path:get',
  configPathSet: 'config:path:set',
  configOpen: 'config:open',
  configSaveAs: 'config:save-as',
  configReveal: 'config:reveal',
  configReset: 'config:reset',
  appInfo: 'app:info'
} as const

export type IpcChannel = (typeof CHANNELS)[keyof typeof CHANNELS]

/** Push channel: main → renderer whenever the tunnel projection changed. */
export const TUNNEL_CHANGED = 'tunnel:changed'

/** Environment info shown in the header. */
export interface AppInfo {
  platform: string
  versions: { electron: string; node: string; chrome: string }
  sshPath: string | null
  plinkPath: string | null
  /** Whether passwords can be kept in the OS credential store. */
  secretsEncrypted: boolean
  configPath: string
  runtimeDir: string
}

/**
 * Arguments and result per channel. Both sides are generic over this, so whichever
 * side drifts fails to compile.
 */
export interface IpcContract {
  [CHANNELS.tunnelList]: { args: []; result: TunnelView[] }
  [CHANNELS.tunnelStart]: { args: [target: string]; result: ActionResult }
  [CHANNELS.tunnelStop]: { args: [target: string]; result: ActionResult }
  [CHANNELS.tunnelRestart]: { args: [target: string]; result: ActionResult }
  [CHANNELS.tunnelValidate]: { args: [target: string]; result: ValidateItem[] }
  [CHANNELS.tunnelLogs]: { args: [target: string, lines: number]; result: LogPayload[] }
  [CHANNELS.configGet]: { args: []; result: ConfigData }
  [CHANNELS.configSave]: { args: [cfg: ConfigData]; result: ConfigData }
  [CHANNELS.configReload]: { args: []; result: ConfigData }
  [CHANNELS.configPathGet]: { args: []; result: { path: string } }
  [CHANNELS.configPathSet]: { args: [path: string]; result: ConfigData }
  [CHANNELS.configOpen]: { args: []; result: { path: string; config: ConfigData } | null }
  [CHANNELS.configSaveAs]: { args: []; result: { path: string } | null }
  [CHANNELS.configReveal]: { args: []; result: { path: string } }
  [CHANNELS.configReset]: { args: []; result: ConfigData }
  [CHANNELS.appInfo]: { args: []; result: AppInfo }
}

export type IpcArgs<K extends IpcChannel> = IpcContract[K]['args']
export type IpcResult<K extends IpcChannel> = IpcContract[K]['result']

/** The `window.api` surface; implemented by the preload bridge. */
export interface TunnelApi {
  list(): Promise<TunnelView[]>
  start(target: string): Promise<ActionResult>
  stop(target: string): Promise<ActionResult>
  restart(target: string): Promise<ActionResult>
  validate(target: string): Promise<ValidateItem[]>
  logs(target: string, lines?: number): Promise<LogPayload[]>
  /**
   * Subscribe to the shell's status pushes. Returns the unsubscribe function, so a
   * component can release the listener without knowing the channel.
   */
  onChanged(handler: (tunnels: TunnelView[]) => void): () => void
}

export interface ConfigApi {
  get(): Promise<ConfigData>
  save(cfg: ConfigData): Promise<ConfigData>
  reload(): Promise<ConfigData>
  getPath(): Promise<{ path: string }>
  setPath(path: string): Promise<ConfigData>
  open(): Promise<{ path: string; config: ConfigData } | null>
  saveAs(): Promise<{ path: string } | null>
  reveal(): Promise<{ path: string }>
  reset(): Promise<ConfigData>
}

export interface AppApi {
  info(): Promise<AppInfo>
}

export interface StmApi {
  tunnel: TunnelApi
  config: ConfigApi
  app: AppApi
}

export type {
  ActionResult,
  ConfigData,
  GroupConfig,
  LogPayload,
  ResolvedTunnel,
  Tunnel,
  TunnelDef,
  TunnelState,
  TunnelView,
  ValidateItem
} from '../core/types'
