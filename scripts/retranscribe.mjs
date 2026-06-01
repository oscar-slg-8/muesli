#!/usr/bin/env node
// ============================================================
// Script de retranscription standalone — pipeline amélioré
//
// Usage :
//   GROQ_API_KEY=gsk_xxx node scripts/retranscribe.mjs [MEETING_ID]
//
// Si MEETING_ID est omis, reprend la dernière réunion en DB.
// Applique toutes les améliorations :
//   - VAD avant Whisper (élimine hallucinations sur silence)
//   - Prompt bilingue FR/EN enrichi
//   - Fusion des micro-segments
//   - Mise à jour de la DB + réaffiche la transcription
// ============================================================

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { createRequire } from 'module'
import os from 'os'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const GROQ_API_KEY = process.env.GROQ_API_KEY
if (!GROQ_API_KEY) {
  console.error(
    '❌  GROQ_API_KEY manquante. Usage : GROQ_API_KEY=gsk_xxx node scripts/retranscribe.mjs [MEETING_ID]'
  )
  process.exit(1)
}

const DB_PATH = join(os.homedir(), 'Library/Application Support/Muesli/muesli.db')
const AUDIO_BASE = join(os.homedir(), 'Library/Application Support/Muesli/audio')

if (!existsSync(DB_PATH)) {
  console.error('❌  DB introuvable :', DB_PATH)
  process.exit(1)
}

const db = new Database(DB_PATH)

// ── Trouver la réunion ──
const meetingId =
  process.argv[2] ||
  db.prepare('SELECT id FROM meetings ORDER BY created_at DESC LIMIT 1').get()?.id

if (!meetingId) {
  console.error('❌  Aucune réunion trouvée')
  process.exit(1)
}

const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId)
if (!meeting) {
  console.error('❌  Meeting introuvable :', meetingId)
  process.exit(1)
}

console.log(`\n🎙  Retranscription : "${meeting.title}" (${meetingId.slice(0, 8)}...)`)
console.log(`    Durée : ${Math.round(meeting.duration_seconds / 60)} min\n`)

// ── Trouver les fichiers audio ──
const audioDir = join(AUDIO_BASE, meetingId)
if (!existsSync(audioDir)) {
  console.error('❌  Dossier audio introuvable :', audioDir)
  process.exit(1)
}

const files = readdirSync(audioDir)
const meChunks = files.filter(f => f.startsWith('me_chunk_') && f.endsWith('.wav')).sort()
const othersChunks = files.filter(f => f.startsWith('others_chunk_') && f.endsWith('.wav')).sort()

console.log(`    ${meChunks.length} chunks micro, ${othersChunks.length} chunks système`)

// ── Vocabulaire bilingue (identique à transcription.ts) ──
const BILINGUAL_VOCAB_PROMPT = `Réunion d'affaires en français avec termes techniques anglais.
Vocabulaire attendu : startup, fundraising, pitch deck, roadmap, product-market fit, MRR, ARR, churn, LTV, CAC, burn rate, runway, KPI, OKR, go-to-market, B2B, B2C, SaaS, API, MVP, sprint, backlog, scalable, growth hacking, A/B testing, funnel, onboarding, offboarding, feedback loop, deep dive, brainstorming, workshop, benchmark, due diligence, term sheet, cap table, bootstrapped, pre-seed, seed, Series A, angel investor, VC, leverage, pipeline, closing, upsell, cross-sell, landing page, conversion rate, retention, cohort, dashboard, analytics, framework, compliance, ROI, P&L, EBITDA, headcount.
Noms de sociétés, produits et personnes sont en majuscules.`

// ── VAD ──
function readWavPcm(wavPath) {
  const buf = readFileSync(wavPath)
  const sampleRate = buf.readUInt32LE(24)
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
  throw new Error(`Chunk data introuvable: ${wavPath}`)
}

