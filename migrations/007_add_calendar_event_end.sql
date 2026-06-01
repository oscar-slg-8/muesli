-- Migration 007 : date de fin de l'événement calendrier
-- Utilisée pour auto-supprimer les drafts non enregistrés 2h après la fin du meeting
ALTER TABLE meetings ADD COLUMN calendar_event_end TEXT;
