/**
 * TunnelManager — the platform-agnostic orchestration layer.
 *
 * It owns everything that is the same on every platform: config lifecycle,
 * target resolution, the per-tunnel lifecycle lock, bounded-concurrency batch
 * actions, and projecting the current state into the view model. It knows
 * nothing about processes, files or sockets — that is the injected
 * `TunnelTransport` / `ConfigStore`.
 *
 * A direct TypeScript port of SSH-Tunnel-Manager's `tunnel-manager.py`.
 */
import {
  defaultConfig,
  parseConfig,
  PASSWORD_PLACEHOLDER,
  resolveTarget,
  resolveTunnels,
  serializeConfig,
  validateConfig
} from './config'
import type { ConfigStore, SecretStore } from './storage'
import type { TransportSession, TunnelTransport } from './transport'
import type {
  ActionResult,
  ConfigData,
  LogPayload,
  ResolvedTunnel,
  TunnelView,
  ValidateItem
} from './types'
import { TunnelError } from './types'

export interface TunnelManagerOptions {
  /** Where the configuration is read from / written to. */
  store: ConfigStore
  /** How tunnels are actually forwarded on this platform. */
  transport: TunnelTransport
  /**
   * Optional encrypted secret storage. When present and available, passwords
   * are moved out of the config file into it (see `extractSecrets`).
   */
  secretStore?: SecretStore
}

/** A config section that may carry a password, plus its stable identity. */
interface ConfigSection {
  ref: string
  values: Record<string, string>
}

/** Every section of a config that can hold a `password`. */
function sectionsOf(cfg: ConfigData): ConfigSection[] {
  return [
    { ref: 'defaults', values: cfg.defaults },
    ...cfg.groups.map((g) => ({ ref: `group:${g.name}`, values: g.values })),
    ...cfg.tunnels.map((t) => ({ ref: `tunnel:${t.group}:${t.name}`, values: t.values }))
  ]
}

/** Deep copy, so secret handling never mutates the caller's config. */
function cloneConfig(cfg: ConfigData): ConfigData {
  return {
    defaults: { ...cfg.defaults },
    groups: cfg.groups.map((g) => ({ name: g.name, values: { ...g.values } })),
    tunnels: cfg.tunnels.map((t) => ({ group: t.group, name: t.name, values: { ...t.values } }))
  }
}

/**
 * Combine a stored config (secrets replaced by references) with the plaintext
 * the caller is editing, so the cached config always looks exactly like a fresh
 * `reload()`. Without carrying the reference back, a later rename would write a
 * new reference and leave the old secret orphaned in the store.
 */
function withPlaintext(stored: ConfigData, source: ConfigData): ConfigData {
  const next = cloneConfig(stored)
  const sourceSections = sectionsOf(source)
  sectionsOf(next).forEach((section, index) => {
    const password = sourceSections[index]?.values.password
    if (password) section.values.password = password
  })
  return next
}

/** How many tunnels a batch action (start/stop/restart) may process at once. */
const ACTION_CONCURRENCY = 4

/**
 * Run `worker` over `items` with at most `limit` tasks in flight. The worker is
 * responsible for its own error handling, so one failure never cancels the rest.
 */
async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
}

/** "PID 1234" for a child process, or the raw handle id when there is none. */
function handleOf(session: TransportSession): string {
  return session.pid === null ? session.id : `PID ${session.pid}`
}

export class TunnelManager {
  private store: ConfigStore
  private readonly transport: TunnelTransport
  private readonly secretStore?: SecretStore
  private config: ConfigData | null = null
  /** Per-tunnel promise chain; see `withLock`. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(opts: TunnelManagerOptions) {
    this.store = opts.store
    this.transport = opts.transport
    this.secretStore = opts.secretStore
  }

  // ---------------------------------------------------------------- config

  async getConfig(): Promise<ConfigData> {
    if (this.config) return this.config
    await this.reload()
    return this.config!
  }

  async reload(): Promise<ConfigData> {
    let text: string
    try {
      text = await this.store.read()
    } catch (error) {
      if (error instanceof TunnelError && error.code === 'CONFIG_NOT_FOUND') {
        await this.ensureConfigFile()
        text = await this.store.read()
      } else {
        throw error
      }
    }
    const config = parseConfig(text)
    await this.injectSecrets(config)
    validateConfig(config) // surface per-tunnel errors early (empty is allowed)
    this.config = config
    return config
  }

  /** Write the default template if nothing has been stored yet. */
  async ensureConfigFile(): Promise<void> {
    if (await this.store.exists()) return
    await this.store.write(serializeConfig(defaultConfig()))
  }

