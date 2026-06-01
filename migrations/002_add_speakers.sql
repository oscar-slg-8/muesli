-- ============================================================
-- Migration 002 : Table des noms de participants par réunion
-- Permet d'avoir des noms différents pour chaque réunion
-- (ex: "Thomas" et "Client Dupont" pour une réunion,
--       "Thomas" et "Équipe Marketing" pour une autre)
-- ============================================================

CREATE TABLE meeting_speakers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_key     TEXT NOT NULL,             -- 'me' ou 'others'
    display_name    TEXT NOT NULL,             -- Nom affiché (ex: "Thomas")
    UNIQUE(meeting_id, speaker_key)
);

-- Index pour retrouver rapidement les speakers d'une réunion
CREATE INDEX idx_speakers_meeting ON meeting_speakers(meeting_id);
