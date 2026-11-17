/**
 * Merging imported sections into an existing config.
 *
 * Platform agnostic and free of I/O on purpose: the shell owns picking and reading
 * the file (`src/main/config-import.ts`), while this decides what actually lands in
 * the config — which is the part worth testing.
 */
import type { ImportResult } from './importers'
import type { ConfigData } from './types'

export interface MergeOutcome {
  config: ConfigData
  /** Groups that were added (existing names are kept as they are). */
  groups: number
  /** Tunnels that were added. */
  tunnels: number
  /** Entries dropped because that group/tunnel already existed. */
  skipped: number
}

/**
 * Add imported sections, never overwrite.
 *
 * An import must not silently change a tunnel the user has already tuned, so
 * existing groups win and duplicate tunnels are skipped and counted instead. Names
 * are compared case-insensitively, matching how the rest of the app resolves a
 * group or an `all` target.
 */
export function mergeImport(current: ConfigData, incoming: ImportResult): MergeOutcome {
  const incomingDefaults = incoming.defaults ?? {}
  const incomingGroupValues = new Map(
    incoming.groups.map((group) => [group.name.toLowerCase(), group.values] as const)
  )
  const groupNames = new Set(current.groups.map((group) => group.name.toLowerCase()))
  const tunnelKeys = new Set(
    current.tunnels.map((tunnel) => `${tunnel.group}/${tunnel.name}`.toLowerCase())
  )

  const groups = [...current.groups]
  let addedGroups = 0
  for (const group of incoming.groups) {
    const name = group.name.toLowerCase()
    if (groupNames.has(name)) continue
    groupNames.add(name)
    groups.push({ name: group.name, values: { ...incomingDefaults, ...group.values } })
    addedGroups++
  }

  const tunnels = [...current.tunnels]
  let addedTunnels = 0
  let skipped = 0
  for (const tunnel of incoming.tunnels) {
    const key = `${tunnel.group}/${tunnel.name}`.toLowerCase()
    if (tunnelKeys.has(key)) {
      skipped++
      continue
    }
    tunnelKeys.add(key)
    // A duplicate group is intentionally left untouched, but a newly imported
    // tunnel still needs the source group's connection values to be usable.
    const groupValues = incomingGroupValues.get(tunnel.group.toLowerCase()) ?? {}
    tunnels.push({
      group: tunnel.group,
      name: tunnel.name,
      values: { ...incomingDefaults, ...groupValues, ...tunnel.values }
    })
    addedTunnels++
  }

  return {
    config: { defaults: { ...incomingDefaults, ...current.defaults }, groups, tunnels },
    groups: addedGroups,
    tunnels: addedTunnels,
    skipped
  }
}
