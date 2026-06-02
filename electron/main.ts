// ============================================================
// Processus principal Electron — Muesli (bootstrap)
// ============================================================

import {
  app,
  BrowserWindow,
  dialog,
  session,
  nativeImage,
  Menu,
  Notification,
  shell,
  protocol
} from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { DatabaseService } from '../src/services/database'
import { AudioCaptureService } from '../src/services/audioCapture'
import { TranscriptionService } from '../src/services/transcription'
import { DiarizationService } from '../src/services/diarization'
import { PyannoteService } from '../src/services/pyannote'
import { SummarizationService } from '../src/services/summarization'
import { createTray, destroyTray } from './tray'
import { getUpcomingMeetings, getUpcomingEvents, extractMeetingUrl } from './calendar'
import { SettingsManager } from './settings/SettingsManager'
import { PipelineManager } from './recording/PipelineManager'
import { RecordingOrchestrator } from './recording/RecordingOrchestrator'
import * as recordingHandlers from './ipc/recordingHandlers'
import * as meetingHandlers from './ipc/meetingHandlers'
import * as settingsHandlers from './ipc/settingsHandlers'

// ============================================================
// App configuration (must run before whenReady)
// ============================================================
app.setName('Muesli')

// Empêcher Chromium de throttler le renderer en arrière-plan (utile pour les timers UI).
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// Protocole muesli-audio:// — doit être déclaré avant app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'muesli-audio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// Résolution des chemins d'icônes
const iconPath = join(app.getAppPath(), 'build', 'icon.icns')
const dockIconPath = join(app.getAppPath(), 'build', 'icon-dock.png')

// Remplace le menu par défaut "Electron" par un menu "Muesli"
Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: 'Muesli',
      submenu: [
        { role: 'about', label: 'À propos de Muesli' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer Muesli' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter Muesli' }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'zoom', label: 'Zoom' },
        { type: 'separator' },
        { role: 'front', label: 'Tout ramener au premier plan' }
      ]
    }
  ])
)

// ============================================================
// Window management
// ============================================================
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    title: 'Muesli',
    backgroundColor: '#F7F6F3',
    icon: existsSync(dockIconPath) ? dockIconPath : existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Sans backgroundThrottling: false, les timers UI (durée, VU-meter) se figent
      // quand la fenêtre est en arrière-plan. La capture audio est désormais native.
      backgroundThrottling: false
    }
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  } else createWindow()
}

