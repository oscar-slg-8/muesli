// ============================================================
// Types TypeScript partagés — Muesli
// ============================================================

export type MeetingStatus =
  | 'draft'
  | 'recording'
  | 'transcribing'
  | 'summarizing'
  | 'complete'
  | 'error'

export interface Meeting {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  durationSeconds: number
  status: MeetingStatus
  speakerMe: string
  speakerOthers: string
  notesMarkdown: string
  summaryMarkdown: string
  summaryModel: string
  language: string
  errorMessage: string | null
  audioPathMe: string
  audioPathOthers: string
  audioDeleted: boolean
  othersOffsetMs: number
  calendarEventId: string | null
  attendees: string[] | null // JSON-parsed list of participant names
}

export interface WordTimestamp {
  word: string
  start: number // secondes absolues depuis le début du meeting
  end: number
  probability: number // confiance Whisper [0,1]
}

export interface DiarizationSegment {
  start: number // secondes absolues depuis le début du meeting
  end: number
  speaker: string // 'me' | 'others_0' | 'others_1' ...
  chunkIndex: number
}

export interface TranscriptSegment {
  id: number
  meetingId: string
  speaker: 'me' | 'others' | string // 'me', 'others', 'others_0', 'others_1', etc.
  startTime: number
  endTime: number
  text: string
  chunkIndex: number
  confidence: number | null
  isOverlap: boolean
  words?: WordTimestamp[]
}

export type TranscriptionProvider = 'groq' | 'mistral'
export type SummaryProvider = 'anthropic' | 'mistral'

export interface Settings {
  micDeviceId?: string
  speakerMeName: string
  speakerOthersName: string
  language: string
  summaryPrompt: string
  transcriptionProvider: TranscriptionProvider
  summaryProvider: SummaryProvider
  apiKeyGroq: string
  apiKeyAnthropic: string
  apiKeyMistral: string
  apiKeyPyannote: string
  apiKeyNotion: string
  notionDatabaseId: string
  shortcut: string
  audioStoragePath: string
  deleteAudioAfterTranscription: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  micDeviceId: undefined,
  speakerMeName: 'MOI',
  speakerOthersName: 'INTERLOCUTEUR',
  language: 'fr',
  summaryPrompt: `Tu es un assistant spécialisé dans la prise de notes de réunions.
Produis un résumé structuré en français avec :
## Titre
## Résumé exécutif (5-8 lignes)
## Points clés discutés
## Décisions prises
## Actions à faire (avec responsable et deadline si mentionnés)
## Prochaines étapes
Reste factuel. Si quelque chose n'est pas clair, indique "[peu clair dans l'audio]".`,
  transcriptionProvider: 'groq',
  summaryProvider: 'anthropic',
  apiKeyGroq: '',
  apiKeyAnthropic: '',
  apiKeyMistral: '',
  apiKeyPyannote: '',
  apiKeyNotion: '',
  notionDatabaseId: '',
  shortcut: 'CommandOrControl+Shift+R',
  audioStoragePath: '',
  deleteAudioAfterTranscription: false
}

export interface PromptTemplate {
  id: number
  name: string
  prompt: string
  isBuiltin: boolean
  createdAt: string
}

export interface DependencyStatus {
  groqApiKey: boolean
  anthropicApiKey: boolean
  mistralApiKey: boolean
  pyannoteApiKey: boolean
  notionConfigured: boolean
  /** true si macOS 14.2+ ET que le binaire system-audio-capture est présent */
  processTapAvailable: boolean
  /** 'ffmpeg' | 'sox' | null — backend de capture micro */
  micBackend: 'ffmpeg' | 'sox' | null
}

export interface TranscriptionProgress {
  meetingId: string
  percent: number
  currentStep: string
  currentChunk: number
  totalChunks: number
}

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }
