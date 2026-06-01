// ============================================================
// AudioCaptureService — capture audio native (Main Process)
//
// Architecture :
//   "me"     → processus enfant ffmpeg ou sox, écrit WAV directement sur disque
//   "others" → SystemAudioCaptureCLI --output (CATap) ou AudioTee fallback
//
// Aucun buffer PCM ne transite par IPC. Seuls les événements d'état (RMS,
// START/STOP) circulent entre Main et Renderer.
//
// Rotation de chunks toutes les 10 minutes :
//   SIGTERM → attente exit propre → merge stéréo → respawn avec nouveau chemin
//
// Output : chunk_NNN.wav stéréo (L=mic, R=system audio)
//   Chaque chunk fusionne les deux canaux avec ffmpeg post-capture.
//   Les fichiers me_chunk_NNN.wav / others_chunk_NNN.wav intermédiaires
//   sont supprimés après fusion.
// ============================================================

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { mkdirSync, openSync, writeSync, closeSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createInterface } from 'readline'
import {
  isMacOS14_2OrLater,
  getSystemAudioBinaryPath,
  detectMicBackend
} from '../../electron/utils/platform'

// ── WavWriter — conservé pour le fallback AudioTee uniquement ──────────────
class WavWriter {
  private fd: number
  private dataSize = 0
  private readonly sampleRate: number
  readonly filePath: string

  constructor(filePath: string, sampleRate: number) {
    this.filePath = filePath
    this.sampleRate = sampleRate
    this.fd = openSync(filePath, 'w')
    this.writeHeader()
  }

  private writeHeader(): void {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(0, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(this.sampleRate, 24)
    header.writeUInt32LE(this.sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(0, 40)
    writeSync(this.fd, header)
  }

  write(samples: Buffer): void {
    writeSync(this.fd, samples)
    this.dataSize += samples.length
  }

  close(): void {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(this.dataSize + 36, 0)
    writeSync(this.fd, buf, 0, 4, 4)
    buf.writeUInt32LE(this.dataSize, 0)
    writeSync(this.fd, buf, 0, 4, 40)
    closeSync(this.fd)
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

type MicBackend = 'ffmpeg' | 'sox' | null

function terminateProcess(proc: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (!proc.pid || proc.killed) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already exited */
      }
      resolve()
    }, 3000)
    proc.once('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timeout)
      resolve()
    }
  })
}

// Fusionne deux fichiers mono en un stéréo (L=mePath, R=othersPath) via ffmpeg.
// Supprime les fichiers source après fusion réussie.
function mergeToStereo(mePath: string, othersPath: string, stereoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i',
      mePath,
      '-i',
      othersPath,
      '-filter_complex',
      '[0:a][1:a]amerge=inputs=2',
      '-ar',
      '16000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      stereoPath
    ]
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', code => {
      if (code === 0) {
        try {
          unlinkSync(mePath)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(othersPath)
        } catch {
          /* ignore */
        }
        resolve()
      } else {
        reject(new Error(`merge stéréo échoué (code=${code}): ${stderr.slice(-400)}`))
      }
    })
    proc.on('error', reject)
  })
}

// ── AudioCaptureService ─────────────────────────────────────────────────────

export interface AudioCaptureCallbacks {
  onWarn: (msg: string) => void
  onError: (msg: string) => void
}

export class AudioCaptureService {
  private micProcess: ChildProcess | null = null
  private systemProcess: ChildProcess | null = null

  private audioTee: import('audiotee').AudioTee | null = null
  private othersWriter: WavWriter | null = null
  private useAudioTee = false

  private meetingDir = ''
  private chunkIndex = 0
  private chunkTimer: ReturnType<typeof setInterval> | null = null
  private startTime = 0
  // Paths intermédiaires du chunk courant (mono, seront mergés en stéréo)
  private currentMePath = ''
  private currentOthersPath = ''
  // Stéréo chunks finalisés
  private chunkFiles: string[] = []
  private isRunning = false
  private isRotating = false
  private micBackend: MicBackend = null
  private systemAudioRestartAttempts = 0
  private callbacks: AudioCaptureCallbacks = { onWarn: () => {}, onError: () => {} }

  currentOthersRMS = 0

  private readonly CHUNK_DURATION_MS = 10 * 60 * 1000
  private readonly SAMPLERATE = 16000

