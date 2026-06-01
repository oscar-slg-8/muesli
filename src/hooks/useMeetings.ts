// ============================================================
// Hook useMeetings — CRUD réunions + recherche
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import type { Meeting, TranscriptSegment, TranscriptionProgress } from '../types'

export function useMeetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null)

  // Charger la liste des réunions
  const refresh = useCallback(async () => {
    const list = (await window.api.meetings.list()) as Meeting[]
    setMeetings(list)
  }, [])

  // Charger une réunion et ses segments
  const select = useCallback(async (id: string | null) => {
    setSelectedId(id)
    if (!id) {
      setSelectedMeeting(null)
      setSegments([])
      return
    }
    const meeting = (await window.api.meetings.get(id)) as Meeting | null
    setSelectedMeeting(meeting)
    if (meeting) {
      const segs = (await window.api.meetings.getSegments(id)) as TranscriptSegment[]
      setSegments(segs)
    }
  }, [])

  // Recherche full-text
  const search = useCallback(
    async (query: string) => {
      setSearchQuery(query)
      if (!query.trim()) {
        refresh()
        return
      }
      const results = (await window.api.meetings.search(query)) as Meeting[]
      setMeetings(results)
    },
    [refresh]
  )

  // Mettre à jour les notes
  const updateNotes = useCallback(
    async (id: string, markdown: string) => {
      await window.api.meetings.updateNotes(id, markdown)
      if (id === selectedId) {
        setSelectedMeeting(m => (m ? { ...m, notesMarkdown: markdown } : null))
      }
    },
    [selectedId]
  )

  // Mettre à jour le titre
  const updateTitle = useCallback(
    async (id: string, title: string) => {
      await window.api.meetings.updateTitle(id, title)
      refresh()
      if (id === selectedId) {
        setSelectedMeeting(m => (m ? { ...m, title } : null))
      }
    },
    [selectedId, refresh]
  )

  // Supprimer une réunion
  const deleteMeeting = useCallback(
    async (id: string) => {
      await window.api.meetings.delete(id)
      if (id === selectedId) {
        setSelectedId(null)
        setSelectedMeeting(null)
        setSegments([])
      }
      refresh()
    },
    [selectedId, refresh]
  )

  // Réessayer le résumé (avec un modèle de prompt optionnel)
  const retrySummary = useCallback(async (id: string, templateId?: number) => {
    await window.api.summarization.retry(id, templateId)
  }, [])

  // Changer la langue d'une réunion (FR/EN)
  const updateLanguage = useCallback(
    async (id: string, language: 'fr' | 'en') => {
      await window.api.meetings.updateLanguage(id, language)
      if (id === selectedId) {
        setSelectedMeeting(m => (m ? { ...m, language } : null))
      }
    },
    [selectedId]
  )

  // Écouter les événements du main process
  useEffect(() => {
    window.api.on('meeting:updated', () => {
      refresh()
      if (selectedId) select(selectedId)
    })
    window.api.on('transcription:progress', (p: unknown) => {
      setProgress(p as TranscriptionProgress)
    })
    window.api.on('transcription:complete', () => {
      setProgress(null)
      refresh()
      if (selectedId) select(selectedId)
    })
    window.api.on('summarization:complete', () => {
      refresh()
      if (selectedId) select(selectedId)
    })

    return () => {
      window.api.removeAllListeners('meeting:updated')
      window.api.removeAllListeners('transcription:progress')
      window.api.removeAllListeners('transcription:complete')
      window.api.removeAllListeners('summarization:complete')
    }
  }, [refresh, select, selectedId])

  // Charger au démarrage
  useEffect(() => {
    refresh()
  }, [refresh])

  return {
    meetings,
    selectedId,
    selectedMeeting,
    segments,
    searchQuery,
    progress,
    select,
    search,
    refresh,
    updateNotes,
    updateTitle,
    deleteMeeting,
    retrySummary,
    updateLanguage
  }
}
