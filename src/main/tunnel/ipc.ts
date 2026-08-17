/**
 * IPC surface for the tunnel manager.
 * All handlers are async `ipcMain.handle` channels; errors are thrown and
 * propagate to the renderer as rejected promises with a readable message.
 */
import { app, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import * as path from 'path'
import type { ConfigData } from './types'
import { TunnelManager } from './manager'
import { defaultConfig, serializeConfig } from './config'

interface Settings {
  configPath?: string
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf-8')) as Settings
  } catch {
    return {}
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
}

function plinkCandidates(): string[] {
  const userData = app.getPath('userData')
  const appRoot = app.getAppPath()
  return [
    path.join(process.resourcesPath, 'plink.exe'), // packaged: extraResources
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'plink.exe'), // packaged: asarUnpack
    path.join(appRoot, 'resources', 'plink.exe'), // dev
    path.join(userData, 'plink.exe') // user-provided override
  ]
}

export function createManager(): TunnelManager {
  const userData = app.getPath('userData')
  const runtimeDir = path.join(userData, '.tunnel')
  const appRoot = app.getAppPath()
  return new TunnelManager({
    configPath: path.join(userData, 'tunnel.conf'),
    rootDir: appRoot,
    runtimeDir,
    plinkCandidates: plinkCandidates()
  })
}

export async function registerIpc(manager: TunnelManager): Promise<void> {
  // Apply the persisted config path (if any) before serving requests.
  const settings = await loadSettings()
  if (settings.configPath) {
    try {
      await manager.setConfigPath(settings.configPath)
    } catch {
      /* keep default path on failure */
    }
  } else {
    await manager.ensureConfigFile()
  }

  ipcMain.handle('tunnel:list', () => manager.list())
  ipcMain.handle('tunnel:start', (_event, target: string) => manager.run('start', target))
  ipcMain.handle('tunnel:stop', (_event, target: string) => manager.run('stop', target))
  ipcMain.handle('tunnel:restart', (_event, target: string) => manager.run('restart', target))
  ipcMain.handle('tunnel:validate', (_event, target: string) => manager.validate(target))
  ipcMain.handle('tunnel:logs', (_event, target: string, lines?: number) =>
    manager.logs(target, Math.max(10, Math.min(2000, lines ?? 200)))
  )

  ipcMain.handle('config:get', () => manager.getConfig())
  ipcMain.handle('config:save', (_event, cfg: ConfigData) => manager.saveConfig(cfg))
  ipcMain.handle('config:reload', () => manager.reload())
  ipcMain.handle('config:path:get', () => ({ path: manager.getConfigPath() }))
  ipcMain.handle('config:path:set', async (_event, nextPath: string) => {
    if (typeof nextPath !== 'string' || !nextPath.trim()) throw new Error('invalid config path')
    const resolved = path.resolve(nextPath.trim())
    await manager.setConfigPath(resolved)
    await saveSettings({ configPath: resolved })
    return manager.getConfig()
  })
  ipcMain.handle('config:open', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择配置文件',
      properties: ['openFile', 'createDirectory'],
      filters: [
        { name: '隧道配置', extensions: ['conf', 'ini', 'txt', 'cfg'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]!
    await manager.setConfigPath(chosen)
    await saveSettings({ configPath: chosen })
    return { path: chosen, config: await manager.getConfig() }
  })
  ipcMain.handle('config:save-as', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出配置',
      defaultPath: path.join(app.getPath('documents'), 'tunnel.conf'),
      filters: [{ name: '隧道配置', extensions: ['conf'] }]
    })
    if (result.canceled || !result.filePath) return null
    const cfg = await manager.getConfig()
    await fs.writeFile(result.filePath, serializeConfig(cfg), 'utf-8')
    return { path: result.filePath }
  })
  ipcMain.handle('config:reveal', async () => {
    const cfgPath = manager.getConfigPath()
    await manager.ensureConfigFile()
    shell.showItemInFolder(cfgPath)
    return { path: cfgPath }
  })
  ipcMain.handle('config:reset', async () => {
    // Re-write the default template and reload it.
    const cfg = defaultConfig()
    await manager.saveConfig(cfg)
    return cfg
  })

  ipcMain.handle('app:info', async () => {
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
      configPath: manager.getConfigPath(),
      runtimeDir: path.join(app.getPath('userData'), '.tunnel')
    }
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
