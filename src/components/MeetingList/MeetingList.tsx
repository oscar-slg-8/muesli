// Sidebar — Liste des réunions, recherche, enregistrement
import type { Meeting } from '../../types'
import { MeetingListItem } from './MeetingListItem'
import { formatDurationTimer } from '../../utils/format'

interface AudioLevels {
  me: number
  others: number
}

interface Props {
  meetings: Meeting[]
  selectedId: string | null
  searchQuery: string
  onSelect: (id: string) => void
  onSearch: (query: string) => void
  onOpenSettings: () => void
  onStartRecording: () => void
  onStopRecording: () => void
  isRecording: boolean
  recordingDuration: number
  audioLevels?: AudioLevels
}

function AudioLevelBar({ level, label, color }: { level: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] w-12 text-right" style={{ color: '#A8A29E' }}>
        {label}
      </span>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#F0EFE9' }}>
        <div
          className="h-full rounded-full transition-all duration-100"
          style={{
            width: `${Math.max(2, level * 100)}%`,
            background: level > 0.01 ? color : '#D6D3D1'
          }}
        />
      </div>
      <div
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: level > 0.01 ? '#22C55E' : '#D6D3D1' }}
      />
    </div>
  )
}

export function MeetingList({
  meetings,
  selectedId,
  searchQuery,
  onSelect,
  onSearch,
  onOpenSettings,
  onStartRecording,
  onStopRecording,
  isRecording,
  recordingDuration,
  audioLevels
}: Props) {
  return (
    <div className="flex flex-col h-full">
      <div
        className="titlebar-drag"
        style={{ paddingTop: 52, paddingLeft: 16, paddingRight: 16, paddingBottom: 12 }}
      >
        <span
          className="text-sm font-semibold"
          style={{ color: '#1A1A1A', letterSpacing: '-0.02em' }}
        >
          Réunions
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#C7C7CC"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Rechercher..."
            value={searchQuery}
            onChange={e => onSearch(e.target.value)}
            className="w-full text-sm pl-8 pr-3 py-2 rounded-lg focus:outline-none transition-all"
            style={{ background: '#F5F4F0', color: '#1A1A1A', border: '1px solid transparent' }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {meetings.length === 0 ? (
          <p className="text-xs px-2 py-4" style={{ color: '#C7C7CC' }}>
            {searchQuery ? 'Aucun résultat' : 'Aucune réunion enregistrée'}
          </p>
        ) : (
          meetings.map(m => (
            <MeetingListItem
              key={m.id}
              meeting={m}
              selected={m.id === selectedId}
              onClick={() => onSelect(m.id)}
            />
          ))
        )}
      </div>

      <div className="p-3 space-y-1" style={{ borderTop: '1px solid #F0EFE9' }}>
        {isRecording ? (
          <div className="space-y-2">
            <button
              onClick={onStopRecording}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium"
              style={{ background: '#FFF5F5', color: '#C0392B' }}
            >
              <span className="w-2 h-2 rounded-full bg-red-500 animate-record flex-shrink-0" />
              <span className="font-mono text-xs">{formatDurationTimer(recordingDuration)}</span>
              <span className="flex-1 text-left">Arrêter</span>
            </button>

            {/* Indicateurs niveaux audio */}
            {audioLevels && (
              <div className="px-2 py-1.5 space-y-1">
                <AudioLevelBar level={audioLevels.me} label="Micro" color="#3B82F6" />
                <AudioLevelBar level={audioLevels.others} label="Système" color="#F59E0B" />
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={onStartRecording}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-stone-100"
            style={{ background: '#F5F4F0', color: '#1A1A1A' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
            Nouvelle réunion
          </button>
        )}

        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors hover:bg-stone-50"
          style={{ color: '#8E8E93' }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Réglages
        </button>
      </div>
    </div>
  )
}
