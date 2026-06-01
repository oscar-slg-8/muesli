// ============================================================
// Service de résumé IA — Anthropic Claude Haiku API
//
// Envoie la transcription à Claude Haiku (claude-haiku-4-5-20251001)
// et récupère un résumé structuré.
// Coût : ~$0.01 par réunion d'1h
// ============================================================

import type { TranscriptSegment } from '../types'

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>
  usage: { input_tokens: number; output_tokens: number }
}

export class SummarizationService {
  private apiKey: string = ''
  private model: string = 'claude-haiku-4-5-20251001'

  configure(apiKey: string): void {
    this.apiKey = apiKey
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0
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

    return this.callClaude(content)
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
      const partial = await this.callClaude(
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

  private async callClaude(content: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), 120000)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content }]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer))

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
