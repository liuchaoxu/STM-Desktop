/**
 * Migrating users in from other SSH clients, platform agnostic.
 *
 * Each importer converts a foreign file format into this project's config
 * sections (`GroupConfig` / `TunnelDef`), so a user moving off OpenSSH, PuTTY
 * or mRemoteNG does not have to retype every host.
 *
 * The conversion is deliberately incomplete in two places:
 *
 *   - port forwards are never invented. A tunnel without `local_port` /
 *     `remote_port` fails validation instead of silently proxying somewhere the
 *     user did not ask for, so every imported tunnel gets a warning and
 *     `enabled=false` — nothing starts before the user has reviewed it;
 *   - anything this app cannot represent (glob hosts, `LocalForward`, RDP
 *     sessions, encrypted blobs) is skipped *with a warning* rather than
 *     dropped silently, because a migration that quietly loses entries is
 *     worse than one that asks the user to redo them.
 *
 * None of these functions throw: they run against files written by third-party
 * tools, so unparsable input yields empty sections plus a warning.
 */
import type { GroupConfig, TunnelDef } from './types'

export interface ImportResult {
  groups: GroupConfig[]
  tunnels: TunnelDef[]
  warnings: string[]
}

// ------------------------------------------------------------------ shared

/**
 * Normalizes foreign text before parsing: a UTF-8 BOM would otherwise become
 * part of the first section header or first key, lone CRs appear in files that
 * were edited on more than one platform, and a `.reg` file decoded from UTF-16
 * leaves a NUL after every character.
 */
function toLines(text: string): string[] {
  // `split`/`join` rather than a regex: a control character in a character
  // class trips `no-control-regex`, and this is not a pattern anyway.
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
}

/**
 * Names end up inside `tunnel:<group>:<name>` section headers, so a newline or
 * a colon coming from a foreign file would produce a config that cannot be read
 * back. `sanitizeName` makes a name printable, `isValidName` decides whether it
 * is usable at all.
 */
function sanitizeName(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim()
}

function isValidName(raw: string): boolean {
  const name = sanitizeName(raw)
  return name.length > 0 && !/[:[\]\r\n]/.test(name)
}

/** Warns about (and drops) a name that cannot be represented as a section. */
function acceptName(raw: string, kind: string, warnings: string[]): string | null {
  const name = sanitizeName(raw)
  if (!name) {
    warnings.push(`跳过了一个没有名字的${kind}。`)
    return null
  }
  if (!isValidName(name)) {
    warnings.push(`名称 "${name}" 含有 [ ] : 等无法写入配置文件的字符，已跳过该${kind}。`)
    return null
  }
  return name
}

/**
 * Ports are free text in every foreign format, while this app validates them as
 * numbers. Returning null lets the caller drop the key so the port falls back to
 * the shared default (22) instead of carrying a value that invalidates the whole
 * config.
 */
function parsePortValue(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? String(port) : null
}

/**
 * Collects groups and tunnels, keeping the first occurrence of a name and
 * warning about the rest. Two tunnels with the same group+name make the saved
 * config invalid (`validateConfig` rejects duplicates), and this is the only
 * place where that decision can still be explained to the user.
 */
class ImportCollector {
  readonly groups: GroupConfig[] = []
  readonly tunnels: TunnelDef[] = []
  readonly warnings: string[] = []

  private readonly groupIds = new Set<string>()
  private readonly tunnelIds = new Set<string>()

  hasGroup(name: string): boolean {
    return this.groupIds.has(name.toLowerCase())
  }

  /** @returns true when the group was added, false when it already existed. */
  addGroup(name: string, values: Record<string, string>): boolean {
    const id = name.toLowerCase()
    if (this.groupIds.has(id)) {
      this.warnings.push(`导入的组 "${name}" 重复，已保留第一个。`)
      return false
    }
    this.groupIds.add(id)
    this.groups.push({ name, values })
    return true
  }

