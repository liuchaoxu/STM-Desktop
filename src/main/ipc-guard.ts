/**
 * Input validation for the IPC surface.
 *
 * The renderer is sandboxed, but a sandboxed renderer can still `invoke`
 * anything: IPC is the trust boundary, so every payload is validated here
 * before it reaches the platform-agnostic core. The limits are deliberately
 * generous — they exist to fail fast on malformed or hostile input, not to
 * second-guess the user.
 *
 * Deliberately dependency-free (no zod) to keep the runtime dependency surface
 * at zero; the shapes are small enough that explicit checks are clearer.
 */
import type { ConfigData, GroupConfig, TunnelDef } from '../core/types'
import type { UiPrefs } from '../shared/contract'

const MAX_TARGET_LENGTH = 256
const MAX_SECTIONS = 500
const MAX_OPTIONS_PER_SECTION = 200
const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 8192

/** A tunnel/group target such as `all`, `feishu` or `feishu/1Panel`. */
export function assertTarget(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid target: expected a string')
  const target = value.trim()
  if (!target) throw new Error('invalid target: empty')
  if (target.length > MAX_TARGET_LENGTH) throw new Error('invalid target: too long')
  return target
}

function assertValues(value: unknown, where: string): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be a set of key=value options`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_OPTIONS_PER_SECTION) {
    throw new Error(`${where} has too many options`)
  }
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new Error(`${where} has an invalid option name`)
    }
    if (typeof raw !== 'string') throw new Error(`${where}.${key} must be a string`)
    if (raw.length > MAX_VALUE_LENGTH) throw new Error(`${where}.${key} is too long`)
    out[key] = raw
  }
  return out
}

function assertName(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  const name = value.trim()
  if (!name) throw new Error(`${where} must not be empty`)
  if (name.length > MAX_KEY_LENGTH) throw new Error(`${where} is too long`)
  return name
}

/**
 * Validate a configuration payload sent by the renderer.
 *
 * Returns a fresh plain object so no renderer-owned prototype, getter or extra
 * property can travel any further.
 */
export function assertConfigPayload(value: unknown): ConfigData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid config: expected an object')
  }
  const raw = value as Record<string, unknown>

  const groupsRaw = raw.groups ?? []
  const tunnelsRaw = raw.tunnels ?? []
  if (!Array.isArray(groupsRaw)) throw new Error('invalid config: groups must be an array')
  if (!Array.isArray(tunnelsRaw)) throw new Error('invalid config: tunnels must be an array')
  if (groupsRaw.length > MAX_SECTIONS) throw new Error('invalid config: too many groups')
  if (tunnelsRaw.length > MAX_SECTIONS) throw new Error('invalid config: too many tunnels')

  const groups: GroupConfig[] = groupsRaw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`invalid config: group ${index} must be an object`)
    }
    const group = entry as Record<string, unknown>
    return {
      name: assertName(group.name, `group ${index} name`),
      values: assertValues(group.values ?? {}, `group ${index}`)
    }
  })
  // Duplicate names would collide in the serialized file (and in the secret
  // store, where a group's name is its key).
  const groupNames = new Set<string>()
  for (const group of groups) {
    const lower = group.name.toLowerCase()
    if (groupNames.has(lower)) throw new Error(`invalid config: duplicate group ${group.name}`)
    groupNames.add(lower)
  }

  const tunnels: TunnelDef[] = tunnelsRaw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`invalid config: tunnel ${index} must be an object`)
    }
    const tunnel = entry as Record<string, unknown>
    return {
      group: assertName(tunnel.group, `tunnel ${index} group`),
      name: assertName(tunnel.name, `tunnel ${index} name`),
      values: assertValues(tunnel.values ?? {}, `tunnel ${index}`)
    }
  })

  return {
    defaults: assertValues(raw.defaults ?? {}, 'defaults'),
    groups,
    tunnels
  }
}

/** The only keys the renderer may write into the header display preferences. */
const UI_PREF_KEYS = ['showAuthorInfo', 'showGithubLink'] as const

/**
 * Validate a UI-preferences patch from the renderer.
 *
 * Keys are read off a whitelist and copied into a fresh object, so an unknown
 * key (or a non-boolean) is rejected instead of being written into the shell's
 * own `settings.json` alongside the config path and the login-item switches.
 */
export function assertUiPrefsPatch(value: unknown): Partial<UiPrefs> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid ui prefs: expected an object')
  }
  const raw = value as Record<string, unknown>
  const out: Partial<UiPrefs> = {}
  for (const key of UI_PREF_KEYS) {
    const next = raw[key]
    if (next === undefined) continue
    if (typeof next !== 'boolean') throw new Error(`invalid ui prefs: ${key} must be a boolean`)
    out[key] = next
  }
  return out
}
