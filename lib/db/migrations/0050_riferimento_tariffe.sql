-- ════════════════════════════════════════════════════════════════════════
-- 0050 — Il riferimento della regola regionale delle tariffe (tappa 6.24)
-- ────────────────────────────────────────────────────────────────────────
-- Le pagine delle tariffe misurano la distanza di una relazione
-- extraurbana sul percorso più servito della linea e, se più linee hanno
-- gli stessi capolinea, con la media pesata sulle corse. La regola è della
-- Regione, e le pagine ne scrivevano il riferimento nel codice («DGR
-- 1036/2022 art. 2.d», che vale solo per le Marche). Ora è un dato
-- dell'azienda: lo scrive l'amministratore, e le pagine lo mostrano accanto
-- al calcolo. Vuoto: non compare.
-- Per Conerobus entra il riferimento di prima.
-- ════════════════════════════════════════════════════════════════════════
DO $riferimento$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS tariffe_riferimento text
    CONSTRAINT azienda_tariffe_riferimento CHECK (char_length(tariffe_riferimento) BETWEEN 1 AND 200);
END $riferimento$;
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
   SET tariffe_riferimento = 'DGR Marche n. 1036/2022, art. 2.d'
 WHERE gtfs_agency_id = 'conerobus' AND tariffe_riferimento IS NULL;
--> statement-breakpoint
RESET ROLE;
