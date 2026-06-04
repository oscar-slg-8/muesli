// ============================================================
// Ouverture d'un lien de réunion dans Google Chrome.
// Cible la fenêtre Chrome DÉJÀ ouverte et y crée un NOUVEL onglet
// (via AppleScript / osascript). Fallback sur le navigateur par défaut
// si Chrome est absent ou si l'automation est refusée.
//
// macOS demandera l'autorisation "Automation" (Muesli → Google Chrome)
// la première fois — c'est attendu.
// ============================================================

import { execFile } from 'child_process'
import { shell } from 'electron'

// Échappe une URL pour une insertion sûre dans une chaîne AppleScript.
// Les URLs de visio ne contiennent normalement ni guillemets ni backslash,
// mais on neutralise les deux par sécurité.
function escapeForAppleScript(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function openMeetingUrl(url: string): Promise<void> {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') {
      shell.openExternal(url).catch(() => {})
      resolve()
      return
    }

    const safeUrl = escapeForAppleScript(url)
    const script = [
      'tell application "Google Chrome"',
      '  activate',
      '  if (count of windows) = 0 then',
      `    make new window`,
      `    set URL of active tab of front window to "${safeUrl}"`,
      '  else',
      `    tell front window to make new tab with properties {URL:"${safeUrl}"}`,
      '  end if',
      'end tell'
    ].join('\n')

    execFile('osascript', ['-e', script], err => {
      if (err) {
        console.warn(
          '[notif] Ouverture Chrome via AppleScript échouée, fallback navigateur par défaut :',
          err.message
        )
        shell.openExternal(url).catch(e => {
          console.error('[notif] Fallback openExternal échoué :', e)
        })
      }
      resolve()
    })
  })
}
