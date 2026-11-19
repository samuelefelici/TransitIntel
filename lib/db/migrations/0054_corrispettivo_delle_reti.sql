-- ════════════════════════════════════════════════════════════════════════
-- 0054 — Il corrispettivo €/km di ogni rete (tappa 6.29)
-- ────────────────────────────────────────────────────────────────────────
-- Il calcolo dei turni macchina pesava i km a vuoto al netto di un
-- corrispettivo di 2,60 €/km scritto nel codice: quello dell'urbano di
-- Ancona, usato per tutte le reti. Il corrispettivo invece cambia da rete
-- a rete (lo fissa la Regione, comune per comune per gli urbani), e non
-- tutti lo pagano anche sui km a vuoto. Ora sono dati della rete:
--   corrispettivo_km        €/km al netto dell'IVA; vuoto: non indicato
--   corrispettivo_su_vuoti  se lo si incassa anche sui km a vuoto
-- Il calcolo dà ai km a vuoto verso una corsa il corrispettivo della sua
-- rete, se lo paga sui vuoti; altrimenti costano per intero.
--
-- Per Conerobus i valori dal 2026 della DGR Marche 456/2026 (Allegato A),
-- e sui km a vuoto come il calcolo li contava finora.
-- ════════════════════════════════════════════════════════════════════════
DO $corrispettivo$
BEGIN
  ALTER TABLE public.reti ADD COLUMN IF NOT EXISTS corrispettivo_km numeric(5,2)
    CONSTRAINT reti_corrispettivo_km CHECK (corrispettivo_km >= 0 AND corrispettivo_km < 100);
  ALTER TABLE public.reti ADD COLUMN IF NOT EXISTS corrispettivo_su_vuoti boolean NOT NULL DEFAULT false;
END $corrispettivo$;
--> statement-breakpoint
-- I dati come cerbero_owner, solo se le tabelle sono già sue e se può già
-- usare lo schema (dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni).
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.reti'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
UPDATE public.reti r
   SET corrispettivo_km = v.km, corrispettivo_su_vuoti = true
  FROM (VALUES
    ('urbano_ancona',        2.60),
    ('urbano_jesi',          1.76),
    ('urbano_falconara',     1.92),
    ('urbano_senigallia',    1.84),
    ('urbano_castelfidardo', 1.68),
    ('urbano_sassoferrato',  2.79),
    ('extraurbano',          1.66)
  ) AS v(rete, km)
 WHERE r.rete = v.rete AND r.corrispettivo_km IS NULL
   AND EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus');
--> statement-breakpoint
RESET ROLE;
