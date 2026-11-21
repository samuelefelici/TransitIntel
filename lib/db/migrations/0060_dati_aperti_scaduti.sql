-- ══════════════════════════════════════════════════════════════════════
-- 0060 — I dati aperti non pubblicano un programma già scaduto (tappa 6.45)
-- ──────────────────────────────────────────────────────────────────────
-- Se tutte le corse del programma in esercizio sono in giorni già passati,
-- il GTFS e i NeTEx non si pubblicano: chi li scarica dal NAP li troverebbe
-- scaduti. In linea resta il file di prima, e la pagina dice perché e dove si
-- corregge. Qui solo il vincolo: un esito nuovo, «scaduto». Nessun dato cambia.
-- ══════════════════════════════════════════════════════════════════════
DO $esito$
BEGIN
  IF pg_catalog.to_regclass('public.dati_aperti') IS NOT NULL THEN
    ALTER TABLE public.dati_aperti DROP CONSTRAINT IF EXISTS dati_aperti_esito;
    ALTER TABLE public.dati_aperti ADD CONSTRAINT dati_aperti_esito CHECK (esito IN (
      'pubblicato', 'gtfs_con_errori', 'non_valido', 'senza_xmllint', 'senza_codice', 'senza_versione', 'errore', 'senza_tariffe', 'scaduto'));
  END IF;
END $esito$;
