// ============================================================
// Composant racine — layout sidebar + zone principale
// Design : minimaliste, style Alan (clair, chaud, aéré)
// ============================================================

import { useState, useEffect } from 'react'
import { useMeetings } from './hooks/useMeetings'
import { useRecording } from './hooks/useRecording'
import { MeetingList } from './components/MeetingList/MeetingList'
import { MeetingDetail } from './components/MeetingDetail/MeetingDetail'
import { Settings } from './components/Settings/Settings'
import { ProgressBar } from './components/ProgressBar'

type View = 'meetings' | 'settings'

function App(): JSX.Element {
  const [view, setView] = useState<View>('meetings')

  const {
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
  } = useMeetings()

  const recording = useRecording()

  const handleStartRecording = async () => {
    await recording.start()
    setView('meetings')
  }

  const handleStartFromDraft = async (meetingId: string) => {
    await recording.startFromDraft(meetingId)
    setView('meetings')
  }

  // Quand un enregistrement démarre et qu'on reçoit le meetingId,
  // naviguer automatiquement vers cette réunion (→ onglet Notes via MeetingDetail)
  useEffect(() => {
    if (recording.isRecording && recording.meetingId) {
      refresh().then(() => {
        select(recording.meetingId!)
      })
    }
  }, [recording.isRecording, recording.meetingId])

  const handleStopRecording = async () => {
    await recording.stop()
    setTimeout(refresh, 1000)
  }

  return (
    <div className="flex h-screen" style={{ background: '#F7F6F3' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 border-r"
        style={{ width: 260, background: '#FFFFFF', borderColor: '#EBEBEB' }}
      >
        <MeetingList
          meetings={meetings}
          selectedId={selectedId}
          searchQuery={searchQuery}
          onSelect={select}
          onSearch={search}
          onOpenSettings={() => setView('settings')}
          onStartRecording={handleStartRecording}
          onStopRecording={handleStopRecording}
          isRecording={recording.isRecording}
          recordingDuration={recording.duration}
          audioLevels={recording.audioLevels}
          onExportNotion={ids => window.api.export.notionExportBulk(ids)}
        />
      </aside>

      {/* Zone principale */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Barre de progression (thin line, top) */}
        <ProgressBar progress={progress} />

        {/* Erreur d'enregistrement */}
        {recording.error && (
          <div
            className="px-5 py-2 text-xs"
            style={{ background: '#FFF5F5', color: '#C0392B', borderBottom: '1px solid #FECDD3' }}
          >
            {recording.error}
          </div>
        )}

        {/* Warning enregistrement (ex: audio système perdu) */}
        {recording.warning && (
          <div
            className="px-5 py-2 text-xs flex items-center gap-2"
            style={{ background: '#FFFBEB', color: '#92400E', borderBottom: '1px solid #FDE68A' }}
          >
            <span>⚠</span>
            {recording.warning}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {view === 'settings' ? (
            <Settings onClose={() => setView('meetings')} />
          ) : selectedMeeting ? (
            <MeetingDetail
              meeting={selectedMeeting}
              segments={segments}
              progress={progress}
              isRecording={recording.isRecording && recording.meetingId === selectedMeeting.id}
              canStartFromDraft={!recording.isRecording}
              onStartFromDraft={handleStartFromDraft}
              onUpdateNotes={updateNotes}
              onUpdateTitle={updateTitle}
              onDelete={async id => {
                await deleteMeeting(id)
              }}
              onRetrySummary={(id, templateId) => retrySummary(id, templateId)}
              onUpdateLanguage={updateLanguage}
            />
          ) : (
            <EmptyState onStart={handleStartRecording} isRecording={recording.isRecording} />
          )}
        </div>
      </main>
    </div>
  )
}

function EmptyState({ onStart, isRecording }: { onStart: () => void; isRecording: boolean }) {
  return (
    <div className="flex items-center justify-center h-full titlebar-drag">
      <div className="text-center max-w-sm px-6">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: '#F0EFE9' }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#A8A29E"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>
        <h2
          className="text-lg font-semibold"
          style={{ color: '#1A1A1A', letterSpacing: '-0.02em' }}
        >
          Aucune réunion sélectionnée
        </h2>
        <p className="text-sm mt-2 leading-relaxed" style={{ color: '#8E8E93' }}>
          Lance un enregistrement ou sélectionne une réunion dans la liste.
        </p>
        {!isRecording && (
          <button
            onClick={onStart}
            className="mt-5 px-5 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{ background: '#1A1A1A', color: '#FFFFFF' }}
          >
            Nouvelle réunion
          </button>
        )}
        <p className="text-xs mt-3" style={{ color: '#C7C7CC' }}>
          ⌘⇧R
        </p>
      </div>
    </div>
  )
}

export default App
