// ============================================================
// NormalizationService — Normalisation audio post-chunk
//
// Applique un gain constant à -3dBFS sur chaque chunk WAV
// avant envoi à Whisper pour améliorer le WER sur les enregistrements
// à faible volume (micros distants, AirPods en mode A2DP).
//
// Utilise sox (prioritaire) ou ffmpeg.
// Le fichier normalisé est temporaire : l'appelant doit le supprimer après.
// ============================================================

import { spawn } from 'child_process'
import { unlinkSync, existsSync } from 'fs'
import { hasCommand } from './depCheck'

export class NormalizationService {
  private backend: 'sox' | 'ffmpeg' | null = null

  initialize(): void {
    if (hasCommand('sox')) this.backend = 'sox'
    else if (hasCommand('ffmpeg')) this.backend = 'ffmpeg'
    else this.backend = null
  }

  isAvailable(): boolean {
    return this.backend !== null
  }

  async normalizeForTranscription(inputPath: string): Promise<string> {
    if (!this.backend) return inputPath

    const outputPath = inputPath.replace(/\.wav$/, '_norm.wav')

    try {
      await this.runNormalize(inputPath, outputPath)
      return outputPath
    } catch (err) {
      console.warn(
        `[normalization] Échec normalisation ${inputPath}: ${err} — utilisation du fichier original`
      )
      return inputPath
    }
  }

  private runNormalize(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc
      if (this.backend === 'sox') {
        // gain -n = normalise au niveau 0dBFS, -3 = headroom de 3dB
        proc = spawn('sox', [inputPath, outputPath, 'gain', '-n', '-3'], {
          stdio: ['ignore', 'ignore', 'pipe']
        })
      } else {
        // ffmpeg : loudnorm filter (EBU R128 normalization to -23 LUFS)
        proc = spawn(
          'ffmpeg',
          [
            '-i',
            inputPath,
            '-af',
            'loudnorm=I=-23:LRA=7:TP=-3',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            '-y',
            outputPath
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )
      }

      proc.stderr?.on('data', () => {
        /* suppress output */
      })
      proc.on('error', reject)
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`${this.backend} exited with code ${code}`))
      })
    })
  }

  cleanup(normalizedPath: string, originalPath: string): void {
    if (normalizedPath !== originalPath && existsSync(normalizedPath)) {
      try {
        unlinkSync(normalizedPath)
      } catch {
        /* ignore */
      }
    }
  }
}
