/**
 * File-backed `ConfigStore` for Node / Electron.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot truncate a
 * user's tunnel configuration.
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import type { ConfigStore } from '../../core/storage'
import { TunnelError } from '../../core/types'

export class FileConfigStore implements ConfigStore {
  readonly label: string

  constructor(private readonly filePath: string) {
    this.label = filePath
  }

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        throw new TunnelError(`configuration file not found: ${this.filePath}`, 'CONFIG_NOT_FOUND')
      }
      throw error
    }
  }

  async write(text: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, text, 'utf-8')
    await fs.rename(tmp, this.filePath)
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath)
      return true
    } catch {
      return false
    }
  }
}
