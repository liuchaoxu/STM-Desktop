/**
 * The shell's own settings file (`<userData>/settings.json`).
 *
 * Deliberately separate from `tunnel.conf`: this is state *about the app* — where
 * the config lives, whether it starts with the OS — not tunnelling configuration the
 * user would expect to find (or export) in their config file.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

export interface Settings {
  /** Config file the app was last pointed at. */
  configPath?: string
  /** Start with the operating system (and therefore in the tray). */
  openAtLogin?: boolean
  /** Closing the window keeps the app in the tray instead of quitting. */
  closeToTray?: boolean
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf-8')) as Settings
  } catch {
    return {}
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
}

/** Merge a patch into the stored settings and return the result. */
export async function patchSettings(patch: Settings): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await saveSettings(next)
  return next
}
