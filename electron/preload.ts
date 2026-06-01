// ============================================================
// Preload — Pont sécurisé entre Electron et React
// Expose window.api avec l'ensemble de l'API de l'application.
// ============================================================

import { contextBridge, ipcRenderer } from 'electron'

// Tracks wrapped listeners so off() can remove the exact wrapper registered by on()
const listenerMap = new Map<
  string,
  Map<(...args: unknown[]) => void, (...args: unknown[]) => void>
>()

const api = {
  // --- Réunions ---
  meetings: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('meetings:list'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('meetings:get', id),
    getSegments: (id: string): Promise<unknown[]> => ipcRenderer.invoke('meetings:getSegments', id),
    updateNotes: (id: string, markdown: string): Promise<void> =>
      ipcRenderer.invoke('meetings:updateNotes', id, markdown),
    updateTitle: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('meetings:updateTitle', id, title),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('meetings:delete', id),
    search: (query: string): Promise<unknown[]> => ipcRenderer.invoke('meetings:search', query),
    getSpeakerNames: (id: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('meetings:getSpeakerNames', id),
    setSpeakerName: (meetingId: string, speakerKey: string, displayName: string): Promise<void> =>
      ipcRenderer.invoke('meetings:setSpeakerName', meetingId, speakerKey, displayName),
    updateSegment: (segmentId: number, text: string): Promise<void> =>
      ipcRenderer.invoke('meetings:updateSegment', segmentId, text),
    updateLanguage: (id: string, language: 'fr' | 'en'): Promise<void> =>
      ipcRenderer.invoke('meetings:updateLanguage', id, language),
    getAudioInfo: (
      meetingId: string
    ): Promise<{ meExists: boolean; othersExists: boolean; audioDeleted: boolean }> =>
      ipcRenderer.invoke('meetings:getAudioInfo', meetingId)
  },

  // --- Enregistrement ---
  recording: {
    start: (): Promise<{ meetingId: string }> => ipcRenderer.invoke('recording:start'),
    startFromDraft: (meetingId: string): Promise<{ meetingId: string }> =>
      ipcRenderer.invoke('recording:startFromDraft', meetingId),
    stop: (): Promise<void> => ipcRenderer.invoke('recording:stop'),
    getStatus: (): Promise<{ recording: boolean; meetingId: string | null; duration: number }> =>
      ipcRenderer.invoke('recording:getStatus'),
    // RMS mic depuis le VU-meter renderer (float 0-1, pas de PCM)
    sendMeLevel: (rms: number): void => {
      ipcRenderer.send('recording:meLevel', rms)
    }
  },

  // --- Transcription / Résumé ---
  transcription: {
    getProgress: (): Promise<unknown> => ipcRenderer.invoke('transcription:getProgress'),
    retry: (meetingId: string): Promise<void> =>
      ipcRenderer.invoke('transcription:retry', meetingId)
  },
  summarization: {
    retry: (meetingId: string, templateId?: number): Promise<void> =>
      ipcRenderer.invoke('summarization:retry', meetingId, templateId)
  },

  // --- Templates de résumé ---
  templates: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('templates:list'),
    create: (name: string, prompt: string): Promise<unknown> =>
      ipcRenderer.invoke('templates:create', name, prompt),
    update: (id: number, name: string, prompt: string): Promise<void> =>
      ipcRenderer.invoke('templates:update', id, name, prompt),
    delete: (id: number): Promise<void> => ipcRenderer.invoke('templates:delete', id)
  },

  // --- Préférences ---
  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
    update: (partial: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('settings:update', partial)
  },

  // --- Calendrier ---
  calendar: {
    getEvents: (): Promise<unknown[]> => ipcRenderer.invoke('calendar:getEvents')
  },

  // --- Export ---
  export: {
    saveFile: (defaultName: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('export:saveFile', defaultName, content),
    copyToClipboard: (text: string): Promise<void> =>
      ipcRenderer.invoke('export:copyToClipboard', text),
    notionExport: (meetingId: string): Promise<{ ok: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('export:notion', meetingId)
  },

  // --- Système ---
  system: {
    checkDependencies: (): Promise<unknown> => ipcRenderer.invoke('system:checkDependencies'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('system:openExternal', url)
  },

  // --- Base de données ---
  database: {
    getStatus: (): Promise<{ initialized: boolean; path: string; migrationsCount: number }> =>
      ipcRenderer.invoke('database:getStatus')
  },

  // --- Événements main → renderer ---
  on: (channel: string, callback: (...args: unknown[]) => void): void => {
    const valid = [
      'recording:started',
      'recording:stopped',
      'transcription:progress',
      'transcription:complete',
      'summarization:complete',
      'meeting:updated',
      'recording:requestStart',
      'recording:requestStop',
      'audio:othersLevel',
      'recording:audioTeeError',
      'recording:warning'
    ]
    if (!valid.includes(channel)) return
    const wrapper = (_event: unknown, ...args: unknown[]) => callback(...args)
    if (!listenerMap.has(channel)) listenerMap.set(channel, new Map())
    listenerMap.get(channel)!.set(callback, wrapper)

    ipcRenderer.on(channel, wrapper as any)
  },

  off: (channel: string, callback: (...args: unknown[]) => void): void => {
    const channelMap = listenerMap.get(channel)
    if (!channelMap) return
    const wrapper = channelMap.get(callback)
    if (!wrapper) return

    ipcRenderer.removeListener(channel, wrapper as any)
    channelMap.delete(callback)
  },

  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel)
    listenerMap.delete(channel)
  }
}

contextBridge.exposeInMainWorld('api', api)