  /** @returns true when the tunnel was added, false when it was a duplicate. */
  addTunnel(group: string, name: string, values: Record<string, string>): boolean {
    const id = `${group}\u0000${name}`.toLowerCase()
    if (this.tunnelIds.has(id)) {
      this.warnings.push(`导入的隧道 "${group}/${name}" 重复，已保留第一个。`)
      return false
    }
    this.tunnelIds.add(id)
    this.tunnels.push({ group, name, values })
    return true
  }

  finish(): ImportResult {
    return { groups: this.groups, tunnels: this.tunnels, warnings: this.warnings }
  }
}

/** Shared tail of every importer: unusable input is a warning, never an error. */
function failedImport(reason: string, prefix = '导入失败'): ImportResult {
  return { groups: [], tunnels: [], warnings: [`${prefix}：${reason}，本次未导入任何内容。`] }
}

/**
 * Imported tunnels carry no ports, so they cannot be enabled yet. This is the
 * one warning every single tunnel gets.
 */
function warnMissingPorts(collector: ImportCollector, group: string, name: string): void {
  collector.warnings.push(
    `隧道 "${group}/${name}" 已导入但缺少本地/远端端口，已自动停用；` +
      `请在配置编辑器中填写本地端口(local_port)、远端主机(remote_host)与远端端口(remote_port)后再启用。`
  )
}

// ----------------------------------------------------------- OpenSSH config

/** Keys carried over from `~/.ssh/config`; anything else is reported as skipped. */
const SSH_KEY_MAP: Record<string, string> = {
  hostname: 'server',
  user: 'username',
  port: 'server_port',
  identityfile: 'private_key',
  proxyjump: 'proxy_jump'
}

/** `*`, `?`, `!` and character classes make a Host token a pattern, not an alias. */
function isSshPattern(token: string): boolean {
  return /[*?[\]!]/.test(token)
}

/**
 * Splits a config line into tokens, honouring double quotes — ssh_config's own
 * quoting rules are "double quotes only", so that is all this handles.
 */
function splitSshTokens(line: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]!)
  }
  return tokens
}

