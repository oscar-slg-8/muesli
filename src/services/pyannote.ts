// ============================================================
// Service pyannoteAI — Transcription + Diarisation multi-speaker
//
// Utilise l'API pyannoteAI STT Orchestration pour obtenir en un
// seul appel : transcription Whisper + identification des locuteurs.
//
// Flow async : upload WAV → job créé → polling → résultat
// Doc : https://docs.pyannote.ai/tutorials/speech-to-text-diarization
// Prix : ~0.12 EUR/h (Developer plan, 125h/mois pour 19 EUR)
// ============================================================

import { readFileSync } from 'fs'
import { basename } from 'path'
import type { TranscriptSegment, DiarizationSegment } from '../types'

interface PyannoteWord {
  start: number
  end: number
  text: string
  speaker: string // "SPEAKER_00", "SPEAKER_01", etc.
  confidence: number
}

interface PyannoteUtterance {
  start: number
  end: number
  text: string
  speaker: string
  confidence: number
  words?: PyannoteWord[]
}

interface PyannoteJobResult {
  status: 'pending' | 'processing' | 'done' | 'failed'
  output?: {
    utterances: PyannoteUtterance[]
  }
  error?: string
}

interface PyannoteDiarizeJobResult {
  status: 'pending' | 'processing' | 'done' | 'failed'
  output?: {
    diarization: Array<{ start: number; end: number; speaker: string }>
  }
  error?: string
}

const PYANNOTE_API_BASE = 'https://api.pyannote.ai/v1'
const POLL_INTERVAL_MS = 2000
const MAX_POLL_ATTEMPTS = 150 // ~5 min max avant fallback Groq

