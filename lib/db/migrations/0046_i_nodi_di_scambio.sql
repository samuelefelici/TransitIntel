-- ════════════════════════════════════════════════════════════════════════
-- 0046 — I nodi di scambio dell'azienda (tappa 6.16)
-- ────────────────────────────────────────────────────────────────────────
-- Stazioni, porti, aeroporti e parcheggi scambiatori erano scritti nel codice
-- in due copie diverse: sei nodi per l'analisi intermodale (routes/
-- intermodal.ts), otto per le zone di coincidenza (routes/coincidence-
-- zones.ts), con l'aeroporto solo nella prima e i tre parcheggi solo nella
-- seconda. Qui diventano una tabella sola, dato dell'azienda:
--   nodi_scambio  nodo (l'identificativo: è quello che le zone di
--                 coincidenza ricordano in hub_id), nome, tipo, coordinate,
--                 le fermate GTFS del nodo, i minuti a piedi fino alla
--                 fermata, una descrizione e gli orari stimati di arrivi e
--                 partenze ([{"luogo": …, "orari": ["HH:MM", …]}]).
-- Gli orari sono una stima scritta a mano: per le stazioni li sostituisce
-- l'orario vero scaricato da ViaggiaTreno, come prima.
-- Per Conerobus entrano i nove nodi delle due copie, con la versione
-- dell'analisi dove le copie differivano (descrizioni, due compagnie del
-- porto). Un'installazione nuova parte vuota: le restano i nodi che l'analisi
-- trova da sola dai nomi delle fermate.
-- ════════════════════════════════════════════════════════════════════════
DO $nodi$
BEGIN
  IF pg_catalog.to_regclass('public.nodi_scambio') IS NULL THEN
    CREATE TABLE public.nodi_scambio (
      -- gli identificativi dei nodi trovati da soli cominciano con «gtfs-» o «synthetic-»: questi no
      nodo           text PRIMARY KEY CONSTRAINT nodi_scambio_nodo
                       CHECK (nodo ~ '^[a-z0-9][a-z0-9-]{1,39}$' AND nodo !~ '^(gtfs|synthetic)-'),
      nome           text NOT NULL CONSTRAINT nodi_scambio_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]]'),
      tipo           text NOT NULL CONSTRAINT nodi_scambio_tipo CHECK (tipo IN ('railway', 'port', 'airport', 'park-ride')),
      lat            double precision NOT NULL CONSTRAINT nodi_scambio_lat CHECK (lat BETWEEN -90 AND 90),
      lng            double precision NOT NULL CONSTRAINT nodi_scambio_lng CHECK (lng BETWEEN -180 AND 180),
      -- gli stop_id del GTFS: dentro un progetto di Planning Studio non valgono, come prima
      fermate_gtfs   text[] NOT NULL DEFAULT '{}'::text[],
      minuti_a_piedi smallint NOT NULL DEFAULT 2 CONSTRAINT nodi_scambio_minuti CHECK (minuti_a_piedi BETWEEN 0 AND 60),
      descrizione    text NOT NULL DEFAULT '' CONSTRAINT nodi_scambio_descrizione CHECK (char_length(descrizione) <= 300 AND descrizione !~ '[[:cntrl:]]'),
      arrivi         jsonb NOT NULL DEFAULT '[]'::jsonb,
      partenze       jsonb NOT NULL DEFAULT '[]'::jsonb,
      ordine         integer NOT NULL DEFAULT 0 CONSTRAINT nodi_scambio_ordine CHECK (ordine BETWEEN 0 AND 99999),
      aggiornato_il  timestamptz NOT NULL DEFAULT now()
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.nodi_scambio OWNER TO cerbero_owner;
  END IF;
