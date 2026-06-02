import { useState, useEffect, useCallback } from 'react'
import type { Settings as SettingsType, DependencyStatus } from '../../types'
import { DEFAULT_SETTINGS } from '../../types'
import { AudioSettings } from './AudioSettings'
import { APISettings } from './APISettings'
import { PromptSettings } from './PromptSettings'

function micBackendLabel(backend: DependencyStatus['micBackend']): string {
  if (backend === 'ffmpeg') return 'ffmpeg'
  if (backend === 'sox') return 'sox'
  return 'Micro manquant'
}

interface Props {
  onClose: () => void
}

export function Settings({ onClose }: Props) {
  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS)
  const [deps, setDeps] = useState<DependencyStatus | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(setSettings)
    window.api.system.checkDependencies().then(setDeps)
  }, [])

  const update = useCallback(async (partial: Partial<SettingsType>) => {
    setSaving(true)
    setSettings(prev => ({ ...prev, ...partial }))
    try {
      await window.api.settings.update(partial)
    } catch (err) {
      console.error('[settings] Échec sauvegarde :', err)
      window.api.settings.get().then(setSettings)
    } finally {
      setSaving(false)
    }
  }, [])

  return (
    <div className="flex flex-col h-full" style={{ background: '#F7F6F3' }}>
      {/* En-tête */}
      <div
        className="flex items-center justify-between px-8 py-5 flex-shrink-0 titlebar-drag"
        style={{ borderBottom: '1px solid #EBEBEB', background: '#F7F6F3', paddingTop: 40 }}
      >
        <h1
          className="text-lg font-semibold"
          style={{ color: '#1A1A1A', letterSpacing: '-0.02em' }}
        >
          Réglages
        </h1>
        <div className="flex items-center gap-4">
          {saving && (
            <span className="text-xs" style={{ color: '#ADADAD' }}>
              Sauvegarde...
            </span>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{ background: '#F0EFE9', color: '#1A1A1A' }}
          >
            Fermer
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-8 py-8 space-y-10">
          {/* Statut API */}
          {deps && (
            <section>
              <h2
                className="text-xs font-semibold uppercase tracking-wider mb-3"
                style={{ color: '#ADADAD' }}
              >
                Statut
              </h2>
              <div className="flex gap-3 flex-wrap">
                <StatusBadge label="Groq" ok={deps.groqApiKey} />
                <StatusBadge label="Anthropic" ok={deps.anthropicApiKey} />
                <StatusBadge label="Mistral" ok={deps.mistralApiKey} />
                <StatusBadge label="pyannote" ok={deps.pyannoteApiKey} />
                <StatusBadge label="Notion" ok={deps.notionConfigured} />
                <StatusBadge
                  label={micBackendLabel(deps.micBackend)}
                  ok={deps.micBackend !== null}
                />
              </div>
              {deps.micBackend === null && (
                <p className="mt-2 text-xs" style={{ color: '#C0392B' }}>
                  ⚠ ffmpeg ou sox requis pour la capture micro — installer via Homebrew :{' '}
                  <code className="font-mono bg-red-50 px-1 rounded">brew install sox</code>
                </p>
              )}
            </section>
          )}

          <APISettings settings={settings} onUpdate={update} />
          <AudioSettings
            settings={settings}
            onUpdate={update}
            processTapAvailable={deps?.processTapAvailable}
            micBackend={deps?.micBackend ?? null}
          />
          <PromptSettings settings={settings} onUpdate={update} />
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm"
      style={{
        background: ok ? '#F0FAF4' : '#FFF5F5',
        color: ok ? '#16A34A' : '#C0392B',
        border: `1px solid ${ok ? '#BBF7D0' : '#FECDD3'}`
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: ok ? '#16A34A' : '#C0392B' }}
      />
      {label}
    </div>
  )
}
