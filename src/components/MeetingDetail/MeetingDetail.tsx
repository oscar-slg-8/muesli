import { useState, useCallback, useEffect, useRef } from 'react'
import type { Meeting, TranscriptSegment, TranscriptionProgress } from '../../types'
import { SummaryTab } from './SummaryTab'
import { TranscriptTab } from './TranscriptTab'
import { NotesTab } from './NotesTab'
type Tab = 'summary' | 'transcript' | 'notes'

interface Props {
  meeting: Meeting
  segments: TranscriptSegment[]
  progress: TranscriptionProgress | null
  isRecording?: boolean
  canStartFromDraft?: boolean
  onStartFromDraft?: (meetingId: string) => void
  onUpdateNotes: (id: string, markdown: string) => Promise<void>
  onUpdateTitle: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRetrySummary: (id: string, templateId?: number) => Promise<void>
  onUpdateLanguage?: (id: string, language: 'fr' | 'en') => Promise<void>
}

const tabs: { key: Tab; label: string }[] = [
  { key: 'summary', label: 'Résumé' },
  { key: 'transcript', label: 'Transcription' },
  { key: 'notes', label: 'Notes' }
]

export function MeetingDetail({
  meeting,
  segments,
  progress,
  isRecording,
  canStartFromDraft,
  onStartFromDraft,
  onUpdateNotes,
  onUpdateTitle,
  onDelete,
  onRetrySummary,
  onUpdateLanguage
}: Props) {
  const [tab, setTab] = useState<Tab>('summary')

  // Basculer sur l'onglet Notes quand la réunion est en cours d'enregistrement
  useEffect(() => {
    if (isRecording) setTab('notes')
  }, [isRecording, meeting.id])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleSavedRef = useRef(false)

  const title = meeting.title || 'Réunion sans titre'

  const startEditTitle = () => {
    titleSavedRef.current = false
    setTitleDraft(meeting.title || '')
    setEditingTitle(true)
  }

  const saveTitle = useCallback(async () => {
    if (titleSavedRef.current) return
    titleSavedRef.current = true
    setEditingTitle(false)
    if (titleDraft.trim() && titleDraft !== meeting.title) {
      await onUpdateTitle(meeting.id, titleDraft.trim())
    }
  }, [titleDraft, meeting.id, meeting.title, onUpdateTitle])

  const handleDelete = async () => {
    if (confirm('Supprimer cette réunion ? Cette action est irréversible.')) {
      await onDelete(meeting.id)
    }
  }

  const dateStr = new Date(meeting.createdAt).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  })
  const timeStr = new Date(meeting.createdAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  })
  const durationStr =
    meeting.durationSeconds > 0 ? `${Math.floor(meeting.durationSeconds / 60)} min` : ''

  return (
    <div className="flex flex-col h-full">
      {/* En-tête */}
      <div className="px-8 pt-8 pb-0 flex-shrink-0 titlebar-drag" style={{ background: '#F7F6F3' }}>
        <div className="flex items-start justify-between mb-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className="text-2xl font-semibold flex-1 mr-3 px-2 py-0.5 rounded-lg focus:outline-none"
              style={{
                color: '#1A1A1A',
                letterSpacing: '-0.03em',
                background: '#EDECEA',
                border: 'none'
              }}
            />
          ) : (
            <h1
              onClick={startEditTitle}
              className="text-2xl font-semibold cursor-text flex-1 mr-3 leading-tight"
              style={
                {
                  color: '#1A1A1A',
                  letterSpacing: '-0.03em',
                  WebkitAppRegion: 'no-drag'
                } as React.CSSProperties
              }
              title="Cliquer pour modifier"
            >
              {title}
            </h1>
          )}

          <button
            onClick={handleDelete}
            className="flex-shrink-0 mt-1 p-1.5 rounded-lg transition-colors"
            style={{ color: '#C7C7CC' }}
            onMouseEnter={e => {
              ;(e.currentTarget as HTMLButtonElement).style.color = '#FF3B30'
              ;(e.currentTarget as HTMLButtonElement).style.background = '#FFF5F5'
            }}
            onMouseLeave={e => {
              ;(e.currentTarget as HTMLButtonElement).style.color = '#C7C7CC'
              ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }}
            title="Supprimer"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-3 mt-0.5">
          <p className="text-sm capitalize" style={{ color: '#ADADAD' }}>
            {dateStr} à {timeStr}
            {durationStr && ` · ${durationStr}`}
            {meeting.attendees &&
              meeting.attendees.length > 0 &&
              ` · ${meeting.attendees.length} participant${meeting.attendees.length > 1 ? 's' : ''}`}
          </p>

          {/* Toggle langue FR / EN */}
          {onUpdateLanguage && (
            <div
              className="flex items-center rounded-md overflow-hidden flex-shrink-0"
              style={{ border: '1px solid #E0DFDC', background: '#EDECEA' }}
            >
              {(['fr', 'en'] as const).map(lang => {
                const active = (meeting.language ?? 'fr') === lang
                const disabled =
                  isRecording ||
                  meeting.status === 'transcribing' ||
                  meeting.status === 'summarizing'
                return (
                  <button
                    key={lang}
                    disabled={disabled}
                    onClick={() => onUpdateLanguage(meeting.id, lang)}
                    className="px-2 py-0.5 text-xs font-medium transition-colors"
                    style={{
                      background: active ? '#1A1A1A' : 'transparent',
                      color: active ? '#FFFFFF' : '#ADADAD',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.5 : 1
                    }}
                    title={
                      disabled
                        ? 'Indisponible pendant le traitement'
                        : `Passer en ${lang.toUpperCase()}`
                    }
                  >
                    {lang.toUpperCase()}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Bouton démarrer l'enregistrement — uniquement sur les drafts calendrier */}
        {meeting.status === 'draft' && canStartFromDraft && onStartFromDraft && (
          <button
            onClick={() => onStartFromDraft(meeting.id)}
            className="mt-4 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ background: '#1A1A1A', color: '#FFFFFF' }}
            onMouseEnter={e => {
              ;(e.currentTarget as HTMLButtonElement).style.background = '#333333'
            }}
            onMouseLeave={e => {
              ;(e.currentTarget as HTMLButtonElement).style.background = '#1A1A1A'
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            Démarrer l'enregistrement
          </button>
        )}

        {/* Onglets */}
        <div className="flex gap-0 mt-6">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-0 py-2 mr-6 text-sm transition-colors"
              style={{
                color: tab === t.key ? '#1A1A1A' : '#ADADAD',
                fontWeight: tab === t.key ? 500 : 400,
                borderBottom: tab === t.key ? '1.5px solid #1A1A1A' : '1.5px solid transparent'
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Séparateur */}
      <div style={{ height: 1, background: '#EBEBEB', flexShrink: 0 }} />

      {/* Contenu */}
      <div className="flex-1 overflow-y-auto" style={{ background: '#F7F6F3' }}>
        <div className="px-8 py-6 max-w-3xl">
          {tab === 'summary' && (
            <SummaryTab
              meeting={meeting}
              progress={progress}
              onRetry={templateId => onRetrySummary(meeting.id, templateId)}
            />
          )}
          {tab === 'transcript' && (
            <TranscriptTab
              segments={segments}
              progress={progress}
              speakerMeName={meeting.speakerMe}
              speakerOthersName={meeting.speakerOthers}
              meetingId={meeting.id}
              meetingStatus={meeting.status}
              onRetranscribe={async () => {
                await window.api.transcription.retry(meeting.id)
              }}
            />
          )}
          {tab === 'notes' && (
            <NotesTab meeting={meeting} onSave={md => onUpdateNotes(meeting.id, md)} />
          )}
        </div>
      </div>
    </div>
  )
}
