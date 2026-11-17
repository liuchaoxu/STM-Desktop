/** Recent configuration snapshots stored beside the active config file. */
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { parseConfig } from '../core/config'
import type { ConfigData } from '../core/types'

export interface ConfigHistoryEntry {
  id: string
  savedAt: string
  summary: string
  changes: string[]
  isCurrent: boolean
}

interface StoredHistoryEntry extends ConfigHistoryEntry {
  text: string
}

export interface ConfigChangeSummary {
  summary: string
  changes: string[]
}

function historyPath(configPath: string): string {
  return `${configPath}.history.json`
}

async function readEntries(configPath: string): Promise<StoredHistoryEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(historyPath(configPath), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isEntry).map(normalizeEntry)
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is StoredHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.savedAt === 'string' &&
    typeof item.text === 'string' &&
    item.text.length > 0
  )
}

function normalizeEntry(value: StoredHistoryEntry): StoredHistoryEntry {
  return {
    ...value,
    summary: typeof value.summary === 'string' ? value.summary : '历史配置版本',
    changes: Array.isArray(value.changes)
      ? value.changes.filter((change): change is string => typeof change === 'string')
      : [],
    isCurrent: false
  }
}

async function writeEntries(configPath: string, entries: StoredHistoryEntry[]): Promise<void> {
  const target = historyPath(configPath)
  const temporary = `${target}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

export async function listConfigHistory(
  configPath: string,
  currentText: string
): Promise<ConfigHistoryEntry[]> {
  let markedCurrent = false
  return (await readEntries(configPath)).map(({ id, savedAt, summary, changes, text }) => {
    const isCurrent = !markedCurrent && text === currentText
    if (isCurrent) markedCurrent = true
    return { id, savedAt, summary, changes, isCurrent }
  })
}

/** Add a distinct snapshot. History is intentionally unbounded until the user clears it. */
export async function recordConfigHistory(
  configPath: string,
  text: string,
  change: ConfigChangeSummary = { summary: '历史配置版本', changes: [] }
): Promise<void> {
  if (!text) return
  const entries = await readEntries(configPath)
  if (entries.some((entry) => entry.text === text)) return
  const next: StoredHistoryEntry = {
    id: randomUUID(),
    savedAt: new Date().toISOString(),
    summary: change.summary,
    changes: change.changes,
    isCurrent: false,
    text
  }
  await writeEntries(configPath, [next, ...entries])
}

export async function readConfigHistory(
  configPath: string,
  id: string
): Promise<string> {
  const entry = (await readEntries(configPath)).find((item) => item.id === id)
  if (!entry) throw new Error('历史配置版本不存在或已被清理')
  return entry.text
}

export async function clearConfigHistory(configPath: string): Promise<number> {
  const entries = await readEntries(configPath)
  await fs.rm(historyPath(configPath), { force: true })
  return entries.length
}

function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

function addValueChange(
  changes: string[],
  label: string,
  before: Record<string, string>,
  after: Record<string, string>
): void {
  const keys = changedKeys(before, after)
  if (keys.length > 0) changes.push(`${label}修改：${keys.join('、')}`)
}

function compareConfigs(before: ConfigData, after: ConfigData): string[] {
  const changes: string[] = []
  addValueChange(changes, '默认设置', before.defaults, after.defaults)

  const beforeGroups = new Map(before.groups.map((group) => [group.name.toLowerCase(), group]))
  const afterGroups = new Map(after.groups.map((group) => [group.name.toLowerCase(), group]))
  const addedGroups = after.groups.filter((group) => !beforeGroups.has(group.name.toLowerCase()))
  const removedGroups = before.groups.filter((group) => !afterGroups.has(group.name.toLowerCase()))
  if (addedGroups.length > 0) {
    changes.push(`新增组：${addedGroups.map((group) => group.name).join('、')}`)
  }
  if (removedGroups.length > 0) {
    changes.push(`删除组：${removedGroups.map((group) => group.name).join('、')}`)
  }
  for (const [name, beforeGroup] of beforeGroups) {
    const afterGroup = afterGroups.get(name)
    if (afterGroup) {
      if (beforeGroup.name !== afterGroup.name) {
        changes.push(`组重命名：${beforeGroup.name} → ${afterGroup.name}`)
      }
      addValueChange(changes, `组「${afterGroup.name}」`, beforeGroup.values, afterGroup.values)
    }
  }

  const tunnelKey = (group: string, name: string): string => `${group}\u0000${name}`.toLowerCase()
  const beforeTunnels = new Map(
    before.tunnels.map((tunnel) => [tunnelKey(tunnel.group, tunnel.name), tunnel])
  )
  const afterTunnels = new Map(
    after.tunnels.map((tunnel) => [tunnelKey(tunnel.group, tunnel.name), tunnel])
  )
  const addedTunnels = after.tunnels.filter(
    (tunnel) => !beforeTunnels.has(tunnelKey(tunnel.group, tunnel.name))
  )
  const removedTunnels = before.tunnels.filter(
    (tunnel) => !afterTunnels.has(tunnelKey(tunnel.group, tunnel.name))
  )
  if (addedTunnels.length > 0) {
    changes.push(`新增隧道：${addedTunnels.map((tunnel) => `${tunnel.group}/${tunnel.name}`).join('、')}`)
  }
  if (removedTunnels.length > 0) {
    changes.push(
      `删除隧道：${removedTunnels.map((tunnel) => `${tunnel.group}/${tunnel.name}`).join('、')}`
    )
  }
  for (const [key, beforeTunnel] of beforeTunnels) {
    const afterTunnel = afterTunnels.get(key)
    if (afterTunnel) {
      addValueChange(
        changes,
        `隧道「${afterTunnel.group}/${afterTunnel.name}」`,
        beforeTunnel.values,
        afterTunnel.values
      )
    }
  }
  return changes
}

export function summarizeConfigChange(beforeText: string, afterText: string): ConfigChangeSummary {
  try {
    const before = parseConfig(beforeText)
    const after = parseConfig(afterText)
    const changes = compareConfigs(before, after)
    return {
      summary: changes.length === 0 ? '配置内容未变化' : changes.slice(0, 2).join('；'),
      changes
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { summary: '配置文本发生变化', changes: [`无法解析详细差异：${reason}`] }
  }
}
