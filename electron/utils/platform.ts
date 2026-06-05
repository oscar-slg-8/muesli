import { execSync } from 'child_process'
import { release } from 'os'
import { join } from 'path'
import { app } from 'electron'

// Une app macOS lancée en GUI (LaunchServices) hérite d'un PATH minimal
// (/usr/bin:/bin:/usr/sbin:/sbin) qui n'inclut PAS Homebrew. Résultat :
// sox/ffmpeg installés via `brew` sont introuvables dans le build packagé,
// alors qu'ils marchent en dev (PATH du shell hérité).
// On préfixe donc les emplacements standards Homebrew au PATH du process.
// Les child_process (spawn/execSync) héritent de process.env → corrige tout
// d'un coup (détection `which` + spawn sox/ffmpeg).
export function ensurePathEnv(): void {
  const candidates = [
    '/opt/homebrew/bin', // Apple Silicon
    '/opt/homebrew/sbin',
    '/usr/local/bin', // Intel / divers
    '/usr/local/sbin'
  ]
  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const missing = candidates.filter(p => !current.includes(p))
  if (missing.length > 0) {
    process.env.PATH = [...missing, ...current].join(':')
  }
}

export function isMacOS14_2OrLater(): boolean {
  const [major, minor] = release().split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 2)
}

export function getSystemAudioBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'system-audio-capture')
    : join(app.getAppPath(), 'resources', 'system-audio-capture')
}

export function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function detectMicBackend(): 'ffmpeg' | 'sox' | null {
  if (hasCommand('ffmpeg')) return 'ffmpeg'
  if (hasCommand('sox')) return 'sox'
  return null
}
