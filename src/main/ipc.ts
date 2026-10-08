/**
 * Electron IPC surface for the tunnel manager.
 *
 * All handlers are async `ipcMain.handle` channels; errors are thrown and
 * propagate to the renderer as rejected promises with a readable message.
 * This file is the desktop-specific wiring only: it builds the Node platform
 * (file-backed config + external ssh/plink transport) and exposes the shared
 * `TunnelManager` over IPC.
 *
 * Channel names and their argument/result types come from `src/shared/contract.ts`,
 * so the shell and the preload bridge cannot disagree about either.
 */
import { app, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import * as path from 'path'
import type { TunnelManager } from '../core/manager'
import { defaultConfig } from '../core/config'
import { createTunnelManager, FileConfigStore } from '../platforms/node'
import { CHANNELS, type IpcArgs, type IpcChannel, type IpcResult } from '../shared/contract'
import { assertConfigPayload, assertTarget, assertUiPrefsPatch } from './ipc-guard'
import { loadSettings, patchSettings, resolveUiPrefs } from './settings'
import { importConfigFromFile } from './config-import'
import { ElectronSecretStore } from './secret-store'
import type { StatusBroadcaster } from './status'

/**
 * `ipcMain.handle` with the contract's argument and result types attached: the
 * handler signature is checked against the channel it is registered for.
 */
function handle<K extends IpcChannel>(
  channel: K,
  handler: (...args: IpcArgs<K>) => IpcResult<K> | Promise<IpcResult<K>>
): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...(args as IpcArgs<K>)))
}

/**
 * plink copies that ship with the app, so their version is known to support
 * `-pwfile` (PuTTY 0.77+).
 */
function shippedPlinkPaths(): string[] {
  return [
    path.join(process.resourcesPath, 'plink.exe'), // packaged: extraResources
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'plink.exe'), // packaged: asarUnpack
    path.join(app.getAppPath(), 'resources', 'plink.exe') // dev
  ]
}

/** Every place a plink may be found; user-supplied copies may be older. */
function plinkCandidates(): string[] {
  return [...shippedPlinkPaths(), path.join(app.getPath('userData'), 'plink.exe')]
}

/**
 * Config files the renderer may switch to. The only sanctioned ways in are
 * `config:open` (a native dialog the user drives) and the path we persisted in
 * `settings.json` ourselves. Without this, a compromised renderer could point
 * the app at any readable file and read it back through parse error messages.
 */
const authorizedConfigPaths = new Set<string>()

function authorizeConfigPath(candidate: string): string {
  const resolved = path.resolve(candidate)
  authorizedConfigPaths.add(resolved)
  return resolved
}

function clampLines(value: unknown): number {
  const lines = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 200
  return Math.max(10, Math.min(2000, lines))
}

export function createManager(): TunnelManager {
  const userData = app.getPath('userData')
  const appRoot = app.getAppPath()
  return createTunnelManager({
    configPath: path.join(userData, 'tunnel.conf'),
    // In packaged builds app.getAppPath() is the app.asar FILE, which cannot be
    // used as a working directory (spawn would fail with ENOENT) or as a base
    // for relative paths. Use the real directory containing the asar instead.
    rootDir: app.isPackaged ? path.dirname(appRoot) : appRoot,
    runtimeDir: path.join(userData, '.tunnel'),
    plinkCandidates: plinkCandidates(),
    shippedPlinkPaths: shippedPlinkPaths(),
    // Passwords are kept out of tunnel.conf whenever the OS can protect them.
    secretStore: new ElectronSecretStore(path.join(userData, 'secrets.json'))
  })
}

