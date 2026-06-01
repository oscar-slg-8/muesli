// ============================================================
// Service de transcription — Groq Whisper API
//
// Envoie chaque chunk WAV à l'API Groq (whisper-large-v3-turbo)
// et retourne les segments avec timestamps.
// Modèle : whisper-large-v3-turbo → qualité excellente, très rapide
// Coût : ~$0.002/min (free tier : 2h audio/jour)
// ============================================================

import { readFileSync } from 'fs'
import { basename } from 'path'
import type { TranscriptSegment, DiarizationSegment, WordTimestamp } from '../types'

interface GroqSegment {
  id: number
  start: number
  end: number
  text: string
  avg_logprob: number
  no_speech_prob: number
}

interface GroqResponse {
  task: string
  language: string
  duration: number
  segments: GroqSegment[]
  text: string
}

interface GroqVerboseResponse extends GroqResponse {
  words?: Array<{ word: string; start: number; end: number; probability: number }>
}

interface WhisperFilterConfig {
  noSpeechProbThreshold: number
  avgLogprobThreshold: number
}

const LANGUAGE_THRESHOLDS: Record<string, WhisperFilterConfig> = {
  fr: { noSpeechProbThreshold: 0.7, avgLogprobThreshold: -1.5 },
  en: { noSpeechProbThreshold: 0.6, avgLogprobThreshold: -1.3 }
}
const DEFAULT_THRESHOLDS: WhisperFilterConfig = {
  noSpeechProbThreshold: 0.65,
  avgLogprobThreshold: -1.4
}

// ── Vocabulaire bilingue FR/EN injecté dans le prompt Whisper ──
//
// Whisper utilise le prompt comme contexte de décodage (temperature=0).
// En listant les termes anglais dans leur orthographe correcte, on empêche
// la phonétisation française ("aile" → "l'oeil", "dipo" → "Divo", etc.).
// La liste couvre le vocabulaire startup/tech/business courant en France.
//
// Référence : https://platform.openai.com/docs/guides/speech-to-text/prompting
// Prompt FR : injecté dans Whisper pour éviter la phonétisation des anglicismes
const FRENCH_VOCAB_PROMPT = `Réunion d'affaires en français avec termes techniques anglais.
Vocabulaire attendu : startup, fundraising, pitch deck, roadmap, product-market fit, MRR, ARR, churn, LTV, CAC, burn rate, runway, KPI, OKR, go-to-market, B2B, B2C, SaaS, API, MVP, sprint, backlog, scalable, growth hacking, A/B testing, funnel, onboarding, offboarding, feedback loop, deep dive, brainstorming, workshop, benchmark, due diligence, term sheet, cap table, bootstrapped, pre-seed, seed, Series A, angel investor, VC, leverage, pipeline, closing, upsell, cross-sell, landing page, conversion rate, retention, cohort, dashboard, analytics, framework, compliance, ROI, P&L, EBITDA, headcount.
Noms de sociétés, produits et personnes sont en majuscules.`

// Prompt EN : aide Whisper à bien orthographier le vocabulaire business anglais
const ENGLISH_VOCAB_PROMPT = `Business meeting in English.
Expected vocabulary: startup, fundraising, pitch deck, roadmap, product-market fit, MRR, ARR, churn, LTV, CAC, burn rate, runway, KPI, OKR, go-to-market, B2B, B2C, SaaS, API, MVP, sprint, backlog, scalable, growth hacking, A/B testing, funnel, onboarding, offboarding, feedback loop, deep dive, brainstorming, workshop, benchmark, due diligence, term sheet, cap table, bootstrapped, pre-seed, seed, Series A, angel investor, VC, leverage, pipeline, closing, upsell, cross-sell, landing page, conversion rate, retention, cohort, dashboard, analytics, framework, compliance, ROI, P&L, EBITDA, headcount.
Company names, products, and people are capitalized.`

