/**
 * TunnelManager: process lifecycle for grouped SSH local port forwards.
 * A direct TypeScript port of SSH-Tunnel-Manager's `tunnel-manager.py`.
 * Pure Node module (no Electron) so it can be smoke-tested standalone.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createConnection } from 'net'
import type {
  ActionResult,
  ConfigData,
  LogPayload,
  ResolvedTunnel,
  TunnelView,
  ValidateItem
} from './types'
import { TunnelError } from './types'
import {
  defaultConfig,
  loadConfigFile,
  resolveTarget,
  resolveTunnels,
  saveConfigFile,
  serializeConfig,
  validateConfig
} from './config'

export interface TunnelManagerOptions {
  /** Absolute path of the active config file. */
  configPath: string
  /** Base directory for relative `private_key` / `client` paths. */
  rootDir: string
  /** Directory for PID state + log files (like `.tunnel/`). */
  runtimeDir: string
  /** Ordered list of plink.exe candidate paths (bundled, PATH, userData…). */
  plinkCandidates: string[]
}

interface StateData {
  pid: number
  client: string
  startedAt: number
  executable: string
  identity?: string
}

type ClientKind = 'plink' | 'openssh' | 'askpass'

interface ClientInfo {
  exe: string
  kind: ClientKind
}

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

/** Read the last N lines of a file efficiently (from the end). */
export async function tailFile(filePath: string, maxLines: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof fs.open>>
  try {
    fh = await fs.open(filePath, 'r')
  } catch {
    return '(no log)'
  }
  try {
    const stat = await fh.stat()
    if (stat.size === 0) return '(empty)'
    const CHUNK = 64 * 1024
    let pos = stat.size
    const chunks: string[] = []
    let lineCount = 0
    while (pos > 0 && lineCount <= maxLines) {
      const size = Math.min(CHUNK, pos)
      pos -= size
      const buf = Buffer.alloc(size)
      await fh.read(buf, 0, size, pos)
      const text = buf.toString('utf-8')
      lineCount += (text.match(/\n/g) || []).length
      chunks.unshift(text)
    }
    const all = chunks.join('')
    const lines = all.split('\n')
    return lines.slice(-maxLines).join('\n').replace(/^\n+/, '') || '(empty)'
  } finally {
    await fh.close()
  }
}

export class TunnelManager {
  private configPath: string
  private readonly rootDir: string
  private readonly runtimeDir: string
  private readonly plinkCandidates: string[]
  private config: ConfigData | null = null
  private readonly children = new Map<number, ChildProcess>()

  constructor(opts: TunnelManagerOptions) {
    this.configPath = opts.configPath
    this.rootDir = opts.rootDir
    this.runtimeDir = opts.runtimeDir
    this.plinkCandidates = opts.plinkCandidates
  }

  // ---------------------------------------------------------------- config

  async getConfig(): Promise<ConfigData> {
    if (this.config) return this.config
    await this.reload()
    return this.config!
  }

  async reload(): Promise<ConfigData> {
    try {
      this.config = await loadConfigFile(this.configPath)
    } catch (error) {
      if (error instanceof TunnelError && error.message.includes('not found')) {
        await this.ensureConfigFile()
        this.config = await loadConfigFile(this.configPath)
      } else {
        throw error
      }
    }
    validateConfig(this.config!) // surface per-tunnel errors early (empty is allowed)
    return this.config!
  }

