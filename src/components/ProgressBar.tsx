// Barre de progression fine — top de l'app
import type { TranscriptionProgress } from '../types'

interface Props {
  progress: TranscriptionProgress | null
}

export function ProgressBar({ progress }: Props) {
  if (!progress) return null

  return (
    <div style={{ height: 3, background: '#F0EFE9', flexShrink: 0 }}>
      <div
        style={{
          height: '100%',
          width: `${progress.percent}%`,
          background: '#1A1A1A',
          transition: 'width 0.4s ease',
          borderRadius: '0 2px 2px 0'
        }}
      />
    </div>
  )
}
