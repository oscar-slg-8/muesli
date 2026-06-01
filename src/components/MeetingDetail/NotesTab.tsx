import { useState, useEffect, useRef } from 'react'
import type { Meeting } from '../../types'

interface Props {
  meeting: Meeting
  onSave: (markdown: string) => Promise<void>
}

export function NotesTab({ meeting, onSave }: Props) {
  const [content, setContent] = useState(meeting.notesMarkdown || '')
  const [saved, setSaved] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setContent(meeting.notesMarkdown || '')
    setSaved(true)
  }, [meeting.id, meeting.notesMarkdown])

  const handleChange = (value: string) => {
    setContent(value)
    setSaved(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      await onSave(value)
      setSaved(true)
    }, 1000)
  }

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (timerRef.current) clearTimeout(timerRef.current)
      await onSave(content)
      setSaved(true)
    }
  }

  return (
    <div className="flex flex-col" style={{ minHeight: 300 }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs" style={{ color: '#ADADAD' }}>
          {saved ? '✓ Sauvegardé' : '● Modifications en cours...'}
        </span>
        <span className="text-xs" style={{ color: '#C7C7CC' }}>
          ⌘S
        </span>
      </div>
      <textarea
        value={content}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Tes notes en Markdown..."
        className="flex-1 w-full outline-none resize-none text-sm leading-relaxed"
        style={{
          background: 'transparent',
          color: '#3A3A3A',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: '0.875rem',
          minHeight: 300,
          caretColor: '#1A1A1A'
        }}
        spellCheck={false}
      />
    </div>
  )
}