// Même raison que dans transcription.ts : AbortSignal.timeout peu fiable dans Electron main
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export class PyannoteService {
  private apiKey: string = ''
  private language: string = 'fr'

  configure(apiKey: string, language: string = 'fr'): void {
    this.apiKey = apiKey
    this.language = language
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0
  }

  // Diarise un fichier WAV (sans transcription) via /v1/diarize.
  // Retourne uniquement les segments avec speaker, sans texte.
  async diarize(
    wavPath: string,
    chunkIndex: number,
    timeOffsetSeconds: number
  ): Promise<DiarizationSegment[]> {
    const jobId = await this.createDiarizeJob(wavPath)
    console.log(`[pyannote] Diarize job créé : ${jobId} pour ${basename(wavPath)}`)

    const result = await this.waitForDiarizeCompletion(jobId)

    if (!result.output?.diarization) {
      console.warn(`[pyannote] Aucune diarisation pour ${basename(wavPath)}`)
      return []
    }

    const speakerMap = new Map<string, number>()
    let nextIndex = 0

    return result.output.diarization.map(seg => {
      if (!speakerMap.has(seg.speaker)) {
        speakerMap.set(seg.speaker, nextIndex++)
      }
      return {
        start: seg.start + timeOffsetSeconds,
        end: seg.end + timeOffsetSeconds,
        speaker: `others_${speakerMap.get(seg.speaker)!}`,
        chunkIndex
      }
    })
  }

  private async createDiarizeJob(wavPath: string): Promise<string> {
    const buf = readFileSync(wavPath)
    const blob = new Blob([buf], { type: 'audio/wav' })

    const formData = new FormData()
    formData.append('audio', blob, basename(wavPath))

    const res = await fetchWithTimeout(
      `${PYANNOTE_API_BASE}/diarize`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData
      },
      60000
    )

    if (!res.ok) {
      const err = await res.text()
      if (res.status === 401)
        throw new Error('Clé API pyannoteAI invalide — vérifie-la dans les Réglages')
      if (res.status === 402)
        throw new Error('Crédit pyannoteAI insuffisant — vérifie ton plan sur pyannote.ai')
      throw new Error(`pyannoteAI diarize erreur ${res.status}: ${err}`)
    }

    const data = (await res.json()) as { jobId: string }
    return data.jobId
  }

  private async waitForDiarizeCompletion(jobId: string): Promise<PyannoteDiarizeJobResult> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const res = await fetchWithTimeout(
        `${PYANNOTE_API_BASE}/jobs/${jobId}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` }
        },
        10000
      )

      if (!res.ok) throw new Error(`pyannoteAI polling erreur ${res.status}`)

      const result = (await res.json()) as PyannoteDiarizeJobResult

      if (result.status === 'done') return result
      if (result.status === 'failed')
        throw new Error(`pyannoteAI diarize job échoué : ${result.error || 'raison inconnue'}`)

      const pollDelay = Math.min(15000, POLL_INTERVAL_MS * Math.pow(1.2, Math.floor(attempt / 30)))
      await new Promise(resolve => setTimeout(resolve, pollDelay))
    }

    throw new Error('pyannoteAI timeout : diarize job non terminé après 30 minutes')
  }

  // Transcrit et diarise un fichier WAV en un seul appel.
  // Retourne des segments avec speaker = 'others_0', 'others_1', etc.
  async transcribeAndDiarize(
    wavPath: string,
    chunkIndex: number,
    timeOffsetSeconds: number
  ): Promise<TranscriptSegment[]> {
    // 1. Upload du fichier et création du job
    const jobId = await this.createJob(wavPath)
    console.log(`[pyannote] Job créé : ${jobId} pour ${basename(wavPath)}`)

    // 2. Polling jusqu'à complétion
    const result = await this.waitForCompletion(jobId)

    if (!result.output?.utterances) {
      console.warn(`[pyannote] Aucun résultat pour ${basename(wavPath)}`)
      return []
    }

    // 3. Mapper les speakers pyannote (SPEAKER_00, SPEAKER_01) vers nos labels (others_0, others_1)
    const speakerMap = new Map<string, number>()
    let nextSpeakerIndex = 0

    return result.output.utterances
      .filter(u => u.text.trim().length > 0)
      .map(u => {
        if (!speakerMap.has(u.speaker)) {
          speakerMap.set(u.speaker, nextSpeakerIndex++)
        }
        const speakerIndex = speakerMap.get(u.speaker)!

        return {
          id: 0,
          meetingId: '',
          speaker: `others_${speakerIndex}`,
          startTime: u.start + timeOffsetSeconds,
          endTime: u.end + timeOffsetSeconds,
          text: u.text.trim(),
          chunkIndex,
          confidence: u.confidence ?? null,
          isOverlap: false
        }
      })
  }

  private async createJob(wavPath: string): Promise<string> {
    const buf = readFileSync(wavPath)
    const blob = new Blob([buf], { type: 'audio/wav' })

    const formData = new FormData()
    formData.append('audio', blob, basename(wavPath))

    const res = await fetchWithTimeout(
      `${PYANNOTE_API_BASE}/transcribe`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData
      },
      60000
    )

    if (!res.ok) {
      const err = await res.text()
      if (res.status === 401)
        throw new Error('Clé API pyannoteAI invalide — vérifie-la dans les Réglages')
      if (res.status === 402)
        throw new Error('Crédit pyannoteAI insuffisant — vérifie ton plan sur pyannote.ai')
      throw new Error(`pyannoteAI erreur ${res.status}: ${err}`)
    }

    const data = (await res.json()) as { jobId: string }
    return data.jobId
  }

  private async waitForCompletion(jobId: string): Promise<PyannoteJobResult> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const res = await fetchWithTimeout(
        `${PYANNOTE_API_BASE}/jobs/${jobId}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` }
        },
        10000
      )

      if (!res.ok) {
        throw new Error(`pyannoteAI polling erreur ${res.status}`)
      }

      const result = (await res.json()) as PyannoteJobResult

      if (result.status === 'done') {
        return result
      }

      if (result.status === 'failed') {
        throw new Error(`pyannoteAI job échoué : ${result.error || 'raison inconnue'}`)
      }

      // Backoff exponentiel : 2s pour les 30 premières tentatives, puis +20% par tranche de 30, cap 15s
      // Évite de saturer l'API pour les jobs longs (chunks de 10 min) tout en restant réactif au début
      const pollDelay = Math.min(15000, POLL_INTERVAL_MS * Math.pow(1.2, Math.floor(attempt / 30)))
      await new Promise(resolve => setTimeout(resolve, pollDelay))
    }

    throw new Error('pyannoteAI timeout : job non terminé après 30 minutes')
  }
}
