// Réglages des clés API + choix des fournisseurs (provider sélectionnable)
import { useState } from 'react'
import type { Settings } from '../../types'

interface Props {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<void>
}

function ProviderToggle<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-stone-700 mb-1.5">{label}</label>
      <div className="inline-flex p-0.5 bg-stone-100 rounded-xl border border-stone-200">
        {options.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              value === opt.value
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function MaskedInput({
  label,
  value,
  placeholder,
  hint,
  onChange
}: {
  label: string
  value: string
  placeholder: string
  hint: string
  onChange: (v: string) => void
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div>
      <label className="block text-sm font-medium text-stone-700 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2.5 text-sm bg-white border border-stone-200 rounded-xl text-stone-900 placeholder-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400 transition-all pr-16"
        />
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600 transition-colors"
        >
          {visible ? 'Masquer' : 'Voir'}
        </button>
      </div>
      <p className="text-xs text-stone-400 mt-1.5">{hint}</p>
    </div>
  )
}

export function APISettings({ settings, onUpdate }: Props) {
  return (
    <section>
      <div className="mb-5">
        <h2 className="text-base font-semibold text-stone-900">Clés API</h2>
        <p className="text-sm text-stone-400 mt-0.5">
          Stockées localement sur ton Mac, jamais transmises ailleurs.
        </p>
      </div>

      <div className="space-y-5">
        {/* Choix des fournisseurs */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100 space-y-4">
          <ProviderToggle
            label="Fournisseur — Transcription"
            value={settings.transcriptionProvider}
            options={[
              { value: 'groq', label: 'Groq Whisper' },
              { value: 'mistral', label: 'Mistral Voxtral' }
            ]}
            onChange={v => onUpdate({ transcriptionProvider: v })}
          />
          <ProviderToggle
            label="Fournisseur — Résumé IA"
            value={settings.summaryProvider}
            options={[
              { value: 'anthropic', label: 'Anthropic Claude' },
              { value: 'mistral', label: 'Mistral' }
            ]}
            onChange={v => onUpdate({ summaryProvider: v })}
          />
          <p className="text-xs text-stone-400">
            Mistral nécessite une clé ci-dessous. La clé du fournisseur non sélectionné peut rester
            vide.
          </p>
        </div>

        {/* Groq */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-2 h-2 rounded-full ${settings.apiKeyGroq ? 'bg-emerald-400' : 'bg-stone-300'}`}
            />
            <span className="text-sm font-medium text-stone-700">Groq — Transcription</span>
            <span className="ml-auto text-xs text-stone-400">console.groq.com</span>
          </div>
          <MaskedInput
            label=""
            value={settings.apiKeyGroq}
            placeholder="gsk_..."
            hint="Gratuit jusqu'à 2h d'audio/jour. Modèle : whisper-large-v3-turbo."
            onChange={v => onUpdate({ apiKeyGroq: v })}
          />
        </div>

        {/* Anthropic */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-2 h-2 rounded-full ${settings.apiKeyAnthropic ? 'bg-emerald-400' : 'bg-stone-300'}`}
            />
            <span className="text-sm font-medium text-stone-700">Anthropic — Résumé IA</span>
            <span className="ml-auto text-xs text-stone-400">console.anthropic.com</span>
          </div>
          <MaskedInput
            label=""
            value={settings.apiKeyAnthropic}
            placeholder="sk-ant-..."
            hint="~$0.01 par réunion d'1h. Modèle : Claude Haiku."
            onChange={v => onUpdate({ apiKeyAnthropic: v })}
          />
        </div>

        {/* Mistral */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-2 h-2 rounded-full ${settings.apiKeyMistral ? 'bg-emerald-400' : 'bg-stone-300'}`}
            />
            <span className="text-sm font-medium text-stone-700">
              Mistral — Transcription &amp; Résumé
            </span>
            <span className="ml-auto text-xs text-stone-400">console.mistral.ai</span>
          </div>
          <MaskedInput
            label=""
            value={settings.apiKeyMistral}
            placeholder="..."
            hint="Voxtral (transcription) et Mistral Small (résumé). Sélectionne Mistral ci-dessus pour l'utiliser."
            onChange={v => onUpdate({ apiKeyMistral: v })}
          />
        </div>

        {/* pyannoteAI */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-2 h-2 rounded-full ${settings.apiKeyPyannote ? 'bg-emerald-400' : 'bg-stone-300'}`}
            />
            <span className="text-sm font-medium text-stone-700">pyannoteAI — Diarisation</span>
            <span className="ml-auto text-xs text-stone-400">pyannote.ai</span>
          </div>
          <MaskedInput
            label=""
            value={settings.apiKeyPyannote}
            placeholder="pyai_..."
            hint="Identifie qui parle. ~0.12€/h. 150h d'essai gratuit. Sans clé : diarisation basique."
            onChange={v => onUpdate({ apiKeyPyannote: v })}
          />
        </div>

        {/* Notion */}
        <div className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-2 h-2 rounded-full ${settings.apiKeyNotion && settings.notionDatabaseId ? 'bg-emerald-400' : 'bg-stone-300'}`}
            />
            <span className="text-sm font-medium text-stone-700">Notion — Export</span>
            <span className="ml-auto text-xs text-stone-400">notion.so/my-integrations</span>
          </div>
          <div className="space-y-3">
            <MaskedInput
              label="Integration Token"
              value={settings.apiKeyNotion}
              placeholder="secret_..."
              hint="Créer une integration sur notion.so/my-integrations, puis connecter ta base."
              onChange={v => onUpdate({ apiKeyNotion: v })}
            />
            <MaskedInput
              label="Database ID"
              value={settings.notionDatabaseId}
              placeholder="abc123def456..."
              hint="Ouvre ta base en pleine page dans Notion (clic ↗), puis copie l'ID depuis l'URL — pas celui de la page parente."
              onChange={v => onUpdate({ notionDatabaseId: v })}
            />
          </div>
        </div>

        {/* Estimation coût */}
        <div className="px-4 py-3 bg-blue-50 rounded-xl border border-blue-100">
          <p className="text-xs text-blue-700 font-medium mb-1">Estimation pour usage personnel</p>
          <p className="text-xs text-blue-600">
            20 réunions × 45 min/mois ≈ <strong>$0–2/mois</strong> (Groq souvent gratuit, pyannote
            ~3€/mois)
          </p>
        </div>
      </div>
    </section>
  )
}