  async start(
    meetingId: string,
    callbacks: AudioCaptureCallbacks
  ): Promise<{ meDir: string; othersDir: string }> {
    this.callbacks = callbacks
    this.micBackend = detectMicBackend()
    this.chunkIndex = 0
    this.startTime = Date.now()
    this.chunkFiles = []
    this.isRunning = true
    this.systemAudioRestartAttempts = 0
    this.currentOthersRMS = 0

    const storagePath = app.getPath('userData')
    this.meetingDir = join(storagePath, 'audio', meetingId)
    mkdirSync(this.meetingDir, { recursive: true })

    await this.spawnChunkProcesses()

    this.chunkTimer = setInterval(() => {
      this.rotateChunk().catch(err => console.error('[audio] Erreur rotation chunk :', err))
    }, this.CHUNK_DURATION_MS)

    return { meDir: this.meetingDir, othersDir: this.meetingDir }
  }

  async stop(): Promise<{ chunkFiles: string[]; durationSeconds: number }> {
    this.isRunning = false
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer)
      this.chunkTimer = null
    }

    const kills: Promise<void>[] = []
    if (this.micProcess) kills.push(terminateProcess(this.micProcess))
    if (this.systemProcess) kills.push(terminateProcess(this.systemProcess))

    if (this.audioTee) {
      try {
        await this.audioTee.stop()
      } catch (err) {
        console.error('[audio] AudioTee stop error:', err)
      }
      this.audioTee = null
    }
    if (this.othersWriter) {
      this.othersWriter.close()
      this.othersWriter = null
    }

    await Promise.all(kills)
    this.micProcess = null
    this.systemProcess = null

    // Merger le dernier chunk en stéréo
    await this.finalizeCurrentChunk()

    const durationSeconds = Math.round((Date.now() - this.startTime) / 1000)
    return { chunkFiles: this.chunkFiles, durationSeconds }
  }

  getMeetingDir(): string {
    return this.meetingDir
  }

  writeOthersChunk(samples: ArrayBuffer): void {
    if (!this.isRunning || !this.othersWriter) return
    this.othersWriter.write(Buffer.from(samples))

    const int16 = new Int16Array(samples)
    let sum = 0
    for (let i = 0; i < int16.length; i++) {
      const n = int16[i] / 32768
      sum += n * n
    }
    this.currentOthersRMS = Math.min(1, Math.sqrt(sum / int16.length) * 10)
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  private async spawnChunkProcesses(): Promise<void> {
    const idx = String(this.chunkIndex).padStart(3, '0')
    this.currentMePath = join(this.meetingDir, `me_chunk_${idx}.wav`)
    this.currentOthersPath = join(this.meetingDir, `others_chunk_${idx}.wav`)

    if (this.micBackend) {
      this.micProcess = this.spawnMic(this.currentMePath)
    } else {
      console.warn('[audio] ffmpeg et sox introuvables — micro non capturé')
      this.callbacks.onError('sox/ffmpeg manquant — installer via Homebrew : brew install sox')
    }

    const binaryPath = getSystemAudioBinaryPath()
    const useProcessTap = isMacOS14_2OrLater() && existsSync(binaryPath)

    if (useProcessTap) {
      this.useAudioTee = false
      this.systemProcess = this.spawnSystemAudio(this.currentOthersPath)
    } else {
      this.useAudioTee = true
      this.othersWriter = new WavWriter(this.currentOthersPath, this.SAMPLERATE)
      await this.startAudioTee()
    }

    console.log(
      `[audio] Chunk ${this.chunkIndex} — me:${this.currentMePath} others:${this.currentOthersPath}`
    )
  }

  // Finalise le chunk courant : merge me+others → chunk_NNN.wav stéréo.
  private async finalizeCurrentChunk(): Promise<void> {
    const idx = String(this.chunkIndex).padStart(3, '0')
    const stereoPath = join(this.meetingDir, `chunk_${idx}.wav`)

    const meExists = existsSync(this.currentMePath)
    const othersExists = existsSync(this.currentOthersPath)

    if (!meExists) {
      console.warn(`[audio] me_chunk_${idx} absent — chunk ignoré`)
      return
    }

    if (othersExists) {
      try {
        await mergeToStereo(this.currentMePath, this.currentOthersPath, stereoPath)
        this.chunkFiles.push(stereoPath)
        console.log(`[audio] Chunk ${this.chunkIndex} stéréo → ${stereoPath}`)
      } catch (err) {
        // Merge échoué → fallback : conserver le fichier me seul comme stéréo fake
        console.error(`[audio] Merge stéréo échoué pour chunk ${this.chunkIndex}: ${err}`)
        this.chunkFiles.push(this.currentMePath)
      }
    } else {
      // Pas d'audio système → utiliser uniquement le canal mic
      console.warn(`[audio] others_chunk_${idx} absent — chunk mono mic uniquement`)
      this.chunkFiles.push(this.currentMePath)
    }
  }

  private spawnMic(outputPath: string): ChildProcess {
    let proc: ChildProcess

    if (this.micBackend === 'ffmpeg') {
      proc = spawn(
        'ffmpeg',
        [
          '-f',
          'avfoundation',
          '-i',
          ':0',
          '-ar',
          String(this.SAMPLERATE),
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-y',
          outputPath
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      proc.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line.includes('Error') || line.includes('error')) {
          console.error('[ffmpeg mic]', line)
        }
      })
    } else {
      proc = spawn(
        'sox',
        ['-d', '-t', 'wav', '-r', String(this.SAMPLERATE), '-c', '1', '-b', '16', outputPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      proc.stderr?.on('data', (d: Buffer) => console.error('[sox mic]', d.toString().trim()))
    }

    proc.on('error', err => {
      console.error(`[audio] Erreur spawn ${this.micBackend}:`, err)
      this.callbacks.onError(String(err))
    })

    proc.on('close', (code, signal) => {
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL' && this.isRunning) {
        console.error(`[audio] Processus mic terminé inopinément (code=${code})`)
      }
    })

    return proc
  }

  private spawnSystemAudio(outputPath: string): ChildProcess {
    const binaryPath = getSystemAudioBinaryPath()
    const proc = spawn(binaryPath, ['--output', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line: string) => {
      try {
        const frame = JSON.parse(line) as { type: string; event?: string; rms?: number }
        if (frame.type === 'stats' && typeof frame.rms === 'number') {
          this.currentOthersRMS = Math.min(1, frame.rms * 10)
        } else if (frame.type === 'status' && frame.event === 'started') {
          console.log('[audio] SystemAudioCapture démarré, écriture vers', outputPath)
        }
      } catch {
        /* ignorer les lignes malformées */
      }
    })

    proc.stderr?.on('data', (d: Buffer) => {
      console.log('[SystemAudioCapture]', d.toString().trim())
    })

    proc.on('error', err => {
      console.error('[audio] Erreur spawn system-audio-capture :', err)
      this.callbacks.onError(String(err))
    })

    proc.on('close', (code, signal) => {
      console.log(`[SystemAudioCapture] Terminé : code=${code}, signal=${signal}`)
      if (
        signal !== 'SIGTERM' &&
        signal !== 'SIGKILL' &&
        this.isRunning &&
        this.systemAudioRestartAttempts < 3
      ) {
        this.systemAudioRestartAttempts++
        console.log(`[SystemAudioCapture] Redémarrage #${this.systemAudioRestartAttempts}…`)
        if (this.systemAudioRestartAttempts >= 2) {
          this.callbacks.onWarn('system-audio-lost')
        }
        setTimeout(() => {
          if (this.isRunning && !this.useAudioTee) {
            this.systemProcess = this.spawnSystemAudio(this.currentOthersPath)
          }
        }, 1000)
      }
    })

    return proc
  }

  private async startAudioTee(): Promise<void> {
    try {
      const { AudioTee } = await import('audiotee')
      this.audioTee = new AudioTee({ sampleRate: this.SAMPLERATE })
      this.audioTee.on('data', chunk => {
        const ab = chunk.data.buffer.slice(
          chunk.data.byteOffset,
          chunk.data.byteOffset + chunk.data.byteLength
        ) as ArrayBuffer
        this.writeOthersChunk(ab)
      })
      this.audioTee.on('error', err => console.error('[audio] AudioTee erreur :', err))
      await this.audioTee.start()
      console.log('[audio] AudioTee démarré (fallback macOS < 14.2)')
    } catch (err) {
      console.error('[audio] Impossible de démarrer AudioTee :', err)
      this.callbacks.onError(String(err))
    }
  }

  // ── Rotation de chunks ──────────────────────────────────────────────────

  private async rotateChunk(): Promise<void> {
    if (this.isRotating || !this.isRunning) return
    this.isRotating = true
    try {
      // Terminer les processus courants (finalise les en-têtes WAV)
      const kills: Promise<void>[] = []
      if (this.micProcess) kills.push(terminateProcess(this.micProcess))
      if (this.systemProcess) kills.push(terminateProcess(this.systemProcess))

      if (this.useAudioTee) {
        if (this.audioTee) {
          try {
            await this.audioTee.stop()
          } catch {
            /* ignore */
          }
          this.audioTee = null
        }
        if (this.othersWriter) {
          this.othersWriter.close()
          this.othersWriter = null
        }
      }

      await Promise.all(kills)
      this.micProcess = null
      this.systemProcess = null

      // Merger le chunk qui vient d'être complété
      await this.finalizeCurrentChunk()

      this.chunkIndex++
      await this.spawnChunkProcesses()
      console.log(`[audio] Rotation → chunk ${this.chunkIndex}`)
    } finally {
      this.isRotating = false
    }
  }
}
