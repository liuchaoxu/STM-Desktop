/**
 * Domain model for the SSH tunnel manager — platform agnostic.
 *
 * Everything in `src/core/` must run on Node, in a browser/webview, or on a
 * mobile runtime. It may not import `fs`, `path`, `os`, `net`,
 * `child_process` or `electron`; those live behind the interfaces in
 * `storage.ts` and `transport.ts` and are provided per platform by
 * `src/platforms/*`. The boundary is enforced by ESLint.
 *
 * Mirrors the config model of the original SSH-Tunnel-Manager project:
 *   defaults -> group -> tunnel  (later layers override earlier ones)
 */

/** A group definition as stored in the config file. */
export interface GroupConfig {
  name: string
  values: Record<string, string>
}

/** A tunnel definition as stored in the config file (before merging). */
export interface TunnelDef {
  group: string
  name: string
  values: Record<string, string>
}

/** The whole parsed configuration. */
export interface ConfigData {
  defaults: Record<string, string>
  groups: GroupConfig[]
  tunnels: TunnelDef[]
}

/** A tunnel after merging defaults/group/tunnel values. */
export interface Tunnel {
  group: string
  name: string
  values: Record<string, string>
}

/** Keys of a tunnel after merge (read-only accessors). */
export interface ResolvedTunnel extends Tunnel {
  readonly key: string
  readonly enabled: boolean
  readonly local: string
  readonly remote: string
}

export type TunnelState = 'stopped' | 'connecting' | 'running'

/** One row shown in the UI list. */
export interface TunnelView {
  key: string
  group: string
  name: string
  enabled: boolean
  values: Record<string, string>
  state: TunnelState
  pid: number | null
  local: string
  remote: string
  /** Epoch ms the current session started, so the UI can show an uptime. */
  startedAt: number | null
  /** Reconnects the shell performed on this tunnel during this app run. */
  restarts: number
}

/** Result of a start/stop/restart batch operation. */
export interface ActionResult {
  ok: boolean
  messages: string[]
  errors: string[]
}

/** Result of validating one tunnel (builds the command line). */
export interface ValidateItem {
  key: string
  ok: boolean
  message: string
  /** Full command line with the password masked, for display. */
  command?: string
}

/** Tail of a tunnel's log files. */
export interface LogPayload {
  key: string
  output: string
  error: string
  outPath: string
  errPath: string
  running: boolean
}

/** Machine-readable error codes, so callers never have to match on message text. */
export type TunnelErrorCode = 'CONFIG_NOT_FOUND'

export class TunnelError extends Error {
  readonly code?: TunnelErrorCode

  constructor(message: string, code?: TunnelErrorCode) {
    super(message)
    this.name = 'TunnelError'
    this.code = code
  }
}