function writeWav(path, pcm, sampleRate) {
  const dataSize = pcm.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(dataSize + 36, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  writeFileSync(
    path,
    Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
  )
}

function extractSpeechSegments(wavPath, opts = {}) {
  const {
    frameDurationMs = 30,
    energyThreshold = 0.004,
    hangoverFrames = 10,
    minSpeechDurationMs = 300,
    mergeGapMs = 800,
    paddingMs = 150
  } = opts

  const { samples, sampleRate } = readWavPcm(wavPath)
  if (samples.length === 0) return []

  const frameSamples = Math.floor((sampleRate * frameDurationMs) / 1000)
  const totalFrames = Math.floor(samples.length / frameSamples)
  if (totalFrames === 0) return []

  const frameEnergy = new Float32Array(totalFrames)
  for (let f = 0; f < totalFrames; f++) {
    let sum = 0
    const start = f * frameSamples
    for (let i = 0; i < frameSamples; i++) {
      const s = samples[start + i] / 32768
      sum += s * s
    }
    frameEnergy[f] = Math.sqrt(sum / frameSamples)
  }

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

  const regions = []
  let regionStart = -1
  for (let f = 0; f <= totalFrames; f++) {
    if (f < totalFrames && isSpeech[f]) {
      if (regionStart === -1) regionStart = f
    } else if (regionStart !== -1) {
      regions.push({ startFrame: regionStart, endFrame: f })
      regionStart = -1
    }
  }

  if (regions.length === 0) return []

  const mergeGapFrames = Math.floor(mergeGapMs / frameDurationMs)
  const merged = [{ ...regions[0] }]
  for (let i = 1; i < regions.length; i++) {
    const last = merged[merged.length - 1]
    if (regions[i].startFrame - last.endFrame < mergeGapFrames) last.endFrame = regions[i].endFrame
    else merged.push({ ...regions[i] })
  }

  const minFrames = Math.floor(minSpeechDurationMs / frameDurationMs)
  const filtered = merged.filter(r => r.endFrame - r.startFrame >= minFrames)
  if (filtered.length === 0) return []

  const paddingSamples = Math.floor((sampleRate * paddingMs) / 1000)
  const base = wavPath.replace(/\.wav$/, '')
  return filtered.map((region, i) => {
    const startSample = Math.max(0, region.startFrame * frameSamples - paddingSamples)
    const endSample = Math.min(samples.length, region.endFrame * frameSamples + paddingSamples)
    const segment = samples.slice(startSample, endSample)
    const outPath = `${base}_speech_${String(i).padStart(3, '0')}.wav`
    writeWav(outPath, segment, sampleRate)
    return {
      path: outPath,
      offsetSeconds: startSample / sampleRate,
      durationSeconds: segment.length / sampleRate
    }
  })
}

// ── Transcription Whisper ──
async function transcribeFile(wavPath, speaker, chunkIndex, timeOffset, promptContext = '') {
  const buf = readFileSync(wavPath)
  const formData = new FormData()
  formData.append('file', new Blob([buf], { type: 'audio/wav' }), basename(wavPath))
  formData.append('model', 'whisper-large-v3-turbo')
  formData.append('response_format', 'verbose_json')
  formData.append('language', 'fr')
  const prompt = promptContext
    ? `${BILINGUAL_VOCAB_PROMPT}\nContexte : ${promptContext}`
    : BILINGUAL_VOCAB_PROMPT
  formData.append('prompt', prompt)

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(120000)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const filtered = (data.segments || []).filter(s => {
    if (!s.text.trim()) return false
    if (s.no_speech_prob > 0.5) return false
    if (s.avg_logprob < -1.5) return false
    if (s.end - s.start > 25 && s.avg_logprob < -0.5) return false
    return true
  })

  // Fusion des micro-segments
  const segments = filtered.map(s => ({
    speaker,
    chunkIndex,
    startTime: s.start + timeOffset,
    endTime: s.end + timeOffset,
    text: s.text.trim(),
    avgLogprob: s.avg_logprob
  }))

  const merged = []
  let cur = segments[0]
  for (let i = 1; cur && i < segments.length; i++) {
    const next = segments[i]
    const gap = next.startTime - cur.endTime
    const words = cur.text.split(/\s+/).length + next.text.split(/\s+/).length
    if (gap <= 0.8 && words <= 40) {
      cur = {
        ...cur,
        endTime: next.endTime,
        text: cur.text.trimEnd() + ' ' + next.text.trimStart()
      }
    } else {
      merged.push(cur)
      cur = next
    }
  }
  if (cur) merged.push(cur)
  return merged
}

// ── Pipeline principal ──
async function run() {
  const CHUNK_DURATION = 600
  const contextPrompt = `Réunion "${meeting.title}"`
  const allSegments = []

  // Canal "me"
  for (let i = 0; i < meChunks.length; i++) {
    const wavPath = join(audioDir, meChunks[i])
    process.stdout.write(`  [me chunk ${i + 1}/${meChunks.length}] VAD... `)
    const speeches = extractSpeechSegments(wavPath, { energyThreshold: 0.004 })
    if (speeches.length === 0) {
      console.log('silence, skip')
      continue
    }
    console.log(`${speeches.length} segments`)

    for (const seg of speeches) {
      const offset = i * CHUNK_DURATION + seg.offsetSeconds
      try {
        process.stdout.write(`    → Whisper offset=${offset.toFixed(0)}s... `)
        const segs = await transcribeFile(seg.path, 'me', i, offset, contextPrompt)
        console.log(`${segs.length} segments`)
        allSegments.push(...segs)
      } catch (e) {
        console.log(`erreur: ${e.message}`)
      }
      try {
        unlinkSync(seg.path)
      } catch {}
    }
  }

  // Canal "others"
  for (let i = 0; i < othersChunks.length; i++) {
    const wavPath = join(audioDir, othersChunks[i])
    process.stdout.write(`  [others chunk ${i + 1}/${othersChunks.length}] VAD... `)
    const speeches = extractSpeechSegments(wavPath, { energyThreshold: 0.003, mergeGapMs: 1200 })
    if (speeches.length === 0) {
      console.log('silence, skip')
      continue
    }
    console.log(`${speeches.length} segments`)

    for (const seg of speeches) {
      const offset = i * CHUNK_DURATION + seg.offsetSeconds
      try {
        process.stdout.write(`    → Whisper offset=${offset.toFixed(0)}s... `)
        const segs = await transcribeFile(seg.path, 'others', i, offset, contextPrompt)
        console.log(`${segs.length} segments`)
        allSegments.push(...segs)
      } catch (e) {
        console.log(`erreur: ${e.message}`)
      }
      try {
        unlinkSync(seg.path)
      } catch {}
    }
  }

  // Trier par timestamp
  allSegments.sort((a, b) => a.startTime - b.startTime)

  // Afficher la transcription
  console.log('\n' + '─'.repeat(70))
  console.log(`📝  TRANSCRIPTION AMÉLIORÉE — ${allSegments.length} segments\n`)

  for (const seg of allSegments) {
    const hh = String(Math.floor(seg.startTime / 3600)).padStart(2, '0')
    const mm = String(Math.floor((seg.startTime % 3600) / 60)).padStart(2, '0')
    const ss = String(Math.floor(seg.startTime % 60)).padStart(2, '0')
    const label = seg.speaker === 'me' ? '🟦 MOI     ' : '🟩 AUTRE   '
    console.log(`${label} ${hh}:${mm}:${ss}  ${seg.text}`)
  }

  console.log('\n' + '─'.repeat(70))

  // Mettre à jour la DB
  const deleteSegs = db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ?')
  const insertSeg = db.prepare(`
    INSERT INTO transcript_segments
    (meeting_id, speaker, start_time, end_time, text, chunk_index, confidence, is_overlap)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `)
  const updateStatus = db.transaction(() => {
    deleteSegs.run(meetingId)
    for (const seg of allSegments) {
      insertSeg.run(
        meetingId,
        seg.speaker,
        seg.startTime,
        seg.endTime,
        seg.text,
        seg.chunkIndex,
        seg.avgLogprob ? Math.exp(seg.avgLogprob) : null
      )
    }
    db.prepare("UPDATE meetings SET status = 'complete', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      meetingId
    )
  })
  updateStatus()

  console.log(
    `\n✅  ${allSegments.length} segments sauvegardés en DB. Recharge Muesli pour voir le résultat.`
  )
}

run().catch(e => {
  console.error('❌  Erreur :', e.message)
  process.exit(1)
})
