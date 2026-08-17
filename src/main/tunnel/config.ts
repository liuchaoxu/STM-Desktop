/**
 * Config file parsing / serialization / validation for the tunnel manager.
 * Pure Node module (no Electron) so it can be unit-tested standalone.
 *
 * File format mirrors the original SSH-Tunnel-Manager `tunnel.conf`:
 *   [defaults]                -> shared defaults
 *   [group:<name>]            -> per-group shared values
 *   [tunnel:<group>:<name>]   -> a single port forward
 *   [<name>]                  -> legacy section, moved to group "default"
 *                                (or the group named by `group=...`)
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import type { ConfigData, ResolvedTunnel, TunnelDef } from './types'
import { TunnelError } from './types'

const FALSE = new Set(['0', 'false', 'no', 'off'])

const REQUIRED_KEYS = ['server', 'username', 'local_port', 'remote_host', 'remote_port'] as const
const PORT_KEYS = ['server_port', 'local_port', 'remote_port'] as const

/** Keys are lower-cased, exactly like Python's `optionxform = str.lower`. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

export function isEnabledValue(value: string | undefined): boolean {
  return !value || !FALSE.has(value.trim().toLowerCase())
}

/** Names used for the runtime state/log files ("feishu/1Panel" -> "feishu_1Panel"). */
export function safeStem(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

function parsePort(key: string, raw: string | undefined, def: string): number {
  const value = raw === undefined || raw === '' ? def : raw.trim()
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelError(`[${key}] ${'port'} must be a number between 1 and 65535`)
  }
  return port
}

/** Validate one merged tunnel; throws TunnelError listing missing/invalid fields. */
export function validateTunnel(t: ResolvedTunnel): void {
  const missing = REQUIRED_KEYS.filter((k) => !t.values[k] || !t.values[k]!.trim())
  if (missing.length > 0) {
    throw new TunnelError(`[${t.key}] missing: ${missing.join(', ')}`)
  }
  for (const k of PORT_KEYS) {
    parsePort(t.key, t.values[k], k === 'server_port' ? '22' : '')
  }
}

type Section =
  | { kind: 'defaults' }
  | { kind: 'group'; name: string }
  | { kind: 'tunnel'; group: string; name: string; legacy: boolean; def: TunnelDef }

/** Parse an INI-like tunnel config file text. */
export function parseConfig(text: string): ConfigData {
  const defaults: Record<string, string> = {}
  const groups: Map<string, Record<string, string>> = new Map()
  const groupOrder: string[] = []
  const tunnels: TunnelDef[] = []
  const seen = new Map<string, Set<string>>()

  let section: Section | null = null

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = /^\[(.*)\]$/.exec(line)
    if (sectionMatch) {
      const header = sectionMatch[1]!.trim()
      if (!header) throw new TunnelError(`line ${i + 1}: empty section header`)
      const parts = header.split(':').map((p) => p.trim())
      const kind = parts[0]!.toLowerCase()
      if (kind === 'defaults' && parts.length === 1) {
        section = { kind: 'defaults' }
      } else if (kind === 'group' && parts.length === 2 && parts[1]) {
        if (!groups.has(parts[1]!)) {
          groups.set(parts[1]!, {})
          groupOrder.push(parts[1]!)
        }
        section = { kind: 'group', name: parts[1]! }
      } else if (kind === 'tunnel' && parts.length === 3 && parts[1] && parts[2]) {
        const def: TunnelDef = { group: parts[1]!, name: parts[2]!, values: {} }
        tunnels.push(def)
        section = { kind: 'tunnel', group: parts[1]!, name: parts[2]!, legacy: false, def }
      } else if (kind === 'tunnel' && parts.length === 2 && parts[1]) {
        const def: TunnelDef = { group: '', name: parts[1]!, values: {} }
        tunnels.push(def)
        section = { kind: 'tunnel', group: '', name: parts[1]!, legacy: true, def }
      } else if (parts.length === 1 && parts[0]) {
        const def: TunnelDef = { group: '', name: parts[0]!, values: {} }
        tunnels.push(def)
        section = { kind: 'tunnel', group: '', name: parts[0]!, legacy: true, def }
      } else {
        throw new TunnelError(`line ${i + 1}: unsupported section header: ${header}`)
      }
      continue
    }

    const eq = line.indexOf('=')
    if (eq <= 0) throw new TunnelError(`line ${i + 1}: expected "key=value", got: ${rawLine}`)
    const key = normalizeKey(line.slice(0, eq))
    const value = line.slice(eq + 1).trim()
    if (!section) throw new TunnelError(`line ${i + 1}: option "${key}" is outside of any section`)

    let target: Record<string, string>
    let sectionId: string
    if (section.kind === 'defaults') {
      target = defaults
      sectionId = 'defaults'
    } else if (section.kind === 'group') {
      target = groups.get(section.name)!
      sectionId = `group:${section.name}`
    } else {
      target = section.def.values
      sectionId = `tunnel:${section.group || '?'}/${section.name}`
    }
    const seenKeys = seen.get(sectionId) ?? new Set<string>()
    if (seenKeys.has(key)) throw new TunnelError(`[${sectionId}] duplicate option: ${key}`)
    seenKeys.add(key)
    seen.set(sectionId, seenKeys)
    target[key] = value
  }

  // Legacy sections: `group=` moves the tunnel into that group.
  for (const def of tunnels) {
    if (!def.group) {
      def.group = def.values.group || 'default'
      delete def.values.group
    }
  }

  return {
    defaults,
    groups: groupOrder.map((name) => ({ name, values: groups.get(name)! })),
    tunnels
  }
}

