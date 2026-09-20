/**
 * Desktop transport: run the system `ssh` (or a bundled `plink`) as a detached
 * child process, one per tunnel.
 *
 * This is the only place in the project that knows about processes, PID state
 * files, port probing and log files. Windows / macOS / Linux use it; Android
 * and iOS cannot (no `fork`/`exec`) and will provide an in-process
 * implementation of the same `TunnelTransport` interface instead.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { createConnection } from 'net'
import * as os from 'os'
import * as path from 'path'
import { safeStem } from '../../core/config'
import type {
  DescribeResult,
  TransportSession,
  TunnelLogs,
  TunnelTransport
} from '../../core/transport'
import type { ResolvedTunnel } from '../../core/types'
import { TunnelError } from '../../core/types'
import { tailFile } from './tail-file'

/** Which SSH client flavour a tunnel resolved to. */
export type ClientKind = 'plink' | 'openssh' | 'askpass'

export interface BuiltCommand {
  cmd: string[]
  kind: ClientKind
  exe: string
  /**
   * When set, `open()` stages the tunnel's password in this file before
   * spawning, so `plink -pwfile` can read it instead of taking it on the
   * command line, where any local process could read it.
   */
  passwordFile?: string
}

export interface ExecTransportOptions {
  /** Base directory for relative `private_key` / `client` paths. */
  rootDir: string
  /** Directory for PID state + log files (like `.tunnel/`). */
  runtimeDir: string
  /** Ordered list of plink.exe candidate paths (bundled, PATH, userData…). */
  plinkCandidates: string[]
  /**
   * The subset of `plinkCandidates` that ships with the app, whose version is
   * therefore known to support `-pwfile` (PuTTY 0.77+). User-supplied or PATH
   * plink copies stay on `-pw` for compatibility with older releases.
   */
  shippedPlinkPaths?: string[]
  /**
   * @internal Test seam. Only replaces command construction, so the real spawn,
   * readiness polling and stop-escalation path stays under test on every
   * platform (Windows cannot execute a script as a "client" without a shell).
   * Production code never sets this.
   */
  commandBuilder?: (t: ResolvedTunnel) => BuiltCommand
}

interface StateData {
  pid: number
  client: string
  startedAt: number
  executable: string
  identity?: string
}

interface ClientInfo {
  exe: string
  kind: ClientKind
}

