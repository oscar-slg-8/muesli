// ============================================================
// Service VAD (Voice Activity Detection) — Extraction de parole
//
// Problème résolu :
//   Whisper hallucine sur le silence (ex: "Sous-titrage Société Radio-Canada")
//   quand on lui envoie un WAV de 10 min dont 95% est du silence
//   (micro coupé par le side-chain AEC).
//
// Solution :
//   Avant d'envoyer un WAV à Whisper, on détecte les régions de parole
//   par analyse d'énergie RMS, et on n'envoie que ces régions.
//   Whisper ne voit jamais de silence → pas d'hallucination.
//
// Algorithme :
//   1. Calcul du RMS par trames de 30ms
//   2. Seuillage adaptatif (médiane du bruit + facteur)
//   3. Hangover pour couvrir les fins de mots
//   4. Merge des segments proches
//   5. Extraction de chaque segment en WAV temporaire
// ============================================================

import { readFileSync, writeFileSync, unlinkSync } from 'fs'

export interface SpeechSegment {
  path: string // Chemin du WAV extrait (à supprimer après transcription)
  offsetSeconds: number // Position dans l'enregistrement original
  durationSeconds: number // Durée du segment
}

interface VADOptions {
  frameDurationMs?: number // Taille de trame pour le calcul d'énergie (défaut 30ms)
  energyThreshold?: number // Seuil RMS minimum pour considérer de la parole (défaut 0.005)
  hangoverFrames?: number // Trames à garder après la fin de la parole (défaut 10 = 300ms)
  minSpeechDurationMs?: number // Durée minimum d'un segment de parole (défaut 300ms)
  mergeGapMs?: number // Fusionner les segments séparés par moins de X ms (défaut 800ms)
  paddingMs?: number // Ajouter du padding avant/après chaque segment (défaut 150ms)
}

// Lit un WAV PCM 16 bits mono, retourne les samples normalisés [-1, 1]
function readWavPcm(wavPath: string): { samples: Int16Array; sampleRate: number } {
  const buf = readFileSync(wavPath)

  // Parser l'en-tête WAV pour trouver le vrai début des données
  // (ne pas supposer 44 octets — certains WAV ont des chunks supplémentaires)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Fichier WAV invalide : ${wavPath}`)
  }

  const sampleRate = buf.readUInt32LE(24)

  // Chercher le chunk "data"
  let offset = 12
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    if (chunkId === 'data') {
      const dataStart = offset + 8
      const dataEnd = Math.min(dataStart + chunkSize, buf.length)
      const samples = new Int16Array(
        buf.buffer,
        buf.byteOffset + dataStart,
        (dataEnd - dataStart) / 2
      )
      return { samples, sampleRate }
    }
    offset += 8 + chunkSize
  }

  throw new Error(`Chunk "data" introuvable dans : ${wavPath}`)
}

