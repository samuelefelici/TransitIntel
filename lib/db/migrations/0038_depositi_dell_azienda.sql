-- ════════════════════════════════════════════════════════════════════════
-- 0038 — I depositi dell'azienda (tappa 6.4)
-- ────────────────────────────────────────────────────────────────────────
-- I sette depositi di Conerobus erano scritti nel codice, e l'API li
-- inseriva a ogni avvio se mancavano: una seconda azienda se li sarebbe
-- trovati senza averli chiesti, e non avrebbe potuto toglierli. Da qui i
-- depositi sono dati dell'azienda:
--   - li crea, li modifica e li toglie l'amministratore (Amministrazione ›
--     Azienda), e ogni modifica resta nel registro, coi valori;
--   - quelli di Conerobus entrano solo nell'installazione di Conerobus (la
--     riga di azienda con gtfs_agency_id «conerobus»), dove ci sono già: una
--     nuova parte vuota;
--   - il codice e il nome hanno una forma (il codice resta quello: lo usano i
--     gruppi turni e i depositi degli utenti).
-- ════════════════════════════════════════════════════════════════════════
DO $depositi$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.roster_depositi') AND conname = 'roster_depositi_codice') THEN
    ALTER TABLE public.roster_depositi
      ADD CONSTRAINT roster_depositi_codice CHECK (codice ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(codice) <= 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.roster_depositi') AND conname = 'roster_depositi_nome') THEN
    ALTER TABLE public.roster_depositi
      ADD CONSTRAINT roster_depositi_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 60);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.roster_depositi') AND conname = 'roster_depositi_ordine') THEN
    ALTER TABLE public.roster_depositi
      ADD CONSTRAINT roster_depositi_ordine CHECK (ordine BETWEEN 0 AND 9999);
  END IF;
END $depositi$;
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_depositi', ARRAY['codice'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.roster_depositi'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
INSERT INTO public.roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine)
SELECT d.codice, d.nome, d.gruppo, d.cadenza_turni, d.alias, d.ordine
  FROM (VALUES
    ('ancona',        'Ancona',        'B', 'semimensile', ARRAY['polverigi'], 1),
    ('marina',        'Marina',        'B', 'semimensile', ARRAY['belvedere', 'belvedere ostrense', 'ostra', 'marina di montemarciano'], 2),
    ('osimo',         'Osimo',         'B', 'semimensile', ARRAY[]::text[], 3),
    ('jesi',          'Jesi',          'A', 'semimensile', ARRAY[]::text[], 4),
    ('jesi-urbano',   'Jesi Urbano',   'A', 'settimanale', ARRAY['moie', 'jesi u', 'jesi urb'], 5),
    ('castelfidardo', 'Castelfidardo', 'A', 'semimensile', ARRAY[]::text[], 6),
    ('filottrano',    'Filottrano',    'A', 'semimensile', ARRAY[]::text[], 7)
  ) AS d(codice, nome, gruppo, cadenza_turni, alias, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
ON CONFLICT (codice) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
