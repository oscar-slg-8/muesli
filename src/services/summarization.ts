// ============================================================
// Service de résumé IA — provider sélectionnable
//
// Deux fournisseurs interchangeables :
//   - anthropic : Claude Haiku (claude-haiku-4-5-20251001), ~$0.01/réunion 1h
//   - mistral   : Mistral Small (mistral-small-latest), ~$0.002/réunion 1h
//
// Les deux reçoivent le même prompt ; seul l'appel HTTP diffère.
// ============================================================

import type { SummaryProvider, TranscriptSegment } from '../types'

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>
  usage: { input_tokens: number; output_tokens: number }
}

interface MistralChatResponse {
  choices: Array<{ message: { content: string } }>
}

const MODELS: Record<SummaryProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  mistral: 'mistral-small-latest'
}

export class SummarizationService {
  private apiKey: string = ''
  private provider: SummaryProvider = 'anthropic'

  configure(apiKey: string, provider: SummaryProvider = 'anthropic'): void {
    this.apiKey = apiKey
    this.provider = provider
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0
  }

  /** Étiquette courte du modèle utilisé, persistée en base (summary_model). */
  get modelLabel(): string {
    return this.provider === 'mistral' ? 'mistral-small' : 'claude-haiku'
  }

  async summarize(
    segments: TranscriptSegment[],
    speakerMe: string,
    speakerOthers: string,
    durationSeconds: number,
    customPrompt: string,
    language: string,
    speakerNames?: Record<string, string>,
    userNotes?: string
  ): Promise<string> {
    const transcriptText = this.formatTranscript(segments, speakerMe, speakerOthers, speakerNames)
    const wordCount = transcriptText.split(/\s+/).length

    if (wordCount < 5000) {
      return this.generateSummary(
        transcriptText,
        speakerMe,
        speakerOthers,
        durationSeconds,
        customPrompt,
        language,
        userNotes
      )
    }

    return this.summarizeLong(
      transcriptText,
      speakerMe,
      speakerOthers,
      durationSeconds,
      customPrompt,
      language,
      userNotes
    )
  }

  private async generateSummary(
    transcript: string,
    speakerMe: string,
    speakerOthers: string,
    durationSeconds: number,
    systemPrompt: string,
    language: string,
    userNotes?: string
  ): Promise<string> {
    const durationMin = Math.round(durationSeconds / 60)
    const langLabel = language === 'fr' ? 'français' : 'anglais'

    let content = `${systemPrompt}

Réunion de ${durationMin} minutes entre ${speakerMe} et ${speakerOthers}.
Langue de sortie : ${langLabel}.`

    // Injecter les notes manuelles de l'utilisateur si présentes
    if (userNotes && userNotes.trim().length > 0) {
      content += `

Notes prises par l'utilisateur pendant la réunion (à intégrer dans le résumé, elles apportent du contexte et des précisions) :
${userNotes.trim()}`
    }

    content += `

Transcription :
${transcript}`

    return this.complete(content)
  }

  private async summarizeLong(
    transcript: string,
    speakerMe: string,
    speakerOthers: string,
    durationSeconds: number,
    systemPrompt: string,
    language: string,
    userNotes?: string
  ): Promise<string> {
    // Claude Haiku supporte 200k tokens, on peut envoyer beaucoup plus en une passe
    // Découper en blocs de 4000 mots seulement si vraiment nécessaire
    const words = transcript.split(/\s+/)
    const blockSize = 4000
    const overlap = 200
    const blocks: string[] = []

    for (let i = 0; i < words.length; i += blockSize - overlap) {
      blocks.push(words.slice(i, i + blockSize).join(' '))
    }

    const partialSummaries: string[] = []
    for (let i = 0; i < blocks.length; i++) {
      const partial = await this.complete(
        `Résume cette partie (${i + 1}/${blocks.length}) d'une transcription de réunion en conservant les points clés, décisions et actions :\n\n${blocks[i]}`
      )
      partialSummaries.push(partial)
    }

    const mergedInput = partialSummaries.join('\n\n---\n\n')
    return this.generateSummary(
      mergedInput,
      speakerMe,
      speakerOthers,
      durationSeconds,
      systemPrompt,
      language,
      userNotes
    )
  }

  private complete(content: string): Promise<string> {
    return this.provider === 'mistral' ? this.callMistral(content) : this.callClaude(content)
  }

  // AbortSignal.timeout() est peu fiable dans le processus principal d'Electron :
  // on utilise AbortController + setTimeout natif (voir transcription.ts).
  private fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs)
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
  }

  private async callClaude(content: string): Promise<string> {
    const res = await this.fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODELS.anthropic,
          max_tokens: 2048,
          messages: [{ role: 'user', content }]
        })
      },
      120000
    )

    if (!res.ok) {
      const body = await res.text()
      console.error('[summarization] Anthropic error', res.status, body)
      if (res.status === 401)
        throw new Error('Clé API Anthropic invalide — vérifie-la dans les Réglages')
      if (
        res.status === 402 ||
        (res.status === 400 && body.includes('credit balance is too low'))
      ) {
        throw new Error(
          'Crédit Anthropic insuffisant — ajoute du crédit sur console.anthropic.com/settings/billing'
        )
      }
      if (res.status === 429)
        throw new Error('Limite de requêtes Anthropic atteinte — réessaie dans quelques secondes')
      throw new Error(`Anthropic API erreur ${res.status}: ${body.slice(0, 300)}`)
    }

    const data = (await res.json()) as AnthropicResponse
    return data.content[0]?.text || ''
  }

  // Mistral expose une API chat completions compatible OpenAI.
  private async callMistral(content: string): Promise<string> {
    const res = await this.fetchWithTimeout(
      'https://api.mistral.ai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: MODELS.mistral,
          max_tokens: 2048,
          messages: [{ role: 'user', content }]
        })
      },
      120000
    )

    if (!res.ok) {
      const body = await res.text()
      console.error('[summarization] Mistral error', res.status, body)
      if (res.status === 401)
        throw new Error('Clé API Mistral invalide — vérifie-la dans les Réglages')
      if (res.status === 402)
        throw new Error('Crédit Mistral insuffisant — vérifie ton compte sur console.mistral.ai')
      if (res.status === 429)
        throw new Error('Limite de requêtes Mistral atteinte — réessaie dans quelques secondes')
      throw new Error(`Mistral API erreur ${res.status}: ${body.slice(0, 300)}`)
    }

    const data = (await res.json()) as MistralChatResponse
    return data.choices[0]?.message?.content || ''
  }

  private formatTranscript(
    segments: TranscriptSegment[],
    speakerMe: string,
    speakerOthers: string,
    speakerNames?: Record<string, string>
  ): string {
    return segments
      .map(s => {
        // Priorité : noms custom (meeting_speakers) > noms par défaut (settings)
        let speaker: string
        if (speakerNames?.[s.speaker]) {
          speaker = speakerNames[s.speaker]
        } else if (s.speaker === 'me') {
          speaker = speakerMe
        } else if (s.speaker === 'others') {
          speaker = speakerOthers
        } else {
          // others_0, others_1, etc. → Participant A, Participant B
          const match = s.speaker.match(/^others_(\d+)$/)
          speaker = match
            ? `Participant ${String.fromCharCode(65 + (parseInt(match[1]) % 26))}`
            : speakerOthers
        }
        const time = this.formatTime(s.startTime)
        return `[${speaker}] ${time} — ${s.text}`
      })
      .join('\n')
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
}
