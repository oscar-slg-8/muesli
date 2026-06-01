import type { Meeting } from '../../types'
import { formatDurationShort } from '../../utils/format'

interface Props {
  meeting: Meeting
  selected: boolean
  onClick: () => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Hier'
  if (days < 7) return d.toLocaleDateString('fr-FR', { weekday: 'long' })
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

const statusDot: Record<string, { color: string; pulse: boolean }> = {
  draft: { color: 'transparent', pulse: false },
  recording: { color: '#FF3B30', pulse: true },
  transcribing: { color: '#007AFF', pulse: true },
  summarizing: { color: '#007AFF', pulse: true },
  complete: { color: 'transparent', pulse: false },
  error: { color: '#FF9500', pulse: false }
}

export function MeetingListItem({ meeting, selected, onClick }: Props) {
  const title = meeting.title || 'Réunion sans titre'
  const dot = statusDot[meeting.status] || { color: 'transparent', pulse: false }
  const isDraft = meeting.status === 'draft'
  const hasCalendar = !!meeting.calendarEventId
  const attendeeCount = meeting.attendees?.length ?? 0

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-3 rounded-xl transition-all mb-0.5"
      style={{
        background: selected ? '#F0EFE9' : 'transparent'
      }}
      onMouseEnter={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = '#F7F6F3'
      }}
      onMouseLeave={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      <div className="flex items-start gap-2">
        {dot.color !== 'transparent' && (
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${dot.pulse ? 'animate-record' : ''}`}
            style={{ background: dot.color }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className="text-sm font-medium truncate leading-snug"
              style={{ color: isDraft ? '#8E8E93' : '#1A1A1A', letterSpacing: '-0.01em' }}
            >
              {title}
            </p>
            {hasCalendar && (
              <span
                className="flex-shrink-0 text-xs"
                style={{ color: '#ADADAD' }}
                title="Lié au calendrier"
              >
                📅
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: '#ADADAD' }}>
            {formatDate(meeting.createdAt)}
            {isDraft && ' · À venir'}
            {!isDraft &&
              meeting.durationSeconds > 0 &&
              ` · ${formatDurationShort(meeting.durationSeconds)}`}
            {!isDraft && meeting.status === 'error' && ' · Erreur'}
            {attendeeCount > 0 && ` · ${attendeeCount} participant${attendeeCount > 1 ? 's' : ''}`}
          </p>
        </div>
      </div>
    </button>
  )
}
