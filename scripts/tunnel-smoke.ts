/**
 * Standalone smoke test for the tunnel engine (no Electron).
 * Run with:  npm run smoke
 *
 * Covers:
 *   [A] core config parse / merge / validate / serialize / target resolution
 *   [B] command building for plink + openssh (including password masking)
 *   [C] the platform-agnostic orchestration layer driven by an IN-MEMORY
 *       transport and config store — no processes, no sockets, no files
 *   [D] log tailing (multi-byte safe) and log rotation
 *   [E] the real desktop transport against a fake SSH client process
 *   [F] stop escalation for a client that ignores SIGTERM
 */
import { promises as fs } from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import {
  defaultConfig,
  parseConfig,
  resolveTarget,
  resolveTunnels,
  serializeConfig
} from '../src/core/config'
import { TunnelManager } from '../src/core/manager'
import type { ConfigStore, SecretStore } from '../src/core/storage'
import type {
  DescribeResult,
  TransportExit,
  TransportSession,
  TunnelLogs,
  TunnelTransport
} from '../src/core/transport'
import type { ConfigData, ResolvedTunnel } from '../src/core/types'
import { TunnelError } from '../src/core/types'
import { assertConfigPayload, assertTarget } from '../src/main/ipc-guard'
import { isAllowedExternalUrl, isInternalNavigation } from '../src/main/url-policy'
import {
  ExecTransport,
  FileConfigStore,
  parseTasklistCsv,
  tailFile,
  type BuiltCommand
} from '../src/platforms/node'
import { CHANNELS, TUNNEL_CHANGED } from '../src/shared/contract'
import { mergeImport } from '../src/core/import-merge'
import { importMRemoteNg, importPuttyRegistry, importSshConfig } from '../src/core/importers'

// `npm run smoke` always runs from the package root.
const PROJECT_ROOT = process.cwd()
/** Sibling checkout holding the original project's real `tunnel.conf` + plink. */
const WORKSPACE = path.resolve(PROJECT_ROOT, '..')
const ORIGINAL_CONF = path.join(WORKSPACE, 'SSH-Tunnel-Manager', 'tunnel.conf')
const PLINK = path.join(WORKSPACE, 'SSH-Tunnel-Manager', 'plink.exe')

let failures = 0
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function throws(name: string, fn: () => unknown, pattern?: RegExp): void {
  try {
    fn()
    failures++
    console.error(`  FAIL  ${name} — expected an error`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (pattern && !pattern.test(message)) {
      failures++
      console.error(`  FAIL  ${name} — wrong error message: ${message}`)
    } else {
      console.log(`  PASS  ${name}${message ? ` (${message.slice(0, 80)})` : ''}`)
    }
  }
}
async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

// ------------------------------------------------------------- test doubles

/** In-memory ConfigStore: the core must work with no filesystem at all. */
class MemoryConfigStore implements ConfigStore {
  readonly label = 'memory://tunnel.conf'

  constructor(private text: string | null = null) {}

  async read(): Promise<string> {
    if (this.text === null) {
      throw new TunnelError(
        'configuration file not found: memory://tunnel.conf',
        'CONFIG_NOT_FOUND'
      )
    }
    return this.text
  }

  async write(text: string): Promise<void> {
    this.text = text
  }

  async exists(): Promise<boolean> {
    return this.text !== null
  }
}

/**
 * In-memory SecretStore: exercises the credential flow without a real OS
 * keyring (the Electron `safeStorage` implementation needs Electron itself).
 */
class MemorySecretStore implements SecretStore {
  readonly entries = new Map<string, string>()
  available = true

  isAvailable(): boolean {
    return this.available
  }

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.entries.delete(key)
  }
}

/**
 * In-memory transport: no child process, no socket, no file. This is also the
 * shape a mobile (in-process) transport takes, and it proves the orchestration
 * layer is genuinely platform independent.
 */
class FakeTransport implements TunnelTransport {
  readonly kind = 'in-process' as const
  /** Ports that something else already occupies. */
  readonly busyPorts = new Set<number>()
  /** Tunnels whose open() must fail, for error-propagation tests. */
  readonly failing = new Set<string>()
  openedKeys: string[] = []
  closedKeys: string[] = []
  /** Every `open()` call, including the ones that throw — i.e. real attempts. */
  openAttempts = 0

  private nextPid = 4000
  private readonly sessions = new Map<string, { session: TransportSession; port: number }>()
  /** Deaths the manager has not been told about yet (see `takeExits`). */
  private readonly exits: TransportExit[] = []

  /** Simulate a client dying on its own: the network dropped, the server hung up. */
  die(key: string, code = 255): void {
    const entry = this.sessions.get(key)
    this.sessions.delete(key)
    this.exits.push({ key, pid: entry?.session.pid ?? null, code })
  }

  takeExits(): TransportExit[] {
    return this.exits.splice(0, this.exits.length)
  }

  describe(t: ResolvedTunnel): DescribeResult {
    return { command: `in-process ${t.key}`, kind: 'in-process', executable: 'fake-transport' }
  }

  async probeLocalPort(t: ResolvedTunnel): Promise<boolean> {
    const port = Number(t.values.local_port)
    if (this.busyPorts.has(port)) return true
    for (const entry of this.sessions.values()) if (entry.port === port) return true
    return false
  }

  async open(t: ResolvedTunnel): Promise<TransportSession> {
    this.openAttempts += 1
    if (this.failing.has(t.key)) throw new TunnelError(`[${t.key}] fake open failure`)
    const session: TransportSession = {
      id: `sess-${this.nextPid}`,
      pid: this.nextPid++,
      startedAt: Date.now()
    }
    this.sessions.set(t.key, { session, port: Number(t.values.local_port) })
    this.openedKeys.push(t.key)
    return session
  }

  async close(t: ResolvedTunnel): Promise<void> {
    this.sessions.delete(t.key)
    this.closedKeys.push(t.key)
  }

  async liveSessions(tunnels: ResolvedTunnel[]): Promise<Map<string, TransportSession>> {
    const out = new Map<string, TransportSession>()
    for (const t of tunnels) {
      const entry = this.sessions.get(t.key)
      if (entry) out.set(t.key, entry.session)
    }
    return out
  }

  async logs(t: ResolvedTunnel): Promise<TunnelLogs> {
    return {
      output: this.sessions.has(t.key) ? `fake output for ${t.key}` : '(no log)',
      error: '(no log)',
      outLabel: `memory://${t.key}.out.log`,
      errLabel: `memory://${t.key}.err.log`
    }
  }
}

