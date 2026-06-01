// ============================================================
// Service de diarisation — Alignement et merge des deux flux
//
// Architecture des flux audio :
//   "me"     → microphone physique (getUserMedia, processus renderer)
//              = voix de l'utilisateur local
//   "others" → sortie audio système (AudioTee / Core Audio Taps, processus main)
//              = voix des interlocuteurs (audio sortant des haut-parleurs)
//
// Les deux flux sont transcrits indépendamment par Groq Whisper puis fusionnés
// ici en une timeline unifiée. L'étape removeEchoSegments() supprime les segments
// "me" qui sont en réalité l'écho des haut-parleurs capté par le micro.
// ============================================================

import type { TranscriptSegment } from '../types'

export class DiarizationService {
  // Merge quand les segments "others" sont déjà diarisés (par pyannoteAI).
  // On garde uniquement l'echo removal et la déduplication, sans l'heuristique par pauses.
  // Version du merge pour le nouveau pipeline stéréo :
  // L'AEC ffmpeg a déjà éliminé l'écho, removeEchoSegments est inutile ici.
  mergePreDiarized(
    meSegments: TranscriptSegment[],
    othersSegments: TranscriptSegment[]
  ): TranscriptSegment[] {
    console.log(
      `[diarization] mergePreDiarized: ${meSegments.length} me, ${othersSegments.length} others (pyannote)`
    )
    const cleanedMe = this.removeLoopHallucinations(meSegments)
    const cleanedOthers = this.removeLoopHallucinations(othersSegments)
    const all = [...cleanedMe, ...cleanedOthers]
    all.sort((a, b) => a.startTime - b.startTime)

    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[j].startTime >= all[i].endTime) break
        if (all[i].speaker !== all[j].speaker) {
          all[i].isOverlap = true
          all[j].isOverlap = true
        }
      }
    }

    return this.consolidateToTurns(this.deduplicateAtBoundaries(all))
  }

  // Seuil de pause (secondes) pour détecter un changement de locuteur
  // dans le flux "others". Une pause > 2s entre segments consécutifs
  // indique probablement qu'un autre participant prend la parole.
  private readonly TURN_GAP_SECONDS = 2.0

  // Fusionner les segments des deux flux en une timeline unifiée
  merge(meSegments: TranscriptSegment[], othersSegments: TranscriptSegment[]): TranscriptSegment[] {
    console.log(
      `[diarization] merge: ${meSegments.length} segments me, ${othersSegments.length} segments others`
    )

    // 0. Supprimer les hallucinations de type "boucle" (Whisper sur audio dégradé).
    const filteredMe = this.removeLoopHallucinations(meSegments)
    const filteredOthers = this.removeLoopHallucinations(othersSegments)

    if (filteredMe.length < meSegments.length) {
      console.log(
        `[diarization] ${meSegments.length - filteredMe.length} segments me supprimés (boucle)`
      )
    }

    // 1. Supprimer les échos : quand le micro capte le son des haut-parleurs,
    //    un segment "me" ressemble fortement à un segment "others" au même moment.
    //    On supprime le segment "me" car c'est l'écho, pas la vraie voix.
    const cleanedMe = this.removeEchoSegments(filteredMe, filteredOthers)
    if (cleanedMe.length < filteredMe.length) {
      console.log(
        `[diarization] ${filteredMe.length - cleanedMe.length} segments me supprimés (écho)`
      )
    }

    // 2. Sans diarisation pyannoteAI, on ne peut pas distinguer les locuteurs
    //    dans le flux "others" (audio système). On assigne tous les segments à
    //    'others' (l'interlocuteur générique) plutôt que d'utiliser une heuristique
    //    par pauses qui génère de faux participants (la VAD supprime les silences,
    //    ce qui crée artificiellement des gaps > 2s entre segments du même locuteur).
    const labeledOthers = filteredOthers.map(s => ({
      ...s,
      speaker: 'others' as TranscriptSegment['speaker']
    }))

    // 3. Combiner les deux tableaux
    const all = [...cleanedMe, ...labeledOthers]

    // 4. Trier par timestamp de début
    all.sort((a, b) => a.startTime - b.startTime)

    // 5. Détecter les chevauchements
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[j].startTime >= all[i].endTime) break
        if (all[i].speaker !== all[j].speaker) {
          all[i].isOverlap = true
          all[j].isOverlap = true
        }
      }
    }

    // 6. Dédupliquer les segments similaires aux jonctions de chunks
    const deduped = this.deduplicateAtBoundaries(all)

    // 7. Consolider en tours de parole.
    // On ne pense plus en "segments Whisper" (2-15s chacun) mais en "prises de parole".
    // Une prise de parole = tout ce que dit un locuteur avant que l'autre prenne la parole,
    // ou avant une pause significative (> MAX_GAP_SECONDS).
    // Résultat : 5-15 tours pour une réunion de 30 min au lieu de 30-80 fragments.
    return this.consolidateToTurns(deduped)
  }

  // Consolide les segments Whisper bruts en tours de parole lisibles.
  // Règle : deux segments du même locuteur séparés par moins de MAX_GAP_SECONDS
  // sont fusionnés en un seul tour. Le texte est concaténé avec un espace.
  //
  // C'est l'équivalent de ce que Granola appelle "speaker turns" : on affiche
  // un paragraphe par prise de parole, pas une ligne par segment Whisper.
  consolidateToTurns(segments: TranscriptSegment[], maxGapSeconds = 1.5): TranscriptSegment[] {
    if (segments.length === 0) return []

    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime)
    const turns: TranscriptSegment[] = []
    let current = { ...sorted[0] }

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i]
      const gap = next.startTime - current.endTime

      if (next.speaker === current.speaker && gap < maxGapSeconds) {
        // Même locuteur, pause courte → on fusionne dans le tour courant
        current = {
          ...current,
          text: current.text + ' ' + next.text,
          endTime: next.endTime,
          // On conserve la confiance la plus basse (maillon faible)
          confidence:
            current.confidence != null && next.confidence != null
              ? Math.min(current.confidence, next.confidence)
              : (current.confidence ?? next.confidence)
        }
      } else {
        // Changement de locuteur ou pause longue → nouveau tour
        turns.push(current)
        current = { ...next }
      }
    }
    turns.push(current)

    return turns
  }

  // Assigne un index de tour de parole aux segments "others" basé sur les pauses.
  // Ex : others_0 → premiers segments, others_1 → après une pause de 2s, etc.
  // L'index alterne (0, 1, 0, 1...) pour modéliser une conversation à 2+ personnes.
  private assignSpeakerTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length === 0) return []

    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime)
    let turnIndex = 0

    return sorted.map((seg, i) => {
      if (i > 0) {
        const gap = seg.startTime - sorted[i - 1].endTime
        if (gap > this.TURN_GAP_SECONDS) {
          turnIndex++
        }
      }
      return { ...seg, speaker: `others_${turnIndex % 8}` as TranscriptSegment['speaker'] }
    })
  }

  // Détecte et supprime les hallucinations de type "boucle".
  // Whisper, face à de l'audio de mauvaise qualité (début d'appel, bruit réseau,
  // micro trop faible), répète parfois la même phrase plusieurs fois dans un
  // seul segment : "Bonjour ! Bonjour ! Bonjour ! Enchanté ! Enchanté !"
  // On détecte cela en vérifiant si la première moitié du texte est très similaire
  // à la seconde moitié (similarité > 75%).
  private removeLoopHallucinations(segments: TranscriptSegment[]): TranscriptSegment[] {
    return segments.filter(s => {
      const text = s.text.trim()
      if (text.length < 20) return true
      const words = text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
      if (words.length < 6) return true
      const half = Math.floor(words.length / 2)
      const firstHalf = words.slice(0, half).join(' ')
      const secondHalf = words.slice(half).join(' ')
      if (this.textSimilarity(firstHalf, secondHalf) > 0.75) {
        console.log(
          `[diarization] Boucle supprimée (${s.startTime.toFixed(1)}s) : "${text.substring(0, 60)}..."`
        )
        return false
      }
      return true
    })
  }

  // Supprime les segments "me" qui sont en réalité l'écho des haut-parleurs.
  //
  // Seuils adaptatifs selon le degré de chevauchement temporel :
  //   - Containment complet  (me ⊂ other ±0.5s) : seuil 0.20 — écho quasi-certain
  //   - Chevauchement fort   (>50% du segment me) : seuil 0.35
  //   - Proximité temporelle (±3s)                : seuil 0.50 — seuil conservateur
  //
  // Similarité : Jaccard sur les mots (rapide, robuste aux longues phrases)
  // + repli Levenshtein normalisé pour les phrases courtes (<8 mots).
  //
  // Complexité : O(n log n) via index temporel par fenêtres de 5s.
  // Chaque segment "me" ne compare que les segments "others" temporellement proches
  // (même bucket ±1), réduisant ~10 000 comparaisons à ~50-200 pour une réunion d'1h.

  private buildTimeIndex(
    segments: TranscriptSegment[],
    windowSec = 5
  ): Map<number, TranscriptSegment[]> {
    const index = new Map<number, TranscriptSegment[]>()
    for (const seg of segments) {
      const bucket = Math.floor(seg.startTime / windowSec)
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        if (!index.has(b)) index.set(b, [])
        index.get(b)!.push(seg)
      }
    }
    return index
  }

  private removeEchoSegments(
    meSegments: TranscriptSegment[],
    othersSegments: TranscriptSegment[]
  ): TranscriptSegment[] {
    if (othersSegments.length === 0) return meSegments

    const WINDOW_SEC = 5
    const timeIndex = this.buildTimeIndex(othersSegments, WINDOW_SEC)

    return meSegments.filter(me => {
      const meDuration = me.endTime - me.startTime
      const bucket = Math.floor(me.startTime / WINDOW_SEC)

      const candidates = new Set<TranscriptSegment>()
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        for (const seg of timeIndex.get(b) ?? []) candidates.add(seg)
      }

      for (const other of candidates) {
        // Proximité temporelle — fenêtre large pour couvrir les décalages de transcription
        const inWindow = me.startTime <= other.endTime + 3 && me.endTime >= other.startTime - 3
        if (!inWindow) continue

        // Calcul du chevauchement temporel réel
        const overlapStart = Math.max(me.startTime, other.startTime)
        const overlapEnd = Math.min(me.endTime, other.endTime)
        const overlap = Math.max(0, overlapEnd - overlapStart)
        const overlapRatio = meDuration > 0 ? overlap / meDuration : 0

        // Seuil adaptatif selon le degré de chevauchement
        let threshold: number
        if (overlapRatio > 0.9) {
          threshold = 0.2 // containment complet → écho quasi-certain
        } else if (overlapRatio > 0.5) {
          threshold = 0.35 // chevauchement fort
        } else {
          threshold = 0.5 // simple proximité → seuil conservateur
        }

        const sim = this.textSimilarity(me.text, other.text)
        if (sim > threshold) {
          console.log(
            `[diarization] Écho supprimé (${me.startTime.toFixed(1)}s, overlap=${(overlapRatio * 100).toFixed(0)}%, sim=${sim.toFixed(2)}) :`,
            `"${me.text.substring(0, 50)}" ≈ "${other.text.substring(0, 50)}"`
          )
          return false
        }
      }
      return true
    })
  }

  // Supprimer les doublons causés par l'overlap entre chunks
  private deduplicateAtBoundaries(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length <= 1) return segments

    const result: TranscriptSegment[] = [segments[0]]

    for (let i = 1; i < segments.length; i++) {
      const prev = result[result.length - 1]
      const curr = segments[i]

      // Même speaker, même chunk suivant, texte similaire → doublon
      if (
        curr.speaker === prev.speaker &&
        Math.abs(curr.startTime - prev.startTime) < 2 &&
        this.textSimilarity(prev.text, curr.text) > 0.8
      ) {
        // Garder le segment le plus long
        if (curr.text.length > prev.text.length) {
          result[result.length - 1] = curr
        }
        continue
      }

      result.push(curr)
    }

    return result
  }

  // Similarité de texte : Jaccard sur les mots pour les phrases longues (≥8 mots),
  // Levenshtein normalisé pour les phrases courtes où chaque caractère compte.
  private textSimilarity(a: string, b: string): number {
    const cleanA = a
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim()
    const cleanB = b
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim()

    if (cleanA === cleanB) return 1
    if (cleanA.length === 0 || cleanB.length === 0) return 0

    const wordsA = cleanA.split(/\s+/)
    const wordsB = cleanB.split(/\s+/)

    // Jaccard pour phrases longues : efficace O(n) et robuste aux reformulations
    if (wordsA.length >= 8 || wordsB.length >= 8) {
      return this.jaccardWords(wordsA, wordsB)
    }

    // Levenshtein normalisé pour les phrases courtes
    const maxLen = Math.max(cleanA.length, cleanB.length)
    return 1 - this.levenshtein(cleanA, cleanB) / maxLen
  }

  // Similarité de Jaccard sur les sacs de mots (insensible à l'ordre)
  private jaccardWords(wordsA: string[], wordsB: string[]): number {
    const setA = new Set(wordsA)
    const setB = new Set(wordsB)
    let intersection = 0
    for (const w of setA) {
      if (setB.has(w)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union === 0 ? 1 : intersection / union
  }

  // Distance de Levenshtein (édition minimale)
  private levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
      }
    }

    return dp[m][n]
  }
}
