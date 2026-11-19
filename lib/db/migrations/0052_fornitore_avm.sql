-- ════════════════════════════════════════════════════════════════════════
-- 0052 — Il fornitore dell'AVM come dato dell'azienda (tappa 6.27)
-- ────────────────────────────────────────────────────────────────────────
-- Le pagine e i testi dell'AVM nominavano il fornitore del primo cliente
-- («Paline Mizar», «Richiesta a Mizar», «Incollalo nella mail a Mizar»).
-- Ora il nome è un dato dell'azienda: lo scrive l'amministratore, e i testi
-- lo usano; vuoto, si legge «il fornitore dell'AVM» (e «AVM» nelle
-- etichette corte). Per Conerobus entra il nome di prima.
-- ════════════════════════════════════════════════════════════════════════
DO $fornitore$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS avm_fornitore text
    CONSTRAINT azienda_avm_fornitore CHECK (char_length(avm_fornitore) BETWEEN 1 AND 40);
END $fornitore$;
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
   SET avm_fornitore = 'Mizar'
 WHERE gtfs_agency_id = 'conerobus' AND avm_fornitore IS NULL;
--> statement-breakpoint
RESET ROLE;