/** Runs a fake SSH client (a plain Node script) through the real spawn path. */
function fakeClientBuilder(script: string): (t: ResolvedTunnel) => BuiltCommand {
  return (t) => ({
    cmd: [process.execPath, script, `--port=${t.values.local_port}`],
    kind: 'openssh',
    exe: process.execPath
  })
}

/** Same, but also asks the transport to stage a password file (plink -pwfile). */
function passwordFileClientBuilder(
  script: string,
  passwordFile: string
): (t: ResolvedTunnel) => BuiltCommand {
  return (t) => ({
    cmd: [process.execPath, script, `--port=${t.values.local_port}`],
    kind: 'plink',
    exe: process.execPath,
    passwordFile
  })
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const FAKE_CLIENT = `const net=require('net');
const port=Number(process.argv.find(a=>a.startsWith('--port=')).split('=')[1]);
const srv=net.createServer(()=>{});
srv.listen(port,'127.0.0.1',()=>console.log('fake ssh listening on '+port));
process.on('SIGTERM',()=>{srv.close(()=>process.exit(0));});
setInterval(()=>{},1000);
`

const STUBBORN_CLIENT = `const net=require('net');
const port=Number(process.argv.find(a=>a.startsWith('--port=')).split('=')[1]);
const srv=net.createServer(()=>{});
srv.listen(port,'127.0.0.1',()=>console.log('stubborn ssh listening'));
process.on('SIGTERM',()=>console.log('ignoring SIGTERM'));
setInterval(()=>{},1000);
`

async function main(): Promise<void> {
  // ------------------------------------------------------------- Part A: config
  console.log('\n[A] core config parse / merge / validate / serialize')
  if (!(await exists(ORIGINAL_CONF))) {
    throw new Error(
      `missing fixture: ${ORIGINAL_CONF}\n` +
        'This smoke test parses the real tunnel.conf from the sibling SSH-Tunnel-Manager checkout.'
    )
  }
  const original = await fs.readFile(ORIGINAL_CONF, 'utf-8')
  const cfg = parseConfig(original)
  check('parses real tunnel.conf', true)
  const groupNames = cfg.groups.map((g) => g.name)
  // Expectations are derived from the parsed file: the real tunnel.conf is a
  // living document, so hard-coding counts here only produced false failures.
  check(
    'groups parsed (unique, feishu + vpn present)',
    groupNames.length > 0 &&
      new Set(groupNames).size === groupNames.length &&
      groupNames.includes('feishu') &&
      groupNames.includes('vpn'),
    JSON.stringify(groupNames)
  )
  check(
    'every tunnel belongs to a declared group',
    cfg.tunnels.length > 0 && cfg.tunnels.every((t) => groupNames.includes(t.group)),
    cfg.tunnels.map((t) => `${t.group}/${t.name}`).join(', ')
  )
  const feishu = cfg.groups.find((g) => g.name === 'feishu')!
  check('group feishu has server', feishu.values.server === '121.43.50.18')
  // The real config may hold either a plaintext password or — after the app has
  // saved it — a `password_ref` into the OS credential store. Assert that
  // whatever is there survives parsing, instead of requiring plaintext.
  check(
    'group feishu keeps its credential',
    typeof feishu.values.password === 'string' || typeof feishu.values.password_ref === 'string',
    JSON.stringify({ password: !!feishu.values.password, ref: feishu.values.password_ref })
  )

  const tunnels = resolveTunnels(cfg)
  check(
    'resolveTunnels ok',
    tunnels.length === cfg.tunnels.length,
    `${tunnels.length} of ${cfg.tunnels.length}`
  )
  const panel = tunnels.find((t) => t.key === 'feishu/1Panel')!
  check('merged server from group', panel.values.server === '121.43.50.18')
  check('merged defaults local_bind', panel.values.local_bind === '127.0.0.1')
  check('tunnel enabled default', panel.enabled === true)
  check('tunnel local string', panel.local === '127.0.0.1:29785', panel.local)
  check('tunnel remote string', panel.remote === '127.0.0.1:29785', panel.remote)

  // serialize -> reparse -> structurally identical
  const text = serializeConfig(cfg)
  const reparsed = parseConfig(text)
  check(
    'round-trip tunnels identical',
    JSON.stringify(reparsed.tunnels) === JSON.stringify(cfg.tunnels)
  )
  check(
    'round-trip defaults identical',
    JSON.stringify(reparsed.defaults) === JSON.stringify(cfg.defaults)
  )
  check(
    'round-trip groups identical',
    JSON.stringify(reparsed.groups) === JSON.stringify(cfg.groups)
  )

  // legacy section support
  const legacy = parseConfig('[mytunnel]\nlocal_port=29785\nremote_port=29785\n')
  check(
    'legacy section -> default group',
    legacy.tunnels[0]?.group === 'default',
    legacy.tunnels[0]?.group
  )
  const legacyGrouped = parseConfig(
    '[old]\ngroup=feishu\nlocal_port=1\nremote_host=h\nremote_port=2\n'
  )
  check(
    'legacy section with group= -> feishu',
    legacyGrouped.tunnels[0]?.group === 'feishu' && !('group' in legacyGrouped.tunnels[0]!.values),
    JSON.stringify(legacyGrouped.tunnels[0])
  )

  // validation errors
  const badPort = parseConfig(
    '[tunnel:g:t]\nserver=s\nusername=u\nlocal_port=99999\nremote_host=h\nremote_port=22\n'
  )
  throws('bad port rejected', () => resolveTunnels(badPort), /between 1 and 65535/)
  const missing = parseConfig('[tunnel:g:t]\nlocal_port=22\n')
  throws('missing keys rejected', () => resolveTunnels(missing), /missing/)
  const dup = parseConfig(
    '[tunnel:g:t]\nserver=s\nusername=u\nlocal_port=1\nremote_host=h\nremote_port=2\n[tunnel:g:T]\nserver=s\nusername=u\nlocal_port=3\nremote_host=h\nremote_port=4\n'
  )
  throws('duplicate tunnel rejected', () => resolveTunnels(dup), /duplicate tunnel/)
  const empty = parseConfig('[defaults]\nenabled=true\n')
  throws('no tunnels rejected', () => resolveTunnels(empty), /no tunnels are configured/)
  throws(
    'duplicate option rejected',
    () => parseConfig('[defaults]\na=1\na=2\n'),
    /duplicate option/
  )

  // target resolution (derived from the real config, not hard-coded counts)
  const feishuCount = cfg.tunnels.filter((t) => t.group === 'feishu').length
  const enabledCount = tunnels.filter((t) => t.enabled).length
  check('target all', resolveTarget(tunnels, 'all', false).length === tunnels.length)
  check(
    'target group',
    resolveTarget(tunnels, 'feishu', false).length === feishuCount,
    `expected ${feishuCount}`
  )
  check('target exact', resolveTarget(tunnels, 'feishu/1Panel', false).length === 1)
  check(
    'target exact case-insensitive',
    resolveTarget(tunnels, 'FEISHU/1PANEL', false).length === 1
  )
  check(
    'target all enabled-only',
    resolveTarget(tunnels, 'all', true).length === enabledCount,
    `expected ${enabledCount}`
  )
  throws(
    'unknown target rejected',
    () => resolveTarget(tunnels, 'nope', false),
    /unknown group or tunnel/
  )

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-smoke-'))
  const confFile = path.join(tmp, 'tunnel.conf')
  await fs.writeFile(confFile, original, 'utf-8')

  // ----------------------------------------------------------- Part B: commands
  console.log('\n[B] client resolution + command building')
  const plinkUsed = await exists(PLINK)
  const describeManager = new TunnelManager({
    store: new FileConfigStore(confFile),
    transport: new ExecTransport({
      rootDir: WORKSPACE,
      runtimeDir: path.join(tmp, '.tunnel'),
      plinkCandidates: [PLINK]
    })
  })
  const items = await describeManager.validate('all')
  check(
    'validate all runs',
    items.length === tunnels.length,
    `${items.length} of ${tunnels.length}`
  )
  for (const item of items) {
    check(`validate ${item.key} ok`, item.ok, item.message)
  }
  if (plinkUsed) {
    // Self-contained fixture: the real tunnel.conf may now carry a
    // `password_ref` instead of a plaintext password (the app migrates it into
    // the OS credential store), which would silently stop testing password
    // handling in the command builder.
    const plinkCfg = parseConfig(
      `[group:g]\nserver=srv.example.com\nusername=alice\npassword=K4j5-secret\nhostkey=SHA256:abc\n` +
        `[tunnel:g:t]\nlocal_port=8080\nremote_host=127.0.0.1\nremote_port=80\nclient=${PLINK.replace(/\\/g, '/')}\n`
    )
    const plinkCmd = new ExecTransport({
      rootDir: WORKSPACE,
      runtimeDir: path.join(tmp, '.tunnel-plink'),
      plinkCandidates: [PLINK]
    }).describe(resolveTunnels(plinkCfg)[0]!)
    check('plink command contains -pw', plinkCmd.command.includes(' -pw '), plinkCmd.command)
    check('plink command masks password', !/K4j5/.test(plinkCmd.command), plinkCmd.command)
    check(
      'plink command contains -hostkey',
      plinkCmd.command.includes('-hostkey'),
      plinkCmd.command
    )
  }

  // openssh command shape via a fake non-plink client file
  const fakeSsh = path.join(tmp, 'fake-ssh.bin')
  await fs.writeFile(fakeSsh, '', 'utf-8')
  const forced = parseConfig(
    `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\nlocal_port=8080\nremote_host=127.0.0.1\nremote_port=80\nprivate_key=~/.ssh/id_ed25519\nclient=${fakeSsh.replace(/\\/g, '/')}\n`
  )
  const forcedTransport = new ExecTransport({
    rootDir: tmp,
    runtimeDir: path.join(tmp, '.tunnel3'),
    plinkCandidates: []
  })
  const openssh = forcedTransport.describe(resolveTunnels(forced)[0]!)
  check('openssh command built', openssh.kind === 'openssh', openssh.kind)
  check('openssh -i flag', openssh.command.includes('-i'), openssh.command)
  check(
    'openssh StrictHostKeyChecking',
    openssh.command.includes('StrictHostKeyChecking='),
    openssh.command
  )
  check('openssh user@server', openssh.command.includes('alice@srv.example.com'), openssh.command)

  // Forwarding shapes beyond a plain -L: SOCKS5, reverse tunnel, bastion.
  const shapes = (body: string): string =>
    new ExecTransport({
      rootDir: tmp,
      runtimeDir: path.join(tmp, '.tunnel-shapes'),
      plinkCandidates: []
    }).describe(
      resolveTunnels(
        parseConfig(`[tunnel:g:t]\nserver=srv.example.com\nusername=alice\n${body}\n`)
      )[0]!
    ).command

  const dynamic = shapes('dynamic_port=1080')
  check('socks5 uses -D', dynamic.includes('-D 127.0.0.1:1080'), dynamic)
  check('socks5 needs no remote target', !dynamic.includes(' -L '), dynamic)

  const reverse = shapes('remote_forward=8080:127.0.0.1:80')
  check(
    'reverse tunnel uses -R with an implicit bind',
    reverse.includes('-R 127.0.0.1:8080:127.0.0.1:80'),
    reverse
  )

  const jump = shapes(
    'local_port=8080\nremote_host=127.0.0.1\nremote_port=80\nproxy_jump=deploy@bastion:22'
  )
  check('bastion uses -J', jump.includes('-J deploy@bastion:22'), jump)

  const combined = shapes(
    'local_port=8080\nremote_host=127.0.0.1\nremote_port=80\ndynamic_port=1080\n' +
      'remote_forward=9000:127.0.0.1:90\nproxy_jump=bastion'
  )
  check(
    'forwards combine on one client',
    [
      '-L 127.0.0.1:8080:127.0.0.1:80',
      '-D 127.0.0.1:1080',
      '-R 127.0.0.1:9000:127.0.0.1:90',
      '-J bastion'
    ].every((flag) => combined.includes(flag)),
    combined
  )

  throws(
    'bastion is rejected for plink',
    () =>
      new ExecTransport({
        rootDir: tmp,
        runtimeDir: path.join(tmp, '.tunnel-plink2'),
        plinkCandidates: [PLINK]
      }).describe(
        resolveTunnels(
          parseConfig(
            `[tunnel:g:t]\nserver=s\nusername=u\nlocal_port=1\nremote_host=h\nremote_port=2\n` +
              `proxy_jump=bastion\nclient=${PLINK.replace(/\\/g, '/')}\n`
          )
        )[0]!
      ),
    /proxy_jump requires the OpenSSH client/
  )

  // A tunnel that forwards nothing, or forwards something malformed, is a config
  // error rather than a client that starts and does nothing.
  throws(
    'tunnel with no forward is rejected',
    () => resolveTunnels(parseConfig('[tunnel:g:t]\nserver=s\nusername=u\n')),
    /missing: one of/
  )
  throws(
    'malformed remote_forward is rejected',
    () =>
      resolveTunnels(
        parseConfig('[tunnel:g:t]\nserver=s\nusername=u\nremote_forward=8080:127.0.0.1\n')
      ),
    /remote_forward must be/
  )
  throws(
    'proxy_jump without a host is rejected',
    () =>
      resolveTunnels(
        parseConfig('[tunnel:g:t]\nserver=s\nusername=u\ndynamic_port=1080\nproxy_jump=user@\n')
      ),
    /proxy_jump has no host/
  )

  // ---------------------------------------- Part C: core, zero OS dependency
  console.log('\n[C] platform-agnostic core (in-memory store + in-memory transport)')
  const memStore = new MemoryConfigStore()
  const fake = new FakeTransport()
  const core = new TunnelManager({ store: memStore, transport: fake })

  // Nothing stored yet -> the core installs the default template itself.
  const template = await core.reload()
  check(
    'core installs the default template',
    template.tunnels.length === 2,
    String(template.tunnels.length)
  )
  check('config label is exposed', core.getConfigPath() === memStore.label, core.getConfigPath())

  const coreTunnels = resolveTunnels(template)
  const t0 = coreTunnels[0]!
  const t1 = coreTunnels[1]!

  const coreStart = await core.run('start', 'all')
  check('core batch start', coreStart.ok, coreStart.errors.join(' | '))
  check(
    'start message carries a handle',
    /started .*\(PID \d+\)/.test(coreStart.messages.join(' ')),
    coreStart.messages.join(' ')
  )
  check('transport opened both tunnels', fake.openedKeys.length === 2, fake.openedKeys.join(', '))

  let coreViews = await core.list()
  check(
    'core list reports running',
    coreViews.length === 2 && coreViews.every((v) => v.state === 'running'),
    JSON.stringify(coreViews.map((v) => v.state))
  )
  check('core list exposes a pid', typeof coreViews[0]?.pid === 'number')

  // Concurrent start must not start the client twice (per-tunnel lifecycle lock).
  await core.stop(t0)
  const openedBefore = fake.openedKeys.filter((k) => k === t0.key).length
  const race = await Promise.all([core.start(t0), core.start(t0)])
  const openedAfter = fake.openedKeys.filter((k) => k === t0.key).length
  check(
    'concurrent start starts exactly once',
    openedAfter - openedBefore === 1 &&
      race.some((m) => /started/.test(m)) &&
      race.some((m) => /already running/.test(m)),
    race.join(' | ')
  )

  // Logs and validation flow through the transport (both tunnels are running).
  const coreLogs = await core.logs('all', 50)
  check(
    'core logs come from the transport',
    coreLogs.length === 2 && coreLogs[0]!.outPath.startsWith('memory://'),
    coreLogs[0]?.outPath
  )
  check(
    'core logs carry the running flag',
    coreLogs.every((l) => l.running),
    JSON.stringify(coreLogs.map((l) => l.running))
  )
  const coreValidate = await core.validate('all')
  check(
    'core validate uses transport.describe',
    coreValidate.length === 2 && coreValidate[0]!.message.includes('fake-transport'),
    coreValidate[0]?.message
  )

  // A port conflict must be reported before any transport call.
  await core.stop(t0)
  fake.busyPorts.add(Number(t0.values.local_port))
  const busy = await core.run('start', t0.key)
  check(
    'port conflict rejected',
    !busy.ok && busy.errors.some((e) => e.includes('in use')),
    busy.errors.join(' | ')
  )
  fake.busyPorts.clear()

  // A transport failure must surface as an error, never as success.
  fake.failing.add(t0.key)
  const failedOpen = await core.run('start', t0.key)
  check(
    'transport failure surfaces',
    !failedOpen.ok && failedOpen.errors[0]!.includes('fake open failure'),
    failedOpen.errors.join(' | ')
  )
  fake.failing.clear()

  // restart = stop + start (t0 is stopped here, t1 is running)
  const restarted = await core.run('restart', 'all')
  check('core batch restart', restarted.ok, restarted.errors.join(' | '))

  // Config round trip through the store, without any file system.
  const saved = await core.saveConfig(template)
  const reread = await core.reload()
  check('save / reload round trip', JSON.stringify(reread) === JSON.stringify(saved))

  // A broken config must roll the store switch back.
  const brokenStore: ConfigStore = {
    label: 'memory://broken',
    read: async () => 'this is not a config',
    write: async () => undefined,
    exists: async () => true
  }
  let switched = false
  try {
    await core.useStore(brokenStore)
  } catch {
    switched = true
  }
  check(
    'failed config switch rolls back',
    switched && core.getConfigPath() === memStore.label,
    core.getConfigPath()
  )

  const coreStop = await core.run('stop', 'all')
  check('core batch stop', coreStop.ok, coreStop.errors.join(' | '))
  coreViews = await core.list()
  check(
    'core list reports stopped',
    coreViews.every((v) => v.state === 'stopped'),
    JSON.stringify(coreViews.map((v) => v.state))
  )
  check('stop called the transport', fake.closedKeys.length >= 2, String(fake.closedKeys.length))
  check('tunnel keys are stable', t1.key === 'feishu/mysql', t1.key)

  // ---------------------------------------------------------------- Part D: logs
  console.log('\n[D] log tailing + rotation')
  {
    // A multi-byte character straddling the 64 KiB read boundary must survive
    // intact; decoding each chunk separately used to yield U+FFFD here.
    const CHUNK = 64 * 1024
    const tailDir = path.join(tmp, 'tail')
    await fs.mkdir(tailDir, { recursive: true })
    const boundaryFile = path.join(tailDir, 'boundary.log')
    await fs.writeFile(boundaryFile, 'a'.repeat(199) + '中' + 'b'.repeat(CHUNK - 2), 'utf-8')
    const boundaryTail = await tailFile(boundaryFile, 10)
    check(
      'tail has no replacement char at a chunk boundary',
      !boundaryTail.includes('\uFFFD'),
      boundaryTail.slice(0, 40)
    )
    check('tail keeps the multi-byte char', boundaryTail.includes('中'))

    const multiFile = path.join(tailDir, 'multi.log')
    await fs.writeFile(multiFile, 'line\n'.repeat(30), 'utf-8')
    const lastTen = await tailFile(multiFile, 10)
    check(
      'tail returns the requested number of lines',
      lastTen.split('\n').length === 10,
      String(lastTen.split('\n').length)
    )
    check(
      'tail of a missing file',
      (await tailFile(path.join(tailDir, 'nope.log'), 5)) === '(no log)'
    )
  }

  // ----------------------------------------- Part E: real desktop transport
  console.log('\n[E] desktop transport: real spawn / status / stop / restart')
  const fakeScript = path.join(tmp, 'fake-ssh.cjs')
  await fs.writeFile(fakeScript, FAKE_CLIENT, 'utf-8')
  const lifeRuntime = path.join(tmp, '.tunnel4')
  const lifePort = await getFreePort()
  const lifeCfg = parseConfig(
    `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\nlocal_port=${lifePort}\nremote_host=127.0.0.1\nremote_port=80\nclient=auto\n`
  )
  const lifeConfFile = path.join(tmp, 'life.conf')
  await fs.writeFile(lifeConfFile, serializeConfig(lifeCfg), 'utf-8')
  const life = new TunnelManager({
    store: new FileConfigStore(lifeConfFile),
    transport: new ExecTransport({
      rootDir: tmp,
      runtimeDir: lifeRuntime,
      plinkCandidates: [],
      commandBuilder: fakeClientBuilder(fakeScript)
    })
  })

  const startRes = await life.run('start', 'all')
  check('start succeeds', startRes.ok, startRes.errors.join(' | '))
  check(
    'start message',
    /started .*\(PID \d+\)/.test(startRes.messages.join(' ')),
    startRes.messages.join(' ')
  )
  let views = await life.list()
  check('status running after start', views[0]?.state === 'running', JSON.stringify(views[0]))
  check('pid present', typeof views[0]?.pid === 'number' && views[0]!.pid! > 0)

  const logs = await life.logs('all', 20)
  check(
    'logs returned',
    logs.length === 1 && logs[0]!.output.includes('fake ssh listening'),
    logs[0]?.output
  )
  check('log file path set', logs[0]!.outPath.includes('.tunnel4'))

  const again = await life.run('start', 'all')
  check(
    'second start reports already running',
    /already running/.test(again.messages.join(' ')),
    again.messages.join(' ')
  )

  const stopRes = await life.run('stop', 'all')
  check('stop succeeds', stopRes.ok, stopRes.errors.join(' | '))
  views = await life.list()
  check('status stopped after stop', views[0]?.state === 'stopped', JSON.stringify(views[0]))
  check('state file removed after stop', !(await exists(path.join(lifeRuntime, 'g_t.json'))))

  const restartRes = await life.run('restart', 'all')
  check('restart succeeds', restartRes.ok, restartRes.errors.join(' | '))
  views = await life.list()
  check('running again after restart', views[0]?.state === 'running', JSON.stringify(views[0]))
  await life.run('stop', 'all')

  // port in use -> start failure (a real listener occupies the port)
  const usedPort = await getFreePort()
  const blocker = await new Promise<net.Server>((resolve) => {
    const srv = net.createServer(() => undefined)
    srv.listen(usedPort, '127.0.0.1', () => resolve(srv))
  })
  const busyCfg = parseConfig(
    `[tunnel:g:b]\nserver=srv.example.com\nusername=alice\nlocal_port=${usedPort}\nremote_host=127.0.0.1\nremote_port=80\nclient=auto\n`
  )
  const busyConfFile = path.join(tmp, 'busy.conf')
  await fs.writeFile(busyConfFile, serializeConfig(busyCfg), 'utf-8')
  const busyLife = new TunnelManager({
    store: new FileConfigStore(busyConfFile),
    transport: new ExecTransport({
      rootDir: tmp,
      runtimeDir: path.join(tmp, '.tunnel5'),
      plinkCandidates: [],
      commandBuilder: fakeClientBuilder(fakeScript)
    })
  })
  const busyRes = await busyLife.run('start', 'all')
  check('start fails when port in use', !busyRes.ok, JSON.stringify(busyRes))
  check(
    'port in use message',
    busyRes.errors.some((e) => e.includes('in use')),
    busyRes.errors.join(' | ')
  )
  blocker.close()

  // An oversized log must be moved aside on the next start instead of growing forever.
  {
    const rotRuntime = path.join(tmp, '.tunnel7')
    const rotPort = await getFreePort()
    const rotCfg = parseConfig(
      `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\nlocal_port=${rotPort}\nremote_host=127.0.0.1\nremote_port=80\nclient=auto\n`
    )
    const rotConfFile = path.join(tmp, 'rot.conf')
    await fs.writeFile(rotConfFile, serializeConfig(rotCfg), 'utf-8')
    const rot = new TunnelManager({
      store: new FileConfigStore(rotConfFile),
      transport: new ExecTransport({
        rootDir: tmp,
        runtimeDir: rotRuntime,
        plinkCandidates: [],
        commandBuilder: fakeClientBuilder(fakeScript)
      })
    })
    await rot.run('start', 'all')
    await rot.run('stop', 'all')

    const outLog = path.join(rotRuntime, 'g_t.out.log')
    await fs.writeFile(outLog, 'x'.repeat(6 * 1024 * 1024), 'utf-8')
    const rotated = await rot.run('start', 'all')
    check('start after an oversized log succeeds', rotated.ok, rotated.errors.join(' | '))
    check('oversized log rotated aside', await exists(`${outLog}.1`))
    const freshSize = (await fs.stat(outLog)).size
    check('log started fresh after rotation', freshSize < 64 * 1024, `${freshSize} bytes`)
    await rot.run('stop', 'all')
  }

  // ------------------------------------------------- Part F: stop escalation
  console.log('\n[F] stop escalation for a client that ignores SIGTERM')
  {
    const stubbornScript = path.join(tmp, 'stubborn-ssh.cjs')
    await fs.writeFile(stubbornScript, STUBBORN_CLIENT, 'utf-8')
    const stubbornRuntime = path.join(tmp, '.tunnel6')
    const stubbornPort = await getFreePort()
    const stubbornCfg = parseConfig(
      `[tunnel:g:s]\nserver=srv.example.com\nusername=alice\nlocal_port=${stubbornPort}\nremote_host=127.0.0.1\nremote_port=80\nclient=auto\n`
    )
    const stubbornConfFile = path.join(tmp, 'stubborn.conf')
    await fs.writeFile(stubbornConfFile, serializeConfig(stubbornCfg), 'utf-8')
    const stubborn = new TunnelManager({
      store: new FileConfigStore(stubbornConfFile),
      transport: new ExecTransport({
        rootDir: tmp,
        runtimeDir: stubbornRuntime,
        plinkCandidates: [],
        commandBuilder: fakeClientBuilder(stubbornScript)
      })
    })
    const stubbornStart = await stubborn.run('start', 'all')
    check('stubborn client starts', stubbornStart.ok, stubbornStart.errors.join(' | '))
    const stubbornStop = await stubborn.run('stop', 'all')
    check('stubborn client stopped', stubbornStop.ok, stubbornStop.errors.join(' | '))
    const stubbornViews = await stubborn.list()
    check('stubborn client reported stopped', stubbornViews[0]?.state === 'stopped')
  }

  // ---------------------------------- Part G: shell policy + IPC input guards
  console.log('\n[G] URL policy + IPC input guards')
  {
    check(
      'http/https links are allowed',
      isAllowedExternalUrl('https://example.com/x') && isAllowedExternalUrl('http://example.com')
    )
    check('file: links are refused', !isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe'))
    check('javascript: links are refused', !isAllowedExternalUrl('javascript:alert(1)'))
    check('custom schemes are refused', !isAllowedExternalUrl('ms-settings:privacy'))
    check('garbage is refused', !isAllowedExternalUrl('not a url'))

    const devUrl = 'http://localhost:5173/index.html'
    check(
      'same-origin navigation allowed',
      isInternalNavigation(devUrl, 'http://localhost:5173/other')
    )
    check(
      'cross-origin navigation refused',
      !isInternalNavigation(devUrl, 'https://evil.example.com/')
    )
    const fileUrl = 'file:///C:/app/out/renderer/index.html'
    check(
      'file navigation inside the bundle allowed',
      isInternalNavigation(fileUrl, 'file:///C:/app/out/renderer/other.html')
    )
    check(
      'file navigation outside the bundle refused',
      !isInternalNavigation(fileUrl, 'file:///C:/Windows/System32/calc.exe')
    )
    check('navigation from a blank page refused', !isInternalNavigation('', 'file:///C:/evil.html'))

    check('valid target accepted', assertTarget(' feishu/1Panel ') === 'feishu/1Panel')
    throws('non-string target rejected', () => assertTarget(42), /invalid target/)
    throws('empty target rejected', () => assertTarget('   '), /invalid target/)
    throws('oversized target rejected', () => assertTarget('x'.repeat(500)), /too long/)

    // The IPC contract is the single source of truth for channel names. Types cover
    // the shapes; these cover the names themselves (a copy-paste collision compiles).
    // Widened to string[] on purpose: the point of the next check is that the push
    // channel is *not* one of the invoke channels, which the narrow type already
    // proves — so assert it at runtime too.
    const channelNames: readonly string[] = Object.values(CHANNELS)
    check('every IPC channel name is unique', new Set(channelNames).size === channelNames.length)
    check(
      'every IPC channel is namespaced',
      channelNames.every((name) => /^[a-z]+:/.test(name))
    )
    check('push channel is not an invoke channel', !channelNames.includes(TUNNEL_CHANGED))
    check(
      'config surface is fully declared',
      [
        'configGet',
        'configSave',
        'configReload',
        'configPathGet',
        'configPathSet',
        'configOpen',
        'configSaveAs',
        'configReveal',
        'configReset'
      ].every((key) => key in CHANNELS)
    )

    // Windows liveness: one unfiltered snapshot instead of a `tasklist` spawn per
    // tunnel, so the parsing has to survive real-world output.
    const listing = parseTasklistCsv(
      '"ssh.exe","1234","Console","1","12,345 K"\r\n"plink.exe","4321","Console","1","9,000 K"\r\n'
    )
    check(
      'tasklist snapshot maps pid to image',
      listing.get(1234) === 'ssh.exe' && listing.get(4321) === 'plink.exe'
    )
    check('tasklist keeps quoted commas intact', listing.size === 2)
    check(
      'tasklist skips lines it cannot parse',
      parseTasklistCsv('INFO: no tasks are running\n"broken line\n"x.exe","not-a-pid"').size === 0
    )
    check('tasklist handles an empty listing', parseTasklistCsv('').size === 0)

    const good = parseConfig(
      '[defaults]\nserver_port=22\n[group:g]\nserver=s\nusername=u\n[tunnel:g:t]\nlocal_port=1\nremote_host=h\nremote_port=2\n'
    )
    const normalized = assertConfigPayload(JSON.parse(JSON.stringify(good)) as unknown)
    check(
      'valid config accepted',
      normalized.tunnels.length === 1 && normalized.groups.length === 1,
      JSON.stringify(normalized)
    )
    throws('config must be an object', () => assertConfigPayload(null), /expected an object/)
    throws(
      'groups must be an array',
      () => assertConfigPayload({ defaults: {}, groups: {}, tunnels: [] }),
      /groups must be an array/
    )
    throws(
      'option values must be strings',
      () => assertConfigPayload({ defaults: { server_port: 22 }, groups: [], tunnels: [] }),
      /must be a string/
    )
    throws(
      'tunnel names must not be empty',
      () =>
        assertConfigPayload({
          defaults: {},
          groups: [],
          tunnels: [{ group: 'g', name: '  ', values: {} }]
        }),
      /must not be empty/
    )
    throws(
      'oversized option value rejected',
      () => assertConfigPayload({ defaults: { a: 'x'.repeat(9000) }, groups: [], tunnels: [] }),
      /too long/
    )
    throws(
      'too many tunnels rejected',
      () =>
        assertConfigPayload({
          defaults: {},
          groups: [],
          tunnels: Array.from({ length: 600 }, () => ({ group: 'g', name: 't', values: {} }))
        }),
      /too many tunnels/
    )
  }

  // ------------------------------------------- Part H: plink -pwfile staging
  console.log('\n[H] plink password staging (-pwfile)')
  {
    const plinkTunnel = resolveTunnels(
      parseConfig(
        '[group:g]\nserver=s\nusername=u\npassword=K4j5-secret\nhostkey=SHA256:abc\n[tunnel:g:t]\nlocal_port=1\nremote_host=h\nremote_port=2\n'
      )
    )[0]!

    // A plink copy shipped with the app: version known, so -pwfile is safe.
    const shippedCmd = new ExecTransport({
      rootDir: tmp,
      runtimeDir: path.join(tmp, '.tunnel8'),
      plinkCandidates: [PLINK],
      shippedPlinkPaths: [PLINK]
    }).describe(plinkTunnel).command
    check('shipped plink uses -pwfile', shippedCmd.includes('-pwfile'), shippedCmd)
    check(
      'shipped plink keeps the secret off the command line',
      !shippedCmd.includes(' -pw '),
      shippedCmd
    )
    check('shipped plink never prints the password', !/K4j5/.test(shippedCmd), shippedCmd)

    // An unknown plink (PATH / user-supplied) keeps the legacy flag.
    const legacyCmd = new ExecTransport({
      rootDir: WORKSPACE,
      runtimeDir: path.join(tmp, '.tunnel9'),
      plinkCandidates: [PLINK]
    }).describe(plinkTunnel).command
    check('unknown plink version keeps -pw', legacyCmd.includes(' -pw '), legacyCmd)

    // Staged file lifecycle: written before spawn, removed when the session ends.
    const pwRuntime = path.join(tmp, '.tunnel10')
    const pwFile = path.join(pwRuntime, 'g_t.pw')
    const stalePasswordFile = path.join(pwRuntime, 'leftover.pw')
    await fs.mkdir(pwRuntime, { recursive: true })
    await fs.writeFile(stalePasswordFile, 'from a previous run', 'utf-8')

    const pwPort = await getFreePort()
    const pwCfg = parseConfig(
      `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\npassword=s3cret\nlocal_port=${pwPort}\nremote_host=127.0.0.1\nremote_port=80\nclient=auto\n`
    )
    const pwConfFile = path.join(tmp, 'pwfile.conf')
    await fs.writeFile(pwConfFile, serializeConfig(pwCfg), 'utf-8')
    const pwManager = new TunnelManager({
      store: new FileConfigStore(pwConfFile),
      transport: new ExecTransport({
        rootDir: tmp,
        runtimeDir: pwRuntime,
        plinkCandidates: [],
        commandBuilder: passwordFileClientBuilder(fakeScript, pwFile)
      })
    })

    const pwStart = await pwManager.run('start', 'all')
    check('password-file client starts', pwStart.ok, pwStart.errors.join(' | '))
    const staged = await fs.readFile(pwFile, 'utf-8').catch(() => null)
    check('password staged for plink', staged === 's3cret', JSON.stringify(staged))
    const mode = (await fs.stat(pwFile)).mode & 0o777
    check(
      'staged password is owner-only where the OS supports it',
      process.platform === 'win32' || mode === 0o600,
      mode.toString(8)
    )
    check('stale password files are swept at startup', !(await exists(stalePasswordFile)))

    await pwManager.run('stop', 'all')
    check('staged password removed when the session ends', !(await exists(pwFile)))
  }

  // ----------------------------------- Part I: encrypted credential storage
  console.log('\n[I] encrypted credential storage (plaintext never hits the file)')
  {
    const secrets = new MemorySecretStore()
    const secretCfg =
      '[group:g]\nserver=s\nusername=u\npassword=hunter2\n[tunnel:g:t]\nlocal_port=1\nremote_host=h\nremote_port=2\n'
    const configFile = new MemoryConfigStore(secretCfg)
    const manager = new TunnelManager({
      store: configFile,
      transport: new FakeTransport(),
      secretStore: secrets
    })

    check('encryption availability is reported', manager.canEncryptSecrets())

    const loaded = await manager.reload()
    check(
      'plaintext password is available to the UI',
      loaded.groups[0]?.values.password === 'hunter2',
      JSON.stringify(loaded.groups[0]?.values)
    )

    await manager.saveConfig(loaded)
    const onDisk = await configFile.read()
    check(
      'secret moved into the secret store',
      secrets.entries.get('group:g') === 'hunter2',
      String(secrets.entries.get('group:g'))
    )
    check('no plaintext password in the stored config', !onDisk.includes('hunter2'), onDisk)
    check('stored config keeps a reference', onDisk.includes('password_ref=group:g'), onDisk)

    const reloaded = await manager.reload()
    check('secret is re-injected on reload', reloaded.groups[0]?.values.password === 'hunter2')

    const secretViews = await manager.list()
    check(
      'resolved tunnel receives the password',
      secretViews[0]?.values.password === 'hunter2',
      JSON.stringify(secretViews[0]?.values.password)
    )

    const exported = await manager.exportConfig()
    check(
      'export omits credentials entirely',
      !exported.includes('hunter2') && !exported.includes('password_ref'),
      exported
    )

    // Renaming a section migrates its secret instead of orphaning it.
    reloaded.groups[0]!.name = 'g2'
    reloaded.tunnels[0]!.group = 'g2'
    await manager.saveConfig(reloaded)
    check(
      'rename migrates the secret',
      secrets.entries.get('group:g2') === 'hunter2' && !secrets.entries.has('group:g'),
      JSON.stringify([...secrets.entries.keys()])
    )

    // Clearing the field drops both the reference and the stored secret.
    const afterRename = await manager.reload()
    afterRename.groups[0]!.values.password = ''
    await manager.saveConfig(afterRename)
    const cleared = await configFile.read()
    check(
      'cleared password removes the stored secret',
      !secrets.entries.has('group:g2') && !cleared.includes('password'),
      cleared
    )

    // Without a usable keyring the file keeps its plaintext: never pretend to
    // encrypt by moving a secret somewhere that is not actually protected.
    const plainFile = new MemoryConfigStore(secretCfg)
    const unavailable = new MemorySecretStore()
    unavailable.available = false
    const plainManager = new TunnelManager({
      store: plainFile,
      transport: new FakeTransport(),
      secretStore: unavailable
    })
    check('unavailable keyring is reported', !plainManager.canEncryptSecrets())
    await plainManager.saveConfig(await plainManager.reload())
    check(
      'no keyring -> plaintext kept as before',
      (await plainFile.read()).includes('password=hunter2'),
      await plainFile.read()
    )

    // The built-in template's placeholder is not a credential.
    const templateFile = new MemoryConfigStore()
    const templateManager = new TunnelManager({
      store: templateFile,
      transport: new FakeTransport(),
      secretStore: new MemorySecretStore()
    })
    await templateManager.saveConfig(await templateManager.reload())
    check(
      'template placeholder stays readable',
      (await templateFile.read()).includes('password=replace-with-password'),
      await templateFile.read()
    )
  }

  // default template config is valid
  const def = defaultConfig()
  check('default config has 2 tunnels', def.tunnels.length === 2, String(def.tunnels.length))
  check('default config resolves', resolveTunnels(def).length === 2)

  // ------------------------------- Part J: auto-reconnect + connection stats
  console.log('\n[J] auto-reconnect policy + connection stats')
  {
    const cfgWith = (extra: string): ConfigData =>
      parseConfig(
        `[group:g]\nserver=s\nusername=u\n${extra}\n` +
          '[tunnel:g:t]\nlocal_port=1001\nremote_host=h\nremote_port=2\n'
      )
    const boot = async (
      extra: string
    ): Promise<{ manager: TunnelManager; fake: FakeTransport }> => {
      const fake = new FakeTransport()
      const manager = new TunnelManager({
        store: new MemoryConfigStore(serializeConfig(cfgWith(extra))),
        transport: fake
      })
      await manager.run('start', 'all')
      return { manager, fake }
    }

    const { manager, fake } = await boot('restart_delay=0')
    const started = (await manager.list())[0]!
    check('a live session reports its start time', typeof started.startedAt === 'number')
    check('no reconnect before anything died', started.restarts === 0)

    fake.die('g/t')
    await manager.reconcile()
    await delay(60) // restart_delay=0 schedules on the next tick
    const reconnected = (await manager.list())[0]!
    check('a dropped tunnel is reconnected', reconnected.state === 'running', reconnected.state)
    check('the reconnect is counted', reconnected.restarts === 1, String(reconnected.restarts))
    check('reconnect refreshes the start time', reconnected.startedAt !== started.startedAt)

    // A user stop must never be undone, however the tunnel died.
    await manager.run('stop', 'all')
    fake.die('g/t')
    await manager.reconcile()
    await delay(60)
    check('a stopped tunnel stays stopped', (await manager.list())[0]!.state === 'stopped')

    // auto_restart=false opts out entirely.
    const off = await boot('restart_delay=0\nauto_restart=false')
    off.fake.die('g/t')
    await off.manager.reconcile()
    await delay(60)
    check('auto_restart=false is honoured', (await off.manager.list())[0]!.state === 'stopped')

    // The attempt budget is spent, not infinite: with limit=1 and a client that
    // cannot come back, the manager gives up instead of looping forever.
    const bounded = await boot('restart_delay=0\nrestart_limit=1')
    bounded.fake.failing.add('g/t')
    const attemptsBefore = bounded.fake.openAttempts
    bounded.fake.die('g/t')
    await bounded.manager.reconcile()
    await delay(60)
    check(
      'a failed reconnect spends the budget',
      (await bounded.manager.list())[0]!.state === 'stopped'
    )
    check(
      'one attempt is made for the first death',
      bounded.fake.openAttempts === attemptsBefore + 1,
      `${bounded.fake.openAttempts - attemptsBefore} attempts`
    )
    bounded.fake.die('g/t')
    await bounded.manager.reconcile()
    await delay(60)
    check(
      'the budget stops further attempts',
      bounded.fake.openAttempts === attemptsBefore + 1,
      `${bounded.fake.openAttempts - attemptsBefore} attempts`
    )
  }

  // ------------------------------- Part K: importing from other tools
  console.log('\n[K] import from other tools')
  {
    const current = parseConfig(
      '[group:keep]\nserver=existing\nusername=u\n' +
        '[tunnel:keep:t]\nlocal_port=1\nremote_host=h\nremote_port=2\n'
    )

    // A realistic OpenSSH snippet: two hosts sharing a pattern, one duplicate of an
    // existing group, and a key that has to survive quoting.
    const ssh = importSshConfig(
      [
        'Host keep',
        '  HostName existing-changed.example.com',
        '  User other',
        '',
        'Host web web-2',
        '  HostName web.example.com',
        '  User deploy',
        '  Port 2222',
        '  IdentityFile "C:\\keys\\my key"',
        '  ProxyJump bastion.example.com',
        '',
        'Host *',
        '  ServerAliveInterval 30'
      ].join('\n')
    )
    check('ssh import finds the host blocks', ssh.tunnels.length >= 3, String(ssh.tunnels.length))
    check(
      'ssh import warns about the glob block',
      ssh.warnings.length > 0,
      ssh.warnings.join(' | ')
    )

    const merged = mergeImport(current, ssh)
    check(
      'import does not overwrite an existing group',
      merged.config.groups.find((g) => g.name === 'keep')!.values.server === 'existing'
    )
    check('import adds new groups', merged.groups === 1, String(merged.groups))
    check(
      'the imported duplicate group is skipped, not merged',
      merged.config.groups.filter((g) => g.name === 'keep').length === 1
    )
    check('nothing was skipped on the first pass', merged.skipped === 0, String(merged.skipped))
    check(
      'every imported tunnel starts disabled',
      merged.config.tunnels
        .filter((t) => t.group !== 'keep')
        .every((t) => t.values.enabled === 'false')
    )
    check(
      'imported tunnels keep their created group',
      merged.config.tunnels.some((t) => t.group === 'web')
    )
    check(
      'the merged config still parses and serializes',
      parseConfig(serializeConfig(merged.config)).tunnels.length === merged.config.tunnels.length
    )
    check(
      'importing twice adds nothing more',
      mergeImport(merged.config, ssh).tunnels === 0 &&
        mergeImport(merged.config, ssh).skipped === ssh.tunnels.length
    )

    // PuTTY and mRemoteNG go through the same merge.
    const putty = importPuttyRegistry(
      'Windows Registry Editor Version 5.00\r\n\r\n' +
        '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\My%20Server]\r\n' +
        '"HostName"="putty.example.com"\r\n"UserName"="deploy"\r\n"PortNumber"=dword:00000016\r\n'
    )
    check('putty import produces a session', putty.groups.length === 1, String(putty.groups.length))
    check(
      'putty group carries the connection values',
      putty.groups[0]!.values.server === 'putty.example.com' &&
        putty.groups[0]!.values.server_port === '22'
    )
    check(
      'putty import merges into the same config',
      mergeImport(current, putty).config.groups.some((g) => g.values.server === 'putty.example.com')
    )

    const ng = importMRemoteNg(
      '<Connections><Node Name="Prod" Type="Container">' +
        '<Node Name="db" Hostname="db.example.com" Username="deploy" Port="2222" Protocol="SSH2"/>' +
        '<Node Name="rdp" Hostname="win.example.com" Protocol="RDP"/>' +
        '</Node></Connections>'
    )
    check(
      'mremoteng imports the ssh child only',
      ng.tunnels.length === 1,
      String(ng.tunnels.length)
    )
    check(
      'mremoteng reports the ignored protocol',
      ng.warnings.some((warning) => warning.includes('RDP')),
      ng.warnings.join(' | ')
    )
    check(
      'mremoteng warns that the ports are missing',
      ng.warnings.some((warning) => warning.includes('local_port')),
      ng.warnings.join(' | ')
    )
    check('mremoteng keeps the container as a group', ng.groups[0]?.name === 'Prod')
  }

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
