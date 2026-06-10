// ============================================================
// Service base de données SQLite — CRUD complet
// Tourne dans le processus principal (main) uniquement.
// ============================================================

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import type {
  Meeting,
  TranscriptSegment,
  Settings,
  DEFAULT_SETTINGS,
  PromptTemplate
} from '../types'

interface MigrationRow {
  filename: string
}
interface MeetingRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  duration_seconds: number
  status: string
  speaker_me: string
  speaker_others: string
  notes_markdown: string
  summary_markdown: string
  summary_model: string
  language: string
  error_message: string | null
  audio_path_me: string
  audio_path_others: string
  audio_deleted: number
  others_offset_ms: number
  calendar_event_id: string | null
  attendees: string | null
}
interface SegmentRow {
  id: number
  meeting_id: string
  speaker: string
  start_time: number
  end_time: number
  text: string
  chunk_index: number
  confidence: number | null
  is_overlap: number
}
interface SettingRow {
  key: string
  value: string
}
interface FtsRow {
  id?: string
  meeting_id?: string
}
interface TemplateRow {
  id: number
  name: string
  prompt: string
  is_builtin: number
  created_at: string
}

export class DatabaseService {
  private db: Database.Database | null = null
  private dbPath: string = ''
  private migrationsApplied: number = 0