// ============================================================
// App ready
// ============================================================
app.whenReady().then(() => {
  // Icône dock — uniquement en dev
  if (app.dock) {
    const dockSrc = [iconPath, dockIconPath].find(p => existsSync(p))
    if (dockSrc) {
      app.dock.setIcon(nativeImage.createFromPath(dockSrc))
    }
  }

  // --- Database ---
  let database: DatabaseService
  try {
    database = new DatabaseService()
    database.initialize()
    console.log('[main] Base de données initialisée :', database.getPath())
  } catch (error) {
    console.error('[main] Erreur base de données :', error)
    dialog.showErrorBox('Erreur', `Base de données : ${String(error)}`)
    return
  }

  // --- Services ---
  const audioCapture = new AudioCaptureService()
  const transcription = new TranscriptionService()
  const diarization = new DiarizationService()
  const pyannote = new PyannoteService()
  const summarization = new SummarizationService()

  // --- Settings ---
  const settingsManager = new SettingsManager(database)
  settingsManager.migrateToEncrypted()

  // --- Pipeline ---
  const pipelineManager = new PipelineManager({
    database,
    get mainWindow() {
      return mainWindow
    },
    transcription,
    diarization,
    pyannote,
    summarization,
    settingsManager
  })

  // --- Tray callbacks (need forward ref to orchestrator) ---
  // Defined after orchestrator is created below; assigned once but referenced
  // by the tray closures above, so it cannot be a const.
  // eslint-disable-next-line prefer-const
  let orchestrator: RecordingOrchestrator

  const trayCallbacks = {
    onStartRecording: (title?: string) => orchestrator.startRecording(title),
    onStopRecording: () => orchestrator.stopRecording(),
    onOpenWindow: () => showWindow(),
    onQuit: () => app.quit()
  }

  // --- Recording ---
  orchestrator = new RecordingOrchestrator({
    database,
    get mainWindow() {
      return mainWindow
    },
    audioCapture,
    settingsManager,
    pipelineManager,
    trayCallbacks
  })

  // --- Audio protocol ---
  // Servir les fichiers audio WAV via muesli-audio://me/{meetingId} et muesli-audio://others/{meetingId}
  protocol.handle('muesli-audio', async request => {
    const url = new URL(request.url)
    const stream = url.hostname as 'me' | 'others'
    const meetingId = url.pathname.slice(1)

    const meeting = database.getMeeting(meetingId)
    if (!meeting || meeting.audioDeleted) return new Response('Audio supprimé', { status: 410 })

    const dirPath = stream === 'others' ? meeting.audioPathOthers : meeting.audioPathMe
    if (!dirPath || !existsSync(dirPath))
      return new Response('Fichier introuvable', { status: 404 })

    // Deux formats supportés :
    //   - nouveau : chunk_NNN.wav stéréo (L=micro/me, R=système/others)
    //   - legacy  : me_chunk_NNN.wav / others_chunk_NNN.wav (mono séparés)
    // Les chunks stéréo sont prioritaires ; on en extrait le canal demandé.
    const all = readdirSync(dirPath)
    const stereoChunks = all
      .filter(f => /^chunk_\d+\.wav$/.test(f))
      .sort()
      .map(f => join(dirPath, f))
    const legacyPrefix = stream === 'me' ? 'me_chunk_' : 'others_chunk_'
    const legacyChunks = all
      .filter(f => f.startsWith(legacyPrefix) && f.endsWith('.wav'))
      .sort()
      .map(f => join(dirPath, f))

    const chunks = stereoChunks.length > 0 ? stereoChunks : legacyChunks
    if (chunks.length === 0) return new Response('Aucun chunk audio', { status: 404 })

    // Canal à extraire d'un chunk stéréo : me = gauche (0), others = droite (1).
    const wantChannel = stream === 'others' ? 1 : 0

    const WAV_HEADER_SIZE = 44
    const pcmParts: Buffer[] = []
    let sampleRate = 16000

    for (const chunkPath of chunks) {
      const data = readFileSync(chunkPath)
      if (data.length <= WAV_HEADER_SIZE) continue
      const numChannels = data.readUInt16LE(22)
      if (pcmParts.length === 0) {
        sampleRate = data.readUInt32LE(24)
      }
      const pcm = data.subarray(WAV_HEADER_SIZE)
      if (numChannels === 2) {
        // Désentrelacer le PCM 16-bit stéréo → mono (canal demandé).
        const frameCount = Math.floor(pcm.length / 4)
        const mono = Buffer.alloc(frameCount * 2)
        const byteOffset = wantChannel * 2
        for (let i = 0; i < frameCount; i++) {
          mono[i * 2] = pcm[i * 4 + byteOffset]
          mono[i * 2 + 1] = pcm[i * 4 + byteOffset + 1]
        }
        pcmParts.push(mono)
      } else {
        pcmParts.push(pcm)
      }
    }

    const pcmData = Buffer.concat(pcmParts)
    const totalDataSize = pcmData.length

    const header = Buffer.alloc(WAV_HEADER_SIZE)
    header.write('RIFF', 0)
    header.writeUInt32LE(totalDataSize + 36, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(1, 22) // mono
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(totalDataSize, 40)

    const wav = Buffer.concat([header, pcmData])
    const totalLength = wav.length

    // Gestion des requêtes Range (seeking audio sans charger tout le fichier)
    const rangeHeader = request.headers.get('range')
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : totalLength - 1
        const safeEnd = Math.min(end, totalLength - 1)
        const chunk = wav.subarray(start, safeEnd + 1)
        return new Response(chunk, {
          status: 206,
          headers: {
            'Content-Type': 'audio/wav',
            'Content-Range': `bytes ${start}-${safeEnd}/${totalLength}`,
            'Content-Length': String(chunk.length),
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    return new Response(wav, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(totalLength),
        'Accept-Ranges': 'bytes'
      }
    })
  })

  // --- IPC handlers ---
  recordingHandlers.register({ orchestrator })
  meetingHandlers.register({
    database,
    get mainWindow() {
      return mainWindow
    },
    settingsManager,
    pipelineManager,
    orchestrator,
    summarization
  })
  settingsHandlers.register({ settingsManager })

  // --- Tray (created BEFORE window to guarantee menu bar presence) ---
  const settings = settingsManager.getSettings()
  createTray(trayCallbacks, settings.shortcut)

  // --- Window ---
  createWindow()
  // Libérer le micro quand la fenêtre se ferme pendant un enregistrement actif.
  // 'close' se déclenche avant destruction → le renderer est encore vivant et
  // peut recevoir le IPC recording:requestStop pour stopper getUserMedia.
  if (mainWindow) {
    mainWindow.on('close', () => {
      if (orchestrator.isRecording) void orchestrator.stopRecording()
    })
  }

  // --- Recovery ---
  pipelineManager.recoverOrphanedMeetings()

  // ============================================================
  // Calendar notifications — meeting alerts & draft pre-creation
  // ============================================================
  const notifiedMeetings = new Set<string>()

  async function checkUpcomingMeetings(): Promise<void> {
    if (orchestrator.isRecording) return

    try {
      const events = await getUpcomingMeetings()
      const now = Date.now()

      for (const event of events) {
        const start = new Date(event.startDate).getTime()
        const diff = start - now
        const key = `${event.title}@${event.startDate}`

        if (diff > 0 && diff <= 90000 && diff > 30000 && !notifiedMeetings.has(key)) {
          notifiedMeetings.add(key)
          const meetingUrl = extractMeetingUrl(event)

          const actions: Electron.NotificationAction[] = []
          if (meetingUrl) {
            actions.push({ type: 'button', text: 'Rejoindre' })
          }
          actions.push({ type: 'button', text: 'Enregistrer' })

          const notif = new Notification({
            title: 'Meeting dans 1 minute',
            body: event.title,
            silent: false,
            actions
          })

          notif.on('action', (_, actionIndex) => {
            if (meetingUrl && actionIndex === 0) {
              shell.openExternal(meetingUrl).catch(err => {
                console.error('[calendar] Erreur ouverture lien de réunion :', err)
              })
            } else {
              startRecordingWhenReady(event.title)
            }
          })

          notif.on('click', () => {
            startRecordingWhenReady(event.title)
          })

          notif.show()
          console.log(
            `[calendar] Notification : "${event.title}" dans 1 min` +
              (meetingUrl ? ` | lien : ${meetingUrl}` : ' | pas de lien trouvé')
          )
        }
      }

      // Nettoyer les events passés du set
      for (const key of notifiedMeetings) {
        const dateStr = key.split('@')[1]
        if (new Date(dateStr).getTime() < now - 3600000) {
          notifiedMeetings.delete(key)
        }
      }
    } catch (err) {
      console.warn('[calendar] Erreur vérification meetings :', err)
    }
  }

  async function cleanupStaleDrafts(): Promise<void> {
    try {
      const deleted = database.deleteStaleDrafts()
      if (deleted > 0) {
        console.log(`[calendar] ${deleted} draft(s) expiré(s) supprimé(s) (2h après fin)`)
        mainWindow?.webContents.send('meeting:updated')
      }
    } catch (err) {
      console.warn('[calendar] Erreur nettoyage drafts :', err)
    }
  }

  async function checkDraftMeetings(): Promise<void> {
    try {
      const upcoming = await getUpcomingEvents(6)
      for (const event of upcoming) {
        const calendarEventId = event.id || `${event.title}@${event.startDate}`
        const exists = database.meetingExistsForEvent(calendarEventId)
        if (!exists) {
          database.createDraftMeeting({
            title: event.title,
            date: event.startDate,
            attendees: event.attendees ?? [],
            calendarEventId,
            eventEnd: event.endDate
          })

          new Notification({
            title: 'Muesli',
            body: `"${event.title}" commence dans 5 minutes`
          }).show()

          mainWindow?.webContents.send('meeting:updated')
          console.log(`[calendar] Brouillon créé pour "${event.title}" (${event.startDate})`)
        }
      }
    } catch (err) {
      console.warn('[calendar] Erreur création brouillon :', err)
    }
  }

  // Démarre l'enregistrement en s'assurant que le renderer est prêt.
  function startRecordingWhenReady(title?: string): void {
    if (!mainWindow) {
      createWindow()
      mainWindow!.webContents.once('did-finish-load', () => {
        void orchestrator.startRecording(title)
      })
    } else {
      mainWindow.show()
      mainWindow.focus()
      void orchestrator.startRecording(title)
    }
  }

  const meetingNotifyTimer = setInterval(checkUpcomingMeetings, 30000)
  checkUpcomingMeetings()

  const draftMeetingTimer = setInterval(checkDraftMeetings, 60_000)
  checkDraftMeetings()

  const staleDraftTimer = setInterval(cleanupStaleDrafts, 5 * 60_000) // toutes les 5 min
  cleanupStaleDrafts()

  // ============================================================
  // App lifecycle
  // ============================================================
  app.on('before-quit', event => {
    if (orchestrator.isRecording || pipelineManager.pendingCount > 0) {
      event.preventDefault()
      const stopIfNeeded = orchestrator.isRecording
        ? orchestrator.stopRecording()
        : Promise.resolve()
      stopIfNeeded
        .then(() => pipelineManager.drainAll())
        .then(() => {
          clearInterval(meetingNotifyTimer)
          clearInterval(draftMeetingTimer)
          clearInterval(staleDraftTimer)
          destroyTray()
          database.close()
          app.exit(0)
        })
      return
    }
    clearInterval(meetingNotifyTimer)
    clearInterval(draftMeetingTimer)
    clearInterval(staleDraftTimer)
    destroyTray()
    database.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