END $nodi$;
--> statement-breakpoint
SELECT registro.sorveglia('public.nodi_scambio', ARRAY['nodo'], NULL, NULL, true, '{}', ARRAY['aggiornato_il']);
--> statement-breakpoint
-- I dati come cerbero_owner, solo se le tabelle che si toccano sono già sue
-- e se può già usare lo schema (dove public non è aperto a tutti, il permesso
-- lo dà il riallineamento dei ruoli, dopo le migrazioni).
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.nodi_scambio'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- I nodi di Conerobus, com'erano nel codice: prima i sei dell'analisi, poi i
-- tre parcheggi scambiatori che avevano solo le zone di coincidenza.
INSERT INTO public.nodi_scambio (nodo, nome, tipo, lat, lng, fermate_gtfs, minuti_a_piedi, descrizione, arrivi, partenze, ordine)
SELECT * FROM (VALUES
  ('rail-ancona', 'Stazione FS Ancona', 'railway', 43.607348, 13.49776447, ARRAY['13', '18', '153', '20006', '20044']::text[], 3, 'Stazione centrale di Ancona — hub ferroviario principale (IC, FR, Regionali)',
   '[{"luogo": "Roma (IC/FR)", "orari": ["08:45", "10:15", "11:50", "13:45", "15:50", "17:45", "19:10", "20:45", "22:10"]}, {"luogo": "Milano (IC/FR)", "orari": ["07:10", "09:10", "11:10", "13:10", "15:10", "17:10", "18:35", "20:10", "22:10"]}, {"luogo": "Pesaro/Rimini (R)", "orari": ["06:25", "06:55", "07:25", "07:55", "08:25", "08:55", "09:55", "10:55", "11:55", "12:55", "13:55", "14:55", "15:55", "16:25", "16:55", "17:25", "17:55", "18:25", "18:55", "19:55", "20:55", "21:55"]}, {"luogo": "Foligno/Fabriano (R)", "orari": ["07:40", "08:40", "09:40", "11:40", "13:40", "15:40", "17:40", "19:40", "21:40"]}]'::jsonb,
   '[{"luogo": "Roma (IC/FR)", "orari": ["06:10", "07:35", "08:55", "10:35", "12:10", "14:10", "16:10", "17:35", "18:55", "20:10"]}, {"luogo": "Milano (IC/FR)", "orari": ["05:50", "06:50", "08:50", "10:50", "12:50", "14:50", "16:25", "17:50", "19:50"]}, {"luogo": "Pesaro/Rimini (R)", "orari": ["05:30", "06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:30", "20:30", "21:30"]}, {"luogo": "Foligno/Fabriano (R)", "orari": ["06:20", "07:20", "08:20", "10:20", "12:20", "14:20", "16:20", "18:20", "20:20"]}]'::jsonb, 10),
  ('rail-falconara', 'Stazione FS Falconara Marittima', 'railway', 43.6301852, 13.39739496, ARRAY['20026', '20027']::text[], 2, 'Stazione di Falconara — nodo ferrovia Adriatica / linea per Roma',
   '[{"luogo": "Ancona (R)", "orari": ["06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "20:00", "21:00"]}, {"luogo": "Roma (via Orte)", "orari": ["10:30", "14:30", "18:30", "21:30"]}, {"luogo": "Pesaro/Rimini (R)", "orari": ["06:50", "07:50", "08:50", "09:50", "11:50", "13:50", "15:50", "17:50", "19:50", "21:50"]}]'::jsonb,
   '[{"luogo": "Ancona (R)", "orari": ["06:10", "06:40", "07:10", "07:40", "08:10", "08:40", "09:40", "10:40", "11:40", "12:40", "13:40", "14:40", "15:40", "16:10", "16:40", "17:10", "17:40", "18:10", "18:40", "19:40", "20:40"]}, {"luogo": "Roma (via Orte)", "orari": ["06:35", "10:05", "14:05", "17:35"]}, {"luogo": "Pesaro/Rimini (R)", "orari": ["06:15", "07:15", "08:15", "09:15", "11:15", "13:15", "15:15", "17:15", "19:15", "21:15"]}]'::jsonb, 20),
  ('rail-palombina', 'Stazione Palombina Nuova', 'railway', 43.61802912, 13.42590525, ARRAY['20020', '20034']::text[], 1, 'Fermata ferroviaria Palombina — collegamento costiero',
   '[{"luogo": "Ancona (R)", "orari": ["06:55", "07:55", "08:55", "10:55", "13:55", "15:55", "17:55", "19:55"]}, {"luogo": "Falconara (R)", "orari": ["06:35", "07:35", "08:35", "09:35", "12:35", "14:35", "16:35", "17:35", "18:35", "19:35"]}]'::jsonb,
   '[{"luogo": "Ancona (R)", "orari": ["06:20", "07:20", "08:20", "09:20", "12:20", "14:20", "16:20", "17:20", "18:20", "19:20"]}, {"luogo": "Falconara (R)", "orari": ["06:45", "07:45", "08:45", "10:45", "13:45", "15:45", "17:45", "19:45"]}]'::jsonb, 30),
  ('port-ancona', 'Porto di Ancona (Terminal Passeggeri)', 'port', 43.61864036, 13.50938321, ARRAY['20003', '20047']::text[], 8, 'Terminal traghetti — linee per Croazia, Grecia, Albania',
   '[{"luogo": "Spalato (HR) - Jadrolinija", "orari": ["07:00"]}, {"luogo": "Spalato (HR) - SNAV", "orari": ["09:00"]}, {"luogo": "Patrasso (GR) - Minoan/Anek", "orari": ["08:00", "15:00"]}, {"luogo": "Durazzo (AL) - Adria Ferries", "orari": ["07:30"]}, {"luogo": "Igoumenitsa (GR)", "orari": ["08:00", "15:00"]}]'::jsonb,
   '[{"luogo": "Spalato (HR) - Jadrolinija", "orari": ["19:00"]}, {"luogo": "Spalato (HR) - SNAV", "orari": ["17:30"]}, {"luogo": "Patrasso (GR) - Minoan/Anek", "orari": ["13:30", "17:00"]}, {"luogo": "Durazzo (AL) - Adria Ferries", "orari": ["21:00"]}, {"luogo": "Igoumenitsa (GR)", "orari": ["13:30", "17:00"]}]'::jsonb, 40),
  ('airport-falconara', 'Aeroporto Raffaello Sanzio (Falconara)', 'airport', 43.61632, 13.36244, ARRAY['20159', '20184', '20158', '20185', '20160', '20183']::text[], 5, 'Aeroporto delle Marche — voli nazionali e internazionali',
   '[{"luogo": "Roma Fiumicino (Ryanair)", "orari": ["10:30", "16:15", "22:00"]}, {"luogo": "Milano Bergamo (Ryanair)", "orari": ["09:45", "20:15"]}, {"luogo": "Londra Stansted (Ryanair)", "orari": ["12:00"]}, {"luogo": "Bruxelles Charleroi", "orari": ["14:00"]}, {"luogo": "Düsseldorf", "orari": ["09:30"]}, {"luogo": "Tirana (Albania)", "orari": ["08:30", "17:30"]}]'::jsonb,
   '[{"luogo": "Roma Fiumicino (Ryanair)", "orari": ["06:30", "13:15", "19:00"]}, {"luogo": "Milano Bergamo (Ryanair)", "orari": ["07:00", "17:30"]}, {"luogo": "Londra Stansted (Ryanair)", "orari": ["12:45"]}, {"luogo": "Bruxelles Charleroi", "orari": ["14:30"]}, {"luogo": "Düsseldorf", "orari": ["10:00"]}, {"luogo": "Tirana (Albania)", "orari": ["09:00", "18:00"]}]'::jsonb, 50),
  ('rail-torrette', 'Stazione di Ancona Torrette', 'railway', 43.60393, 13.45299, ARRAY['20335', '20466', '20011', '20039', '20370', '20467']::text[], 2, 'Fermata ferroviaria Torrette — adiacente Ospedale Regionale Ospedali Riuniti',
   '[{"luogo": "Ancona (R)", "orari": ["06:50", "07:50", "08:50", "10:50", "13:50", "15:50", "17:50", "19:50"]}, {"luogo": "Falconara (R)", "orari": ["06:30", "07:30", "08:30", "09:30", "12:30", "14:30", "16:30", "17:30", "18:30", "19:30"]}]'::jsonb,
   '[{"luogo": "Ancona (R)", "orari": ["06:25", "07:25", "08:25", "09:25", "12:25", "14:25", "16:25", "17:25", "18:25", "19:25"]}, {"luogo": "Falconara (R)", "orari": ["06:50", "07:50", "08:50", "10:50", "13:50", "15:50", "17:50", "19:50"]}]'::jsonb, 60),
  ('pr-tavernelle', 'P+R Tavernelle (Stadio del Conero)', 'park-ride', 43.58046, 13.51847, '{}'::text[], 2, 'Parcheggio scambiatore Tavernelle — navetta per centro',
   '[]'::jsonb,
   '[]'::jsonb, 70),
  ('pr-baraccola', 'P+R Baraccola (Centro Comm.le)', 'park-ride', 43.58597, 13.48261, '{}'::text[], 2, 'Parcheggio scambiatore Baraccola — zona commerciale',
   '[]'::jsonb,
   '[]'::jsonb, 80),
  ('pr-posatora', 'P+R Posatora', 'park-ride', 43.60128, 13.48701, '{}'::text[], 1, 'Parcheggio scambiatore Posatora — ingresso ovest',
   '[]'::jsonb,
   '[]'::jsonb, 90)
) AS v(nodo, nome, tipo, lat, lng, fermate_gtfs, minuti_a_piedi, descrizione, arrivi, partenze, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.nodi_scambio);
--> statement-breakpoint
RESET ROLE;
