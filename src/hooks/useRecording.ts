// ============================================================
// Hook useRecording — VU-meter uniquement (Renderer)
//
// La capture audio est entièrement déléguée au Main Process (ffmpeg/sox +
// SystemAudioCaptureCLI). Ce hook gère uniquement :
//   - L'état UI de l'enregistrement (isRecording, duration, meetingId)
//   - Le VU-meter micro : getUserMedia + AnalyserNode (aucun AudioWorklet,
//     aucun transfert de buffer PCM sur IPC — juste un float RMS toutes les 100ms)
//   - La réception des événements d'état depuis le Main Process
// ============================================================

import { useState, useEffect, useRef, useCallback } from 'react'

interface AudioLevels {
  me: number // 0-1 (RMS normalisé)
  others: number
}

interface RecordingState {
  isRecording: boolean
  meetingId: string | null
  duration: number
  error: string | null
  warning: string | null // ex: 'system-audio-lost'
  audioLevels: AudioLevels
}

export function useRecording() {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    meetingId: null,
    duration: 0,
    error: null,
    warning: null,
    audioLevels: { me: 0, others: 0 }
  })
  const audioLevelsRef = useRef<AudioLevels>({ me: 0, others: 0 })

  // VU-meter mic — getUserMedia minimal, AnalyserNode uniquement
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const meLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Cancellation token: incremented each time stopVuMeter is called so a pending
  // getUserMedia that resolves after stop can detect it should release immediately.
  const vuMeterTokenRef = useRef<number>(0)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(0)

  const startVuMeter = useCallback(async () => {
    // Guard: don't open a second stream if already running
    if (micStreamRef.current) return
    const token = ++vuMeterTokenRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

      // Race condition guard: stopVuMeter was called while getUserMedia was pending
      if (vuMeterTokenRef.current !== token) {
        for (const track of stream.getTracks()) track.stop()
        return
      }

      micStreamRef.current = stream

      const ctx = new AudioContext()
      audioContextRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)

      const data = new Float32Array(analyser.fftSize)

      meLevelTimerRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.min(1, Math.sqrt(sum / data.length) * 10)
        audioLevelsRef.current.me = rms
        window.api.recording.sendMeLevel(rms)
      }, 100)
    } catch (err) {
      console.warn('[useRecording] VU-meter micro indisponible :', err)
    }
  }, [])

  const stopVuMeter = useCallback(() => {
    vuMeterTokenRef.current++ // invalidate any in-flight getUserMedia call
    if (meLevelTimerRef.current) {
      clearInterval(meLevelTimerRef.current)
      meLevelTimerRef.current = null
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) track.stop()
      micStreamRef.current = null
    }
    audioContextRef.current?.close()
    audioContextRef.current = null
    audioLevelsRef.current.me = 0
  }, [])

  // beforeunload est garanti de s'exécuter avant la destruction de la page,
  // contrairement au cleanup de useEffect qui peut ne pas s'exécuter si Electron
  // détruit la fenêtre trop rapidement. C'est le seul moyen fiable de libérer
  // le micro (getUserMedia) quand la fenêtre est fermée.
  useEffect(() => {
    window.addEventListener('beforeunload', stopVuMeter)
    return () => window.removeEventListener('beforeunload', stopVuMeter)
  }, [stopVuMeter])

  useEffect(() => {
    const handleRequestStart = () => {
      startVuMeter()
    }
    const handleOthersLevel = (level: unknown) => {
      audioLevelsRef.current.others = level as number
    }
    const handleRequestStop = () => stopVuMeter()
    const handleStarted = (meetingId: unknown) => {
      startTimeRef.current = Date.now()
      setState({
        isRecording: true,
        meetingId: meetingId as string,
        duration: 0,
        error: null,
        warning: null,
        audioLevels: { me: 0, others: 0 }
      })
    }
    const handleStopped = () => {
      stopVuMeter() // safety net in case recording:requestStop was missed
      setState(s => ({ ...s, isRecording: false, warning: null }))
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    const handleAudioTeeError = () => {
      setState(s => ({
        ...s,
        error:
          "Capture audio système indisponible — seul le micro sera transcrit. Vérifiez les permissions dans Réglages Système → Confidentialité → Enregistrement d'écran."
      }))
    }
    const handleWarning = (msg: unknown) => {
      if (msg === 'system-audio-lost') {
        setState(s => ({
          ...s,
          warning: "Audio système perdu — l'audio des interlocuteurs ne sera plus capturé."
        }))
      }
    }

    window.api.on('recording:requestStart', handleRequestStart)
    window.api.on('audio:othersLevel', handleOthersLevel)
    window.api.on('recording:requestStop', handleRequestStop)
    window.api.on('recording:started', handleStarted)
    window.api.on('recording:stopped', handleStopped)
    window.api.on('recording:audioTeeError', handleAudioTeeError)
    window.api.on('recording:warning', handleWarning)

    return () => {
      window.api.off('recording:requestStart', handleRequestStart)
      window.api.off('audio:othersLevel', handleOthersLevel)
      window.api.off('recording:requestStop', handleRequestStop)
      window.api.off('recording:started', handleStarted)
      window.api.off('recording:stopped', handleStopped)
      window.api.off('recording:audioTeeError', handleAudioTeeError)
      window.api.off('recording:warning', handleWarning)
      stopVuMeter()
    }
  }, [startVuMeter, stopVuMeter])

  useEffect(() => {
    if (state.isRecording) {
      timerRef.current = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000)
        setState(s => ({ ...s, duration: elapsed }))
      }, 1000)
      const levelsTimer = setInterval(() => {
        setState(s => ({ ...s, audioLevels: { ...audioLevelsRef.current } }))
      }, 100)
      return () => {
        if (timerRef.current) clearInterval(timerRef.current)
        clearInterval(levelsTimer)
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [state.isRecording])

  const start = useCallback(async () => {
    try {
      await window.api.recording.start()
    } catch (err) {
      setState(s => ({ ...s, error: String(err) }))
    }
  }, [])

  const startFromDraft = useCallback(async (meetingId: string) => {
    try {
      await window.api.recording.startFromDraft(meetingId)
    } catch (err) {
      setState(s => ({ ...s, error: String(err) }))
    }
  }, [])

  const stop = useCallback(async () => {
    try {
      await window.api.recording.stop()
    } catch (err) {
      setState(s => ({ ...s, error: String(err) }))
    }
  }, [])

  return { ...state, start, startFromDraft, stop }
}
