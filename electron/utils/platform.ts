import { execSync } from 'child_process'
import { release } from 'os'
import { join } from 'path'
import { app } from 'electron'

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
