-- ============================================================
-- Migration 001 : Schéma initial de Granola Local
-- Crée les tables meetings et transcript_segments
-- avec la recherche full-text (FTS5)
-- ============================================================

-- Table principale des réunions
CREATE TABLE meetings (
    id                TEXT PRIMARY KEY,          -- UUID v4
    title             TEXT NOT NULL DEFAULT '',  -- Titre auto-généré ou édité
    created_at        TEXT NOT NULL,             -- ISO 8601
    updated_at        TEXT NOT NULL,             -- ISO 8601
    duration_seconds  INTEGER DEFAULT 0,         -- Durée en secondes
    status            TEXT NOT NULL DEFAULT 'recording',
                      -- Valeurs possibles : recording | transcribing | summarizing | complete | error
    speaker_me        TEXT NOT NULL DEFAULT 'MOI',
    speaker_others    TEXT NOT NULL DEFAULT 'INTERLOCUTEUR',
    notes_markdown    TEXT DEFAULT '',           -- Notes libres de l'utilisateur
    summary_markdown  TEXT DEFAULT '',           -- Résumé généré par Ollama
    summary_model     TEXT DEFAULT '',           -- Modèle utilisé (ex: mistral)
    summary_prompt    TEXT DEFAULT '',           -- Prompt utilisé (pour reproductibilité)
    language          TEXT DEFAULT 'fr',         -- Langue principale détectée
    error_message     TEXT DEFAULT NULL,         -- Message d'erreur si status = error
    audio_path_me     TEXT DEFAULT '',           -- Chemin dossier chunks "moi"
    audio_path_others TEXT DEFAULT '',           -- Chemin dossier chunks "eux"
    audio_deleted     INTEGER DEFAULT 0          -- 1 si WAV supprimés après transcription
);

-- Segments de transcription (une ligne = une phrase avec son timestamp)
CREATE TABLE transcript_segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker         TEXT NOT NULL,             -- 'me' ou 'others'
    start_time      REAL NOT NULL,             -- Secondes depuis le début de la réunion
    end_time        REAL NOT NULL,             -- Secondes depuis le début de la réunion
    text            TEXT NOT NULL,             -- Texte transcrit
    chunk_index     INTEGER NOT NULL,          -- Numéro du chunk source
    confidence      REAL DEFAULT NULL,         -- Score de confiance whisper (0 à 1)
    is_overlap      INTEGER DEFAULT 0          -- 1 si chevauchement avec l'autre flux
);

-- ============================================================
-- Index pour les requêtes fréquentes
-- ============================================================

-- Trouver les segments d'une réunion
CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id);

-- Afficher les segments dans l'ordre chronologique
CREATE INDEX idx_segments_time ON transcript_segments(meeting_id, start_time);

-- Filtrer par speaker (MOI / EUX)
CREATE INDEX idx_segments_speaker ON transcript_segments(meeting_id, speaker);

-- Liste des réunions triées par date (plus récentes en premier)
CREATE INDEX idx_meetings_created ON meetings(created_at DESC);

-- Filtrer les réunions par statut
CREATE INDEX idx_meetings_status ON meetings(status);

-- ============================================================
-- Recherche full-text avec FTS5
-- ============================================================

-- Index FTS sur les réunions (titre, notes, résumé)
CREATE VIRTUAL TABLE meetings_fts USING fts5(
    title,
    notes_markdown,
    summary_markdown,
    content='meetings',
    content_rowid='rowid'
);

-- Index FTS sur les segments de transcription
CREATE VIRTUAL TABLE segments_fts USING fts5(
    text,
    content='transcript_segments',
    content_rowid='rowid'
);

-- ============================================================
-- Triggers pour synchroniser FTS automatiquement
-- ============================================================

-- Quand on insère une réunion → ajouter dans l'index FTS
CREATE TRIGGER meetings_ai AFTER INSERT ON meetings BEGIN
    INSERT INTO meetings_fts(rowid, title, notes_markdown, summary_markdown)
    VALUES (new.rowid, new.title, new.notes_markdown, new.summary_markdown);
END;

-- Quand on supprime une réunion → retirer de l'index FTS
CREATE TRIGGER meetings_ad AFTER DELETE ON meetings BEGIN
    INSERT INTO meetings_fts(meetings_fts, rowid, title, notes_markdown, summary_markdown)
    VALUES ('delete', old.rowid, old.title, old.notes_markdown, old.summary_markdown);
END;

-- Quand on met à jour une réunion → mettre à jour l'index FTS
CREATE TRIGGER meetings_au AFTER UPDATE ON meetings BEGIN
    INSERT INTO meetings_fts(meetings_fts, rowid, title, notes_markdown, summary_markdown)
    VALUES ('delete', old.rowid, old.title, old.notes_markdown, old.summary_markdown);
    INSERT INTO meetings_fts(rowid, title, notes_markdown, summary_markdown)
    VALUES (new.rowid, new.title, new.notes_markdown, new.summary_markdown);
END;

-- Quand on insère un segment → ajouter dans l'index FTS
CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO segments_fts(rowid, text)
    VALUES (new.rowid, new.text);
END;

-- Quand on supprime un segment → retirer de l'index FTS
CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
END;
