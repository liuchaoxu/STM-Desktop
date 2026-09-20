/**
 * URL policy for the shell — deliberately free of Electron imports so it can be
 * unit tested (see `npm run smoke`).
 */

/** Protocols the shell is ever willing to hand to the OS. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Whether `raw` may be opened in the user's browser. Anything else — `file:`,
 * `javascript:`, custom schemes registered by other applications — is refused.
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol)
}

/**
 * Whether an in-app navigation should be allowed, given the current URL.
 *
 * The renderer only ever needs to navigate within its own bundle: the dev
 * server origin in development, or files sitting next to the loaded document in
 * production. Everything else is refused (and, for http/https, handed to the
 * browser instead).
 */
export function isInternalNavigation(current: string, next: string): boolean {
  let from: URL
  let to: URL
  try {
    from = new URL(current)
    to = new URL(next)
  } catch {
    return false
  }

  if (from.protocol === 'file:' && to.protocol === 'file:') {
    // Same directory as the loaded document, so a crafted `file:///C:/Windows/…`
    // cannot be reached from the renderer.
    const dir = from.href.slice(0, from.href.lastIndexOf('/') + 1)
    return to.href.startsWith(dir)
  }

  return from.protocol === to.protocol && from.host === to.host
}
