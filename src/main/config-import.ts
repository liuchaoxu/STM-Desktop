/**
 * "Import from another tool" — the shell half.
 *
 * The parsers themselves are pure text → sections transforms in
 * `src/core/importers.ts`; this module owns everything that needs the OS: picking a
 * file, reading it in whichever encoding the source tool used, asking for
 * confirmation, and merging into the config the renderer holds as a *draft*.
 * Nothing is written to disk here — the user reviews the imported tunnels (their
 * ports are always missing, because none of these formats describes a local
 * forward) and saves when they are happy.
 */
import { dialog } from 'electron'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  importMRemoteNg,
  importPuttyRegistry,
  importSshConfig,
  type ImportResult
} from '../core/importers'
import { mergeImport } from '../core/import-merge'
import type { TunnelManager } from '../core/manager'
import type { ConfigImportResult } from '../shared/contract'

interface Parser {
  source: string
  parse: (text: string) => ImportResult
}

/**
 * Which parser a file belongs to.
 *
 * Extension first (that is what a user recognises), then a content sniff for the
 * two formats that are trivially recognisable — a `.reg` export saved as `.txt` and
 * an mRemoteNG export named anything at all are both common.
 */
function pickParser(filePath: string, text: string): Parser {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.reg') return { source: 'PuTTY 会话导出', parse: importPuttyRegistry }
  if (ext === '.xml') return { source: 'mRemoteNG', parse: importMRemoteNg }
  if (/^\s*Windows Registry Editor/i.test(text)) {
    return { source: 'PuTTY 会话导出', parse: importPuttyRegistry }
  }
  if (/<Connections[\s>]|<Node[\s>]/i.test(text)) {
    return { source: 'mRemoteNG', parse: importMRemoteNg }
  }
  return { source: 'OpenSSH 配置', parse: importSshConfig }
}

/** A `.reg` export is UTF-16LE; everything else here is UTF-8 (BOM or not). */
function decode(buffer: Buffer): string {
  if (buffer.length > 1 && buffer[1] === 0) return buffer.toString('utf16le')
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * Pick a foreign config file, parse it, confirm, and return the merged draft.
 *
 * The merge itself lives in `src/core/import-merge.ts` (pure, and covered by the
 * smoke test); this function is only the part that needs dialogs and the disk.
 */
export async function importConfigFromFile(
  manager: TunnelManager
): Promise<ConfigImportResult | null> {
  const picked = await dialog.showOpenDialog({
    title: '导入其它工具的配置',
    // The OpenSSH config is the most common source by far.
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile'],
    filters: [
      { name: '支持的格式', extensions: ['config', 'conf', 'reg', 'xml', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return null
  const file = picked.filePaths[0]!

  const text = decode(await fs.readFile(file))
  const parser = pickParser(file, text)
  const parsed = parser.parse(text)
  if (parsed.groups.length === 0 && parsed.tunnels.length === 0) {
    const why = parsed.warnings[0] ? `：${parsed.warnings[0]}` : ''
    throw new Error(`未能从该文件解析出任何隧道（识别为${parser.source}）${why}`)
  }

  const merged = mergeImport(await manager.getConfig(), parsed)

  const detail = [
    `新增 ${merged.groups} 个组、${merged.tunnels} 条隧道` +
      (merged.skipped > 0 ? `，跳过 ${merged.skipped} 条已存在的隧道` : ''),
    '导入的隧道默认停用，且需要你补全本地/远端端口。',
    parsed.warnings.length > 0 ? `\n注意：\n· ${parsed.warnings.slice(0, 8).join('\n· ')}` : ''
  ].join('\n')

  const confirm = await dialog.showMessageBox({
    type: 'question',
    buttons: ['导入', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '确认导入',
    message: `识别为${parser.source}`,
    detail
  })
  if (confirm.response !== 0) return null

  return {
    source: parser.source,
    groups: merged.groups,
    tunnels: merged.tunnels,
    skipped: merged.skipped,
    warnings: parsed.warnings,
    config: merged.config
  }
}
