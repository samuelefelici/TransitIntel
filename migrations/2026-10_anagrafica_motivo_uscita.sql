-- ═══════════════════════════════════════════════════════════════════════════
-- Anagrafica del personale: il motivo dell'uscita dal servizio
-- ───────────────────────────────────────────────────────────────────────────
-- Accanto alla data di uscita (data_fine_servizio, già presente) il motivo:
-- pensione, dimissioni, licenziamento, fine_contratto, altro. La data è un
-- dato operativo (chi veste i turni deve saperla), il motivo no: lo vede solo
-- chi ha il permesso «Personale».
--
-- L'applicazione aggiunge la colonna da sé al primo avvio
-- (api-server/src/lib/anagrafica-store.ts); il file serve a chi preferisce
-- applicarla prima, e a lasciarne traccia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE roster_drivers ADD COLUMN IF NOT EXISTS motivo_cessazione text;
