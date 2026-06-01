import { useState, useEffect, useCallback } from 'react'
import type { Settings, PromptTemplate } from '../../types'

interface Props {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<void>
}

export function PromptSettings(_props: Props) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadTemplates = useCallback(async () => {
    const list = await window.api.templates.list()
    setTemplates(list)
    return list
  }, [])

  useEffect(() => {
    loadTemplates().then(list => {
      if (list.length > 0 && selectedId === null) {
        setSelectedId(list[0].id)
        setNameDraft(list[0].name)
        setPromptDraft(list[0].prompt)
      }
      setLoading(false)
    })
  }, [])

  const selectTemplate = (t: PromptTemplate) => {
    setSelectedId(t.id)
    setNameDraft(t.name)
    setPromptDraft(t.prompt)
    setSaved(false)
  }

  const selected = templates.find(t => t.id === selectedId) ?? null

  const handleSave = async () => {
    if (!selected) return
    await window.api.templates.update(selected.id, nameDraft, promptDraft)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    await loadTemplates()
  }

  const handleReset = () => {
    if (!selected) return
    setNameDraft(selected.name)
    setPromptDraft(selected.prompt)
    setSaved(false)
  }

  const handleAdd = async () => {
    const newT = await window.api.templates.create('Nouveau modèle', '')
    const list = await loadTemplates()
    const created = list.find(t => t.id === newT.id) ?? list[list.length - 1]
    setSelectedId(created.id)
    setNameDraft(created.name)
    setPromptDraft(created.prompt)
    setSaved(false)
  }

  const handleDelete = async () => {
    if (!selected || selected.isBuiltin) return
    if (!confirm(`Supprimer le modèle "${selected.name}" ?`)) return
    await window.api.templates.delete(selected.id)
    const list = await loadTemplates()
    if (list.length > 0) {
      setSelectedId(list[0].id)
      setNameDraft(list[0].name)
      setPromptDraft(list[0].prompt)
    } else {
      setSelectedId(null)
      setNameDraft('')
      setPromptDraft('')
    }
    setSaved(false)
  }

  if (loading) return null

  return (
    <section>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold" style={{ color: '#1A1A1A' }}>
            Modèles de résumé
          </h2>
          <p className="text-sm mt-0.5" style={{ color: '#ADADAD' }}>
            Crée des recettes pour chaque type de réunion.
          </p>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{ background: '#F5F4F0', color: '#57534E' }}
          title="Nouveau modèle"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Ajouter
        </button>
      </div>

      {/* Template list */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: '1px solid #E7E5E4' }}>
        {templates.map((t, i) => (
          <button
            key={t.id}
            onClick={() => selectTemplate(t)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm transition-colors text-left"
            style={{
              background: selectedId === t.id ? '#F0EFE9' : '#FFFFFF',
              borderBottom: i < templates.length - 1 ? '1px solid #F0EFE9' : 'none',
              color: selectedId === t.id ? '#1A1A1A' : '#3A3A3A'
            }}
          >
            <span className="font-medium">{t.name}</span>
            {t.isBuiltin ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#C7C7CC"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              <span style={{ color: '#C7C7CC', fontSize: '0.7rem' }}>perso</span>
            )}
          </button>
        ))}
      </div>

      {/* Editor */}
      {selected && (
        <div className="space-y-3">
          {!selected.isBuiltin && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#8E8E93' }}>
                Nom
              </label>
              <input
                value={nameDraft}
                onChange={e => {
                  setNameDraft(e.target.value)
                  setSaved(false)
                }}
                className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none"
                style={{ background: '#FFFFFF', border: '1px solid #E7E5E4', color: '#1A1A1A' }}
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#8E8E93' }}>
              Instructions pour Claude
            </label>
            <textarea
              value={promptDraft}
              onChange={e => {
                setPromptDraft(e.target.value)
                setSaved(false)
              }}
              rows={10}
              className="w-full px-3 py-3 rounded-xl text-sm focus:outline-none resize-y font-mono"
              style={{
                background: '#FFFFFF',
                border: '1px solid #E7E5E4',
                color: '#3A3A3A',
                lineHeight: 1.6
              }}
            />
          </div>

          <div className="flex gap-2 items-center">
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              style={{ background: '#1A1A1A', color: '#FFFFFF' }}
            >
              Sauvegarder
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-xl text-sm transition-colors"
              style={{ background: '#F5F4F0', color: '#57534E' }}
            >
              Annuler
            </button>
            {!selected.isBuiltin && (
              <button
                onClick={handleDelete}
                className="ml-auto px-3 py-2 rounded-xl text-sm transition-colors"
                style={{ background: '#FFF5F5', color: '#C0392B' }}
              >
                Supprimer
              </button>
            )}
            {saved && (
              <span className="text-xs" style={{ color: '#16A34A' }}>
                ✓ Sauvegardé
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
