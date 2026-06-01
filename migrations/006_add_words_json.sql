-- Migration 006 : word-level timestamps pour les segments transcrits
ALTER TABLE transcript_segments ADD COLUMN words_json TEXT;
