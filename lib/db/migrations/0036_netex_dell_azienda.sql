-- ════════════════════════════════════════════════════════════════════════
-- 0036 — NeTEx con il profilo italiano: i codici dell'azienda (tappa 6.2)
-- ────────────────────────────────────────────────────────────────────────
-- Gli identificativi NeTEx del profilo italiano hanno la forma
-- [nazione]:[codice locale]:[Tipo]:[codice](:[fornitore]) (linee guida del
-- profilo italiano v4.0.1, 4.2.1). Il codice locale è un NUTS (per le Marche
-- «ITI3»); il fornitore è facoltativo, e serve quando nello stesso file
-- regionale arrivano i dati di più aziende. Li decide la Regione: qui stanno
-- con i dati dell'azienda, e li cambia l'amministratore.
-- Per Conerobus il codice locale entra «ITI3» (la regione Marche); il
-- fornitore resta vuoto finché la Regione o ATMA non dicono quale.
-- ════════════════════════════════════════════════════════════════════════
DO $netex$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS netex_codice_locale text
    CONSTRAINT azienda_netex_codice_locale CHECK (netex_codice_locale ~ '^[A-Z]{2}[A-Z0-9]{0,3}$');
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS netex_fornitore text
    CONSTRAINT azienda_netex_fornitore CHECK (netex_fornitore ~ '^[A-Za-z0-9_-]{1,40}$');
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
UPDATE public.azienda SET netex_codice_locale = 'ITI3' WHERE gtfs_agency_id = 'conerobus' AND netex_codice_locale IS NULL;
--> statement-breakpoint
RESET ROLE;
