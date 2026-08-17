/**
 * Shared model for the SSH tunnel manager (main process side).
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

export class TunnelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TunnelError'
  }
}
