// ============================================================
// RecordingOrchestrator — state machine de l'enregistrement
//
// Responsabilités :
//   - Créer le meeting en DB
//   - Déléguer 100% de la capture audio à AudioCaptureService
//   - Envoyer les événements d'état au Renderer (no PCM sur IPC)
//   - Déclencher le pipeline de transcription après arrêt
// ============================================================

import { app } from 'electron'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { AudioCaptureService } from '../../src/services/audioCapture'
import { DatabaseService } from '../../src/services/database'
import { setRecordingState } from '../tray'
import type { TrayCallbacks } from '../tray'
import type { SettingsManager } from '../settings/SettingsManager'
import type { PipelineManager } from './PipelineManager'

export interface RecordingOrchestratorDeps {
  database: DatabaseService
  mainWindow: BrowserWindow | null
  audioCapture: AudioCaptureService
  settingsManager: SettingsManager
  pipelineManager: PipelineManager
  trayCallbacks: TrayCallbacks
}

export class RecordingOrchestrator {
  private deps: RecordingOrchestratorDeps

  isRecording = false
  currentMeetingId: string | null = null
  recordingStartTime = 0

  // Timer VU-meter : envoie le RMS "others" au Renderer toutes les 100ms
  private othersLevelTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: RecordingOrchestratorDeps) {
    this.deps = deps
  }

  private sendToRenderer(channel: string, ...args: unknown[]): void {
    this.deps.mainWindow?.webContents.send(channel, ...args)
  }

  // existingMeetingId : passer l'id d'un meeting en status='draft' pour le promouvoir
  // en enregistrement sans créer un nouveau meeting (cas calendrier).
  async startRecording(title?: string, existingMeetingId?: string): Promise<{ meetingId: string }> {
    if (this.isRecording) return { meetingId: this.currentMeetingId! }

    const { database, audioCapture, settingsManager, trayCallbacks } = this.deps
    const settings = settingsManager.getSettings()
    const meetingId = existingMeetingId ?? randomUUID()
    const audioDir = join(app.getPath('userData'), 'audio', meetingId)

    if (existingMeetingId) {
      // Promouvoir un meeting draft existant : mettre à jour les chemins audio
      if (title) database.updateMeeting(meetingId, { title })
      database.updateMeeting(meetingId, { audio_path_me: audioDir, audio_path_others: audioDir })
    } else {
      database.createMeeting(
        meetingId,
        settings.speakerMeName,
        settings.speakerOthersName,
        audioDir,
        audioDir
      )
      if (title) database.updateMeeting(meetingId, { title })
    }

    await audioCapture.start(meetingId, {
      onWarn: msg => this.sendToRenderer('recording:warning', msg),
      onError: msg => this.sendToRenderer('recording:audioTeeError', msg)
    })

    this.isRecording = true
    this.currentMeetingId = meetingId
    this.recordingStartTime = Date.now()

    // VU-meter : envoyer le RMS "others" depuis le service (calculé en main process)
    this.othersLevelTimer = setInterval(() => {
      this.sendToRenderer('audio:othersLevel', audioCapture.currentOthersRMS)
    }, 100)

    setRecordingState(true, trayCallbacks)

    // Informer le Renderer que l'enregistrement a commencé
    // recording:requestStart déclenche uniquement le VU-meter mic côté renderer (no AudioWorklet)
    this.sendToRenderer('recording:started', meetingId)
    this.sendToRenderer('recording:requestStart', { meetingId })

    console.log(`[main] Enregistrement démarré : ${meetingId}`)
    return { meetingId }
  }

  async stopRecording(): Promise<void> {
    if (!this.isRecording || !this.currentMeetingId) return

    const { database, audioCapture, pipelineManager, trayCallbacks } = this.deps
    const meetingId = this.currentMeetingId

    if (this.othersLevelTimer) {
      clearInterval(this.othersLevelTimer)
      this.othersLevelTimer = null
    }

    // Arrêter les processus audio (attend le flush WAV)
    const { chunkFiles, durationSeconds } = await audioCapture.stop()

    this.isRecording = false
    this.currentMeetingId = null

    setRecordingState(false, trayCallbacks)
    this.sendToRenderer('recording:requestStop')
    this.sendToRenderer('recording:stopped', meetingId)

    database.updateMeeting(meetingId, { duration_seconds: durationSeconds, status: 'transcribing' })
    this.sendToRenderer('meeting:updated', meetingId)

    console.log(
      `[main] Enregistrement arrêté : ${durationSeconds}s, ${chunkFiles.length} chunks stéréo`
    )

    pipelineManager.trackPipeline(
      pipelineManager.processTranscription(meetingId, chunkFiles, durationSeconds).catch(err => {
        console.error('[main] Erreur pipeline :', err)
        pipelineManager.currentProgress = null
        database.updateMeeting(meetingId, { status: 'error', error_message: String(err) })
        this.sendToRenderer('meeting:updated', meetingId)
      })
    )
  }
}