/** Serialize a ConfigData object back to INI text. */
export function serializeConfig(cfg: ConfigData): string {
  const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ')
  const validKey = (k: string): boolean => /^[A-Za-z0-9_.-]+$/.test(k)

  const out: string[] = []
  out.push('# Generated by SSH Tunnel Manager (STM Desktop)')
  out.push('# Merge order: [defaults] -> [group:<name>] -> [tunnel:<group>:<name>]')
  out.push('')

  const emitSection = (title: string, values: Record<string, string>): void => {
    const entries = Object.entries(values)
    if (entries.length === 0) return
    out.push(`[${title}]`)
    for (const [k, v] of entries) {
      if (!validKey(k)) throw new TunnelError(`invalid option key: ${k}`)
      out.push(`${k}=${clean(v)}`)
    }
    out.push('')
  }

  emitSection('defaults', cfg.defaults)
  for (const group of cfg.groups) {
    if (!group.name.trim()) throw new TunnelError('group name must not be empty')
    emitSection(`group:${group.name.trim()}`, group.values)
  }
  for (const t of cfg.tunnels) {
    if (!t.group.trim() || !t.name.trim()) {
      throw new TunnelError('tunnel group and name must not be empty')
    }
    const values = { ...t.values }
    emitSection(`tunnel:${t.group.trim()}:${t.name.trim()}`, values)
  }
  return out.join('\n')
}

/** Read + parse a config file. Creates nothing. */
export async function loadConfigFile(filePath: string): Promise<ConfigData> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    if (e.code === 'ENOENT') throw new TunnelError(`configuration file not found: ${filePath}`)
    throw error
  }
  return parseConfig(text)
}

/** Atomically write a config file (tmp + rename). */
export async function saveConfigFile(filePath: string, cfg: ConfigData): Promise<void> {
  const text = serializeConfig(cfg)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, text, 'utf-8')
  await fs.rename(tmp, filePath)
}

/** Merge defaults -> group -> tunnel into one effective value map. */
export function mergeTunnel(cfg: ConfigData, def: TunnelDef): ResolvedTunnel {
  const group = cfg.groups.find((g) => g.name.toLowerCase() === def.group.toLowerCase())
  const values = { ...cfg.defaults, ...(group ? group.values : {}), ...def.values }
  const tunnel: ResolvedTunnel = {
    group: def.group,
    name: def.name,
    values,
    get key() {
      return `${def.group}/${def.name}`
    },
    get enabled() {
      return isEnabledValue(values.enabled)
    },
    get local() {
      return `${values.local_bind ?? '127.0.0.1'}:${values.local_port ?? '?'}`
    },
    get remote() {
      return `${values.remote_host ?? '?'}:${values.remote_port ?? '?'}`
    }
  }
  validateTunnel(tunnel)
  return tunnel
}

/** Merge all tunnels of a config, validating each and rejecting duplicates. */
export function resolveTunnels(cfg: ConfigData): ResolvedTunnel[] {
  const out = validateConfig(cfg)
  if (out.length === 0) throw new TunnelError('no tunnels are configured')
  return out
}

/**
 * Validate the whole config (each tunnel + duplicate keys) without requiring
 * at least one tunnel — used when saving from the UI so an empty config is
 * still a valid starting point.
 */
export function validateConfig(cfg: ConfigData): ResolvedTunnel[] {
  const out: ResolvedTunnel[] = []
  const seen = new Set<string>()
  for (const def of cfg.tunnels) {
    const tunnel = mergeTunnel(cfg, def)
    const key = tunnel.key.toLowerCase()
    if (seen.has(key)) throw new TunnelError(`duplicate tunnel: ${tunnel.key}`)
    seen.add(key)
    out.push(tunnel)
  }
  return out
}

/** Resolve a command target: "all" | group name | "group/tunnel". */
export function resolveTarget(
  tunnels: ResolvedTunnel[],
  target: string | undefined,
  enabledOnly: boolean
): ResolvedTunnel[] {
  const raw = (target || 'all').trim()
  const items = [...tunnels]
  if (raw.toLowerCase() !== 'all') {
    const exact = items.find((t) => t.key.toLowerCase() === raw.toLowerCase())
    if (exact) {
      return enabledOnly && !exact.enabled ? [] : [exact]
    }
    const byGroup = items.filter((t) => t.group.toLowerCase() === raw.toLowerCase())
    if (byGroup.length === 0) throw new TunnelError(`unknown group or tunnel: ${target}`)
    return enabledOnly ? byGroup.filter((t) => t.enabled) : byGroup
  }
  return enabledOnly ? items.filter((t) => t.enabled) : items
}

/** Default config template written on first run. */
export const DEFAULT_CONFIG_TEXT = `# SSH Tunnel Manager 配置文件
#
# 配置继承顺序：[defaults] -> [group:<组名>] -> [tunnel:<组名>:<隧道名>]，
# 后一级覆盖前一级。命令目标支持 all、组名、组/隧道名。

[defaults]
client=auto
server_port=22
local_bind=127.0.0.1
enabled=true
strict_host_key_checking=accept-new

# 密码认证示例（Windows 自动使用内置 plink.exe，Linux/macOS 自动使用 OpenSSH AskPass）
[group:feishu]
server=ssh.example.com
username=deploy
password=replace-with-password
# 使用 Plink 时建议填写人工核验的 SHA256 主机指纹
hostkey=SHA256:replace-with-server-fingerprint

[tunnel:feishu:redis]
local_port=6379
remote_host=127.0.0.1
remote_port=6379

[tunnel:feishu:mysql]
local_port=3306
remote_host=127.0.0.1
remote_port=3306
`

export function defaultConfig(): ConfigData {
  return parseConfig(DEFAULT_CONFIG_TEXT)
}