  /**
   * Identifier of the active configuration. A file path on desktop; an opaque
   * document label on runtimes without a filesystem.
   */
  getConfigPath(): string {
    return this.store.label
  }

  /** Validate + persist a new config from the UI. */
  async saveConfig(cfg: ConfigData): Promise<ConfigData> {
    validateConfig(cfg) // throws TunnelError with precise message on problems
    // Secrets leave the file before it is written; the cached config then keeps
    // both the reference that is now on disk and the plaintext the UI is
    // editing, so it matches what `reload()` would have produced.
    const stored = await this.extractSecrets(cfg)
    await this.store.write(serializeConfig(stored))
    this.config = withPlaintext(stored, cfg)
    return this.config
  }

  /** Whether credentials can be stored encrypted on this platform. */
  canEncryptSecrets(): boolean {
    return this.secretStore?.isAvailable() ?? false
  }

  /**
   * Serialized configuration for export, with every secret removed.
   *
   * Credentials deliberately do not travel: an exported file is meant to be
   * shared or moved, while the encrypted store is bound to this OS account.
   */
  async exportConfig(): Promise<string> {
    const cfg = cloneConfig(await this.getConfig())
    for (const section of sectionsOf(cfg)) {
      delete section.values.password
      delete section.values.password_ref
    }
    return serializeConfig(cfg)
  }

  /**
   * Fill in passwords that live in the secret store, so the rest of the core
   * (and the UI) only ever deals with `values.password`.
   */
  private async injectSecrets(cfg: ConfigData): Promise<void> {
    const secrets = this.secretStore
    if (!secrets?.isAvailable()) return
    for (const section of sectionsOf(cfg)) {
      const ref = section.values.password_ref
      if (!ref || section.values.password) continue
      const secret = await secrets.get(ref)
      if (secret !== null) section.values.password = secret
    }
  }

  /**
   * Move plaintext passwords into the secret store and replace them with a
   * reference. Returns a copy, so the caller's config keeps its plaintext.
   *
   * Without an available secret store the config is returned unchanged, i.e.
   * passwords stay in the file exactly as before — never silently "encrypted"
   * into something that is not actually protected.
   */
  private async extractSecrets(cfg: ConfigData): Promise<ConfigData> {
    const copy = cloneConfig(cfg)
    const secrets = this.secretStore
    if (!secrets?.isAvailable()) return copy

    for (const section of sectionsOf(copy)) {
      const password = section.values.password
      if (password === undefined) continue

      if (!password) {
        // The user cleared the field: drop the reference and the stored secret.
        if (section.values.password_ref) await secrets.remove(section.values.password_ref)
        delete section.values.password
        delete section.values.password_ref
        continue
      }
      // The placeholder in the built-in template is not a real credential.
      if (password === PASSWORD_PLACEHOLDER) continue

      // The reference follows the section identity, so renaming a group or
      // tunnel migrates the secret instead of orphaning it.
      const previousRef = section.values.password_ref
      await secrets.set(section.ref, password)
      if (previousRef && previousRef !== section.ref) await secrets.remove(previousRef)
      delete section.values.password
      section.values.password_ref = section.ref
    }
    return copy
  }

  /**
   * Switch to a different configuration (creating the template when missing).
   * Both the store and the cached config are rolled back when loading fails.
   */
  async useStore(next: ConfigStore): Promise<ConfigData> {
    const previousStore = this.store
    const previousConfig = this.config
    this.store = next
    this.config = null
    try {
      return await this.reload()
    } catch (error) {
      this.store = previousStore
      this.config = previousConfig
      throw error
    }
  }

  private async resolved(): Promise<ResolvedTunnel[]> {
    const cfg = await this.getConfig()
    return resolveTunnels(cfg)
  }

  /** The live session of one tunnel, or null when it is not running. */
  private async sessionFor(t: ResolvedTunnel): Promise<TransportSession | null> {
    const live = await this.transport.liveSessions([t])
    return live.get(t.key) ?? null
  }

