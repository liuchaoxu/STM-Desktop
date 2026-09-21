/**
 * Field descriptions for the three kinds of config section.
 *
 * `defaults`, a group and a tunnel are all "a map of string options", so the
 * same editor renders all three; only this list differs. Anything a user sets
 * that is not listed here stays reachable through the advanced key/value
 * editor, so no option is ever unreachable from the UI.
 */
import type { OptionField } from './OptionsEditor.vue'

const HOST_KEY_CHECKING: OptionField['options'] = [
  { value: 'accept-new', label: 'accept-new（推荐）' },
  { value: 'yes', label: 'yes（严格）' },
  { value: 'no', label: 'no（不安全）' }
]

/**
 * Where the tunnel row's "在浏览器中打开" button points. Without these, the button
 * uses `http://<本地绑定地址>:<本地端口>/`; `web_path` appends a path and
 * `web_url` replaces the whole address (any http/https URL).
 */
const WEB_FIELDS: OptionField[] = [
  {
    key: 'web_path',
    label: '浏览器打开路径',
    wide: true,
    placeholder: '/（留空即打开根路径）',
    hint: '拼在本地地址后面，例如 /admin 或 /#/dashboard'
  },
  {
    key: 'web_url',
    label: '浏览器打开地址',
    wide: true,
    placeholder: 'http://127.0.0.1:6379/',
    hint: '填了就整体覆盖上面的本地地址与路径，仅支持 http/https'
  }
]

/**
 * Forwarding shapes beyond the plain `-L` local forward: a SOCKS5 proxy, a reverse
 * tunnel and a bastion. Each is optional and they combine, which is why they are
 * separate keys rather than one "mode" switch.
 */
const FORWARD_FIELDS: OptionField[] = [
  {
    key: 'dynamic_port',
    label: 'SOCKS5 端口',
    kind: 'number',
    placeholder: '1080',
    hint: '填了就开一个 SOCKS5 代理（-D），不需要远端主机/端口'
  },
  {
    key: 'remote_forward',
    label: '反向隧道',
    wide: true,
    placeholder: '8080:127.0.0.1:80',
    hint: 'ssh 的 -R 语法：[绑定地址:]远端端口:目标主机:目标端口'
  },
  {
    key: 'proxy_jump',
    label: '跳板机',
    wide: true,
    placeholder: 'deploy@bastion.example.com:22',
    hint: 'ssh 的 -J，仅 OpenSSH 支持（plink 没有 -J）'
  }
]

/** Keeping a tunnel alive: the app reconnects by itself, with an exponential backoff. */
const RESTART_FIELDS: OptionField[] = [
  {
    key: 'auto_restart',
    label: '断线自动重连',
    kind: 'checkbox',
    hint: '默认开启；只重连应用自己拉起的隧道，手动停止的不会复活'
  },
  { key: 'restart_limit', label: '最大重连次数', kind: 'number', placeholder: '5' },
  { key: 'restart_delay', label: '首次重连等待（秒）', kind: 'number', placeholder: '2' }
]

export const DEFAULT_FIELDS: OptionField[] = [
  { key: 'client', label: 'SSH 客户端', placeholder: 'auto', list: 'client-options' },
  { key: 'server_port', label: 'SSH 端口', kind: 'number', placeholder: '22' },
  { key: 'local_bind', label: '本地绑定地址', placeholder: '127.0.0.1' },
  { key: 'enabled', label: '默认启用', kind: 'checkbox' },
  {
    key: 'strict_host_key_checking',
    label: '主机密钥校验',
    kind: 'select',
    options: HOST_KEY_CHECKING
  },
  ...FORWARD_FIELDS,
  ...RESTART_FIELDS,
  ...WEB_FIELDS
]

export const GROUP_FIELDS: OptionField[] = [
  { key: 'server', label: '服务器', placeholder: 'ssh.example.com' },
  { key: 'username', label: '用户名', placeholder: 'deploy' },
  { key: 'password', label: '密码', kind: 'password', wide: true, hint: '填写后自动加密保存' },
  {
    key: 'private_key',
    label: '私钥路径',
    wide: true,
    placeholder: '~/.ssh/id_ed25519 或绝对路径'
  },
  { key: 'hostkey', label: '主机指纹', wide: true, placeholder: 'SHA256:…（Plink 推荐）' },
  { key: 'client', label: 'SSH 客户端', placeholder: 'auto', list: 'client-options' },
  { key: 'server_port', label: 'SSH 端口', kind: 'number', placeholder: '22' },
  { key: 'local_bind', label: '本地绑定地址', placeholder: '127.0.0.1' },
  {
    key: 'strict_host_key_checking',
    label: '主机密钥校验',
    kind: 'select',
    options: HOST_KEY_CHECKING
  },
  { key: 'remote_host', label: '远端主机', placeholder: '127.0.0.1' },
  ...FORWARD_FIELDS,
  ...RESTART_FIELDS,
  ...WEB_FIELDS
]

export const TUNNEL_FIELDS: OptionField[] = [
  { key: 'enabled', label: '启用', kind: 'checkbox' },
  { key: 'local_port', label: '本地端口', kind: 'number', placeholder: '6379' },
  { key: 'remote_host', label: '远端主机', placeholder: '127.0.0.1' },
  { key: 'remote_port', label: '远端端口', kind: 'number', placeholder: '6379' },
  { key: 'local_bind', label: '本地绑定地址', placeholder: '127.0.0.1' },
  { key: 'server_port', label: 'SSH 端口', kind: 'number', placeholder: '22' },
  { key: 'client', label: 'SSH 客户端', placeholder: 'auto', list: 'client-options' },
  {
    key: 'private_key',
    label: '私钥路径',
    wide: true,
    placeholder: '~/.ssh/id_ed25519 或绝对路径'
  },
  { key: 'password', label: '密码', kind: 'password', wide: true, hint: '填写后自动加密保存' },
  { key: 'hostkey', label: '主机指纹', wide: true, placeholder: 'SHA256:…（Plink 推荐）' },
  {
    key: 'strict_host_key_checking',
    label: '主机密钥校验',
    kind: 'select',
    options: HOST_KEY_CHECKING
  },
  ...FORWARD_FIELDS,
  ...RESTART_FIELDS,
  ...WEB_FIELDS
]
