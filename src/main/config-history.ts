/** Recent configuration snapshots stored beside the active config file. */
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'

export const CONFIG_HISTORY_LIMIT = 5

export interface ConfigHistoryEntry {
  id: string
  savedAt: string
}

interface StoredHistoryEntry extends ConfigHistoryEntry {
  text: string
}

function historyPath(configPath: string): string {
  return `${configPath}.history.json`
}

async function readEntries(configPath: string): Promise<StoredHistoryEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(historyPath(configPath), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isEntry).slice(0, CONFIG_HISTORY_LIMIT)
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

async function writeEntries(configPath: string, entries: StoredHistoryEntry[]): Promise<void> {
  const target = historyPath(configPath)
  const temporary = `${target}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

export async function listConfigHistory(configPath: string): Promise<ConfigHistoryEntry[]> {
  return (await readEntries(configPath)).map(({ id, savedAt }) => ({ id, savedAt }))
}

/** Add a distinct snapshot, newest first, while keeping the history bounded. */
export async function recordConfigHistory(configPath: string, text: string): Promise<void> {
  if (!text) return
  const entries = await readEntries(configPath)
  if (entries[0]?.text === text) return
  const next: StoredHistoryEntry = {
    id: randomUUID(),
    savedAt: new Date().toISOString(),
    text
  }
  const withoutDuplicate = entries.filter((entry) => entry.text !== text)
  await writeEntries(configPath, [next, ...withoutDuplicate].slice(0, CONFIG_HISTORY_LIMIT))
}

export async function readConfigHistory(
  configPath: string,
  id: string
): Promise<string> {
  const entry = (await readEntries(configPath)).find((item) => item.id === id)
  if (!entry) throw new Error('历史配置版本不存在或已被清理')
  return entry.text
}
