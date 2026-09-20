/**
 * The one seam that every platform must provide: how a local port forward is
 * actually established.
 *
 *   - Windows / macOS / Linux : spawn the system `ssh` or a bundled `plink`
 *     (`src/platforms/node/exec-transport.ts`) — keeps `~/.ssh/config`,
 *     ssh-agent and `known_hosts` working.
 *   - Android / iOS          : must run in-process (no `fork`/`exec` allowed);
 *     e.g. Kotlin + sshj / Apache MINA SSHD, or Swift + SwiftNIO SSH.
 *
 * Everything else (config merge, target resolution, batch scheduling, the
 * per-tunnel lifecycle lock, view projection) lives in `./manager.ts` and is
 * shared by every platform.
 */
import type { ResolvedTunnel } from './types'

/** A live forwarding session. */
export interface TransportSession {
  /** Transport-defined handle (kept for logging and diagnostics). */
  readonly id: string
  /** OS process id when the transport runs a child process, otherwise null. */
  readonly pid: number | null
}

/** Result of asking the transport to explain one tunnel. */
export interface DescribeResult {
  /** Full command line with secrets masked, for the validate view. */
  command: string
  /** Client kind reported to the user, e.g. "plink", "openssh", "in-process". */
  kind: string
  /** Resolved client location (a path on desktop, a library name on mobile). */
  executable: string
}

/** stdout / stderr tails for one tunnel. */
export interface TunnelLogs {
  output: string
  error: string
  /** Where the output comes from, shown next to the log pane. */
  outLabel: string
  /** Where the error stream comes from, shown next to the log pane. */
  errLabel: string
}

export interface TunnelTransport {
  readonly kind: 'exec' | 'in-process'

  /** Explain one tunnel (used by "校验配置"); throws TunnelError when invalid. */
  describe(t: ResolvedTunnel): DescribeResult

  /**
   * Whether something is already accepting connections on the tunnel's local
   * bind address and port. Used both as a pre-flight conflict check and to
   * decide between `running` and `connecting`.
   */
  probeLocalPort(t: ResolvedTunnel): Promise<boolean>

  /**
   * Start forwarding. Resolves once the local port accepts connections, and
   * rejects without leaving anything behind when the client fails to start.
   */
  open(t: ResolvedTunnel): Promise<TransportSession>

  /**
   * Stop a session. Rejects when the session could not be stopped, so the
   * caller never reports success for a process that is still alive.
   */
  close(t: ResolvedTunnel, session: TransportSession): Promise<void>

  /**
   * Sessions that are still alive for the given tunnels, keyed by tunnel key.
   * A desktop transport also recovers sessions started by a previous app run.
   */
  liveSessions(tunnels: ResolvedTunnel[]): Promise<Map<string, TransportSession>>

  /** stdout / stderr tails for one tunnel. */
  logs(t: ResolvedTunnel, lines: number): Promise<TunnelLogs>
}