function unquoteSshValue(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/** One accumulated `Host` block, flushed when the next `Host` line appears. */
interface SshBlock {
  /** First alias of the block — the name of the imported group. */
  aliases: string[]
  values: Record<string, string>
  /** Host tokens that looked like patterns and were skipped. */
  droppedPatterns: string[]
  /** Keys this app has no equivalent for, e.g. `LocalForward` (reported once). */
  skippedKeys: string[]
  /** 1-based line of the `Host` line, for warning text. */
  line: number
}

/** OpenSSH `~/.ssh/config` text. */
export function importSshConfig(text: string): ImportResult {
  const collector = new ImportCollector()
  const lines = toLines(text)

  let sawContent = false
  let current: SshBlock | null = null

  const flush = (block: SshBlock): void => {
    for (const token of block.droppedPatterns) {
      collector.warnings.push(
        `第 ${block.line} 行的 Host 模式 "${token}" 是通配/否定模式，无法映射为单个隧道，已跳过。`
      )
    }
    for (const key of block.skippedKeys) {
      collector.warnings.push(
        `第 ${block.line} 行的 Host 块中未支持 ${key}，该项已跳过（如需要请手动配置）。`
      )
    }

    const aliases: string[] = []
    for (const alias of block.aliases) {
      if (aliases.some((seen) => seen.toLowerCase() === alias.toLowerCase())) {
        collector.warnings.push(
          `第 ${block.line} 行的 Host 块中别名 "${alias}" 重复，已保留第一个。`
        )
        continue
      }
      aliases.push(alias)
    }
    if (aliases.length === 0) return

    const firstAlias = aliases.find((alias) => isValidName(alias))
    if (firstAlias === undefined) {
      collector.warnings.push(`第 ${block.line} 行的 Host 块没有可用的别名，已跳过。`)
      return
    }
    const groupName = acceptName(firstAlias, '组', collector.warnings)
    if (groupName === null) return

    // The connection values live on the group and every alias becomes a port
    // forward inside it, which is exactly the hand-written config layout.
    if (!collector.addGroup(groupName, { ...block.values })) return
    for (const alias of aliases) {
      const tunnelName = acceptName(alias, '隧道', collector.warnings)
      if (tunnelName === null) continue
      if (collector.addTunnel(groupName, tunnelName, { enabled: 'false' })) {
        warnMissingPorts(collector, groupName, tunnelName)
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    // `#` may be part of a value (a path, a jump host), so only a `#` starting a
    // line or preceded by whitespace opens a comment.
    const line = lines[i]!.replace(/(^|\s)#.*$/, '$1').trim()
    if (!line) continue
    sawContent = true

    const tokens = splitSshTokens(line)
    const keyword = tokens[0]!.toLowerCase()
    const rawValue = line.slice(tokens[0]!.length).trim()

    if (keyword === 'host') {
      // A new Host line always terminates the previous block, even when the new
      // block turns out to be unusable.
      if (current) flush(current)
      const block: SshBlock = {
        aliases: [],
        values: {},
        droppedPatterns: [],
        skippedKeys: [],
        line: lineNumber
      }
      for (const token of tokens.slice(1)) {
        if (isSshPattern(token)) block.droppedPatterns.push(token)
        else block.aliases.push(token)
      }
      current = block
      continue
    }

    if (!current) {
      collector.warnings.push(`第 ${lineNumber} 行的 ${tokens[0]} 位于任何 Host 块之外，已跳过。`)
      continue
    }

    if (keyword === 'include') {
      collector.warnings.push(
        `第 ${lineNumber} 行使用了 Include（引用其它文件），本工具无法读取被引用的文件，已跳过：${rawValue}`
      )
      continue
    }
    if (keyword === 'match') {
      collector.warnings.push(
        `第 ${lineNumber} 行使用了 Match 条件块，本工具不支持条件匹配，其后的配置可能被忽略。`
      )
      continue
    }

    const mapped = SSH_KEY_MAP[keyword]
    if (!mapped) {
      // Collecting once per block keeps a long "Host *" block from producing one
      // warning per line.
      if (!current.skippedKeys.includes(tokens[0]!)) current.skippedKeys.push(tokens[0]!)
      continue
    }

    const value = unquoteSshValue(rawValue)
    if (!value) {
      collector.warnings.push(`第 ${lineNumber} 行的 ${tokens[0]} 没有取值，已跳过。`)
      continue
    }
    if (mapped === 'server_port') {
      const port = parsePortValue(value)
      if (port === null) {
        collector.warnings.push(
          `第 ${lineNumber} 行的 Port 值 "${value}" 不是 1-65535 的端口，已忽略（将使用默认端口）。`
        )
        continue
      }
      current.values[mapped] = port
      continue
    }
    current.values[mapped] = value
  }
  if (current) flush(current)

  if (!sawContent) return failedImport('文件内容为空', '无法导入 OpenSSH 配置')
  if (collector.tunnels.length === 0) {
    collector.warnings.push('导入完成：文件中没有找到可导入的 Host 块。')
  }
  return collector.finish()
}

// --------------------------------------------------------- PuTTY registry

const PUTTY_SESSION_PREFIX = 'hkey_current_user\\software\\simontatham\\putty\\sessions\\'
/** PuTTY's own template session; it is never a real connection. */
const PUTTY_DEFAULT_SESSION = 'default settings'

/** Session names come from a registry key path, so they are percent-encoded. */
function decodeSessionName(raw: string): string {
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    // Not valid percent-encoding (a literal `%`, a stray escape): keep the raw
    // text instead of losing the session.
  }
  // PuTTY itself writes `+` for a space in some versions.
  return name.replace(/\+/g, ' ') || raw
}

/** Parses a `.reg` string value: `"C:\\keys\\id_rsa.ppk"` -> `C:\keys\id_rsa.ppk`. */
function parseRegString(raw: string): string | null {
  const value = raw.trim()
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null
  let out = ''
  for (let i = 1; i < value.length - 1; i++) {
    const ch = value[i]!
    // In .reg files the backslash is the escape character for both `\` and `"`.
    if (ch === '\\' && i + 1 < value.length - 1) {
      i++
      out += value[i]!
    } else {
      out += ch
    }
  }
  return out
}

/** Value name -> config key; everything else in a session is ignored. */
const PUTTY_VALUE_MAP: Record<string, string> = {
  hostname: 'server',
  username: 'username',
  publickeyfile: 'private_key'
}

/** PuTTY session export, i.e. the text of a `.reg` file. */
export function importPuttyRegistry(text: string): ImportResult {
  const collector = new ImportCollector()
  const lines = toLines(text)

  /** Group of the session being read; its values go straight into it. */
  let currentGroup: GroupConfig | null = null
  let sawContent = false

  /**
   * Opens the group for a session as soon as its `[Sessions\<name>]` line is
   * seen: the values that follow are written into that group, so it has to
   * exist before they are read.
   *
   * @returns the group, or null when the session is not worth importing.
   */
  const beginSession = (session: string): GroupConfig | null => {
    // "Default Settings" is PuTTY's template, not a connection.
    if (session.trim().toLowerCase() === PUTTY_DEFAULT_SESSION) {
      collector.warnings.push('已跳过 PuTTY 的默认会话 "Default Settings"。')
      return null
    }
    const groupName = acceptName(session, '组', collector.warnings)
    if (groupName === null) return null
    // Every session is driven through Plink on Windows, which is what the app
    // ships; the user can switch it back to "auto" in the editor.
    const group: GroupConfig = { name: groupName, values: { client: 'plink.exe' } }
    return collector.addGroup(group.name, group.values) ? group : null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (/^Windows Registry Editor/i.test(line)) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      currentGroup = null
      const key = line.slice(1, -1).trim()
      if (!key.toLowerCase().startsWith(PUTTY_SESSION_PREFIX)) continue
      // Only direct children of Sessions are sessions; a deeper key belongs to
      // one and contributes to it. The first path segment is the session name.
      const sessionName = key.slice(PUTTY_SESSION_PREFIX.length).split('\\')[0]!.trim()
      if (!sessionName) continue
      sawContent = true
      currentGroup = beginSession(decodeSessionName(sessionName))
      continue
    }

    if (currentGroup === null) continue
    sawContent = true

    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const valueName = line.slice(0, eq).trim().replace(/^"|"$/g, '').toLowerCase()
    const rawValue = line.slice(eq + 1).trim()

    let value: string
    if (/^dword:/i.test(rawValue)) {
      const hex = rawValue.slice(rawValue.indexOf(':') + 1).trim()
      if (!/^[0-9a-f]+$/i.test(hex)) {
        collector.warnings.push(
          `会话 "${currentGroup.name}" 的 ${valueName} 不是有效的 dword，已跳过。`
        )
        continue
      }
      value = String(parseInt(hex, 16))
    } else if (rawValue.startsWith('"')) {
      const parsed = parseRegString(rawValue)
      if (parsed === null) {
        collector.warnings.push(
          `会话 "${currentGroup.name}" 的 ${valueName} 取值格式无法识别，已跳过。`
        )
        continue
      }
      value = parsed
    } else {
      // REG_BINARY and friends carry no connection data worth mapping.
      continue
    }

    if (valueName === 'portnumber') {
      const port = parsePortValue(value)
      if (port === null) {
        collector.warnings.push(
          `会话 "${currentGroup.name}" 的 PortNumber "${value}" 不是有效端口，已忽略。`
        )
        continue
      }
      currentGroup.values.server_port = port
      continue
    }
    const mapped = PUTTY_VALUE_MAP[valueName]
    if (mapped) currentGroup.values[mapped] = value
  }

  if (!sawContent) return failedImport('内容为空或不含 PuTTY 会话', '无法导入 PuTTY 会话')
  if (collector.groups.length === 0) {
    collector.warnings.push(
      '未在文件中找到 PuTTY 会话，需要形如 [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\<名称>] 的段落。'
    )
    return collector.finish()
  }

  // PuTTY stores the port forward separately from the session, so each session
  // becomes a group with a single tunnel that only needs ports filled in.
  for (const group of collector.groups) {
    if (collector.addTunnel(group.name, group.name, { enabled: 'false' })) {
      warnMissingPorts(collector, group.name, group.name)
    }
  }
  return collector.finish()
}

// ---------------------------------------------------------------- mRemoteNG

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return XML_ENTITIES[body] ?? match
  })
}