/** Rotate a tunnel log once it grows past this size (one previous file kept). */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/** How long to wait for a started client to open its local port. */
const READY_ATTEMPTS = 30
const READY_INTERVAL_MS = 200
const EXIT_ATTEMPTS = 30
const EXIT_INTERVAL_MS = 100

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function findOnPath(name: string): string | null {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Hide `-pw <secret>` pairs from anything the user can see. */
function maskSecrets(cmd: string[]): string {
  return cmd
    .map((part, index) => {
      if (part === '-pw') return part
      if (index > 0 && cmd[index - 1] === '-pw') return part.replace(/./g, '*')
      return part
    })
    .join(' ')
}

export class ExecTransport implements TunnelTransport {
  readonly kind = 'exec' as const

  private readonly rootDir: string
  private readonly runtimeDir: string
  private readonly plinkCandidates: string[]
  private readonly shippedPlinkPaths: string[]
  private readonly commandBuilder: (t: ResolvedTunnel) => BuiltCommand
  private readonly children = new Map<number, ChildProcess>()
  /** Children we spawned that already reported 'exit' (see `probeAlive`). */
  private readonly exited = new Set<number>()
  private sweptPasswordFiles = false

  constructor(opts: ExecTransportOptions) {
    this.rootDir = opts.rootDir
    this.runtimeDir = opts.runtimeDir
    this.plinkCandidates = opts.plinkCandidates
    this.shippedPlinkPaths = opts.shippedPlinkPaths ?? []
    this.commandBuilder = opts.commandBuilder ?? ((t) => this.buildCommand(t))
  }

  // ------------------------------------------------------- TunnelTransport

  describe(t: ResolvedTunnel): DescribeResult {
    const { cmd, kind, exe } = this.commandBuilder(t)
    return { command: maskSecrets(cmd), kind, executable: exe }
  }

  async probeLocalPort(t: ResolvedTunnel): Promise<boolean> {
    return this.openPort(t.values.local_bind || '127.0.0.1', Number(t.values.local_port))
  }

  async open(t: ResolvedTunnel): Promise<TransportSession> {
    const { cmd, kind, exe, passwordFile } = this.commandBuilder(t)
    const bind = t.values.local_bind || '127.0.0.1'
    const port = Number(t.values.local_port)
    await fs.mkdir(this.runtimeDir, { recursive: true })
    const { state: stateFile, out: outFile, err: errFile } = this.pathsFor(t)

    let childEnv: NodeJS.ProcessEnv | undefined
    if (kind === 'askpass') {
      childEnv = { ...process.env }
      childEnv.TUNNEL_MANAGER_PASSWORD = t.values.password
      childEnv.SSH_ASKPASS = await this.ensureAskpass()
      childEnv.SSH_ASKPASS_REQUIRE = 'force'
      childEnv.DISPLAY = childEnv.DISPLAY || 'tunnel-manager:0'
    }

    await this.sweepPasswordFiles()
    if (passwordFile && t.values.password) {
      await this.writePasswordFile(passwordFile, t.values.password)
    }

    await this.rotateLog(outFile)
    await this.rotateLog(errFile)
    const outHandle = await fs.open(outFile, 'a')
    const errHandle = await fs.open(errFile, 'a')
    let child: ChildProcess
    const spawnState: { error: Error | null } = { error: null }
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: this.rootDir,
        stdio: ['ignore', outHandle.fd, errHandle.fd],
        detached: true,
        windowsHide: true,
        env: childEnv ?? process.env
      })
    } catch (error) {
      await outHandle.close()
      await errHandle.close()
      throw error
    }
    const cleanup = (): void => {
      if (child.pid !== undefined) {
        this.children.delete(child.pid)
        this.recordExit(child.pid)
      }
      void outHandle.close().catch(() => undefined)
      void errHandle.close().catch(() => undefined)
    }
    // Attach listeners BEFORE checking the pid: when spawn fails (e.g. ENOENT),
    // Node emits 'error' asynchronously. If the listener is attached only after
    // throwing below, that event is unhandled and crashes the main process.
    child.on('exit', cleanup)
    child.on('error', (error) => {
      spawnState.error = error
      cleanup()
    })
    if (child.pid === undefined) {
      await outHandle.close()
      await errHandle.close()
      await this.removePasswordFile(t)
      throw new TunnelError(`[${t.key}] failed to spawn ${cmd[0]}`)
    }
    this.children.set(child.pid, child)
    this.exited.delete(child.pid) // PIDs are recycled; this one is alive again

    const data: StateData = {
      pid: child.pid,
      client: kind,
      startedAt: Date.now(),
      executable: path.resolve(exe),
      identity: await this.currentIdentity(child.pid)
    }
    const tmp = `${stateFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
    await fs.rename(tmp, stateFile)

    for (let i = 0; i < READY_ATTEMPTS; i++) {
      if (spawnState.error) {
        await this.removeState(t)
        await this.removePasswordFile(t)
        throw new TunnelError(`[${t.key}] failed to start client: ${spawnState.error.message}`)
      }
      if (child.exitCode !== null) break
      if (await this.openPort(bind, port)) {
        return { id: String(child.pid), pid: child.pid }
      }
      await delay(READY_INTERVAL_MS)
    }
    await this.removeState(t)
    await this.removePasswordFile(t)
    if (child.exitCode === null) child.kill('SIGTERM')
    throw new TunnelError(`[${t.key}] failed; see ${errFile}`)
  }

  async close(t: ResolvedTunnel, session: TransportSession): Promise<void> {
    try {
      const pid = session.pid
      if (pid === null) {
        throw new TunnelError(`[${t.key}] session ${session.id} has no OS process to stop`)
      }
      const data = (await this.readStateFile(t)) ?? {
        pid,
        client: this.kind,
        startedAt: 0,
        executable: ''
      }

      this.signal(pid, 'SIGTERM')
      if (await this.waitForExit(pid, data, EXIT_ATTEMPTS)) {
        await this.removeState(t)
        return
      }

      // The graceful signal did not take, so escalate. When the process survives
      // even that, the state file is deliberately kept: deleting it would hide a
      // live process that still holds the local port and could no longer be
      // stopped from the UI.
      this.signal(pid, 'SIGKILL')
      if (await this.waitForExit(pid, data, 20)) {
        await this.removeState(t)
        return
      }
      throw new TunnelError(`[${t.key}] failed to stop (PID ${pid} is still alive)`)
    } finally {
      // A running plink has already read the staged password, so the file never
      // needs to outlive the session.
      await this.removePasswordFile(t)
    }
  }

  async liveSessions(tunnels: ResolvedTunnel[]): Promise<Map<string, TransportSession>> {
    const out = new Map<string, TransportSession>()
    for (const t of tunnels) {
      const data = await this.readStateFile(t)
      if (data) out.set(t.key, { id: String(data.pid), pid: data.pid })
    }
    return out
  }

  async logs(t: ResolvedTunnel, lines: number): Promise<TunnelLogs> {
    const { out, err } = this.pathsFor(t)
    return {
      output: await tailFile(out, lines),
      error: await tailFile(err, lines),
      outLabel: out,
      errLabel: err
    }
  }

  // ------------------------------------------------------------ internals

  private pathsFor(t: Pick<ResolvedTunnel, 'key'>): {
    state: string
    out: string
    err: string
  } {
    const stem = safeStem(t.key)
    return {
      state: path.join(this.runtimeDir, `${stem}.json`),
      out: path.join(this.runtimeDir, `${stem}.out.log`),
      err: path.join(this.runtimeDir, `${stem}.err.log`)
    }
  }

  private async removeState(t: Pick<ResolvedTunnel, 'key'>): Promise<void> {
    await fs.rm(this.pathsFor(t).state, { force: true })
  }

  /** Read a state file without any liveness filtering. */
  private async readRawState(t: Pick<ResolvedTunnel, 'key'>): Promise<StateData | null> {
    const stateFile = this.pathsFor(t).state
    let raw: string
    try {
      raw = await fs.readFile(stateFile, 'utf-8')
    } catch {
      await fs.rm(stateFile, { force: true })
      return null
    }
    try {
      const data = JSON.parse(raw) as StateData
      if (!Number.isInteger(data.pid) || data.pid <= 0) throw new Error('invalid pid')
      return data
    } catch {
      await fs.rm(stateFile, { force: true })
      return null
    }
  }

  /** Read a state file; clean it up when the recorded process is gone. */
  private async readStateFile(t: Pick<ResolvedTunnel, 'key'>): Promise<StateData | null> {
    const data = await this.readRawState(t)
    if (!data) return null
    if (!(await this.probeAlive(data.pid, data))) {
      await this.removeState(t)
      return null
    }
    return data
  }

  /** Windows: image name via tasklist; POSIX: /proc/<pid>/stat starttime. */
  private async currentIdentity(pid: number): Promise<string | undefined> {
    try {
      if (process.platform === 'win32') {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { timeout: 3000, windowsHide: true },
            (err, out) => (err ? reject(err) : resolve(out))
          )
        })
        const first = stdout.split(/\r?\n/)[0]
        if (!first || !first.startsWith('"')) return undefined
        try {
          return (JSON.parse(`[${first}]`) as string[])[0]
        } catch {
          return undefined
        }
      }
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'ascii')
      return stat.split(' ')[21]
    } catch {
      return undefined
    }
  }

  /** Is the pid from a state file still the same process we launched? */
  private async probeAlive(pid: number, data: StateData): Promise<boolean> {
    if (this.exited.has(pid)) return false
    const child = this.children.get(pid)
    if (child) return child.exitCode === null
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    if (data.identity) {
      try {
        const now = await this.currentIdentity(pid)
        if (now && now !== data.identity) return false // PID was reused
      } catch {
        /* fall back to existence check */
      }
    }
    return true
  }

  /** Remember an exited child so `probeAlive` never has to guess via kill(pid, 0). */
  private recordExit(pid: number): void {
    if (this.exited.size > 512) this.exited.clear() // bounded: PIDs are recycled
    this.exited.add(pid)
  }

  /** Signal a tunnel's process, or its whole session (detached -> setsid) on POSIX. */
  private signal(pid: number, signal: NodeJS.Signals): void {
    const child = this.children.get(pid)
    try {
      if (child) child.kill(signal)
      else if (process.platform === 'win32') process.kill(pid, signal)
      else process.kill(-pid, signal)
    } catch {
      /* process already gone */
    }
  }

  /** Poll until the process is gone; true when it exited within `attempts` ticks. */
  private async waitForExit(pid: number, data: StateData, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (!(await this.probeAlive(pid, data))) return true
      await delay(EXIT_INTERVAL_MS)
    }
    return !(await this.probeAlive(pid, data))
  }

  /** Keep tunnel logs bounded so a long-lived app cannot fill the disk. */
  private async rotateLog(file: string): Promise<void> {
    try {
      const stat = await fs.stat(file)
      if (stat.size < LOG_MAX_BYTES) return
      await fs.rm(`${file}.1`, { force: true })
      await fs.rename(file, `${file}.1`)
    } catch {
      // Best-effort: on Windows an orphaned process may still hold the handle,
      // in which case we simply keep appending.
    }
  }

  private async ensureAskpass(): Promise<string> {
    const helper = path.join(this.runtimeDir, 'askpass.sh')
    const content = '#!/bin/sh\nprintf "%s\\n" "$TUNNEL_MANAGER_PASSWORD"\n'
    await fs.mkdir(this.runtimeDir, { recursive: true })
    try {
      const existing = await fs.readFile(helper, 'utf-8')
      if (existing !== content) await fs.writeFile(helper, content, { mode: 0o700 })
    } catch {
      await fs.writeFile(helper, content, { mode: 0o700 })
    }
    await fs.chmod(helper, 0o700)
    return helper
  }

  /** Is this plink one of the copies shipped with the app (version known)? */
  private supportsPasswordFile(exe: string): boolean {
    const target = path.resolve(exe).toLowerCase()
    return this.shippedPlinkPaths.some((p) => path.resolve(p).toLowerCase() === target)
  }

  /** Where a plink password is staged for `-pwfile`. */
  private passwordFileFor(t: Pick<ResolvedTunnel, 'key'>): string {
    return path.join(this.runtimeDir, `${safeStem(t.key)}.pw`)
  }

  /**
   * Stage a password for `plink -pwfile` with owner-only permissions. Written
   * without a trailing newline: plink uses this file's content as the password.
   */
  private async writePasswordFile(file: string, password: string): Promise<void> {
    await fs.mkdir(this.runtimeDir, { recursive: true })
    await fs.writeFile(file, password, { mode: 0o600 })
    await fs.chmod(file, 0o600).catch(() => undefined)
  }

  private async removePasswordFile(t: Pick<ResolvedTunnel, 'key'>): Promise<void> {
    await fs.rm(this.passwordFileFor(t), { force: true }).catch(() => undefined)
  }

  /**
   * Remove password files left behind by a previous run. Safe by construction: a
   * tunnel still running from that run has already read its password.
   */
  private async sweepPasswordFiles(): Promise<void> {
    if (this.sweptPasswordFiles) return
    this.sweptPasswordFiles = true
    try {
      for (const name of await fs.readdir(this.runtimeDir)) {
        if (name.endsWith('.pw')) await fs.rm(path.join(this.runtimeDir, name), { force: true })
      }
    } catch {
      /* the runtime directory does not exist yet */
    }
  }

  private async openPort(host: string, port: number): Promise<boolean> {
    const target = host === '0.0.0.0' || host === '::' || host === '*' ? '127.0.0.1' : host
    return new Promise((resolve) => {
      const socket = createConnection({ host: target, port, timeout: 200 })
      socket.setTimeout(200)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  private bundledPlink(): string | null {
    for (const candidate of this.plinkCandidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private resolveExecutable(requested: string): string | null {
    const fromPath = findOnPath(requested)
    if (fromPath) return fromPath
    const relative = path.resolve(this.rootDir, requested)
    if (existsSync(relative)) return relative
    return null
  }

  private resolveClient(t: ResolvedTunnel): ClientInfo {
    const requested = (t.values.client || 'auto').trim()
    const isPlink = (p: string): boolean => path.basename(p).toLowerCase().startsWith('plink')

    if (requested !== 'auto') {
      const candidate = this.resolveExecutable(requested)
      if (!candidate) throw new TunnelError(`[${t.key}] SSH client not found: ${requested}`)
      return { exe: candidate, kind: isPlink(candidate) ? 'plink' : 'openssh' }
    }

    const needsPassword = Boolean(t.values.password) && !t.values.private_key
    if (needsPassword && process.platform === 'win32') {
      const bundled = this.bundledPlink()
      if (bundled) return { exe: bundled, kind: 'plink' }
      const inPath = findOnPath('plink')
      if (inPath) return { exe: inPath, kind: 'plink' }
    }
    const ssh = findOnPath('ssh')
    if (ssh) return { exe: ssh, kind: 'openssh' }
    if (process.platform === 'win32') {
      const bundled = this.bundledPlink()
      if (bundled) return { exe: bundled, kind: 'plink' }
    }
    const plink = findOnPath('plink')
    if (plink) return { exe: plink, kind: 'plink' }
    throw new TunnelError('no SSH client found; install OpenSSH or configure client=...')
  }

  /** Build the exact command line, mirroring tunnel-manager.py. */
  private buildCommand(t: ResolvedTunnel): BuiltCommand {
    const { exe, kind } = this.resolveClient(t)
    const v = t.values
    const bind = v.local_bind || '127.0.0.1'
    const forward = `${bind}:${v.local_port}:${v.remote_host}:${v.remote_port}`
    const rawKey = v.private_key ? expandHome(v.private_key) : ''
    const key = rawKey && !path.isAbsolute(rawKey) ? path.resolve(this.rootDir, rawKey) : rawKey

    if (kind === 'plink') {
      const cmd = [
        exe,
        '-ssh',
        '-P',
        v.server_port || '22',
        '-l',
        v.username,
        '-L',
        forward,
        '-N',
        '-batch'
      ]
      let passwordFile: string | undefined
      if (key) {
        cmd.push('-i', key)
      } else if (v.password) {
        if (this.supportsPasswordFile(exe)) {
          // `-pwfile` (PuTTY 0.77+) keeps the password out of the process
          // command line, where any local process could otherwise read it.
          passwordFile = this.passwordFileFor(t)
          cmd.push('-pwfile', passwordFile)
        } else {
          cmd.push('-pw', v.password)
        }
      }
      if (v.hostkey) cmd.push('-hostkey', v.hostkey)
      cmd.push(v.server)
      return { cmd, kind, exe, passwordFile }
    }

    const cmd = [
      exe,
      '-N',
      '-T',
      '-p',
      v.server_port || '22',
      '-L',
      forward,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3'
    ]
    if (key) cmd.push('-i', key)
    cmd.push('-o', `StrictHostKeyChecking=${v.strict_host_key_checking || 'yes'}`)
    cmd.push(`${v.username}@${v.server}`)
    if (v.password && !key) {
      if (process.platform === 'win32') {
        throw new TunnelError(
          `[${t.key}] use client=plink.exe for password authentication on Windows`
        )
      }
      return { cmd, kind: 'askpass', exe }
    }
    return { cmd, kind, exe }
  }
}
