// Sidebar — Liste des réunions, recherche, enregistrement
import { useState } from 'react'
import type { Meeting } from '../../types'
import { MeetingListItem } from './MeetingListItem'
import { formatDurationTimer } from '../../utils/format'

type BulkNotionResult = {
  results: Array<{ id: string; ok: boolean; url?: string; error?: string }>
}

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
  onExportNotion: (ids: string[]) => Promise<BulkNotionResult>
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
  audioLevels,
  onExportNotion
}: Props) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [statusMsg, setStatusMsg] = useState<{ text: string; error: boolean } | null>(null)

  const exitSelection = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  const toggleId = (id: string) => {
    setStatusMsg(null)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allVisibleSelected = meetings.length > 0 && meetings.every(m => selectedIds.has(m.id))
  const toggleAll = () => {
    setStatusMsg(null)
    setSelectedIds(allVisibleSelected ? new Set() : new Set(meetings.map(m => m.id)))
  }

  const handleExport = async () => {
    if (selectedIds.size === 0 || exporting) return
    setExporting(true)
    setStatusMsg(null)
    try {
      const { results } = await onExportNotion(Array.from(selectedIds))
      const okCount = results.filter(r => r.ok).length
      const failCount = results.length - okCount
      if (failCount === 0) {
        setStatusMsg({ text: `${okCount} réunion(s) exportée(s) vers Notion ✓`, error: false })
        exitSelection()
      } else {
        const firstErr = results.find(r => !r.ok)?.error ?? 'Erreur'
        setStatusMsg({
          text: `${okCount} export(s) OK, ${failCount} échec(s) : ${firstErr}`,
          error: true
        })
      }
    } catch (err) {
      setStatusMsg({ text: err instanceof Error ? err.message : String(err), error: true })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className="titlebar-drag flex items-center justify-between"
        style={{ paddingTop: 52, paddingLeft: 16, paddingRight: 16, paddingBottom: 12 }}
      >
        <span
          className="text-sm font-semibold"
          style={{ color: '#1A1A1A', letterSpacing: '-0.02em' }}
        >
          Réunions
        </span>
        {meetings.length > 0 && (
          <button
            onClick={() => {
              setStatusMsg(null)
              if (selectionMode) exitSelection()
              else setSelectionMode(true)
            }}
            className="text-xs font-medium transition-colors"
            style={
              {
                color: selectionMode ? '#C0392B' : '#2563EB',
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            {selectionMode ? 'Annuler' : 'Sélectionner'}
          </button>
        )}
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
              selectionMode={selectionMode}
              checked={selectedIds.has(m.id)}
              onToggle={() => toggleId(m.id)}
            />
          ))
        )}
      </div>

      {statusMsg && (
        <div
          className="mx-3 mb-1 px-3 py-2 rounded-lg text-xs"
          style={
            statusMsg.error
              ? { background: '#FFF5F5', color: '#C0392B' }
              : { background: '#F0FDF4', color: '#15803D' }
          }
        >
          {statusMsg.text}
        </div>
      )}

      {selectionMode && (
        <div className="p-3 space-y-2" style={{ borderTop: '1px solid #F0EFE9' }}>
          <div className="flex items-center justify-between px-1">
            <span className="text-xs" style={{ color: '#8E8E93' }}>
              {selectedIds.size} sélectionnée{selectedIds.size > 1 ? 's' : ''}
            </span>
            <button
              onClick={toggleAll}
              className="text-xs font-medium"
              style={{ color: '#2563EB' }}
            >
              {allVisibleSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
            </button>
          </div>
          <button
            onClick={handleExport}
            disabled={selectedIds.size === 0 || exporting}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{
              background: selectedIds.size === 0 || exporting ? '#E5E7EB' : '#2563EB',
              color: selectedIds.size === 0 || exporting ? '#9CA3AF' : '#FFFFFF',
              cursor: selectedIds.size === 0 || exporting ? 'default' : 'pointer'
            }}
          >
            {exporting
              ? 'Export en cours…'
              : `Exporter vers Notion${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}`}
          </button>
        </div>
      )}

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
