// ============================================================
// settingsHandlers — IPC handlers for settings:get / settings:update
// ============================================================

import { ipcMain } from 'electron'
import type { SettingsManager } from '../settings/SettingsManager'
import { safeHandle, IpcSchemas } from './validators'

export interface SettingsDeps {
  settingsManager: SettingsManager
}

export function register(deps: SettingsDeps): void {
  const { settingsManager } = deps

  ipcMain.handle('settings:get', () => settingsManager.getSettings())

  safeHandle('settings:update', IpcSchemas['settings:update'], partial => {
    for (const [key, val] of Object.entries(partial)) {
      // String(undefined) produirait la chaîne littérale "undefined" en base
      settingsManager.saveSetting(key, val !== undefined && val !== null ? String(val) : '')
    }
  })
}
