// ============================================================
// PipelineManager — transcription + résumé + recovery + cleanup
//
// Nouveau pipeline (stéréo / AEC / diarisation séparée) :
//   1. Merge me+others → stéréo (si format legacy) ou chunk natif stéréo
//   2. AEC ffmpeg aechocancel (écho éliminé en audio)
//   3. Extraction canaux mono (L=mic, R=system)
//   4. Canal gauche (me) → Whisper large-v3 direct
//   5. Canal droit (others) → Pyannote /v1/diarize → Whisper large-v3 par segment
//   6. consolidateToTurns(maxGap=1.5s)
// ============================================================

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import { DatabaseService } from '../../src/services/database'
import { TranscriptionService } from '../../src/services/transcription'
import { DiarizationService } from '../../src/services/diarization'
import { PyannoteService } from '../../src/services/pyannote'
import { SummarizationService } from '../../src/services/summarization'
import { hasSpeech } from '../../src/services/vad'
import type { TranscriptSegment, TranscriptionProgress, DiarizationSegment } from '../../src/types'
import type { SettingsManager } from '../settings/SettingsManager'
import { NormalizationService } from '../services/NormalizationService'

export interface PipelineDeps {
  database: DatabaseService
  mainWindow: BrowserWindow | null
  transcription: TranscriptionService
  diarization: DiarizationService
  pyannote: PyannoteService
  summarization: SummarizationService
  settingsManager: SettingsManager
}

