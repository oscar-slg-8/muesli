-- ============================================================
-- Migration 003 : Persistance du décalage temporel du canal "others"
--
-- othersGracePeriodOffsetMs est calculé au démarrage de l'enregistrement
-- (temps écoulé avant le premier chunk AudioTee valide, après la grace period).
-- Sans persistance, ce décalage est perdu si l'app redémarre avant un retry
-- → tous les timestamps du canal "others" sont décalés de ~3s.
-- ============================================================

ALTER TABLE meetings ADD COLUMN others_offset_ms INTEGER NOT NULL DEFAULT 0;
