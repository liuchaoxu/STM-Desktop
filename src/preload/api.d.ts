import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  /** A tunnel after merging defaults/group/tunnel values, plus live status. */
  interface TunnelView {
    key: string
    group: string
    name: string
    enabled: boolean
    values: Record<string, string>
    state: 'stopped' | 'connecting' | 'running'
    pid: number | null
    local: string
    remote: string
  }

  /** Result of a start/stop/restart batch operation. */
  interface ActionResult {
    ok: boolean
    messages: string[]
    errors: string[]
  }

  /** One validation row. */
  interface ValidateItem {
    key: string
    ok: boolean
    message: string
    /** Full command line with the password masked, for display. */
    command?: string
  }

  /** Tail of a tunnel's log files. */
  interface LogPayload {
    key: string
    output: string
    error: string
    outPath: string
    errPath: string
    running: boolean
  }

  /** A group definition as stored in the config file. */
  interface GroupConfig {
    name: string
    values: Record<string, string>
  }

  /** A tunnel definition as stored in the config file. */
  interface TunnelDef {
    group: string
    name: string
    values: Record<string, string>
  }

  /** The whole parsed configuration. */
  interface ConfigData {
    defaults: Record<string, string>
    groups: GroupConfig[]
    tunnels: TunnelDef[]
  }

  /** Environment info shown in the header. */
  interface AppInfo {
    platform: string
    versions: { electron: string; node: string; chrome: string }
    sshPath: string | null
    plinkPath: string | null
    configPath: string
    runtimeDir: string
  }

  interface TunnelApi {
    list(): Promise<TunnelView[]>
    start(target: string): Promise<ActionResult>
    stop(target: string): Promise<ActionResult>
    restart(target: string): Promise<ActionResult>
    validate(target: string): Promise<ValidateItem[]>
    logs(target: string, lines?: number): Promise<LogPayload[]>
  }

  interface ConfigApi {
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

  interface AppApi {
    info(): Promise<AppInfo>
  }

  interface Window {
    electron: ElectronAPI
    api: {
      tunnel: TunnelApi
      config: ConfigApi
      app: AppApi
    }
  }
}

export {}
