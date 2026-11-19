-- ════════════════════════════════════════════════════════════════════════
-- 0051 — La codifica dei turni guida come dato dell'azienda (tappa 6.25)
-- ────────────────────────────────────────────────────────────────────────
-- Il solver dei turni guida dà a ogni turno un codice: la lettera del
-- deposito di residenza e tre cifre, 001-099 per i turni del mattino e
-- 100-199 per quelli del pomeriggio, divisi a mezzogiorno. Era scritto nel
-- codice (la codifica del primo cliente), con la lettera presa dall'iniziale
-- del nome del deposito: due depositi con la stessa iniziale si dividevano
-- la lettera. Ora:
--   - depots.sigla: la sigla del deposito nei codici (da 1 a 3 lettere o
--     cifre maiuscole); vuota, l'iniziale del nome come prima;
--   - azienda.turni_guida_pomeriggio_da: da che minuto del giorno un turno è
--     pomeridiano; vuoto, una sola numerazione da 001.
-- Per Conerobus entra mezzogiorno (720): i codici restano quelli di prima.
-- ════════════════════════════════════════════════════════════════════════
DO $codifica$
BEGIN
  ALTER TABLE public.depots ADD COLUMN IF NOT EXISTS sigla text
    CONSTRAINT depots_sigla CHECK (sigla ~ '^[A-Z0-9]{1,3}$');
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS turni_guida_pomeriggio_da integer
    CONSTRAINT azienda_turni_guida_pomeriggio_da CHECK (turni_guida_pomeriggio_da BETWEEN 1 AND 1439);
END $codifica$;
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
   SET turni_guida_pomeriggio_da = 720
 WHERE gtfs_agency_id = 'conerobus' AND turni_guida_pomeriggio_da IS NULL;
--> statement-breakpoint
RESET ROLE;
