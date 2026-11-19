-- ════════════════════════════════════════════════════════════════════════
-- 0053 — Il sistema di bigliettazione regionale come dato dell'azienda (tappa 6.28)
-- ────────────────────────────────────────────────────────────────────────
-- Le pagine delle tariffe nominavano il sistema di bigliettazione della
-- regione del primo cliente: la scheda dei cluster («… (Urban +
-- Addensamenti)», «conformità …») e l'export delle polimetriche. Ora le
-- etichette dicono «nodi tariffari regionali», e il nome del sistema è un
-- dato dell'azienda: lo scrive l'amministratore e compare accanto; vuoto,
-- si legge «il sistema regionale». Per Conerobus entra il nome di prima.
-- ════════════════════════════════════════════════════════════════════════
DO $sistema$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS bigliettazione_sistema text
    CONSTRAINT azienda_bigliettazione_sistema CHECK (char_length(bigliettazione_sistema) BETWEEN 1 AND 60);
END $sistema$;
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
   SET bigliettazione_sistema = 'Telemaco'
 WHERE gtfs_agency_id = 'conerobus' AND bigliettazione_sistema IS NULL;
--> statement-breakpoint
RESET ROLE;
