/**
 * Renderer hardening.
 *
 * The window runs sandboxed and every navigation, popup and permission request
 * is denied unless it is provably part of the app itself. Anything that must
 * reach the outside world goes through `openExternalSafely`, which is limited
 * to http/https.
 */
import { shell, type WebContents } from 'electron'
import { isAllowedExternalUrl, isInternalNavigation } from './url-policy'

/** Open a link in the user's browser, refusing anything but http/https. */
export function openExternalSafely(raw: string): void {
  if (!isAllowedExternalUrl(raw)) return
  void shell.openExternal(raw)
}

/**
 * Apply the app's navigation, popup and permission policy to a window.
 *
 * This is defence in depth: a renderer that is somehow compromised (a bad
 * dependency, an injected string) still cannot navigate to a remote page, open
 * a popup window, launch a `file:`/custom-scheme handler, or ask for the
 * camera, microphone, geolocation or notifications.
 */
export function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (isInternalNavigation(contents.getURL(), url)) return
    event.preventDefault()
    openExternalSafely(url)
  })

  // `will-attach-webview` is part of the same policy: the app never embeds one.
  contents.on('will-attach-webview', (event) => event.preventDefault())

  const { session } = contents
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}

/**
 * The webPreferences every app window must use.
 *
 * The renderer gets no Node.js access and no direct OS reach: everything
 * crosses the typed IPC bridge, where payloads are validated.
 */
export const SECURE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false
} as const
