/**
 * Ambient declarations for the renderer.
 *
 * The shapes themselves live in `src/shared/contract.ts` (which re-exports the
 * platform-agnostic domain types from `src/core/types.ts`); this file only maps them
 * onto globals, so the renderer keeps writing `TunnelView` / `window.api` without
 * importing anything. Nothing is declared by hand twice any more — that duplication
 * is exactly what let the preload bridge and the views drift apart.
 */
import type * as Contract from '../shared/contract'

declare global {
  type TunnelView = Contract.TunnelView
  type GroupConfig = Contract.GroupConfig
  type TunnelDef = Contract.TunnelDef
  type ConfigData = Contract.ConfigData
  type ActionResult = Contract.ActionResult
  type ValidateItem = Contract.ValidateItem
  type LogPayload = Contract.LogPayload
  type AppInfo = Contract.AppInfo
  type ConfigImportResult = Contract.ConfigImportResult

  interface Window {
    api: Contract.StmApi
  }
}

export {}
