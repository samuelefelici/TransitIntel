-- ════════════════════════════════════════════════════════════════════════
-- 0039 — Le vetture dell'azienda nell'AVM (tappa 6.5)
-- ────────────────────────────────────────────────────────────────────────
-- Nel canale dell'AVM passano anche le vetture delle aziende consorziate. Le
-- pagine dell'AVM (diario, controllo settimanale, andamento) e il confronto
-- col parco dell'officina guardano di base solo quelle dell'azienda, e le
-- riconoscevano con una regola scritta nel codice in tredici punti:
-- «matricola di 1-4 cifre = vettura Conerobus».
-- Qui la regola diventa un dato dell'azienda:
--   azienda.avm_matricola_cifre   quante cifre ha al più la matricola di una
--                                 vettura dell'azienda nel canale. Vuoto:
--                                 tutte le vetture del canale sono sue.
-- Per Conerobus entra 4: non cambia niente.
-- ════════════════════════════════════════════════════════════════════════
DO $vetture$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS avm_matricola_cifre smallint
    CONSTRAINT azienda_avm_matricola_cifre CHECK (avm_matricola_cifre BETWEEN 1 AND 9);
END $vetture$;
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
UPDATE public.azienda SET avm_matricola_cifre = 4 WHERE gtfs_agency_id = 'conerobus' AND avm_matricola_cifre IS NULL;
--> statement-breakpoint
RESET ROLE;