  /** Write the default template if the config file does not exist yet. */
  async ensureConfigFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    try {
      await fs.access(this.configPath)
    } catch {
      await fs.writeFile(this.configPath, serializeConfig(defaultConfig()), 'utf-8')
    }
  }

  getConfigPath(): string {
    return this.configPath
  }

  /** Validate + persist a new config from the UI. */
  async saveConfig(cfg: ConfigData): Promise<ConfigData> {
    validateConfig(cfg) // throws TunnelError with precise message on problems
    await saveConfigFile(this.configPath, cfg)
    this.config = cfg
    return cfg
  }

  /** Switch to a different config file (creating the template when missing). */
  async setConfigPath(nextPath: string): Promise<ConfigData> {
    const old = this.configPath
    this.configPath = nextPath
    try {
      await this.reload()
      return this.config!
    } catch (error) {
      this.configPath = old
      throw error
    }
  }

  private async resolved(): Promise<ResolvedTunnel[]> {
    const cfg = await this.getConfig()
    return resolveTunnels(cfg)
  }

  // ------------------------------------------------------------- runtime

  private pathsFor(t: Pick<ResolvedTunnel, 'key'>): {
    state: string
    out: string
    err: string
  } {
    const stem = t.key.replace(/[^A-Za-z0-9._-]/g, '_')
    return {
      state: path.join(this.runtimeDir, `${stem}.json`),
      out: path.join(this.runtimeDir, `${stem}.out.log`),
      err: path.join(this.runtimeDir, `${stem}.err.log`)
    }
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

  private async spawnIdentity(pid: number): Promise<string | undefined> {
    return this.currentIdentity(pid)
  }

  /** Is the pid from a state file still the same process we launched? */
  private async probeAlive(pid: number, data: StateData): Promise<boolean> {
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

  /** Read state file; clean it up when the process is gone. */
  private async state(t: Pick<ResolvedTunnel, 'key'>): Promise<StateData | null> {
    const stateFile = this.pathsFor(t).state
    let raw: string
    try {
      raw = await fs.readFile(stateFile, 'utf-8')
    } catch {
      await fs.rm(stateFile, { force: true })
      return null
    }
    let data: StateData
    try {
      data = JSON.parse(raw) as StateData
    } catch {
      await fs.rm(stateFile, { force: true })
      return null
    }
    if (!Number.isInteger(data.pid) || data.pid <= 0) {
      await fs.rm(stateFile, { force: true })
      return null
    }
    if (!(await this.probeAlive(data.pid, data))) {
      await fs.rm(stateFile, { force: true })
      return null
    }
    return data
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
  private buildCommand(t: ResolvedTunnel): { cmd: string[]; kind: ClientKind; exe: string } {
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
      if (key) cmd.push('-i', key)
      else if (v.password) cmd.push('-pw', v.password)
      if (v.hostkey) cmd.push('-hostkey', v.hostkey)
      cmd.push(v.server)
      return { cmd, kind, exe }
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

  async start(t: ResolvedTunnel): Promise<string> {
    const current = await this.state(t)
    if (current) return `[${t.key}] already running (PID ${current.pid})`

    const bind = t.values.local_bind || '127.0.0.1'
    const port = Number(t.values.local_port)
    if (await this.openPort(bind, port)) {
      throw new TunnelError(`[${t.key}] local port ${bind}:${port} is in use`)
    }

    const { cmd, kind, exe } = this.buildCommand(t)
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

    const outHandle = await fs.open(outFile, 'a')
    const errHandle = await fs.open(errFile, 'a')
    let child: ChildProcess
    const spawnState: { error: Error | null } = { error: null }
    try {
      child = spawn(cmd[0], cmd.slice(1), {
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
      this.children.delete(child.pid!)
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
      throw new TunnelError(`[${t.key}] failed to spawn ${cmd[0]}`)
    }
    this.children.set(child.pid, child)

    const data: StateData = {
      pid: child.pid,
      client: kind,
      startedAt: Date.now(),
      executable: path.resolve(exe),
      identity: await this.spawnIdentity(child.pid)
    }
    const tmp = `${stateFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
    await fs.rename(tmp, stateFile)

    for (let i = 0; i < 30; i++) {
      if (spawnState.error) {
        await fs.rm(stateFile, { force: true })
        throw new TunnelError(`[${t.key}] failed to start client: ${spawnState.error.message}`)
      }
      if (child.exitCode !== null) break
      if (await this.openPort(bind, port)) {
        return `[${t.key}] started ${bind}:${port} -> ${t.values.remote_host}:${t.values.remote_port} (PID ${child.pid})`
      }
      await delay(200)
    }
    await fs.rm(stateFile, { force: true })
    if (child.exitCode === null) child.kill('SIGTERM')
    throw new TunnelError(`[${t.key}] failed; see ${errFile}`)
  }

  async stop(t: ResolvedTunnel): Promise<string> {
    const current = await this.state(t)
    if (!current) return `[${t.key}] is not running`
    const pid = current.pid
    const child = this.children.get(pid)
    try {
      if (child) {
        child.kill('SIGTERM')
      } else if (process.platform === 'win32') {
        process.kill(pid, 'SIGTERM')
      } else {
        process.kill(-pid, 'SIGTERM') // kill the whole session (detached -> setsid)
      }
    } catch {
      /* process already gone */
    }
    for (let i = 0; i < 30; i++) {
      if (!(await this.probeAlive(pid, current))) break
      await delay(100)
    }
    await fs.rm(this.pathsFor(t).state, { force: true })
    return `[${t.key}] stopped`
  }

  async run(action: 'start' | 'stop' | 'restart', target: string): Promise<ActionResult> {
    const tunnels = resolveTarget(
      await this.resolved(),
      target,
      action === 'start' || action === 'restart'
    )
    const messages: string[] = []
    const errors: string[] = []
    for (const t of tunnels) {
      try {
        if (action === 'start') messages.push(await this.start(t))
        else if (action === 'stop') messages.push(await this.stop(t))
        else {
          messages.push(await this.stop(t))
          messages.push(await this.start(t))
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { ok: errors.length === 0, messages, errors }
  }

  async list(): Promise<TunnelView[]> {
    let tunnels: ResolvedTunnel[]
    try {
      tunnels = await this.resolved()
    } catch {
      return []
    }
    const views: TunnelView[] = []
    for (const t of tunnels) {
      const current = await this.state(t)
      let state: TunnelView['state'] = 'stopped'
      let pid: number | null = null
      if (current) {
        pid = current.pid
        state =
          (await this.openPort(t.values.local_bind || '127.0.0.1', Number(t.values.local_port))) ===
          true
            ? 'running'
            : 'connecting'
      }
      views.push({
        key: t.key,
        group: t.group,
        name: t.name,
        enabled: t.enabled,
        values: t.values,
        state,
        pid,
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
        const { cmd, kind } = this.buildCommand(t)
        const masked = cmd.map((part, index) => {
          if (part === '-pw') return part
          if (index > 0 && cmd[index - 1] === '-pw') return part.replace(/./g, '*')
          return part
        })
        return {
          key: t.key,
          ok: true,
          message: `OK (${kind}: ${cmd[0]})`,
          command: masked.join(' ')
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
    const out: LogPayload[] = []
    for (const t of tunnels) {
      const { out: outFile, err: errFile } = this.pathsFor(t)
      const current = await this.state(t)
      out.push({
        key: t.key,
        output: await tailFile(outFile, lines),
        error: await tailFile(errFile, lines),
        outPath: outFile,
        errPath: errFile,
        running: current !== null
      })
    }
    return out
  }
}