  /**
   * Serialize lifecycle operations per tunnel. Without this, two concurrent
   * start/restart calls both pass the "is it running?" check and start twice.
   */
  private withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(work, work)
    // Keep the chain alive without leaving an unhandled rejection behind.
    const guard = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(key, guard)
    void guard.then(() => {
      if (this.locks.get(key) === guard) this.locks.delete(key)
    })
    return run
  }

  // ------------------------------------------------------------- lifecycle

  async start(t: ResolvedTunnel): Promise<string> {
    return this.withLock(t.key, () => this.startUnlocked(t))
  }

  private async startUnlocked(t: ResolvedTunnel): Promise<string> {
    const running = await this.sessionFor(t)
    if (running) return `[${t.key}] already running (${handleOf(running)})`

    const bind = t.values.local_bind || '127.0.0.1'
    const port = Number(t.values.local_port)
    if (await this.transport.probeLocalPort(t)) {
      throw new TunnelError(`[${t.key}] local port ${bind}:${port} is in use`)
    }

    const session = await this.transport.open(t)
    return (
      `[${t.key}] started ${bind}:${port} -> ` +
      `${t.values.remote_host}:${t.values.remote_port} (${handleOf(session)})`
    )
  }

  async stop(t: ResolvedTunnel): Promise<string> {
    return this.withLock(t.key, () => this.stopUnlocked(t))
  }

  private async stopUnlocked(t: ResolvedTunnel): Promise<string> {
    const session = await this.sessionFor(t)
    if (!session) return `[${t.key}] is not running`
    await this.transport.close(t, session)
    return `[${t.key}] stopped`
  }

  async run(action: 'start' | 'stop' | 'restart', target: string): Promise<ActionResult> {
    const tunnels = resolveTarget(
      await this.resolved(),
      target,
      action === 'start' || action === 'restart'
    )
    // Batch actions run with bounded concurrency: each `start` waits for the
    // local port to open, so a serial loop would stall for minutes on a large
    // config. Slots stay index-aligned so the reported order is deterministic.
    const results = tunnels.map(() => ({ messages: [] as string[], errors: [] as string[] }))
    await mapPool(tunnels, ACTION_CONCURRENCY, async (t, index) => {
      const slot = results[index]!
      try {
        if (action === 'start') slot.messages.push(await this.start(t))
        else if (action === 'stop') slot.messages.push(await this.stop(t))
        else {
          slot.messages.push(await this.stop(t))
          slot.messages.push(await this.start(t))
        }
      } catch (error) {
        slot.errors.push(error instanceof Error ? error.message : String(error))
      }
    })
    const messages = results.flatMap((r) => r.messages)
    const errors = results.flatMap((r) => r.errors)
    return { ok: errors.length === 0, messages, errors }
  }

  // ----------------------------------------------------------- projections

  async list(): Promise<TunnelView[]> {
    let tunnels: ResolvedTunnel[]
    try {
      tunnels = await this.resolved()
    } catch {
      return []
    }
    const live = await this.transport.liveSessions(tunnels)
    const views: TunnelView[] = []
    for (const t of tunnels) {
      const session = live.get(t.key) ?? null
      // A live session whose local port is not accepting connections yet is
      // still handshaking: "connecting" rather than "running".
      const state: TunnelView['state'] = session
        ? (await this.transport.probeLocalPort(t))
          ? 'running'
          : 'connecting'
        : 'stopped'
      views.push({
        key: t.key,
        group: t.group,
        name: t.name,
        enabled: t.enabled,
        values: t.values,
        state,
        pid: session?.pid ?? null,
        local: t.local,
        remote: t.remote
      })
    }
    return views
  }

  async validate(target: string): Promise<ValidateItem[]> {
    const tunnels = resolveTarget(await this.resolved(), target, false)
    return tunnels.map((t) => {
      try {
        const { command, kind, executable } = this.transport.describe(t)
        return {
          key: t.key,
          ok: true,
          message: `OK (${kind}: ${executable})`,
          command
        }
      } catch (error) {
        return {
          key: t.key,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    })
  }

  async logs(target: string, lines: number): Promise<LogPayload[]> {
    const tunnels = resolveTarget(await this.resolved(), target, false)
    const live = await this.transport.liveSessions(tunnels)
    const out: LogPayload[] = []
    for (const t of tunnels) {
      const tail = await this.transport.logs(t, lines)
      out.push({
        key: t.key,
        output: tail.output,
        error: tail.error,
        outPath: tail.outLabel,
        errPath: tail.errLabel,
        running: live.has(t.key)
      })
    }
    return out
  }
}