// ── Utilitaire ffmpeg (promesse) ────────────────────────────────────────────

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (code=${code}): ${stderr.slice(-600)}`))
    })
    proc.on('error', reject)
  })
}

function tmpWav(): string {
  return join(tmpdir(), `muesli_${randomUUID()}.wav`)
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* ignore */
  }
}

// ── PipelineManager ─────────────────────────────────────────────────────────

export class PipelineManager {
  private deps: PipelineDeps
  private activePipelines = new Set<Promise<void>>()
  private normalization = new NormalizationService()

  currentProgress: TranscriptionProgress | null = null

  constructor(deps: PipelineDeps) {
    this.deps = deps
    this.normalization.initialize()
  }

  private sendToRenderer(channel: string, ...args: unknown[]): void {
    this.deps.mainWindow?.webContents.send(channel, ...args)
  }

  trackPipeline(p: Promise<void>): void {
    this.activePipelines.add(p)
    p.finally(() => this.activePipelines.delete(p))
  }

  get pendingCount(): number {
    return this.activePipelines.size
  }

  async drainAll(): Promise<void> {
    await Promise.allSettled([...this.activePipelines])
  }

  // ============================================================
  // Audio cleanup
  // ============================================================
  cleanupAudioIfNeeded(meetingId: string): void {
    const { database, settingsManager } = this.deps
    const settings = settingsManager.getSettings()
    if (!settings.deleteAudioAfterTranscription) return

    const meeting = database.getMeeting(meetingId)
    if (!meeting) return

    const audioDir =
      meeting.audioPathMe && existsSync(meeting.audioPathMe)
        ? meeting.audioPathMe
        : join(app.getPath('userData'), 'audio', meetingId)
    if (existsSync(audioDir)) {
      try {
        rmSync(audioDir, { recursive: true, force: true })
        database.updateMeeting(meetingId, { audio_deleted: 1 })
        console.log(`[main] Audio supprimé pour ${meetingId} : ${audioDir}`)
      } catch (err) {
        console.error(`[main] Erreur suppression audio ${meetingId}:`, err)
      }
    }
  }

  // ============================================================
  // Préparation audio : merge stéréo + AEC + extraction canaux
  // ============================================================

  private async mergeToStereo(mePath: string, othersPath: string): Promise<string> {
    const out = tmpWav()
    await runFfmpeg([
      '-i',
      mePath,
      '-i',
      othersPath,
      '-filter_complex',
      '[0:a][1:a]amerge=inputs=2',
      '-ar',
      '16000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      out
    ])
    return out
  }

  private async applyAEC(stereoPath: string): Promise<string> {
    const out = tmpWav()
    await runFfmpeg([
      '-i',
      stereoPath,
      '-filter_complex',
      '[0:a]channelsplit=channel_layout=stereo[mic][ref];[mic][ref]aechocancel=length=100:onset=16000[clean];[clean][ref]amerge[out]',
      '-map',
      '[out]',
      '-ar',
      '16000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      out
    ])
    return out
  }

  private async extractMono(stereoPath: string, channel: 0 | 1): Promise<string> {
    const out = tmpWav()
    // Note: -map_channel was removed in ffmpeg 7+; use pan filter instead
    const channelName = channel === 0 ? 'FL' : 'FR'
    await runFfmpeg([
      '-i',
      stereoPath,
      '-af',
      `pan=mono|c0=${channelName}`,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      out
    ])
    return out
  }

  private async extractSlice(monoPath: string, startRel: number, endRel: number): Promise<string> {
    const out = tmpWav()
    await runFfmpeg([
      '-i',
      monoPath,
      '-ss',
      String(startRel),
      '-to',
      String(endRel),
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      out
    ])
    return out
  }

  // Crée un stéréo L=mono, R=silence (quand l'audio système est absent).
  private async mergeMonoToFakeStereo(monoPath: string): Promise<string> {
    const out = tmpWav()
    await runFfmpeg([
      '-i',
      monoPath,
      '-filter_complex',
      '[0:a]channelmap=0|0[out]',
      '-map',
      '[out]',
      '-ar',
      '16000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      out
    ])
    return out
  }

  // ============================================================
  // Transcription par segment diarisé
  // ============================================================

  private async transcribeSegments(
    othersMonoPath: string,
    diarizationSegs: DiarizationSegment[],
    timeOffsetSeconds: number
  ): Promise<TranscriptSegment[]> {
    const { transcription } = this.deps
    const results: TranscriptSegment[] = []

    for (const seg of diarizationSegs) {
      const startRel = seg.start - timeOffsetSeconds
      const endRel = seg.end - timeOffsetSeconds
      if (endRel - startRel < 0.3) continue

      const slicePath = await this.extractSlice(othersMonoPath, startRel, endRel)
      try {
        const words = await transcription.transcribeSlice(slicePath, seg)
        if (words.length === 0) continue

        const text = words
          .map(w => w.word)
          .join(' ')
          .trim()
        if (!text) continue

        const avgProb = words.reduce((acc, w) => acc + w.probability, 0) / words.length
        results.push({
          id: 0,
          meetingId: '',
          speaker: seg.speaker,
          startTime: seg.start,
          endTime: seg.end,
          text,
          words,
          chunkIndex: seg.chunkIndex,
          confidence: avgProb,
          isOverlap: false
        })
      } finally {
        safeUnlink(slicePath)
      }
    }

    return results
  }

  // ============================================================
  // Transcription pipeline
  //
  // Accepte deux formats :
  //   string[]                       — chunks stéréo natifs (nouveau format)
  //   { me: string[]; others: string[] } — format legacy (recovery anciens meetings)
  // ============================================================
  async processTranscription(
    meetingId: string,
    input: string[] | { me: string[]; others: string[] },
    durationSeconds: number
  ): Promise<void> {
    const isStereo = Array.isArray(input)
    const stereoChunks = isStereo ? (input as string[]) : []
    const legacyMe = isStereo ? [] : (input as { me: string[]; others: string[] }).me
    const legacyOthers = isStereo ? [] : (input as { me: string[]; others: string[] }).others
    const totalChunks = isStereo ? stereoChunks.length : legacyMe.length

    const { database, transcription, diarization, pyannote, summarization, settingsManager } =
      this.deps
    const settings = settingsManager.getSettings()

    // Priorité : langue de la réunion (définie par l'utilisateur via le toggle FR/EN)
    // Fallback : langue globale des réglages
    const meeting = database.getMeeting(meetingId)
    const meetingLanguage = meeting?.language ?? settings.language

    const transcriptionKey =
      settings.transcriptionProvider === 'mistral' ? settings.apiKeyMistral : settings.apiKeyGroq
    const summaryKey =
      settings.summaryProvider === 'mistral' ? settings.apiKeyMistral : settings.apiKeyAnthropic
    transcription.configure(transcriptionKey, meetingLanguage, settings.transcriptionProvider)
    pyannote.configure(settings.apiKeyPyannote, meetingLanguage)
    summarization.configure(summaryKey, settings.summaryProvider)

    const usePyannote = pyannote.isAvailable()
    console.log(
      `[main] Pipeline ${isStereo ? 'stéréo' : 'legacy'}: usePyannote=${usePyannote}, chunks=${totalChunks}, lang=${meetingLanguage}`
    )

    const promptParts: string[] = []
    if (meeting?.title) promptParts.push(meeting.title)
    if (settings.speakerMeName) promptParts.push(settings.speakerMeName)
    if (settings.speakerOthersName) promptParts.push(settings.speakerOthersName)
    if (promptParts.length > 0) {
      const contextPrefix = meetingLanguage === 'en' ? 'Meeting' : 'Réunion'
      transcription.setPromptContext(`${contextPrefix} : ${promptParts.join(', ')}`)
    }

    if (!transcription.isAvailable()) {
      database.updateMeeting(meetingId, {
        status: 'error',
        error_message: 'Clé API de transcription manquante — configure-la dans les Réglages'
      })
      this.sendToRenderer('meeting:updated', meetingId)
      return
    }

    const chunkDuration = 600
    let processedChunks = 0
    const allMeSegments: TranscriptSegment[] = []
    const allOthersSegments: TranscriptSegment[] = []

    for (let i = 0; i < totalChunks; i++) {
      this.currentProgress = {
        meetingId,
        currentChunk: processedChunks + 1,
        totalChunks,
        percent: Math.round((processedChunks / totalChunks) * 80),
        currentStep: `Traitement chunk ${i + 1}/${totalChunks}`
      }
      this.sendToRenderer('transcription:progress', this.currentProgress)

      const timeOffset = i * chunkDuration
      const tempFiles: string[] = []

      try {
        // ── Étape 1 : Obtenir un fichier stéréo ───────────────────────────
        let stereoPath: string
        let stereoIsTemp = false

        if (isStereo) {
          stereoPath = stereoChunks[i]
        } else {
          // Format legacy : fusionner me + others
          const othersPath = legacyOthers[i] ?? ''
          const hasOthers = othersPath && existsSync(othersPath)
          if (hasOthers) {
            stereoPath = await this.mergeToStereo(legacyMe[i], othersPath)
          } else {
            stereoPath = await this.mergeMonoToFakeStereo(legacyMe[i])
          }
          stereoIsTemp = true
          tempFiles.push(stereoPath)
        }

        // ── Étape 2 : AEC ────────────────────────────────────────────────
        let cleanPath: string
        try {
          cleanPath = await this.applyAEC(stereoPath)
          tempFiles.push(cleanPath)
        } catch (aecErr) {
          console.warn(`[main] AEC échoué (${aecErr}), skip AEC`)
          cleanPath = stereoPath
          stereoIsTemp = false // ne pas supprimer le stéréo natif en cas d'échec AEC
        }
        void stereoIsTemp // utilisé implicitement via tempFiles

        // ── Étape 3 : Extraction canaux mono ─────────────────────────────
        const meMono = await this.extractMono(cleanPath, 0)
        tempFiles.push(meMono)

        // ── Étape 4 : Canal "me" → Whisper large-v3 ──────────────────────
        if (hasSpeech(meMono, { energyThreshold: 0.003 })) {
          console.log(`[main] me chunk ${i}: transcription (offset ${timeOffset}s)`)
          try {
            const normalizedMe = await this.normalization.normalizeForTranscription(meMono)
            const meSegs = await transcription.transcribeFile(normalizedMe, 'me', i, timeOffset)
            this.normalization.cleanup(normalizedMe, meMono)
            allMeSegments.push(...meSegs)
            console.log(`[main] me chunk ${i}: ${meSegs.length} segments`)
          } catch (err) {
            console.error(`[main] Erreur transcription me chunk ${i}:`, err)
          }
        } else {
          console.log(`[main] me chunk ${i}: aucune parole (VAD), skip`)
        }

        // ── Étape 5 : Canal "others" ──────────────────────────────────────
        // On vérifie si le chunk stéréo d'origine avait un vrai canal droit.
        // Pour un chunk stéréo natif (isAlreadyStereo=true) on extrait toujours.
        // Pour un fake-stéréo (mono mic dupliqué) on ignore le canal droit.
        const chunkHasOthers = isStereo || (legacyOthers[i] && existsSync(legacyOthers[i]))

        if (chunkHasOthers) {
          const othersMono = await this.extractMono(cleanPath, 1)
          tempFiles.push(othersMono)

          if (!hasSpeech(othersMono, { energyThreshold: 0.003 })) {
            console.log(`[main] others chunk ${i}: aucune parole (VAD), skip`)
          } else if (usePyannote) {
            try {
              this.currentProgress = {
                meetingId,
                currentChunk: processedChunks + 1,
                totalChunks,
                percent: Math.round((processedChunks / totalChunks) * 80),
                currentStep: `Diarisation chunk ${i + 1}/${totalChunks}…`
              }
              this.sendToRenderer('transcription:progress', this.currentProgress)

              const diarSegs = await pyannote.diarize(othersMono, i, timeOffset)
              console.log(`[main] pyannote chunk ${i}: ${diarSegs.length} segments diarisés`)

              this.currentProgress = {
                meetingId,
                currentChunk: processedChunks + 1,
                totalChunks,
                percent: Math.round((processedChunks / totalChunks) * 80),
                currentStep: `Transcription par segment chunk ${i + 1}/${totalChunks}…`
              }
              this.sendToRenderer('transcription:progress', this.currentProgress)

              const othersSegs = await this.transcribeSegments(othersMono, diarSegs, timeOffset)
              allOthersSegments.push(...othersSegs)
              console.log(
                `[main] others chunk ${i}: ${othersSegs.length} segments, speakers: ${new Set(othersSegs.map(s => s.speaker)).size}`
              )
            } catch (pyannoteErr) {
              console.warn(`[main] Pyannote chunk ${i} échoué (${pyannoteErr}), fallback Groq`)
              try {
                const normalizedOthers =
                  await this.normalization.normalizeForTranscription(othersMono)
                const othersSegs = await transcription.transcribeFile(
                  normalizedOthers,
                  'others',
                  i,
                  timeOffset
                )
                this.normalization.cleanup(normalizedOthers, othersMono)
                allOthersSegments.push(...othersSegs)
                console.log(`[main] fallback Groq others chunk ${i}: ${othersSegs.length} segments`)
              } catch (fbErr) {
                console.error(`[main] Fallback Groq chunk ${i} échoué:`, fbErr)
              }
            }
          } else {
            try {
              const normalizedOthers =
                await this.normalization.normalizeForTranscription(othersMono)
              const othersSegs = await transcription.transcribeFile(
                normalizedOthers,
                'others',
                i,
                timeOffset
              )
              this.normalization.cleanup(normalizedOthers, othersMono)
              allOthersSegments.push(...othersSegs)
              console.log(`[main] others chunk ${i} (Groq): ${othersSegs.length} segments`)
            } catch (err) {
              console.error(`[main] Erreur transcription others chunk ${i}:`, err)
            }
          }
        }
      } catch (err) {
        console.error(`[main] Erreur traitement chunk ${i}:`, err)
      } finally {
        for (const f of tempFiles) safeUnlink(f)
        processedChunks++
      }
    }

    // ── Merge & consolidation ─────────────────────────────────────────────
    this.currentProgress = {
      meetingId,
      currentChunk: totalChunks,
      totalChunks,
      percent: 85,
      currentStep: 'Fusion des flux…'
    }
    this.sendToRenderer('transcription:progress', this.currentProgress)

    const mergedSegments = usePyannote
      ? diarization.mergePreDiarized(allMeSegments, allOthersSegments)
      : diarization.merge(allMeSegments, allOthersSegments)

    database.addSegments(
      meetingId,
      mergedSegments.map(s => ({
        ...s,
        meetingId,
        words_json: s.words ? JSON.stringify(s.words) : undefined
      }))
    )

    this.sendToRenderer('transcription:complete', meetingId)
    console.log(`[main] Transcription terminée : ${mergedSegments.length} segments`)

    // ── Résumé IA ─────────────────────────────────────────────────────────
    database.updateMeeting(meetingId, { status: 'summarizing' })
    this.sendToRenderer('meeting:updated', meetingId)

    this.currentProgress = {
      meetingId,
      currentChunk: totalChunks,
      totalChunks,
      percent: 90,
      currentStep: 'Génération du résumé…'
    }
    this.sendToRenderer('transcription:progress', this.currentProgress)

    if (summarization.isAvailable() && mergedSegments.length > 0) {
      const meetingForSummary = database.getMeeting(meetingId)
      try {
        const speakerNames = database.getSpeakerNames(meetingId)
        const userNotes = meetingForSummary?.notesMarkdown || ''
        const summary = await summarization.summarize(
          mergedSegments,
          settings.speakerMeName,
          settings.speakerOthersName,
          durationSeconds,
          settings.summaryPrompt,
          meetingLanguage,
          speakerNames,
          userNotes
        )
        const titleMatch = summary.match(/##\s*Titre\s*\n+(.+)/i)
        const aiTitle = titleMatch ? titleMatch[1].trim().replace(/^#+\s*/, '') : null
        const title =
          aiTitle ||
          meetingForSummary?.title ||
          `Réunion du ${new Date().toLocaleDateString('fr-FR')}`
        database.updateMeeting(meetingId, {
          status: 'complete',
          summary_markdown: summary,
          summary_model: summarization.modelLabel,
          title
        })
        this.cleanupAudioIfNeeded(meetingId)
        this.sendToRenderer('summarization:complete', meetingId)
      } catch (err) {
        console.error('[main] Erreur résumé :', err)
        const fallbackTitle =
          database.getMeeting(meetingId)?.title ||
          `Réunion du ${new Date().toLocaleDateString('fr-FR')}`
        database.updateMeeting(meetingId, {
          status: 'error',
          title: fallbackTitle,
          error_message: `Résumé échoué : ${String(err)}`
        })
      }
    } else {
      const m = database.getMeeting(meetingId)
      database.updateMeeting(meetingId, {
        status: 'complete',
        title: m?.title || `Réunion du ${new Date().toLocaleDateString('fr-FR')}`,
        error_message: summarization.isAvailable()
          ? undefined
          : 'Clé API de résumé manquante — résumé en attente'
      })
      this.cleanupAudioIfNeeded(meetingId)
    }

    this.currentProgress = null
    this.sendToRenderer('meeting:updated', meetingId)
    console.log(`[main] Pipeline terminé pour ${meetingId}`)
  }

  // ============================================================
  // Crash recovery
  // Supporte les deux formats de chunks (stéréo natif + legacy me/others)
  // ============================================================
  recoverOrphanedMeetings(): void {
    const { database } = this.deps
    const meetings = database.listMeetings()

    for (const m of meetings) {
      if (m.status !== 'recording' && m.status !== 'transcribing' && m.status !== 'summarizing')
        continue

      const audioDir =
        m.audioPathMe && existsSync(m.audioPathMe)
          ? m.audioPathMe
          : join(app.getPath('userData'), 'audio', m.id)

      if (!existsSync(audioDir)) {
        database.updateMeeting(m.id, {
          status: 'error',
          error_message: `${m.status === 'recording' ? 'Enregistrement' : 'Transcription'} interrompu(e) — dossier audio introuvable`
        })
        continue
      }

      const all = readdirSync(audioDir)
      // Priorité : chunks stéréo natifs (nouveau format)
      const stereoFiles = all
        .filter(f => /^chunk_\d+\.wav$/.test(f))
        .map(f => join(audioDir, f))
        .sort()
      // Fallback : format legacy me/others
      const meFiles = all
        .filter(f => f.startsWith('me_chunk_') && f.endsWith('.wav'))
        .map(f => join(audioDir, f))
        .sort()
      const othersFiles = all
        .filter(f => f.startsWith('others_chunk_') && f.endsWith('.wav'))
        .map(f => join(audioDir, f))
        .sort()

      const hasChunks = stereoFiles.length > 0 || meFiles.length > 0

      if (!hasChunks) {
        database.updateMeeting(m.id, {
          status: 'error',
          error_message: 'Enregistrement interrompu — aucun audio récupérable'
        })
        continue
      }

      const input: string[] | { me: string[]; others: string[] } =
        stereoFiles.length > 0 ? stereoFiles : { me: meFiles, others: othersFiles }

      const format = stereoFiles.length > 0 ? 'stéréo' : 'legacy'
      const count = stereoFiles.length > 0 ? stereoFiles.length : meFiles.length
      console.log(`[recovery] Meeting ${m.id} (${m.status}) — relance ${format} (${count} chunks)`)

      database.updateMeeting(m.id, { status: 'transcribing' })
      this.sendToRenderer('meeting:updated', m.id)
      this.trackPipeline(
        this.processTranscription(m.id, input, m.durationSeconds || 0).catch(err => {
          console.error(`[recovery] Échec transcription ${m.id}:`, err)
          this.currentProgress = null
          database.updateMeeting(m.id, {
            status: 'error',
            error_message: `Recovery échoué : ${String(err)}`
          })
          this.sendToRenderer('meeting:updated', m.id)
        })
      )
    }
  }
}
