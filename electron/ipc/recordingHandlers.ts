// ============================================================
// recordingHandlers — IPC handlers for recording:*
//
// Canal supprimé : recording:audioChunk (plus aucun PCM sur IPC)
// Canal supprimé : recording:silenceDetected (auto-stop désactivé)
// Canal ajouté   : recording:meLevel (RMS float depuis le VU-meter renderer)
// ============================================================

import { ipcMain } from 'electron'
import type { RecordingOrchestrator } from '../recording/RecordingOrchestrator'
import { safeHandle, IpcSchemas } from './validators'

export interface RecordingDeps {
  orchestrator: RecordingOrchestrator
}

export function register(deps: RecordingDeps): void {
  const { orchestrator } = deps

  ipcMain.handle('recording:start', () => orchestrator.startRecording())
  safeHandle('recording:startFromDraft', IpcSchemas['recording:startFromDraft'], meetingId =>
    orchestrator.startRecording(undefined, meetingId)
  )
  ipcMain.handle('recording:stop', () => orchestrator.stopRecording())
  ipcMain.handle('recording:getStatus', () => ({
    recording: orchestrator.isRecording,
    meetingId: orchestrator.currentMeetingId,
    duration: orchestrator.isRecording
      ? Math.round((Date.now() - orchestrator.recordingStartTime) / 1000)
      : 0
  }))

  // RMS mic depuis le VU-meter renderer (float 0-1, ~100ms interval)
  // Pas de données audio — juste un float pour les logs/UI si besoin
  ipcMain.on('recording:meLevel', (_event, rms: number) => {
    // Stocker pour exposition future si nécessaire
    void rms
  })
}
