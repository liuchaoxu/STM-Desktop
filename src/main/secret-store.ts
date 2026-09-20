/**
 * `SecretStore` backed by Electron's `safeStorage`.
 *
 * Ciphertext lives in a JSON file under the app's userData directory; the key
 * never leaves the OS credential system (DPAPI on Windows, Keychain on macOS,
 * libsecret / kwallet on Linux). Only the main process can decrypt.
 */
import { safeStorage } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { SecretStore } from '../core/storage'

interface SecretFile {
  version: number
  entries: Record<string, string>
}

const FILE_VERSION = 1

export class ElectronSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null

  constructor(private readonly filePath: string) {}

  /**
   * False when the platform has no usable keyring (e.g. a Linux box without
   * libsecret). The core then keeps passwords in the config file rather than
   * pretending they are protected.
   */
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null
    const encoded = (await this.load())[key]
    if (!encoded) return null
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      // Written by another OS user/profile, or corrupted: treat as absent so
      // the user is asked for the password again instead of seeing an error.
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.isAvailable()) throw new Error('encrypted storage is unavailable on this system')
    const entries = await this.load()
    entries[key] = safeStorage.encryptString(value).toString('base64')
    await this.save(entries)
  }

  async remove(key: string): Promise<void> {
    const entries = await this.load()
    if (!(key in entries)) return
    delete entries[key]
    await this.save(entries)
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as SecretFile
      this.cache = parsed.entries ?? {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private async save(entries: Record<string, string>): Promise<void> {
    this.cache = entries
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: SecretFile = { version: FILE_VERSION, entries }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, this.filePath)
  }
}
