-- ════════════════════════════════════════════════════════════════════════
-- 0041 — Le fasce chilometriche dell'extraurbano (tappa 6.8)
-- ────────────────────────────────────────────────────────────────────────
-- Il prezzo di una corsa extraurbana si ricava dalla distanza: a ogni fascia
-- di chilometri il suo prezzo. La tabella delle fasce era scritta due volte
-- nel codice, uguale, con i prezzi di una sola azienda. Da qui è un dato
-- dell'azienda:
--   fasce_km   una riga per fascia, numerate da 1 senza buchi. La prima
--              parte da 0 km e ognuna comincia dove finisce quella prima:
--              lo controlla l'API, che salva l'elenco intero. Una distanza
--              sta nella fascia se è più di «da» e al più «a».
-- La cambia l'amministratore (Amministrazione › Azienda), per esempio quando
-- esce una nuova delibera regionale, e ogni modifica resta nel registro.
-- Le fasce di Conerobus entrano solo nell'installazione di Conerobus (la
-- riga di azienda con gtfs_agency_id «conerobus»), uguali a quelle che erano
-- nel codice: lì i prezzi calcolati non cambiano. Una nuova parte senza.
-- ════════════════════════════════════════════════════════════════════════
DO $fasce$
BEGIN
  IF pg_catalog.to_regclass('public.fasce_km') IS NULL THEN
    CREATE TABLE public.fasce_km (
      fascia   smallint PRIMARY KEY CONSTRAINT fasce_km_fascia CHECK (fascia BETWEEN 1 AND 60),
      km_da    numeric(6,1) NOT NULL CONSTRAINT fasce_km_da CHECK (km_da >= 0),
      km_a     numeric(6,1) NOT NULL CONSTRAINT fasce_km_a CHECK (km_a <= 2000),
      prezzo   numeric(6,2) NOT NULL CONSTRAINT fasce_km_prezzo CHECK (prezzo > 0 AND prezzo <= 999.99),
      CONSTRAINT fasce_km_intervallo CHECK (km_a > km_da)
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.fasce_km OWNER TO cerbero_owner;
  END IF;
END $fasce$;
--> statement-breakpoint
SELECT registro.sorveglia('public.fasce_km', ARRAY['fascia'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.fasce_km'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- Le 23 fasce di Conerobus, come erano nel codice. Solo se la tabella è
-- ancora vuota: una seconda esecuzione non le rimette sopra a quelle che
-- l'amministratore ha cambiato.
INSERT INTO public.fasce_km (fascia, km_da, km_a, prezzo)
SELECT f.fascia, f.km_da, f.km_a, f.prezzo
  FROM (VALUES
    (1,    0,   6, 1.35),
    (2,    6,  12, 1.85),
    (3,   12,  18, 2.35),
    (4,   18,  24, 2.85),
    (5,   24,  30, 3.20),
    (6,   30,  36, 3.55),
    (7,   36,  42, 3.90),
    (8,   42,  50, 4.25),
    (9,   50,  60, 4.55),
    (10,  60,  70, 4.85),
    (11,  70,  80, 5.15),
    (12,  80,  90, 5.45),
    (13,  90, 100, 5.75),
    (14, 100, 110, 6.05),
    (15, 110, 120, 6.35),
    (16, 120, 130, 6.65),
    (17, 130, 140, 6.95),
    (18, 140, 150, 7.25),
    (19, 150, 160, 7.55),
    (20, 160, 170, 7.85),
    (21, 170, 180, 8.15),
    (22, 180, 190, 8.45),
    (23, 190, 200, 8.75)
  ) AS f(fascia, km_da, km_a, prezzo)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.fasce_km);
--> statement-breakpoint
RESET ROLE;
