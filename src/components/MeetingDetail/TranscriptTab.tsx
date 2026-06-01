import { useState, useEffect, useCallback, useRef } from 'react'
import type { TranscriptSegment, TranscriptionProgress } from '../../types'
import { formatTime } from '../../utils/format'

interface Props {
  segments: TranscriptSegment[]
  progress: TranscriptionProgress | null
  speakerMeName?: string
  speakerOthersName?: string
  meetingId: string
  meetingStatus: string
  onRetranscribe: () => Promise<void>
}

const OTHERS_COLORS = [
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#FF2D55',
  '#5AC8FA',
  '#FFD60A',
  '#30D158',
  '#64D2FF'
]

function getSpeakerColor(speaker: string): string {
  if (speaker === 'me') return '#007AFF'
  if (speaker === 'others') return '#34C759'
  const match = speaker.match(/^others_(\d+)$/)
  if (match) return OTHERS_COLORS[parseInt(match[1]) % OTHERS_COLORS.length]
  return '#34C759'
}

function getSpeakerLabel(
  speaker: string,
  meName?: string,
  othersName?: string,
  customNames?: Record<string, string>
): string {
  if (customNames?.[speaker]) return customNames[speaker]
  if (speaker === 'me') return meName || 'Moi'
  if (speaker === 'others') return othersName || 'Interlocuteur'
  const match = speaker.match(/^others_(\d+)$/)
  if (match) {
    const letter = String.fromCharCode(65 + (parseInt(match[1]) % 26))
    return `Participant ${letter}`
  }
  return othersName || 'Interlocuteur'
}

// ── Badge speaker cliquable pour renommer ──
function SpeakerBadge({
  speaker,
  label,
  color,
  onRename
}: {
  speaker: string
  label: string
  color: string
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)

  const save = useCallback(() => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== label) onRename(trimmed)
  }, [draft, label, onRename])

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="text-xs font-semibold uppercase tracking-wide px-1 py-0.5 rounded outline-none"
        style={{ color, background: `${color}15`, border: `1px solid ${color}40`, width: 120 }}
      />
    )
  }

  return (
    <span
      className="text-xs font-semibold uppercase tracking-wide cursor-pointer hover:underline"
      style={{ color }}
      onClick={() => {
        setDraft(label)
        setEditing(true)
      }}
      title="Cliquer pour renommer"
    >
      {label}
    </span>
  )
}

// ── Texte d'un segment — cliquable pour éditer inline ──
function SegmentText({
  segment,
  onSave
}: {
  segment: TranscriptSegment
  onSave: (id: number, text: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(segment.text)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Ajuster la hauteur de la textarea automatiquement
  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }
  }, [editing, draft])

  const save = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      setDraft(segment.text)
      setEditing(false)
      return
    }
    if (trimmed === segment.text) {
      setEditing(false)
      return
    }
    setSaving(true)
    await onSave(segment.id, trimmed)
    setSaving(false)
    setEditing(false)
  }, [draft, segment.id, segment.text, onSave])

  const cancel = useCallback(() => {
    setDraft(segment.text)
    setEditing(false)
  }, [segment.text])

  if (editing) {
    return (
      <div className="mt-0.5">
        <textarea
          ref={textareaRef}
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              cancel()
              return
            }
            // Cmd+Enter ou Ctrl+Enter pour sauvegarder
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
          className="w-full text-sm leading-relaxed resize-none outline-none rounded-lg px-2 py-1.5"
          style={{
            color: '#1A1A1A',
            background: '#F0EFE9',
            border: '1px solid #D6D3D1',
            fontFamily: 'inherit',
            lineHeight: 1.6,
            overflow: 'hidden'
          }}
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-2 py-0.5 rounded-md font-medium transition-colors"
            style={{ background: '#1A1A1A', color: '#FFF' }}
          >
            {saving ? '...' : 'Enregistrer'}
          </button>
          <button
            onClick={cancel}
            className="text-xs px-2 py-0.5 rounded-md transition-colors"
            style={{ color: '#8E8E93' }}
          >
            Annuler
          </button>
          <span className="text-xs ml-auto" style={{ color: '#C7C7CC' }}>
            ⌘↩
          </span>
        </div>
      </div>
    )
  }

  return (
    <p
      className="text-sm mt-0.5 leading-relaxed cursor-text rounded px-1 -mx-1 transition-colors"
      style={{ color: '#3A3A3A' }}
      onClick={() => {
        setDraft(segment.text)
        setEditing(true)
      }}
      title="Cliquer pour modifier"
    >
      {segment.text}
    </p>
  )
}

function AudioPlayer({
  meetingId,
  meName,
  othersName
}: {
  meetingId: string
  meName: string
  othersName: string
}) {
  const [audioInfo, setAudioInfo] = useState<{
    meExists: boolean
    othersExists: boolean
    audioDeleted: boolean
  } | null>(null)

  useEffect(() => {
    window.api.meetings.getAudioInfo(meetingId).then(setAudioInfo)
  }, [meetingId])

  if (!audioInfo || audioInfo.audioDeleted) return null
  if (!audioInfo.meExists && !audioInfo.othersExists) return null

  return (
    <div className="mb-5 space-y-3 p-3 rounded-xl" style={{ background: '#F0EFE9' }}>
      <p className="text-xs font-medium" style={{ color: '#8E8E93' }}>
        Audio enregistré
      </p>
      {audioInfo.meExists && (
        <div>
          <p className="text-xs mb-1" style={{ color: '#57534E' }}>
            {meName}
          </p>
          <audio
            controls
            src={`muesli-audio://me/${meetingId}`}
            style={{ width: '100%', height: 28 }}
          />
        </div>
      )}
      {audioInfo.othersExists && (
        <div>
          <p className="text-xs mb-1" style={{ color: '#57534E' }}>
            {othersName}
          </p>
          <audio
            controls
            src={`muesli-audio://others/${meetingId}`}
            style={{ width: '100%', height: 28 }}
          />
        </div>
      )}
    </div>
  )
}

