-- ══════════════════════════════════════════════════════════════════════
-- 0059 — Il NeTEx di livello 3 fra i dati aperti (tappa 6.41)
-- ──────────────────────────────────────────────────────────────────────
-- I dati aperti pubblicano il NeTEx in due file, uno per livello del profilo
-- italiano, come fa il portale regionale (un file per livello):
--   netex      livello 1 (EPIP), quello che la Regione legge oggi
--   netex_l3   livello 3, con le tariffe (tappa 6.40)
-- Qui solo i vincoli: il tipo del file, e un esito nuovo, «senza_tariffe»,
-- per il livello 3 di un'azienda che non ha tariffe (il file non si fa). La
-- riga del livello 3 la scrive la preparazione dei dati aperti, la prima
-- volta che gira.
-- ══════════════════════════════════════════════════════════════════════
DO $tipo$
BEGIN
  IF pg_catalog.to_regclass('public.dati_aperti') IS NOT NULL THEN
    ALTER TABLE public.dati_aperti DROP CONSTRAINT IF EXISTS dati_aperti_tipo;
    ALTER TABLE public.dati_aperti ADD CONSTRAINT dati_aperti_tipo CHECK (tipo IN ('gtfs', 'netex', 'netex_l3'));
    ALTER TABLE public.dati_aperti DROP CONSTRAINT IF EXISTS dati_aperti_esito;
    ALTER TABLE public.dati_aperti ADD CONSTRAINT dati_aperti_esito CHECK (esito IN (
      'pubblicato', 'gtfs_con_errori', 'non_valido', 'senza_xmllint', 'senza_codice', 'senza_versione', 'errore', 'senza_tariffe'));
  END IF;
END $tipo$;