  initialize(): void {
    const userDataPath = app.getPath('userData')
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })

    this.dbPath = join(userDataPath, 'muesli.db')
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.runMigrations()
    this.ensureSettingsTable()
    this.seedBuiltinTemplates()
  }

  // --- Migrations ---
  private runMigrations(): void {
    const db = this.getDb()
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )`)

    const migrationsPath = this.getMigrationsPath()
    if (!existsSync(migrationsPath)) return

    const files = readdirSync(migrationsPath)
      .filter(f => f.endsWith('.sql'))
      .sort()
    const rows = db.prepare('SELECT filename FROM _migrations').all() as MigrationRow[]
    const applied = new Set(rows.map(r => r.filename))

    for (const file of files) {
      if (applied.has(file)) {
        this.migrationsApplied++
        continue
      }
      const sql = readFileSync(join(migrationsPath, file), 'utf-8')
      db.transaction(() => {
        db.exec(sql)
        db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString()
        )
      })()
      this.migrationsApplied++
      console.log(`[database] Migration appliquée : ${file}`)
    }
    console.log(`[database] ${this.migrationsApplied} migration(s) au total`)
  }

  private ensureSettingsTable(): void {
    this.getDb().exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`)
  }

  private getMigrationsPath(): string {
    if (!app.isPackaged) return join(app.getAppPath(), 'migrations')
    return join(process.resourcesPath, 'migrations')
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('Base de données non initialisée')
    return this.db
  }

  // --- Réunions CRUD ---
  private rowToMeeting(row: MeetingRow): Meeting {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      durationSeconds: row.duration_seconds,
      status: row.status as Meeting['status'],
      speakerMe: row.speaker_me,
      speakerOthers: row.speaker_others,
      notesMarkdown: row.notes_markdown,
      summaryMarkdown: row.summary_markdown,
      summaryModel: row.summary_model,
      language: row.language,
      errorMessage: row.error_message,
      audioPathMe: row.audio_path_me,
      audioPathOthers: row.audio_path_others,
      audioDeleted: row.audio_deleted === 1,
      othersOffsetMs: row.others_offset_ms ?? 0,
      calendarEventId: row.calendar_event_id ?? null,
      attendees: row.attendees ? (JSON.parse(row.attendees) as string[]) : null
    }
  }

  createMeeting(
    id: string,
    speakerMe: string,
    speakerOthers: string,
    audioPathMe: string,
    audioPathOthers: string
  ): Meeting {
    const now = new Date().toISOString()
    this.getDb()
      .prepare(
        `INSERT INTO meetings
      (id, title, created_at, updated_at, status, speaker_me, speaker_others, audio_path_me, audio_path_others)
      VALUES (?, '', ?, ?, 'recording', ?, ?, ?, ?)`
      )
      .run(id, now, now, speakerMe, speakerOthers, audioPathMe, audioPathOthers)
    return this.getMeeting(id)!
  }

  getMeeting(id: string): Meeting | null {
    const row = this.getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as
      | MeetingRow
      | undefined
    return row ? this.rowToMeeting(row) : null
  }

  listMeetings(): Meeting[] {
    const rows = this.getDb()
      .prepare(
        // Timeline descendante continue : réunion à venir la plus lointaine en
        // haut → la plus proche → puis l'historique (du plus récent au plus
        // ancien). En lisant de bas en haut, l'à-venir est donc croissant et
        // enchaîne logiquement avec le passé. (created_at d'un brouillon =
        // heure de début de la réunion.)
        'SELECT * FROM meetings ORDER BY created_at DESC'
      )
      .all() as MeetingRow[]
    return rows.map(r => this.rowToMeeting(r))
  }

  updateMeeting(id: string, updates: Partial<Record<string, string | number | null>>): void {
    const db = this.getDb()
    const allowed = [
      'title',
      'status',
      'duration_seconds',
      'notes_markdown',
      'summary_markdown',
      'summary_model',
      'language',
      'error_message',
      'audio_path_me',
      'audio_path_others',
      'audio_deleted',
      'others_offset_ms',
      'calendar_event_id',
      'attendees',
      'calendar_event_end'
    ]
    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const [key, val] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`)
        values.push(val ?? null)
      }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)
    db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  meetingExistsForEvent(calendarEventId: string): boolean {
    const row = this.getDb()
      .prepare('SELECT id FROM meetings WHERE calendar_event_id = ? LIMIT 1')
      .get(calendarEventId) as { id: string } | undefined
    return row !== undefined
  }

  createDraftMeeting(fields: {
    title: string
    date: string
    attendees: string[]
    calendarEventId: string
    eventEnd?: string
  }): string {
    const id = require('crypto').randomUUID() as string
    const now = new Date().toISOString()
    const settings = {
      speakerMe: this.getSetting('speakerMeName', 'MOI'),
      speakerOthers: this.getSetting('speakerOthersName', 'INTERLOCUTEUR')
    }
    this.getDb()
      .prepare(
        `INSERT INTO meetings
      (id, title, created_at, updated_at, status, speaker_me, speaker_others,
       audio_path_me, audio_path_others, calendar_event_id, attendees, calendar_event_end)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, '', '', ?, ?, ?)`
      )
      .run(
        id,
        fields.title,
        // created_at = heure de DÉBUT de la réunion (et non l'instant de création) :
        // permet de trier/afficher les brouillons par heure de début.
        fields.date,
        now,
        settings.speakerMe,
        settings.speakerOthers,
        fields.calendarEventId,
        JSON.stringify(fields.attendees),
        fields.eventEnd ?? null
      )
    return id
  }

  // Supprime les meetings draft dont l'événement calendrier est terminé
  // (heure de fin passée) et qui n'ont jamais été enregistrés.
  deleteStaleDrafts(): number {
    const result = this.getDb()
      .prepare(
        `
      DELETE FROM meetings
      WHERE status = 'draft'
        AND calendar_event_end IS NOT NULL
        AND datetime(calendar_event_end) < datetime('now')
    `
      )
      .run()
    return result.changes
  }

  deleteMeeting(id: string): void {
    this.getDb().prepare('DELETE FROM meetings WHERE id = ?').run(id)
  }

  // --- Segments de transcription ---
  addSegments(
    meetingId: string,
    segments: (Omit<TranscriptSegment, 'id'> & { words_json?: string })[]
  ): void {
    const db = this.getDb()
    const insert = db.prepare(`INSERT INTO transcript_segments
      (meeting_id, speaker, start_time, end_time, text, chunk_index, confidence, is_overlap, words_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    db.transaction(() => {
      for (const s of segments) {
        insert.run(
          meetingId,
          s.speaker,
          s.startTime,
          s.endTime,
          s.text,
          s.chunkIndex,
          s.confidence,
          s.isOverlap ? 1 : 0,
          s.words_json ?? null
        )
      }
    })()
  }

  updateSegmentText(segmentId: number, text: string): void {
    this.getDb()
      .prepare('UPDATE transcript_segments SET text = ? WHERE id = ?')
      .run(text.trim(), segmentId)
  }

  deleteSegments(meetingId: string): void {
    this.getDb().prepare('DELETE FROM transcript_segments WHERE meeting_id = ?').run(meetingId)
  }

  getSegments(meetingId: string): TranscriptSegment[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_time')
      .all(meetingId) as SegmentRow[]
    return rows.map(r => ({
      id: r.id,
      meetingId: r.meeting_id,
      speaker: r.speaker as 'me' | 'others',
      startTime: r.start_time,
      endTime: r.end_time,
      text: r.text,
      chunkIndex: r.chunk_index,
      confidence: r.confidence,
      isOverlap: r.is_overlap === 1
    }))
  }

  // --- Recherche full-text ---
  searchMeetings(query: string): Meeting[] {
    const db = this.getDb()
    const meetingIds = new Set<string>()

    // Chercher dans les réunions (titre, notes, résumé)
    const mRows = db
      .prepare(`SELECT rowid FROM meetings_fts WHERE meetings_fts MATCH ?`)
      .all(query) as Array<{ rowid: number }>
    for (const r of mRows) {
      const m = db.prepare('SELECT id FROM meetings WHERE rowid = ?').get(r.rowid) as
        | { id: string }
        | undefined
      if (m) meetingIds.add(m.id)
    }

    // Chercher dans les segments
    const sRows = db
      .prepare(`SELECT rowid FROM segments_fts WHERE segments_fts MATCH ?`)
      .all(query) as Array<{ rowid: number }>
    for (const r of sRows) {
      const s = db
        .prepare('SELECT meeting_id FROM transcript_segments WHERE rowid = ?')
        .get(r.rowid) as { meeting_id: string } | undefined
      if (s) meetingIds.add(s.meeting_id)
    }

    if (meetingIds.size === 0) return []
    const placeholders = [...meetingIds].map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM meetings WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...meetingIds) as MeetingRow[]
    return rows.map(r => this.rowToMeeting(r))
  }

  // --- Speaker names (per-meeting) ---
  getSpeakerNames(meetingId: string): Record<string, string> {
    const rows = this.getDb()
      .prepare('SELECT speaker_key, display_name FROM meeting_speakers WHERE meeting_id = ?')
      .all(meetingId) as Array<{ speaker_key: string; display_name: string }>
    const map: Record<string, string> = {}
    for (const r of rows) map[r.speaker_key] = r.display_name
    return map
  }

  setSpeakerName(meetingId: string, speakerKey: string, displayName: string): void {
    this.getDb()
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_key, display_name) VALUES (?, ?, ?)
       ON CONFLICT(meeting_id, speaker_key) DO UPDATE SET display_name = excluded.display_name`
      )
      .run(meetingId, speakerKey, displayName)
  }

  // --- Settings ---
  getSetting(key: string, defaultValue: string): string {
    const row = this.getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | SettingRow
      | undefined
    return row ? row.value : defaultValue
  }

  setSetting(key: string, value: string): void {
    this.getDb()
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  // --- Templates de résumé ---
  private rowToTemplate(row: TemplateRow): PromptTemplate {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      isBuiltin: row.is_builtin === 1,
      createdAt: row.created_at
    }
  }

  getTemplates(): PromptTemplate[] {
    try {
      const rows = this.getDb()
        .prepare('SELECT * FROM templates ORDER BY is_builtin DESC, id ASC')
        .all() as TemplateRow[]
      return rows.map(r => this.rowToTemplate(r))
    } catch {
      return []
    }
  }

  getTemplate(id: number): PromptTemplate | null {
    try {
      const row = this.getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id) as
        | TemplateRow
        | undefined
      return row ? this.rowToTemplate(row) : null
    } catch {
      return null
    }
  }

  createTemplate(name: string, prompt: string): PromptTemplate {
    const info = this.getDb()
      .prepare('INSERT INTO templates (name, prompt, is_builtin) VALUES (?, ?, 0)')
      .run(name, prompt)
    return this.getTemplate(info.lastInsertRowid as number)!
  }

  updateTemplate(id: number, name: string, prompt: string): void {
    this.getDb()
      .prepare('UPDATE templates SET name = ?, prompt = ? WHERE id = ?')
      .run(name, prompt, id)
  }

  deleteTemplate(id: number): void {
    this.getDb().prepare('DELETE FROM templates WHERE id = ? AND is_builtin = 0').run(id)
  }

  seedBuiltinTemplates(): void {
    const db = this.getDb()
    try {
      const count = (db.prepare('SELECT COUNT(*) as c FROM templates').get() as { c: number }).c
      if (count > 0) return
    } catch {
      return
    }

    const defaultPrompt = this.getSetting(
      'summaryPrompt',
      'Tu es un assistant spécialisé dans la prise de notes de réunions.\n' +
        'Produis un résumé structuré en français avec :\n' +
        '## Titre\n## Résumé exécutif (5-8 lignes)\n## Points clés discutés\n' +
        '## Décisions prises\n## Actions à faire (avec responsable et deadline si mentionnés)\n## Prochaines étapes\n' +
        'Reste factuel. Si quelque chose n\'est pas clair, indique "[peu clair dans l\'audio]".'
    )

    const builtins = [
      { name: 'Défaut', prompt: defaultPrompt },
      {
        name: '1:1',
        prompt:
          'Tu es un assistant spécialisé dans les réunions individuelles.\n' +
          'Produis un résumé structuré avec :\n## Titre\n## Sujets abordés\n## Décisions prises\n' +
          '## Actions par personne (avec responsable et deadline)\n## Points de suivi pour le prochain 1:1\n' +
          'Reste factuel et concis.'
      },
      {
        name: 'Appel client',
        prompt:
          'Tu es un assistant spécialisé dans les réunions clients.\n' +
          'Produis un résumé structuré avec :\n## Titre\n## Contexte et objectifs\n## Points discutés\n' +
          "## Engagements pris (avec responsable)\n## Risques et points d'attention\n## Prochaines étapes et suivi\n" +
          'Utilise un ton professionnel. Reste factuel.'
      },
      {
        name: 'Standup',
        prompt:
          "Tu es un assistant spécialisé dans les standups d'équipe.\n" +
          'Produis un résumé structuré par personne avec :\n## Titre\n' +
          '## Par participant : ce qui a été fait, ce qui est prévu, les blocages éventuels\n' +
          "## Points d'action collectifs\nSois concis et factuel."
      },
      {
        name: 'Revue technique',
        prompt:
          'Tu es un assistant spécialisé dans les réunions techniques.\n' +
          'Produis un résumé structuré avec :\n## Titre\n## Problème ou objectif\n' +
          '## Options discutées (avec avantages et inconvénients)\n## Décision retenue et justification\n' +
          '## Questions ouvertes\n## Actions techniques (avec responsable)\nReste précis et factuel.'
      }
    ]

    const insert = db.prepare('INSERT INTO templates (name, prompt, is_builtin) VALUES (?, ?, 1)')
    for (const t of builtins) insert.run(t.name, t.prompt)
  }

  getPath(): string {
    return this.dbPath
  }
  getMigrationsCount(): number {
    return this.migrationsApplied
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