export async function registerIpc(
  manager: TunnelManager,
  status: StatusBroadcaster
): Promise<void> {
  /** Mutations push the new projection instead of waiting for the next tick. */
  const announce = (): void => void status.push(true)

  // The default config location is always switchable.
  authorizeConfigPath(manager.getConfigPath())

  // Apply the persisted config path (if any) before serving requests.
  const settings = await loadSettings()
  if (settings.configPath) {
    // We wrote this path ourselves, so it is authorised by construction.
    const persisted = authorizeConfigPath(settings.configPath)
    try {
      await manager.useStore(new FileConfigStore(persisted))
    } catch {
      /* keep default path on failure */
    }
  } else {
    await manager.ensureConfigFile()
  }

  handle(CHANNELS.tunnelList, () => manager.list())
  handle(CHANNELS.tunnelStart, async (target) => {
    const result = await manager.run('start', assertTarget(target))
    announce()
    return result
  })
  handle(CHANNELS.tunnelStop, async (target) => {
    const result = await manager.run('stop', assertTarget(target))
    announce()
    return result
  })
  handle(CHANNELS.tunnelRestart, async (target) => {
    const result = await manager.run('restart', assertTarget(target))
    announce()
    return result
  })
  handle(CHANNELS.tunnelValidate, (target) => manager.validate(assertTarget(target)))
  handle(CHANNELS.tunnelLogs, (target, lines) =>
    manager.logs(assertTarget(target), clampLines(lines))
  )

  handle(CHANNELS.configGet, () => manager.getConfig())
  handle(CHANNELS.configSave, async (cfg) => {
    const next = await manager.saveConfig(assertConfigPayload(cfg))
    announce()
    return next
  })
  handle(CHANNELS.configReload, async () => {
    const next = await manager.reload()
    announce()
    return next
  })
  handle(CHANNELS.configPathGet, () => ({ path: manager.getConfigPath() }))
  handle(CHANNELS.configPathSet, async (nextPath) => {
    if (typeof nextPath !== 'string' || !nextPath.trim()) throw new Error('invalid config path')
    const resolved = path.resolve(nextPath.trim())
    if (!authorizedConfigPaths.has(resolved)) {
      throw new Error('config path is not authorized')
    }
    await manager.useStore(new FileConfigStore(resolved))
    await patchSettings({ configPath: resolved })
    announce()
    return manager.getConfig()
  })
  handle(CHANNELS.configOpen, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择配置文件',
      properties: ['openFile', 'createDirectory'],
      filters: [
        { name: '隧道配置', extensions: ['conf', 'ini', 'txt', 'cfg'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = authorizeConfigPath(result.filePaths[0]!)
    await manager.useStore(new FileConfigStore(chosen))
    await patchSettings({ configPath: chosen })
    announce()
    return { path: chosen, config: await manager.getConfig() }
  })
  handle(CHANNELS.configImport, () => importConfigFromFile(manager))
  handle(CHANNELS.configSaveAs, async () => {
    const result = await dialog.showSaveDialog({
      // Credentials never leave the encrypted store, so say so up front.
      title: '导出配置（不含密码）',
      defaultPath: path.join(app.getPath('documents'), 'tunnel.conf'),
      filters: [{ name: '隧道配置', extensions: ['conf'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, await manager.exportConfig(), 'utf-8')
    return { path: result.filePath }
  })
  handle(CHANNELS.configReveal, async () => {
    const cfgPath = manager.getConfigPath()
    await manager.ensureConfigFile()
    shell.showItemInFolder(cfgPath)
    return { path: cfgPath }
  })
  handle(CHANNELS.configReset, async () => {
    // Re-write the default template and reload it.
    const cfg = defaultConfig()
    await manager.saveConfig(cfg)
    announce()
    return cfg
  })

  handle(CHANNELS.appInfo, async () => {
    const sshPath = await findOnPathFirst('ssh')
    const plinkPath =
      (await findOnPathFirst('plink')) ?? plinkCandidates().find((p) => existsSync(p)) ?? null
    return {
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome
      },
      sshPath,
      plinkPath,
      secretsEncrypted: manager.canEncryptSecrets(),
      configPath: manager.getConfigPath(),
      runtimeDir: path.join(app.getPath('userData'), '.tunnel')
    }
  })

  // ── 顶部工具栏的显示偏好（右上角作者信息 / GitHub 项目链接）──────────────
  // 默认值在 `settings.ts`：作者信息默认关闭，GitHub 链接默认开启。
  handle(CHANNELS.uiPrefsGet, async () => resolveUiPrefs(await loadSettings()))
  handle(CHANNELS.uiPrefsPatch, async (patch) => {
    // 只接受白名单里的布尔字段，其余内容不会落到 settings.json。
    const stored = await patchSettings(assertUiPrefsPatch(patch))
    return resolveUiPrefs(stored)
  })
}

async function findOnPathFirst(name: string): Promise<string | null> {
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