// Écrit un WAV PCM 16 bits mono
function writeWav(path: string, pcm: Int16Array, sampleRate: number): void {
  const dataSize = pcm.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(dataSize + 36, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // Mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  writeFileSync(path, Buffer.concat([header, data]))
}

// Détecte et extrait les segments de parole d'un fichier WAV.
// Retourne une liste de WAV temporaires contenant uniquement de la parole,
// avec leur offset temporel dans l'enregistrement original.
export function extractSpeechSegments(wavPath: string, options: VADOptions = {}): SpeechSegment[] {
  const {
    frameDurationMs = 30,
    energyThreshold = 0.005,
    hangoverFrames = 10,
    minSpeechDurationMs = 300,
    mergeGapMs = 800,
    paddingMs = 150
  } = options

  const { samples, sampleRate } = readWavPcm(wavPath)

  if (samples.length === 0) return []

  const frameSamples = Math.floor((sampleRate * frameDurationMs) / 1000)
  const totalFrames = Math.floor(samples.length / frameSamples)

  if (totalFrames === 0) return []

  // ── Étape 1 : RMS par trame ──
  const frameEnergy = new Float32Array(totalFrames)
  for (let f = 0; f < totalFrames; f++) {
    let sum = 0
    const start = f * frameSamples
    for (let i = 0; i < frameSamples; i++) {
      const normalized = samples[start + i] / 32768
      sum += normalized * normalized
    }
    frameEnergy[f] = Math.sqrt(sum / frameSamples)
  }

  // ── Étape 2 : Seuillage + hangover ──
  const isSpeech = new Uint8Array(totalFrames)
  let hangover = 0
  for (let f = 0; f < totalFrames; f++) {
    if (frameEnergy[f] > energyThreshold) {
      isSpeech[f] = 1
      hangover = hangoverFrames
    } else if (hangover > 0) {
      isSpeech[f] = 1
      hangover--
    }
  }

  // ── Étape 3 : Extraire les régions contiguës ──
  interface Region {
    startFrame: number
    endFrame: number
  }
  const regions: Region[] = []
  let regionStart = -1

  for (let f = 0; f <= totalFrames; f++) {
    if (f < totalFrames && isSpeech[f]) {
      if (regionStart === -1) regionStart = f
    } else if (regionStart !== -1) {
      regions.push({ startFrame: regionStart, endFrame: f })
      regionStart = -1
    }
  }

  if (regions.length === 0) {
    console.log(`[vad] Aucune parole détectée dans ${wavPath}`)
    return []
  }

  // ── Étape 4 : Fusionner les régions proches ──
  const mergeGapFrames = Math.floor(mergeGapMs / frameDurationMs)
  const merged: Region[] = [{ ...regions[0] }]

  for (let i = 1; i < regions.length; i++) {
    const last = merged[merged.length - 1]
    if (regions[i].startFrame - last.endFrame < mergeGapFrames) {
      last.endFrame = regions[i].endFrame
    } else {
      merged.push({ ...regions[i] })
    }
  }

  // ── Étape 5 : Filtrer les segments trop courts ──
  const minFrames = Math.floor(minSpeechDurationMs / frameDurationMs)
  const filtered = merged.filter(r => r.endFrame - r.startFrame >= minFrames)

  if (filtered.length === 0) {
    console.log(
      `[vad] Aucun segment assez long dans ${wavPath} (${merged.length} régions trop courtes)`
    )
    return []
  }

  // ── Étape 6 : Extraire chaque segment en WAV avec padding ──
  const paddingSamples = Math.floor((sampleRate * paddingMs) / 1000)
  const baseName = wavPath.replace(/\.wav$/, '')

  const results: SpeechSegment[] = []

  for (let i = 0; i < filtered.length; i++) {
    const region = filtered[i]
    const startSample = Math.max(0, region.startFrame * frameSamples - paddingSamples)
    const endSample = Math.min(samples.length, region.endFrame * frameSamples + paddingSamples)
    const segment = samples.slice(startSample, endSample)

    const offsetSeconds = startSample / sampleRate
    const durationSeconds = segment.length / sampleRate
    const outPath = `${baseName}_speech_${String(i).padStart(3, '0')}.wav`

    writeWav(outPath, segment, sampleRate)

    results.push({ path: outPath, offsetSeconds, durationSeconds })
  }

  const totalSpeech = results.reduce((s, r) => s + r.durationSeconds, 0)
  const totalDuration = samples.length / sampleRate
  console.log(
    `[vad] ${wavPath}: ${results.length} segments de parole ` +
      `(${totalSpeech.toFixed(1)}s / ${totalDuration.toFixed(1)}s = ${((totalSpeech / totalDuration) * 100).toFixed(0)}%)`
  )

  return results
}

// Vérifie si un WAV contient de la parole détectable, sans créer de fichiers temporaires.
// Utilisé comme garde-fou avant d'envoyer un chunk à Whisper : si aucune parole
// n'est détectée, on skip l'appel API pour éviter les hallucinations sur le silence pur.
export function hasSpeech(
  wavPath: string,
  options: Pick<VADOptions, 'energyThreshold' | 'frameDurationMs' | 'minSpeechDurationMs'> = {}
): boolean {
  const { frameDurationMs = 30, energyThreshold = 0.005, minSpeechDurationMs = 500 } = options

  try {
    const { samples, sampleRate } = readWavPcm(wavPath)
    if (samples.length === 0) return false

    const frameSamples = Math.floor((sampleRate * frameDurationMs) / 1000)
    const minSpeechFrames = Math.floor(minSpeechDurationMs / frameDurationMs)
    let consecutiveSpeechFrames = 0

    for (let offset = 0; offset + frameSamples <= samples.length; offset += frameSamples) {
      let sum = 0
      for (let i = 0; i < frameSamples; i++) {
        const v = samples[offset + i] / 32768
        sum += v * v
      }
      if (Math.sqrt(sum / frameSamples) > energyThreshold) {
        consecutiveSpeechFrames++
        if (consecutiveSpeechFrames >= minSpeechFrames) return true
      } else {
        consecutiveSpeechFrames = 0
      }
    }
    return false
  } catch {
    return true // en cas d'erreur de lecture, laisser passer à Whisper
  }
}

// Supprime les fichiers WAV temporaires créés par extractSpeechSegments
export function cleanupSpeechSegments(segments: SpeechSegment[]): void {
  for (const seg of segments) {
    try {
      unlinkSync(seg.path)
    } catch {
      /* fichier déjà supprimé ou inexistant */
    }
  }
}
