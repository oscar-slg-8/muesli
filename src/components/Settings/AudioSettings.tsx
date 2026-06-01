import type { Settings, DependencyStatus } from '../../types'

interface Props {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<void>
  processTapAvailable?: boolean
  micBackend: DependencyStatus['micBackend']
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium mb-1.5" style={{ color: '#57534E' }}>
      {children}
    </label>
  )
}

export function AudioSettings({ settings, onUpdate, processTapAvailable, micBackend }: Props) {
  return (
    <section>
      <div className="mb-5">
        <h2 className="text-base font-semibold" style={{ color: '#1A1A1A' }}>
          Audio
        </h2>
      </div>

      <div className="space-y-5">
        <div>
          <FieldLabel>Microphone (ta voix)</FieldLabel>
          <p className="mt-1 text-xs" style={{ color: '#ADADAD' }}>
            La capture native utilise le micro système par défaut (MacBook mic). La sélection de
            périphérique personnalisé sera disponible dans une prochaine version.
          </p>
        </div>

        <div>
          {processTapAvailable ? (
            <div className="flex items-center gap-2">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: '#22C55E' }}
              />
              <p className="text-xs" style={{ color: '#ADADAD' }}>
                Audio système : Process Tap actif — aucun pilote requis.
              </p>
            </div>
          ) : (
            <p className="text-xs" style={{ color: '#ADADAD' }}>
              L'audio système est capturé via Core Audio (fallback AudioTee).
            </p>
          )}
        </div>

        {/* [C] Statut moteur de capture mic */}
        {micBackend !== null ? (
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: '#22C55E' }}
            />
            <p className="text-xs" style={{ color: '#ADADAD' }}>
              Capture micro : <code className="font-mono">{micBackend}</code>
            </p>
          </div>
        ) : (
          <div
            className="rounded-xl px-4 py-3 text-xs"
            style={{ background: '#FFF5F5', color: '#C0392B', border: '1px solid #FECDD3' }}
          >
            <strong>Micro non disponible.</strong> Installe sox ou ffmpeg via Homebrew :{' '}
            <code className="font-mono bg-red-50 px-1 rounded">brew install sox</code>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <FieldLabel>Supprimer l'audio après transcription</FieldLabel>
            <p className="text-xs" style={{ color: '#ADADAD' }}>
              Les fichiers WAV sont supprimés une fois la transcription terminée.
            </p>
          </div>
          <button
            onClick={() =>
              onUpdate({ deleteAudioAfterTranscription: !settings.deleteAudioAfterTranscription })
            }
            className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ml-4"
            style={{ background: settings.deleteAudioAfterTranscription ? '#1A1A1A' : '#D6D3D1' }}
          >
            <span
              className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
              style={{
                transform: settings.deleteAudioAfterTranscription
                  ? 'translateX(20px)'
                  : 'translateX(0)'
              }}
            />
          </button>
        </div>

        <div>
          <FieldLabel>Raccourci global</FieldLabel>
          <input
            value={settings.shortcut}
            onChange={e => onUpdate({ shortcut: e.target.value })}
            placeholder="CommandOrControl+Shift+R"
            className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
            style={{ background: '#FFFFFF', border: '1px solid #E7E5E4', color: '#1A1A1A' }}
          />
        </div>
      </div>
    </section>
  )
}
