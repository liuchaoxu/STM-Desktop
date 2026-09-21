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
  isEnabledValue,
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

/** How long a tunnel must stay up before its backoff budget is refunded. */
const HEALTHY_AFTER_MS = 30_000
/** Ceiling for the exponential backoff. */
const MAX_BACKOFF_MS = 60_000

/**
 * Auto-reconnect settings, read from a tunnel's merged values.
 *
 * `auto_restart` defaults to on: a tunnel that dies because the network blipped is
 * the single most common failure this app has, and "silently stopped" is the worst
 * possible outcome. It never fights the user — only sessions the app is *keeping*
 * alive are reconnected (see `desired`).
 */
interface RestartPolicy {
  enabled: boolean
  limit: number
  baseDelayMs: number
}

function restartPolicy(values: Record<string, string>): RestartPolicy {
  const limit = Number((values.restart_limit ?? '').trim() || '5')
  const delay = Number((values.restart_delay ?? '').trim() || '2')
  return {
    enabled: isEnabledValue(values.auto_restart ?? 'true'),
    limit: Number.isInteger(limit) && limit >= 0 ? limit : 5,
    baseDelayMs: (Number.isFinite(delay) && delay >= 0 ? delay : 2) * 1000
  }
}

export class TunnelManager {
  private store: ConfigStore
  private readonly transport: TunnelTransport
  private readonly secretStore?: SecretStore
  private config: ConfigData | null = null
  /** Per-tunnel promise chain; see `withLock`. */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Tunnels the user asked to stay running; auto-reconnect serves only these. */
  private readonly desired = new Set<string>()
  /** Reconnects performed per tunnel during this app run. */
  private readonly restarts = new Map<string, number>()
  /** Consecutive reconnect attempts, for the exponential backoff. */
  private readonly attempts = new Map<string, number>()
  /** Pending reconnect timers, so stopping a tunnel can cancel one. */
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When the current session was (re)established, to refund the backoff. */
  private readonly upSince = new Map<string, number>()

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
    this.desired.add(t.key)
    const running = await this.sessionFor(t)
    if (running) return `[${t.key}] already running (${handleOf(running)})`

    const bind = t.values.local_bind || '127.0.0.1'
    const port = (t.values.local_port || t.values.dynamic_port || '').trim()
    if (await this.transport.probeLocalPort(t)) {
      throw new TunnelError(`[${t.key}] local port ${bind}:${port || '?'} is in use`)
    }

    const session = await this.transport.open(t)
    this.upSince.set(t.key, Date.now())
    return `[${t.key}] started ${t.local} -> ${t.remote} (${handleOf(session)})`
  }

  async stop(t: ResolvedTunnel): Promise<string> {
    return this.withLock(t.key, () => this.stopUnlocked(t))
  }

  private async stopUnlocked(t: ResolvedTunnel): Promise<string> {
    // Before anything else: a reconnect must not be scheduled *during* the stop.
    this.desired.delete(t.key)
    this.cancelReconnect(t.key)
    this.attempts.delete(t.key)
    this.upSince.delete(t.key)
    const session = await this.sessionFor(t)
    if (!session) return `[${t.key}] is not running`
    await this.transport.close(t, session)
    return `[${t.key}] stopped`
  }

  private cancelReconnect(key: string): void {
    const timer = this.reconnectTimers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.reconnectTimers.delete(key)
  }

  /**
   * Apply the auto-reconnect policy to whatever the transport reported since the
   * last call.
   *
   * Driven by the shell's status loop rather than a timer of its own, so the whole
   * app agrees on one tick and a headless manager can be stepped deterministically.
   * The transport only reports deaths nobody asked for, so this can never resurrect
   * a tunnel the user stopped.
   */
  async reconcile(): Promise<void> {
    const tunnels = await this.resolved().catch(() => [] as ResolvedTunnel[])
    const byKey = new Map(tunnels.map((t) => [t.key, t]))

    // A tunnel that has been healthy for a while gets its attempt budget back:
    // otherwise a link that flaps once an hour eventually stops reconnecting.
    const now = Date.now()
    for (const key of this.desired) {
      const since = this.upSince.get(key)
      if (since !== undefined && now - since > HEALTHY_AFTER_MS) {
        this.attempts.delete(key)
        this.upSince.set(key, now)
      }
    }

    for (const exit of this.transport.takeExits?.() ?? []) {
      const t = byKey.get(exit.key)
      if (!t || !this.desired.has(exit.key)) continue
      const policy = restartPolicy(t.values)
      if (!policy.enabled) {
        this.desired.delete(exit.key)
        continue
      }
      const attempts = this.attempts.get(exit.key) ?? 0
      if (attempts >= policy.limit) {
        // Out of budget: stay stopped, and keep the count so the UI can say so.
        this.desired.delete(exit.key)
        continue
      }
      this.scheduleReconnect(t, attempts)
    }
  }

  private scheduleReconnect(t: ResolvedTunnel, attempts: number): void {
    if (this.reconnectTimers.has(t.key)) return
    this.attempts.set(t.key, attempts + 1)
    const delay = Math.min(restartPolicy(t.values).baseDelayMs * 2 ** attempts, MAX_BACKOFF_MS)
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(t.key)
      void this.reconnect(t.key).catch(() => undefined)
    }, delay)
    // A pending reconnect must not keep the process alive on its own.
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    this.reconnectTimers.set(t.key, timer)
  }

  private async reconnect(key: string): Promise<void> {
    const tunnels = await this.resolved().catch(() => [] as ResolvedTunnel[])
    const t = tunnels.find((entry) => entry.key === key)
    if (!t || !this.desired.has(key)) return
    try {
      await this.start(t)
      this.restarts.set(key, (this.restarts.get(key) ?? 0) + 1)
    } catch {
      // A failed attempt burns budget and backs off further; the transport has
      // already recorded the reason in the tunnel's log.
      const policy = restartPolicy(t.values)
      const attempts = this.attempts.get(key) ?? 0
      if (attempts < policy.limit) this.scheduleReconnect(t, attempts)
      else this.desired.delete(key)
    }
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
        remote: t.remote,
        startedAt: session?.startedAt ?? null,
        restarts: this.restarts.get(t.key) ?? 0
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
