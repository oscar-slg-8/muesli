import { useState, useCallback, useEffect } from 'react'
import type { Meeting, TranscriptionProgress, PromptTemplate } from '../../types'

interface Props {
  meeting: Meeting
  progress: TranscriptionProgress | null
  onRetry: (templateId?: number) => void
}

function buildFrontmatter(meeting: Meeting): string {
  const title = meeting.title || 'Réunion sans titre'
  const date = new Date(meeting.createdAt).toISOString()
  const m = Math.floor(meeting.durationSeconds / 60)
  const duration = m > 0 ? `${m}min` : '< 1min'
  const attendees =
    meeting.attendees && meeting.attendees.length > 0 ? `[${meeting.attendees.join(', ')}]` : '[]'
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    `duration: ${duration}`,
    `attendees: ${attendees}`,
    'tags: [meeting]',
    '---',
    ''
  ].join('\n')
}

function ExportButtons({
  meeting,
  notionConfigured
}: {
  meeting: Meeting
  notionConfigured: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [notionState, setNotionState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [notionError, setNotionError] = useState('')

  const handleCopy = useCallback(async () => {
    await window.api.export.copyToClipboard(meeting.summaryMarkdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [meeting.summaryMarkdown])

  const handleExportMd = useCallback(async () => {
    const safeName = (meeting.title || 'reunion')
      .replace(/[^a-zA-Z0-9àâäéèêëïîôùûüÿçœæ _-]/g, '')
      .slice(0, 60)
    const content = buildFrontmatter(meeting) + meeting.summaryMarkdown
    await window.api.export.saveFile(`${safeName}.md`, content)
  }, [meeting])

  const handleNotion = useCallback(async () => {
    setNotionState('loading')
    setNotionError('')
    const result = await window.api.export.notionExport(meeting.id)
    if (result.ok) {
      setNotionState('success')
      await window.api.system.openExternal(result.url)
      setTimeout(() => setNotionState('idle'), 3000)
    } else {
      setNotionState('error')
      setNotionError(result.error)
      setTimeout(() => setNotionState('idle'), 5000)
    }
  }, [meeting.id])

  return (
    <div className="flex flex-col gap-2 mb-5">
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: copied ? '#F0FAF4' : '#F5F4F0',
            color: copied ? '#16A34A' : '#6B6B6B'
          }}
        >
          {copied ? (
            <>
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
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Copié
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
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copier
            </>
          )}
        </button>
        <button
          onClick={handleExportMd}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{ background: '#F5F4F0', color: '#6B6B6B' }}
        >
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
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Exporter .md
        </button>
        {notionConfigured && (
          <button
            onClick={handleNotion}
            disabled={notionState === 'loading'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background:
                notionState === 'success'
                  ? '#F0FAF4'
                  : notionState === 'error'
                    ? '#FFF5F5'
                    : '#F5F4F0',
              color:
                notionState === 'success'
                  ? '#16A34A'
                  : notionState === 'error'
                    ? '#C0392B'
                    : '#6B6B6B',
              opacity: notionState === 'loading' ? 0.6 : 1,
              cursor: notionState === 'loading' ? 'not-allowed' : 'pointer'
            }}
          >
            {notionState === 'loading' ? (
              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
            ) : notionState === 'success' ? (
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
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
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
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            )}
            {notionState === 'loading'
              ? 'Export...'
              : notionState === 'success'
                ? 'Ouvert dans Notion'
                : 'Notion'}
          </button>
        )}
      </div>
      {notionState === 'error' && notionError && (
        <p className="text-xs px-1" style={{ color: '#C0392B' }}>
          {notionError}
        </p>
      )}
    </div>
  )
}

function TemplatePicker({
  onRetry,
  label
}: {
  onRetry: (templateId?: number) => void
  label: string
}) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined)

  useEffect(() => {
    window.api.templates.list().then(list => {
      setTemplates(list)
      if (list.length > 0) setSelectedId(list[0].id)
    })
  }, [])

  return (
    <div className="flex gap-2 items-center flex-wrap">
      {templates.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : undefined)}
          className="px-3 py-2 rounded-xl text-sm focus:outline-none"
          style={{ background: '#F5F4F0', border: '1px solid #E7E5E4', color: '#3A3A3A' }}
        >
          {templates.map(t => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={() => onRetry(selectedId)}
        className="px-4 py-2 rounded-xl text-sm font-medium transition-colors"
        style={{ background: '#1A1A1A', color: '#FFFFFF' }}
      >
        {label}
      </button>
    </div>
  )
}

