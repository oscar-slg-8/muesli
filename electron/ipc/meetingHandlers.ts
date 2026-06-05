// ============================================================
// meetingHandlers — IPC handlers for meetings:*, transcription:*,
//   summarization:*, templates:*, export:*, calendar:*, system:*,
//   database:getStatus
// ============================================================

import { ipcMain, dialog, clipboard, shell } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { safeHandle, IpcSchemas } from './validators'
import { DatabaseService } from '../../src/services/database'
import { SummarizationService } from '../../src/services/summarization'
import { exportToNotion } from '../../src/services/export'
import { getCalendarEvents } from '../calendar'
import type { SettingsManager } from '../settings/SettingsManager'
import type { PipelineManager } from '../recording/PipelineManager'
import type { RecordingOrchestrator } from '../recording/RecordingOrchestrator'
import { isMacOS14_2OrLater, getSystemAudioBinaryPath } from '../recording/SystemAudioProcess'
import { hasCommand } from '../services/depCheck'

export interface MeetingDeps {
  database: DatabaseService
  mainWindow: BrowserWindow | null
  settingsManager: SettingsManager
  pipelineManager: PipelineManager
  orchestrator: RecordingOrchestrator
  summarization: SummarizationService
}

export function register(deps: MeetingDeps): void {
  const { database, settingsManager, pipelineManager, orchestrator, summarization } = deps

  // ---- database ----
  ipcMain.handle('database:getStatus', () => ({
    initialized: true,
    path: database.getPath(),
    migrationsCount: database.getMigrationsCount()
  }))

  // ---- meetings ----
  ipcMain.handle('meetings:list', () => {
    try {
      return database.listMeetings()
    } catch (err) {
      console.error('[ipc] meetings:list', err)
      return []
    }
  })
  safeHandle('meetings:get', IpcSchemas['meetings:get'], id => {
    try {
      return database.getMeeting(id)
    } catch (err) {
      console.error('[ipc] meetings:get', err)
      return null
    }
  })
  safeHandle('meetings:getSegments', IpcSchemas['meetings:getSegments'], id => {
    try {
      return database.getSegments(id)
    } catch (err) {
      console.error('[ipc] meetings:getSegments', err)
      return []
    }
  })
  safeHandle('meetings:updateNotes', IpcSchemas['meetings:updateNotes'], ([id, md]) => {
    try {
      database.updateMeeting(id, { notes_markdown: md })
    } catch (err) {
      console.error('[ipc] meetings:updateNotes', err)
    }
  })
  safeHandle('meetings:updateTitle', IpcSchemas['meetings:updateTitle'], ([id, title]) => {
    try {
      database.updateMeeting(id, { title })
    } catch (err) {
      console.error('[ipc] meetings:updateTitle', err)
    }
  })
  safeHandle('meetings:updateLanguage', IpcSchemas['meetings:updateLanguage'], ([id, language]) => {
    try {
      database.updateMeeting(id, { language })
      deps.mainWindow?.webContents.send('meeting:updated', id)
    } catch (err) {
      console.error('[ipc] meetings:updateLanguage', err)
    }
  })
  safeHandle('meetings:delete', IpcSchemas['meetings:delete'], id => {
    try {
      database.deleteMeeting(id)
    } catch (err) {
      console.error('[ipc] meetings:delete', err)
    }
  })
  safeHandle('meetings:search', IpcSchemas['meetings:search'], query => {
    try {
      return database.searchMeetings(query)
    } catch (err) {
      console.error('[ipc] meetings:search', err)
      return []
    }
  })
  safeHandle('meetings:getSpeakerNames', IpcSchemas['meetings:getSpeakerNames'], id => {
    try {
      return database.getSpeakerNames(id)
    } catch (err) {
      console.error('[ipc] getSpeakerNames', err)
      return {}
    }
  })
  safeHandle(
    'meetings:setSpeakerName',
    IpcSchemas['meetings:setSpeakerName'],
    ([meetingId, speakerKey, displayName]) => {
      try {
        database.setSpeakerName(meetingId, speakerKey, displayName)
      } catch (err) {
        console.error('[ipc] setSpeakerName', err)
      }
    }
  )
  safeHandle(
    'meetings:updateSegment',
    IpcSchemas['meetings:updateSegment'],
    ([segmentId, text]) => {
      try {
        database.updateSegmentText(segmentId, text)
      } catch (err) {
        console.error('[ipc] meetings:updateSegment', err)
        throw err
      }
    }
  )
  safeHandle('meetings:getAudioInfo', IpcSchemas['meetings:getAudioInfo'], meetingId => {
    const meeting = database.getMeeting(meetingId)
    if (!meeting) return { meExists: false, othersExists: false, audioDeleted: true }
    return {
      meExists: !meeting.audioDeleted && !!meeting.audioPathMe && existsSync(meeting.audioPathMe),
      othersExists:
        !meeting.audioDeleted && !!meeting.audioPathOthers && existsSync(meeting.audioPathOthers),
      audioDeleted: meeting.audioDeleted
    }
  })

  // ---- transcription ----
  ipcMain.handle('transcription:getProgress', () => pipelineManager.currentProgress)

  safeHandle('transcription:retry', IpcSchemas['transcription:retry'], async meetingId => {
    const meeting = database.getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting introuvable')
    if (orchestrator.isRecording && orchestrator.currentMeetingId === meetingId) {
      throw new Error('Enregistrement en cours')
    }

    const audioDir =
      meeting.audioPathMe && existsSync(meeting.audioPathMe)
        ? meeting.audioPathMe
        : join(app.getPath('userData'), 'audio', meetingId)

    if (!existsSync(audioDir)) {
      throw new Error('Fichiers audio introuvables — ils ont peut-être été supprimés')
    }

    const allFiles = readdirSync(audioDir)

    // Priorité : chunks stéréo natifs (nouveau format chunk_NNN.wav)
    const stereoChunks = allFiles
      .filter(f => /^chunk_\d+\.wav$/.test(f))
      .sort()
      .map(f => join(audioDir, f))

    // Fallback : format legacy me_chunk_* / others_chunk_*
    const meChunks = allFiles
      .filter(f => f.startsWith('me_chunk_') && f.endsWith('.wav'))
      .sort()
      .map(f => join(audioDir, f))
    const othersChunks = allFiles
      .filter(f => f.startsWith('others_chunk_') && f.endsWith('.wav'))
      .sort()
      .map(f => join(audioDir, f))

    if (stereoChunks.length === 0 && meChunks.length === 0) {
      throw new Error('Aucun fichier audio trouvé dans ' + audioDir)
    }

    const input: string[] | { me: string[]; others: string[] } =
      stereoChunks.length > 0 ? stereoChunks : { me: meChunks, others: othersChunks }

    database.deleteSegments(meetingId)
    database.updateMeeting(meetingId, { status: 'transcribing', error_message: null })
    deps.mainWindow?.webContents.send('meeting:updated', meetingId)

    pipelineManager.trackPipeline(
      pipelineManager
        .processTranscription(meetingId, input, meeting.durationSeconds || 0)
        .catch(err => {
          console.error('[main] Erreur retranscription :', err)
          pipelineManager.currentProgress = null
          database.updateMeeting(meetingId, { status: 'error', error_message: String(err) })
          deps.mainWindow?.webContents.send('meeting:updated', meetingId)
        })
    )
  })

  // ---- summarization ----
  safeHandle(
    'summarization:retry',
    IpcSchemas['summarization:retry'],
    async ([meetingId, templateId]) => {
      const meeting = database.getMeeting(meetingId)
      if (!meeting) return
      const segments = database.getSegments(meetingId)
      const settings = settingsManager.getSettings()
      const summaryKey =
        settings.summaryProvider === 'mistral' ? settings.apiKeyMistral : settings.apiKeyAnthropic
      summarization.configure(summaryKey, settings.summaryProvider)

      let summaryPrompt = settings.summaryPrompt
      if (templateId !== undefined) {
        const template = database.getTemplate(templateId)
        if (template) summaryPrompt = template.prompt
      }

      try {
        database.updateMeeting(meetingId, { status: 'summarizing' })
        deps.mainWindow?.webContents.send('meeting:updated', meetingId)

        const speakerNames = database.getSpeakerNames(meetingId)
        const userNotes = meeting.notesMarkdown || ''
        const summary = await summarization.summarize(
          segments,
          settings.speakerMeName,
          settings.speakerOthersName,
          meeting.durationSeconds,
          summaryPrompt,
          meeting.language ?? settings.language,
          speakerNames,
          userNotes
        )
        database.updateMeeting(meetingId, {
          status: 'complete',
          summary_markdown: summary,
          summary_model: summarization.modelLabel,
          error_message: null
        })
        pipelineManager.cleanupAudioIfNeeded(meetingId)
      } catch (err) {
        database.updateMeeting(meetingId, {
          status: 'error',
          error_message: `Résumé échoué : ${String(err)}`
        })
      }
      deps.mainWindow?.webContents.send('meeting:updated', meetingId)
    }
  )

  // ---- templates ----
  ipcMain.handle('templates:list', () => {
    try {
      return database.getTemplates()
    } catch (err) {
      console.error('[ipc] templates:list', err)
      return []
    }
  })
  safeHandle('templates:create', IpcSchemas['templates:create'], ([name, prompt]) => {
    try {
      return database.createTemplate(name, prompt)
    } catch (err) {
      console.error('[ipc] templates:create', err)
      throw err
    }
  })
  safeHandle('templates:update', IpcSchemas['templates:update'], ([id, name, prompt]) => {
    try {
      database.updateTemplate(id, name, prompt)
    } catch (err) {
      console.error('[ipc] templates:update', err)
      throw err
    }
  })
  safeHandle('templates:delete', IpcSchemas['templates:delete'], id => {
    try {
      database.deleteTemplate(id)
    } catch (err) {
      console.error('[ipc] templates:delete', err)
      throw err
    }
  })

  // ---- export ----
  safeHandle('export:saveFile', IpcSchemas['export:saveFile'], async ([defaultName, content]) => {
    const result = await dialog.showSaveDialog(deps.mainWindow!, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Texte', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, content, 'utf-8')
    return true
  })

  safeHandle('export:copyToClipboard', IpcSchemas['export:copyToClipboard'], text => {
    clipboard.writeText(text)
  })

  safeHandle('export:notion', IpcSchemas['export:notion'], async meetingId => {
    try {
      const meeting = database.getMeeting(meetingId)
      if (!meeting) return { ok: false, error: 'Réunion introuvable' }
      const segments = database.getSegments(meetingId)
      const settings = settingsManager.getSettings()
      if (!settings.apiKeyNotion) return { ok: false, error: 'Token Notion non configuré' }
      if (!settings.notionDatabaseId)
        return { ok: false, error: 'Database ID Notion non configuré' }
      const url = await exportToNotion(
        meeting,
        segments,
        settings.apiKeyNotion,
        settings.notionDatabaseId
      )
      return { ok: true, url }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[ipc] export:notion', msg)
      return { ok: false, error: msg }
    }
  })

  // Export multiple : une page Notion par réunion, résultats agrégés par id.
  safeHandle('export:notionBulk', IpcSchemas['export:notionBulk'], async meetingIds => {
    const settings = settingsManager.getSettings()
    if (!settings.apiKeyNotion)
      return {
        results: meetingIds.map(id => ({ id, ok: false, error: 'Token Notion non configuré' }))
      }
    if (!settings.notionDatabaseId)
      return {
        results: meetingIds.map(id => ({
          id,
          ok: false,
          error: 'Database ID Notion non configuré'
        }))
      }

    const results: Array<{ id: string; ok: boolean; url?: string; error?: string }> = []
    // Séquentiel : évite de saturer l'API Notion (rate limit ~3 req/s).
    for (const id of meetingIds) {
      try {
        const meeting = database.getMeeting(id)
        if (!meeting) {
          results.push({ id, ok: false, error: 'Réunion introuvable' })
          continue
        }
        const segments = database.getSegments(id)
        const url = await exportToNotion(
          meeting,
          segments,
          settings.apiKeyNotion,
          settings.notionDatabaseId
        )
        results.push({ id, ok: true, url })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[ipc] export:notionBulk', id, msg)
        results.push({ id, ok: false, error: msg })
      }
    }
    return { results }
  })

  // ---- calendar ----
  ipcMain.handle('calendar:getEvents', async () => {
    try {
      return await getCalendarEvents()
    } catch (err) {
      console.error('[ipc] calendar:getEvents', err)
      return []
    }
  })

  // ---- system ----
  safeHandle('system:openExternal', IpcSchemas['system:openExternal'], url =>
    shell.openExternal(url)
  )

  ipcMain.handle('system:checkDependencies', () => {
    const settings = settingsManager.getSettings()
    const processTapAvailable = isMacOS14_2OrLater() && existsSync(getSystemAudioBinaryPath())
    const micBackend: 'ffmpeg' | 'sox' | null = hasCommand('ffmpeg')
      ? 'ffmpeg'
      : hasCommand('sox')
        ? 'sox'
        : null
    return {
      groqApiKey: settings.apiKeyGroq.length > 0,
      anthropicApiKey: settings.apiKeyAnthropic.length > 0,
      mistralApiKey: settings.apiKeyMistral.length > 0,
      pyannoteApiKey: settings.apiKeyPyannote.length > 0,
      notionConfigured: settings.apiKeyNotion.length > 0 && settings.notionDatabaseId.length > 0,
      processTapAvailable,
      micBackend
    }
  })
}