/**
 * Reads attributes from one `<Node …>` tag. mRemoteNG itself writes double
 * quotes, but hand-edited files (and other exporters) show up with single
 * quotes too, so both are accepted.
 */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const word = /[A-Za-z_][\w:.-]*/g
  let match: RegExpExecArray | null
  while ((match = word.exec(tag)) !== null) {
    const name = match[0]
    // Only `=` (optionally preceded by spaces) directly after the name makes it
    // an attribute; anything else is element text, so the scan just moves on.
    const afterName = match.index + name.length
    const eq = tag.indexOf('=', afterName)
    if (eq === -1 || tag.slice(afterName, eq).trim() !== '') continue
    const quote = tag[eq + 1]
    if (quote !== '"' && quote !== "'") continue
    const end = tag.indexOf(quote, eq + 2)
    if (end === -1) continue
    attrs[name.toLowerCase()] = decodeXmlEntities(tag.slice(eq + 2, end))
    word.lastIndex = end + 1
  }
  return attrs
}

function localTagName(tag: string): string {
  const match = /^<\s*\/?\s*([A-Za-z_][\w:.-]*)/.exec(tag)
  return match ? match[1]!.toLowerCase().replace(/^.*:/, '') : ''
}

function firstAttr(attrs: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = attrs[name]
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

interface MRemoteNode {
  attrs: Record<string, string>
  /** Index of the enclosing `<Node>`, or -1 when the parent is the root. */
  parentIndex: number
  hasChildren: boolean
}

/**
 * Walks the document once and records every `<Node>` together with its parent.
 *
 * A hand-rolled scanner is used instead of `DOMParser` because this module runs
 * on Node, in a webview and on mobile, where no single XML parser is available;
 * the element shape here is a flat list of quoted attributes.
 */
function scanMRemoteNodes(xml: string): MRemoteNode[] {
  const nodes: MRemoteNode[] = []
  // Stack of open elements: the node index of a <Node>, or -1 for anything else.
  const stack: number[] = []
  const source = xml.replace(/<!--[\s\S]*?-->/g, '')
  const tagPattern = /<(\/?)\s*([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g

  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(source)) !== null) {
    const closing = match[1] === '/'
    const name = match[2]!.toLowerCase().replace(/^.*:/, '')
    const selfClosing = match[4] === '/'
    if (closing) {
      if (name === 'node') stack.pop()
      continue
    }
    if (name !== 'node') {
      if (!selfClosing) stack.push(-1)
      continue
    }

    const parentIndex = stack.length > 0 ? stack[stack.length - 1]! : -1
    const parent = parentIndex >= 0 ? nodes[parentIndex] : undefined
    const attrs = parseAttributes(match[0]!)
    nodes.push({ attrs, parentIndex, hasChildren: false })
    if (parent) parent.hasChildren = true
    const index = nodes.length - 1
    if (!selfClosing) stack.push(index)
  }
  return nodes
}

/** Root node of a confCons.xml: the document element named `Connections`. */
function findRootAttributes(xml: string): Record<string, string> {
  const pattern = /<([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    if (localTagName(match[0]!) === 'connections') return parseAttributes(match[0]!)
  }
  return {}
}

/** mRemoteNG `confCons.xml`. */
export function importMRemoteNg(xml: string): ImportResult {
  const collector = new ImportCollector()
  const text = String(xml ?? '').replace(/^\uFEFF/, '')

  if (!text.trim()) return failedImport('文件内容为空', '无法导入 mRemoteNG 配置')
  if (!/<Connections[\s/>]/i.test(text)) {
    return failedImport(
      '未找到 <Connections> 根节点（不是有效的 confCons.xml）',
      '无法导入 mRemoteNG 配置'
    )
  }
  if (!/<Node[\s/>]/i.test(text)) {
    collector.warnings.push('文件中没有 <Node> 节点，无法导入连接。')
    return collector.finish()
  }

  const rootAttrs = findRootAttributes(text)
  const engine = (rootAttrs.encryptionengine ?? '').trim()
  const hasPassword = (rootAttrs.password ?? '').trim() !== ''
  const looksEncrypted = (engine !== '' && engine.toUpperCase() !== 'AES') || hasPassword

  const nodes = scanMRemoteNodes(text)
  if (!nodes.some((node) => firstAttr(node.attrs, ['hostname', 'host']) !== undefined)) {
    // Without hostnames nothing can be imported; say why instead of reporting a
    // silent "0 connections".
    const reason = looksEncrypted
      ? `文件看起来已加密（EncryptionEngine=${engine || '非空'}），无法在不解密的情况下读取连接，请在 mRemoteNG 中取消加密后重新导出`
      : '文件中没有任何带有主机名的连接'
    return { groups: [], tunnels: [], warnings: [`无法导入 mRemoteNG 配置：${reason}。`] }
  }

  const emitConnection = (
    hostname: string,
    groupName: string,
    node: MRemoteNode,
    fallbackName: string
  ): void => {
    const group = acceptName(groupName, '组', collector.warnings)
    if (group === null) return
    if (!collector.hasGroup(group)) {
      const values: Record<string, string> = { server: hostname }
      const username = firstAttr(node.attrs, ['username', 'user'])
      if (username !== undefined) values.username = username
      const rawPort = firstAttr(node.attrs, ['port'])
      if (rawPort !== undefined) {
        const port = parsePortValue(rawPort)
        if (port === null) {
          collector.warnings.push(
            `连接 "${fallbackName}" 的端口 "${rawPort}" 不是有效端口，已忽略。`
          )
        } else {
          values.server_port = port
        }
      }
      collector.addGroup(group, values)
    }
    const tunnelName = acceptName(fallbackName, '隧道', collector.warnings)
    if (tunnelName === null) return
    if (collector.addTunnel(group, tunnelName, { enabled: 'false' })) {
      warnMissingPorts(collector, group, tunnelName)
    }
  }

  /** Direct children share the scanner's parent index, which is exact. */
  const childIndexes = (index: number): number[] => {
    const children: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i]!.parentIndex === index) children.push(i)
    }
    return children
  }

  const visit = (index: number, groupName: string | null): void => {
    const node = nodes[index]
    if (!node) return
    const name = (node.attrs.name ?? '').trim()
    const hostname = firstAttr(node.attrs, ['hostname', 'host'])
    const protocol = (firstAttr(node.attrs, ['protocol']) ?? '').toUpperCase()
    // Missing protocol means an SSH node: older exports omit it for SSH.
    const isSsh = protocol === '' || /^SSH/.test(protocol)

    if (!isSsh) {
      collector.warnings.push(`已忽略非 SSH 连接 "${name || hostname}"（协议 ${protocol}）。`)
      // Still descend: a folder may hold RDP and SSH sessions side by side.
      for (const child of childIndexes(index)) visit(child, groupName)
      return
    }

    if (hostname !== undefined) {
      // A top-level SSH node becomes its own group; a nested one joins its
      // container's group.
      const target = groupName ?? (name !== '' ? name : hostname)
      emitConnection(hostname, target, node, name !== '' ? name : hostname)
      for (const child of childIndexes(index)) visit(child, target)
      return
    }

    // A container takes its own group, so its children have something to join.
    // The group itself stays empty on purpose: the *first child connection*
    // fills in server/username/port, which is why the group must not be created
    // here — `emitConnection` only writes values into a group it creates.
    if (node.hasChildren || groupName === null) {
      const container = name !== '' ? name : '导入的连接'
      if (isValidName(container)) {
        const children = childIndexes(index)
        if (children.length === 0) {
          collector.warnings.push(`容器 "${container}" 中没有任何连接，已跳过。`)
        }
        for (const child of children) visit(child, container)
      } else {
        // An unusable container name must not swallow its children: keep
        // whatever group they would have joined, and say why.
        collector.warnings.push(`分组名称 "${name}" 无法写入配置文件，其子项归入上级分组。`)
        for (const child of childIndexes(index)) visit(child, groupName)
      }
      return
    }

    collector.warnings.push(`已忽略没有主机名的节点 "${name}"。`)
  }

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.parentIndex === -1) visit(i, null)
  }
  return collector.finish()
}
