/**
 * Persistence seams for the platform-agnostic core.
 *
 * The core never touches a filesystem directly: it talks to these two
 * interfaces, and each platform provides an implementation.
 *   - Electron/Node : `src/platforms/node/config-store.ts` (files)
 *   - Mobile        : Capacitor Filesystem / SQLite / IndexedDB, plus
 *                     Keychain (iOS) or Keystore (Android) for secrets
 */

/** Where the tunnel configuration lives. */
export interface ConfigStore {
  /**
   * Stable identifier shown in the UI. On desktop this is the file path; on a
   * mobile runtime it may be an opaque document name.
   */
  readonly label: string

  /**
   * Raw configuration text.
   *
   * @throws {TunnelError} with `code: 'CONFIG_NOT_FOUND'` when nothing has been
   * stored yet, so the core can install the default template.
   */
  read(): Promise<string>

  /** Persist the configuration. Implementations should write atomically. */
  write(text: string): Promise<void>

  /** Whether a configuration has been stored yet. */
  exists(): Promise<boolean>
}

/**
 * Secrets (SSH passwords, key passphrases) kept outside the configuration file.
 *
 * The core stores a `password_ref` in the config and moves the plaintext here,
 * so `tunnel.conf` never contains a password. Keys are the section identity
 * (`defaults`, `group:<name>`, `tunnel:<group>:<name>`).
 *
 * Implementations: Electron `safeStorage` (DPAPI / Keychain / libsecret),
 * iOS Keychain, Android Keystore.
 */
export interface SecretStore {
  /**
   * Whether this runtime can actually keep secrets out of plain sight.
   *
   * When false (e.g. a Linux box without a keyring) the core deliberately keeps
   * passwords in the config file as before, instead of pretending to encrypt
   * them.
   */
  isAvailable(): boolean

  /** The secret for `key`, or null when absent or undecryptable. */
  get(key: string): Promise<string | null>

  set(key: string, value: string): Promise<void>

  remove(key: string): Promise<void>
}
