/**
 * Desktop (Node / Electron) wiring for the platform-agnostic core.
 *
 * Selecting a platform is reduced to picking a `ConfigStore` and a
 * `TunnelTransport`; everything else is shared.
 */
import { TunnelManager } from '../../core/manager'
import type { SecretStore } from '../../core/storage'
import { FileConfigStore } from './config-store'
import { ExecTransport } from './exec-transport'

export interface NodeTunnelManagerOptions {
  /** Absolute path of the active config file. */
  configPath: string
  /** Base directory for relative `private_key` / `client` paths. */
  rootDir: string
  /** Directory for PID state + log files (like `.tunnel/`). */
  runtimeDir: string
  /** Ordered list of plink.exe candidate paths (bundled, PATH, userData…). */
  plinkCandidates: string[]
  /** Subset of `plinkCandidates` shipped with the app (see ExecTransportOptions). */
  shippedPlinkPaths?: string[]
  /** Optional encrypted secret storage (Electron `safeStorage` on desktop). */
  secretStore?: SecretStore
}

export function createTunnelManager(opts: NodeTunnelManagerOptions): TunnelManager {
  return new TunnelManager({
    store: new FileConfigStore(opts.configPath),
    secretStore: opts.secretStore,
    transport: new ExecTransport({
      rootDir: opts.rootDir,
      runtimeDir: opts.runtimeDir,
      plinkCandidates: opts.plinkCandidates,
      shippedPlinkPaths: opts.shippedPlinkPaths ?? []
    })
  })
}

export { ExecTransport, FileConfigStore }
export type { BuiltCommand, ClientKind, ExecTransportOptions } from './exec-transport'
export { tailFile } from './tail-file'
