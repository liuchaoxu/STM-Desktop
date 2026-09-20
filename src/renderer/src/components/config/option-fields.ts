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
  }
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
  { key: 'remote_host', label: '远端主机', placeholder: '127.0.0.1' }
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
  }
]