// AbortSignal.timeout() est peu fiable dans le processus principal d'Electron
// (le timer peut ne pas se déclencher si la boucle d'événements est occupée sur
// des I/O réseau). On utilise AbortController + setTimeout natif à la place.
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// Retry sur les erreurs réseau et les erreurs transitoires de l'API Groq.
// On ne retente PAS sur les erreurs permanentes (400, 401, 413).
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 2000): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err)
      const isTransient =
        msg.includes('fetch') ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('429') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503')
      if (!isTransient || attempt === maxAttempts) throw err
      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      console.warn(
        `[transcription] Tentative ${attempt}/${maxAttempts} échouée, retry dans ${delay}ms`
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

export class TranscriptionService {
  private apiKey: string = ''
  private language: string = 'fr'

  configure(apiKey: string, language: string = 'fr'): void {
    this.apiKey = apiKey
    this.language = language
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0
  }

  // Contexte spécifique à la réunion (titre, noms des participants, sujet)
  // Complète le vocabulaire bilingue de base.
  private promptContext: string = ''

  setPromptContext(context: string): void {
    this.promptContext = context
  }

  async transcribeFile(
    wavPath: string,
    speaker: 'me' | 'others',
    chunkIndex: number,
    timeOffsetSeconds: number
  ): Promise<TranscriptSegment[]> {
    const buf = readFileSync(wavPath)
    const blob = new Blob([buf], { type: 'audio/wav' })

    const formData = new FormData()
    formData.append('file', blob, basename(wavPath))
    formData.append('model', 'whisper-large-v3')
    formData.append('response_format', 'verbose_json')
    formData.append('language', this.language)
    // temperature=0 : sortie déterministe → élimine les hallucinations sur silences/bruits.
    // Sans ce paramètre, Whisper génère du texte aléatoire quand l'audio est peu clair.
    formData.append('temperature', '0')

    // Prompt Whisper = vocabulaire de base (FR ou EN) + contexte spécifique à la réunion.
    // Le prompt est utilisé comme texte d'amorçage pour le décodage (température=0) :
    // les mots présents dans le prompt sont fortement favorisés → moins de phonétisation
    // des anglicismes en français, meilleure reconnaissance des noms propres.
    const vocabPrompt = this.language === 'en' ? ENGLISH_VOCAB_PROMPT : FRENCH_VOCAB_PROMPT
    const contextLabel = this.language === 'en' ? 'Context' : 'Contexte'
    const fullPrompt = this.promptContext
      ? `${vocabPrompt}\n${contextLabel} : ${this.promptContext}`
      : vocabPrompt
    formData.append('prompt', fullPrompt)

    const fileSizeKB = Math.round(buf.byteLength / 1024)
    console.log(
      `[transcription] Envoi Groq : ${basename(wavPath)} (${fileSizeKB} KB, speaker=${speaker}, offset=${timeOffsetSeconds}s)`
    )

    const data = await withRetry(async () => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: formData
        },
        180000
      ) // 3 min max
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Groq API erreur ${res.status}: ${body}`)
      }
      return res.json() as Promise<GroqResponse>
    })

    console.log(
      `[transcription] Groq réponse : ${data.segments?.length ?? 0} segments bruts, durée audio=${data.duration?.toFixed(1)}s`
    )

    const thresholds = LANGUAGE_THRESHOLDS[this.language] ?? DEFAULT_THRESHOLDS
    const filtered = (data.segments || []).filter(s => {
      const text = s.text.trim()
      if (text.length === 0) return false
      if (s.no_speech_prob > thresholds.noSpeechProbThreshold) return false
      if (s.avg_logprob < thresholds.avgLogprobThreshold) return false
      return true
    })

    const removedCount = (data.segments?.length ?? 0) - filtered.length
    if (removedCount > 0) {
      console.log(`[transcription] ${removedCount} segments filtrés (no_speech ou logprob faible)`)
    }

    const mapped: TranscriptSegment[] = filtered.map(s => ({
      id: 0,
      meetingId: '',
      speaker,
      startTime: s.start + timeOffsetSeconds,
      endTime: s.end + timeOffsetSeconds,
      text: s.text.trim(),
      chunkIndex,
      confidence: s.avg_logprob ? Math.exp(s.avg_logprob) : null,
      isOverlap: false
    }))

    return this.mergeShortSegments(mapped)
  }

  // Transcrit une tranche audio (extrait d'un segment diarisé) et retourne les
  // timestamps mot par mot. Les timestamps sont réajustés en temps absolu de meeting.
  async transcribeSlice(slicePath: string, seg: DiarizationSegment): Promise<WordTimestamp[]> {
    const buf = readFileSync(slicePath)
    const blob = new Blob([buf], { type: 'audio/wav' })

    const formData = new FormData()
    formData.append('file', blob, basename(slicePath))
    formData.append('model', 'whisper-large-v3')
    formData.append('response_format', 'verbose_json')
    formData.append('timestamp_granularities[]', 'word')
    formData.append('timestamp_granularities[]', 'segment')
    formData.append('language', this.language)
    formData.append('temperature', '0')
    const vocabPromptSlice = this.language === 'en' ? ENGLISH_VOCAB_PROMPT : FRENCH_VOCAB_PROMPT
    const contextLabelSlice = this.language === 'en' ? 'Context' : 'Contexte'
    formData.append(
      'prompt',
      this.promptContext
        ? `${vocabPromptSlice}\n${contextLabelSlice} : ${this.promptContext}`
        : vocabPromptSlice
    )

    const data = await withRetry(async () => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: formData
        },
        30000
      ) // 30s max par slice (courte durée, Groq répond en < 5s normalement)
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Groq API erreur ${res.status}: ${body}`)
      }
      return res.json() as Promise<GroqVerboseResponse>
    })

    return (data.words ?? []).map(w => ({
      word: w.word,
      start: w.start + seg.start,
      end: w.end + seg.start,
      probability: w.probability
    }))
  }

  // Fusionne les segments consécutifs trop courts pour être des phrases complètes.
  //
  // Whisper sur de l'audio fragmenté (courtes rafales de parole) produit
  // beaucoup de segments de 1-3 secondes au lieu de phrases naturelles.
  // On les regroupe tant qu'ils sont proches et courts.
  //
  // Critères de fusion :
  //   - Gap entre deux segments < GAP_MAX_S (0.8s)
  //   - Texte cumulé < MAX_WORDS mots (on arrête de fusionner au-delà)
  private mergeShortSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length <= 1) return segments

    const GAP_MAX_S = 0.8 // écart max entre deux segments à fusionner
    const MAX_WORDS = 40 // ne pas créer de blocs trop longs

    const result: TranscriptSegment[] = []
    let current = { ...segments[0] }

    for (let i = 1; i < segments.length; i++) {
      const next = segments[i]
      const gap = next.startTime - current.endTime
      const currentWords = current.text.split(/\s+/).length
      const nextWords = next.text.split(/\s+/).length

      if (gap <= GAP_MAX_S && currentWords + nextWords <= MAX_WORDS) {
        current = {
          ...current,
          endTime: next.endTime,
          text: current.text.trimEnd() + ' ' + next.text.trimStart(),
          confidence:
            current.confidence !== null && next.confidence !== null
              ? (current.confidence * (current.endTime - current.startTime) +
                  next.confidence * (next.endTime - next.startTime)) /
                (current.endTime - current.startTime + (next.endTime - next.startTime))
              : current.confidence
        }
      } else {
        result.push(current)
        current = { ...next }
      }
    }
    result.push(current)

    return result
  }
}
