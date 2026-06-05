// ============================================================
// Déclaration globale pour window.api
// Correspond exactement à ce que preload.ts expose
// ============================================================

import type {
  Meeting,
  TranscriptSegment,
  Settings,
  DependencyStatus,
  TranscriptionProgress,
  PromptTemplate
} from './index'

export interface ElectronAPI {
  // --- Réunions ---
  meetings: {
    list: () => Promise<Meeting[]>
    get: (id: string) => Promise<Meeting | null>
    getSegments: (id: string) => Promise<TranscriptSegment[]>
    updateNotes: (id: string, markdown: string) => Promise<void>
    updateTitle: (id: string, title: string) => Promise<void>
    delete: (id: string) => Promise<void>
    search: (query: string) => Promise<Meeting[]>
    getSpeakerNames: (id: string) => Promise<Record<string, string>>
    setSpeakerName: (meetingId: string, speakerKey: string, displayName: string) => Promise<void>
    updateSegment: (segmentId: number, text: string) => Promise<void>
    updateLanguage: (id: string, language: 'fr' | 'en') => Promise<void>
    getAudioInfo: (
      meetingId: string
    ) => Promise<{ meExists: boolean; othersExists: boolean; audioDeleted: boolean }>
  }

  // --- Enregistrement ---
  recording: {
    start: () => Promise<{ meetingId: string }>
    startFromDraft: (meetingId: string) => Promise<{ meetingId: string }>
    stop: () => Promise<void>
    getStatus: () => Promise<{ recording: boolean; meetingId: string | null; duration: number }>
    sendMeLevel: (rms: number) => void
  }

  // --- Transcription / Résumé ---
  transcription: {
    getProgress: () => Promise<TranscriptionProgress | null>
    retry: (meetingId: string) => Promise<void>
  }
  summarization: {
    retry: (meetingId: string, templateId?: number) => Promise<void>
  }

  // --- Templates de résumé ---
  templates: {
    list: () => Promise<PromptTemplate[]>
    create: (name: string, prompt: string) => Promise<PromptTemplate>
    update: (id: number, name: string, prompt: string) => Promise<void>
    delete: (id: number) => Promise<void>
  }

  // --- Préférences ---
  settings: {
    get: () => Promise<Settings>
    update: (partial: Partial<Settings>) => Promise<void>
  }

  // --- Export ---
  export: {
    saveFile: (defaultName: string, content: string) => Promise<boolean>
    copyToClipboard: (text: string) => Promise<void>
    notionExport: (
      meetingId: string
    ) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
    notionExportBulk: (
      meetingIds: string[]
    ) => Promise<{ results: Array<{ id: string; ok: boolean; url?: string; error?: string }> }>
  }

  // --- Système ---
  system: {
    checkDependencies: () => Promise<DependencyStatus>
    openExternal: (url: string) => Promise<void>
  }

  // --- Calendrier ---
  calendar: {
    getEvents: () => Promise<unknown[]>
  }

  // --- Base de données ---
  database: {
    getStatus: () => Promise<{ initialized: boolean; path: string; migrationsCount: number }>
  }

  // --- Événements main → renderer ---
  on: (channel: string, callback: (...args: unknown[]) => void) => void
  off: (channel: string, callback: (...args: unknown[]) => void) => void
  removeAllListeners: (channel: string) => void
}

declare global {
  interface Window {
    readonly api: ElectronAPI
  }
}
