/**
 * Standalone smoke test for the tunnel engine (no Electron).
 * Run with:  node scripts/tunnel-smoke.ts
 * Covers: config parse/serialize/validate/merge, target resolution,
 * command building (plink + openssh), and full start/stop/restart lifecycle.
 */
import { promises as fs } from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { TunnelManager } from '../src/main/tunnel/manager'
import {
  parseConfig,
  serializeConfig,
  resolveTunnels,
  resolveTarget,
  defaultConfig
} from '../src/main/tunnel/config'

const __dirname = path.dirname(__filename)
const WORKSPACE = path.resolve(__dirname, '..')
const ORIGINAL_CONF = path.join(WORKSPACE, 'SSH-Tunnel-Manager', 'tunnel.conf')
const PLINK = path.join(WORKSPACE, 'SSH-Tunnel-Manager', 'plink.exe')

let failures = 0
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

async function main(): Promise<void> {
  // ---------------------------------------------------------------- Part A: config
  console.log('\n[A] config parse / merge / validate / serialize')
  const original = await fs.readFile(ORIGINAL_CONF, 'utf-8')
  const cfg = parseConfig(original)
  check('parses real tunnel.conf', true)
  check(
    'groups feishu + vpn',
    cfg.groups.map((g) => g.name).join(',') === 'feishu,vpn',
    JSON.stringify(cfg.groups.map((g) => g.name))
  )
  check(
    'tunnels count = 6',
    cfg.tunnels.length === 6,
    `got ${cfg.tunnels.length}: ${cfg.tunnels.map((t) => t.key).join(',')}`
  )
  const feishu = cfg.groups.find((g) => g.name === 'feishu')!
  check('group feishu has server', feishu.values.server === '121.43.50.18')
  check('group feishu keeps password', feishu.values.password.length > 10)

  const tunnels = resolveTunnels(cfg)
  check('resolveTunnels ok', tunnels.length === 6)
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

  // target resolution
  check('target all', resolveTarget(tunnels, 'all', false).length === 6)
  check('target group', resolveTarget(tunnels, 'feishu', false).length === 5)
  check('target exact', resolveTarget(tunnels, 'feishu/1Panel', false).length === 1)
  check(
    'target exact case-insensitive',
    resolveTarget(tunnels, 'FEISHU/1PANEL', false).length === 1
  )
  check('target all enabled-only', resolveTarget(tunnels, 'all', true).length === 6)
  throws(
    'unknown target rejected',
    () => resolveTarget(tunnels, 'nope', false),
    /unknown group or tunnel/
  )

  // ---------------------------------------------------------------- Part B: commands
  console.log('\n[B] client resolution + command building')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnel-smoke-'))
  const confFile = path.join(tmp, 'tunnel.conf')
  await fs.writeFile(confFile, original, 'utf-8')
  const manager = new TunnelManager({
    configPath: confFile,
    rootDir: WORKSPACE,
    runtimeDir: path.join(tmp, '.tunnel'),
    plinkCandidates: [PLINK]
  })

  const plinkUsed = await fs
    .access(PLINK)
    .then(() => true)
    .catch(() => false)
  const items = await manager.validate('all')
  check('validate all runs', items.length === 6)
  for (const item of items) {
    check(`validate ${item.key} ok`, item.ok, item.message)
  }
  if (plinkUsed) {
    const plinkCmd = (await manager.validate('feishu/1Panel'))[0]!
    check(
      'plink command contains -pw',
      plinkCmd.command?.includes('-pw') === true,
      plinkCmd.command
    )
    check('plink command masks password', !/K4j5/.test(plinkCmd.command ?? ''), plinkCmd.command)
    check(
      'plink command contains -hostkey',
      plinkCmd.command?.includes('SHA256:') === true,
      plinkCmd.command
    )
  }

  // openssh command shape via a fake non-plink client file
  const fakeSsh = path.join(tmp, 'fake-ssh.bin')
  await fs.writeFile(fakeSsh, '', 'utf-8')
  const forced = parseConfig(
    `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\nlocal_port=8080\nremote_host=127.0.0.1\nremote_port=80\nprivate_key=~/.ssh/id_ed25519\nclient=${fakeSsh.replace(/\\/g, '/')}\n`
  )
  const forcedConfFile = path.join(tmp, 'forced.conf')
  await fs.writeFile(forcedConfFile, serializeConfig(forced), 'utf-8')
  const forcedManager = new TunnelManager({
    configPath: forcedConfFile,
    rootDir: tmp,
    runtimeDir: path.join(tmp, '.tunnel3'),
    plinkCandidates: []
  })
  const opensshItem = (await forcedManager.validate('all'))[0]!
  check('openssh command built', opensshItem.ok, opensshItem.message)
  check('openssh -i flag', opensshItem.command?.includes('-i') === true, opensshItem.command)
  check(
    'openssh StrictHostKeyChecking',
    opensshItem.command?.includes('StrictHostKeyChecking=') === true,
    opensshItem.command
  )
  check(
    'openssh user@server',
    opensshItem.command?.includes('alice@srv.example.com') === true,
    opensshItem.command
  )

  // ---------------------------------------------------------------- Part C: lifecycle
  console.log('\n[C] start / status / stop / restart lifecycle')
  const fakeScript = path.join(tmp, 'fake-ssh.cjs')
  await fs.writeFile(
    fakeScript,
    `const net=require('net');
const port=Number(process.argv.find(a=>a.startsWith('--port=')).split('=')[1]);
const srv=net.createServer(()=>{});
srv.listen(port,'127.0.0.1',()=>console.log('fake ssh listening on '+port));
process.on('SIGTERM',()=>{srv.close(()=>process.exit(0));});
setInterval(()=>{},1000);\n`,
    'utf-8'
  )
  const freePort = await getFreePort()
  const lifeCfg = parseConfig(
    `[tunnel:g:t]\nserver=srv.example.com\nusername=alice\nlocal_port=${freePort}\nremote_host=127.0.0.1\nremote_port=80\nclient=${fakeScript.replace(/\\/g, '/')}\n`
  )
  const lifeConfFile = path.join(tmp, 'life.conf')
  await fs.writeFile(lifeConfFile, serializeConfig(lifeCfg), 'utf-8')
  const life = new TunnelManager({
    configPath: lifeConfFile,
    rootDir: tmp,
    runtimeDir: path.join(tmp, '.tunnel4'),
    plinkCandidates: []
  })
  // Override command building so the "ssh client" is node running our fake script.
  life.buildCommand = ((t: never) => {
    const port = Number(t.values.local_port)
    return {
      cmd: [process.execPath, fakeScript, `--port=${port}`],
      kind: 'openssh',
      exe: process.execPath
    }
  }) as never

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

  const restartRes = await life.run('restart', 'all')
  check('restart succeeds', restartRes.ok, restartRes.errors.join(' | '))
  views = await life.list()
  check('running again after restart', views[0]?.state === 'running', JSON.stringify(views[0]))
  await life.run('stop', 'all')

  // port in use -> start failure
  const usedPort = await getFreePort()
  const blocker = await new Promise<net.Server>((resolve) => {
    const srv = net.createServer(() => undefined)
    srv.listen(usedPort, '127.0.0.1', () => resolve(srv))
  })
  const busyCfg = parseConfig(
    `[tunnel:g:b]\nserver=srv.example.com\nusername=alice\nlocal_port=${usedPort}\nremote_host=127.0.0.1\nremote_port=80\nclient=${fakeScript.replace(/\\/g, '/')}\n`
  )
  const busyConfFile = path.join(tmp, 'busy.conf')
  await fs.writeFile(busyConfFile, serializeConfig(busyCfg), 'utf-8')
  const busy = new TunnelManager({
    configPath: busyConfFile,
    rootDir: tmp,
    runtimeDir: path.join(tmp, '.tunnel5'),
    plinkCandidates: []
  })
  busy.buildCommand = life.buildCommand
  const busyRes = await busy.run('start', 'all')
  check('start fails when port in use', !busyRes.ok, JSON.stringify(busyRes))
  check(
    'port in use message',
    busyRes.errors.some((e) => e.includes('in use')),
    busyRes.errors.join(' | ')
  )
  blocker.close()

  // default template config is valid
  const def = defaultConfig()
  check('default config has 2 tunnels', def.tunnels.length === 2, String(def.tunnels.length))
  check('default config resolves', resolveTunnels(def).length === 2)

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
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

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
