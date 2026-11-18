-- ════════════════════════════════════════════════════════════════════════
-- 0047 — NeTEx: gli identificativi come quelli della Regione (tappa 6.19c)
-- ────────────────────────────────────────────────────────────────────────
-- La Regione pubblica il NeTEx della rete con identificativi come
--   epd:IT:ITI3:Line:ATMA_1/3      epd:IT:ITI3:ScheduledStopPoint:ATMA_1
--   epd:IT:ITI3:Network:RETE_TPL_ATMA
-- cioè con un prefisso davanti a tutto («epd»), un prefisso davanti a ogni
-- codice («ATMA», con «_») e un codice suo per la rete. Perché una linea o
-- una fermata tenga lo stesso identificativo quando il NeTEx lo fa Cerbero,
-- questi tre pezzi stanno con i dati dell'azienda e li cambia
-- l'amministratore. Vuoti: gli identificativi senza prefissi, e la rete col
-- codice dell'azienda.
-- Per Conerobus entrano i valori dei file della Regione Marche del 2026.
-- ════════════════════════════════════════════════════════════════════════
DO $netex$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS netex_prefisso text
    CONSTRAINT azienda_netex_prefisso CHECK (netex_prefisso ~ '^[A-Za-z][A-Za-z0-9]{0,9}$');
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS netex_prefisso_codici text
    CONSTRAINT azienda_netex_prefisso_codici CHECK (netex_prefisso_codici ~ '^[A-Za-z0-9-]{1,20}$');
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS netex_codice_rete text
    CONSTRAINT azienda_netex_codice_rete CHECK (netex_codice_rete ~ '^[A-Za-z0-9_-]{1,40}$');
END $netex$;
--> statement-breakpoint
-- I dati come cerbero_owner, solo se la tabella è già sua e se può già usare
-- lo schema (dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni).
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid = pg_catalog.to_regclass('public.azienda')
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
UPDATE public.azienda
   SET netex_prefisso = 'epd', netex_prefisso_codici = 'ATMA', netex_codice_rete = 'RETE_TPL_ATMA'
 WHERE gtfs_agency_id = 'conerobus'
   AND netex_prefisso IS NULL AND netex_prefisso_codici IS NULL AND netex_codice_rete IS NULL;
--> statement-breakpoint
RESET ROLE;