export function TranscriptTab({
  segments,
  progress,
  speakerMeName,
  speakerOthersName,
  meetingId,
  meetingStatus,
  onRetranscribe
}: Props) {
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [retranscribing, setRetranscribing] = useState(false)
  const [retranscribeError, setRetranscribeError] = useState<string | null>(null)

  useEffect(() => {
    window.api.meetings.getSpeakerNames(meetingId).then(setSpeakerNames)
  }, [meetingId])

  const handleRename = useCallback(
    async (speakerKey: string, displayName: string) => {
      await window.api.meetings.setSpeakerName(meetingId, speakerKey, displayName)
      setSpeakerNames(prev => ({ ...prev, [speakerKey]: displayName }))
    },
    [meetingId]
  )

  const handleSaveSegment = useCallback(async (segmentId: number, text: string) => {
    await window.api.meetings.updateSegment(segmentId, text)
  }, [])

  const handleRetranscribe = useCallback(async () => {
    setRetranscribeError(null)
    setRetranscribing(true)
    try {
      await onRetranscribe()
    } catch (err) {
      setRetranscribeError(String(err))
    } finally {
      setRetranscribing(false)
    }
  }, [onRetranscribe])

  const isProcessing =
    meetingStatus === 'transcribing' || meetingStatus === 'summarizing' || retranscribing

  // ── Barre d'outils ──
  const toolbar = (
    <div className="flex items-center gap-2 mb-5">
      <button
        onClick={handleRetranscribe}
        disabled={isProcessing}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
        style={{ background: '#F5F4F0', color: '#1A1A1A' }}
        title={
          isProcessing
            ? 'Traitement en cours...'
            : 'Relancer la transcription depuis les fichiers audio'
        }
      >
        {isProcessing ? (
          <>
            <span className="w-3 h-3 border border-stone-400 border-t-transparent rounded-full animate-spin" />
            En cours...
          </>
        ) : (
          <>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
            Retranscrire
          </>
        )}
      </button>
      {segments.length > 0 && (
        <span className="text-xs" style={{ color: '#C7C7CC' }}>
          cliquer sur le texte pour modifier
        </span>
      )}
    </div>
  )

  if (progress && (meetingStatus === 'transcribing' || retranscribing)) {
    return (
      <div className="py-6">
        {toolbar}
        <p className="text-sm mb-3" style={{ color: '#8E8E93' }}>
          Transcription en cours...
        </p>
        <div style={{ height: 3, background: '#EBEBEB', borderRadius: 2, overflow: 'hidden' }}>
          <div
            style={{
              width: `${progress.percent}%`,
              height: '100%',
              background: '#1A1A1A',
              transition: 'width 0.4s ease'
            }}
          />
        </div>
        <p className="text-xs mt-2" style={{ color: '#C7C7CC' }}>
          {progress.currentStep}
        </p>
      </div>
    )
  }

  if (segments.length === 0 && progress) {
    return (
      <div className="py-6">
        {toolbar}
        <p className="text-sm mb-3" style={{ color: '#8E8E93' }}>
          Transcription en cours...
        </p>
        <div style={{ height: 3, background: '#EBEBEB', borderRadius: 2, overflow: 'hidden' }}>
          <div
            style={{
              width: `${progress.percent}%`,
              height: '100%',
              background: '#1A1A1A',
              transition: 'width 0.4s ease'
            }}
          />
        </div>
        <p className="text-xs mt-2" style={{ color: '#C7C7CC' }}>
          {progress.currentStep}
        </p>
      </div>
    )
  }

  if (segments.length === 0) {
    return (
      <div className="py-6">
        {toolbar}
        {retranscribeError && (
          <div
            className="mb-4 px-3 py-2 rounded-xl text-xs"
            style={{ background: '#FFF5F5', color: '#C0392B', border: '1px solid #FECDD3' }}
          >
            {retranscribeError}
          </div>
        )}
        <p className="text-sm text-center py-8" style={{ color: '#8E8E93' }}>
          Aucune transcription disponible.
        </p>
      </div>
    )
  }

  return (
    <div>
      <AudioPlayer
        meetingId={meetingId}
        meName={speakerMeName || 'Moi'}
        othersName={speakerOthersName || 'Interlocuteur'}
      />
      {toolbar}

      {retranscribeError && (
        <div
          className="mb-4 px-3 py-2 rounded-xl text-xs"
          style={{ background: '#FFF5F5', color: '#C0392B', border: '1px solid #FECDD3' }}
        >
          {retranscribeError}
        </div>
      )}

      <div className="space-y-6">
        {segments.map(seg => {
          const color = getSpeakerColor(seg.speaker)
          const label = getSpeakerLabel(seg.speaker, speakerMeName, speakerOthersName, speakerNames)
          return (
            <div key={seg.id} className="group">
              {/* En-tête du tour : speaker + timestamp */}
              <div className="flex items-baseline gap-2 mb-1">
                <SpeakerBadge
                  speaker={seg.speaker}
                  label={label}
                  color={color}
                  onRename={name => handleRename(seg.speaker, name)}
                />
                <span className="text-xs font-mono" style={{ color: '#C7C7CC' }}>
                  {formatTime(seg.startTime)}
                </span>
              </div>
              {/* Corps du tour — texte long, paragraphe fluide */}
              <SegmentText segment={seg} onSave={handleSaveSegment} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