export function SummaryTab({ meeting, progress, onRetry }: Props) {
  const [notionConfigured, setNotionConfigured] = useState(false)

  useEffect(() => {
    window.api.system
      .checkDependencies()
      .then(deps => setNotionConfigured(deps.notionConfigured))
      .catch(() => {
        /* silent */
      })
  }, [])

  if (meeting.status === 'recording') {
    return (
      <div className="py-12 text-center">
        <div
          className="w-8 h-8 rounded-full border-2 flex items-center justify-center mx-auto mb-4"
          style={{ borderColor: '#FF3B30' }}
        >
          <span className="w-2 h-2 rounded-full animate-record" style={{ background: '#FF3B30' }} />
        </div>
        <p className="text-sm" style={{ color: '#8E8E93' }}>
          Enregistrement en cours...
        </p>
        <p className="text-xs mt-1" style={{ color: '#C7C7CC' }}>
          Le résumé sera généré après l'arrêt.
        </p>
      </div>
    )
  }

  if (meeting.status === 'transcribing') {
    return (
      <div className="py-12">
        <p className="text-sm mb-4" style={{ color: '#8E8E93' }}>
          Transcription en cours via Groq...
        </p>
        {progress && (
          <>
            <div
              className="rounded-full overflow-hidden"
              style={{ height: 3, background: '#EBEBEB' }}
            >
              <div
                className="h-full transition-all"
                style={{ width: `${progress.percent}%`, background: '#1A1A1A', borderRadius: 2 }}
              />
            </div>
            <p className="text-xs mt-2" style={{ color: '#C7C7CC' }}>
              {progress.currentStep} — {progress.percent}%
            </p>
          </>
        )}
      </div>
    )
  }

  if (meeting.status === 'summarizing') {
    return (
      <div className="py-12 text-center">
        <div
          className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-4"
          style={{ borderColor: '#1A1A1A', borderTopColor: 'transparent' }}
        />
        <p className="text-sm" style={{ color: '#8E8E93' }}>
          Génération du résumé avec Claude Haiku...
        </p>
      </div>
    )
  }

  if (meeting.status === 'error' && !meeting.summaryMarkdown) {
    return (
      <div className="py-6">
        <div
          className="rounded-2xl p-4"
          style={{ background: '#FFF5F5', border: '1px solid #FECDD3' }}
        >
          <p className="text-sm font-medium" style={{ color: '#C0392B' }}>
            Erreur lors du traitement
          </p>
          <p className="text-sm mt-1 mb-3" style={{ color: '#E57373' }}>
            {meeting.errorMessage || 'Erreur inconnue'}
          </p>
          <TemplatePicker onRetry={onRetry} label="Réessayer" />
        </div>
      </div>
    )
  }

  if (meeting.summaryMarkdown) {
    return (
      <div className="prose-meeting">
        <ExportButtons meeting={meeting} notionConfigured={notionConfigured} />
        {meeting.errorMessage && (
          <div
            className="mb-4 px-3 py-2 rounded-xl text-xs"
            style={{ background: '#FFF9E6', color: '#B45309', border: '1px solid #FDE68A' }}
          >
            Note : {meeting.errorMessage}
          </div>
        )}
        <SummaryMarkdown content={meeting.summaryMarkdown} />
        <div className="mt-6 pt-4" style={{ borderTop: '1px solid #EBEBEB' }}>
          <p className="text-xs mb-2" style={{ color: '#ADADAD' }}>
            Re-générer avec un autre modèle
          </p>
          <TemplatePicker onRetry={onRetry} label="Re-générer" />
        </div>
      </div>
    )
  }

  return (
    <div className="py-12 text-center">
      <p className="text-sm mb-4" style={{ color: '#8E8E93' }}>
        Aucun résumé disponible.
      </p>
      <TemplatePicker onRetry={onRetry} label="Générer le résumé" />
    </div>
  )
}

function SummaryMarkdown({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: JSX.Element[] = []
  let i = 0

  for (const line of lines) {
    const key = i++
    if (line.startsWith('## ')) {
      elements.push(
        <h2
          key={key}
          style={{
            fontSize: '0.875rem',
            fontWeight: 600,
            color: '#1A1A1A',
            marginTop: '1.4rem',
            marginBottom: '0.4rem'
          }}
        >
          {line.slice(3)}
        </h2>
      )
    } else if (line.startsWith('# ')) {
      elements.push(
        <h1
          key={key}
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            color: '#1A1A1A',
            marginTop: '1rem',
            marginBottom: '0.5rem'
          }}
        >
          {line.slice(2)}
        </h1>
      )
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={key} className="flex gap-2" style={{ marginBottom: '0.2rem' }}>
          <span style={{ color: '#ADADAD', flexShrink: 0, marginTop: '0.1rem' }}>·</span>
          <span style={{ fontSize: '0.9rem', lineHeight: 1.6, color: '#3A3A3A' }}>
            <InlineFormat text={line.slice(2)} />
          </span>
        </div>
      )
    } else if (line.trim() === '') {
      elements.push(<div key={key} style={{ height: '0.4rem' }} />)
    } else {
      elements.push(
        <p
          key={key}
          style={{ fontSize: '0.9rem', lineHeight: 1.65, color: '#3A3A3A', marginBottom: '0.5rem' }}
        >
          <InlineFormat text={line} />
        </p>
      )
    }
  }

  return <>{elements}</>
}

function InlineFormat({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={i} style={{ fontWeight: 600, color: '#1A1A1A' }}>
              {part.slice(2, -2)}
            </strong>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
