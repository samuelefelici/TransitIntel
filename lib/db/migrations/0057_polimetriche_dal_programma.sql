-- ══════════════════════════════════════════════════════════════════════
-- 0057 — Le polimetriche dal programma di esercizio (tappa 6.36)
-- ──────────────────────────────────────────────────────────────────────
-- Le polimetriche si facevano su un GTFS caricato a mano (uno ZIP). Ora si
-- fanno su un programma di Planning Studio: di solito quello in esercizio
-- (la sua versione pubblicata), o un programma programmato o una bozza per
-- preparare quelle del prossimo.
--
-- Dal programma si fa una FOTOGRAFIA: le linee extraurbane, le loro
-- varianti, le fermate coi km. È una riga di polim_imports come quelle degli
-- ZIP, così tutto il resto (area di lavoro, polimetriche salvate, confronto
-- con la bigliettazione) non cambia. Una fotografia, e non il programma
-- vivo: le polimetriche salvate puntano alle fermate per posizione, e una
-- modifica in Planning Studio le sposterebbe senza dirlo.
--
--   fonte            'gtfs' per le righe di prima (uno ZIP), 'programma'
--   progetto_id      il progetto di Planning Studio fotografato (vuoto se
--                    poi si cancella: la fotografia resta)
--   progetto_nome    il suo nome quando è stata fatta la fotografia
--   stato_programma  in esercizio, programmato o bozza, in quel momento
--
-- Le righe di prima restano 'gtfs': si aprono come prima.
--
-- Le decisioni del confronto con la bigliettazione (0056) puntano a un
-- percorso dell'azienda con gli identificativi di una fotografia: in un'altra
-- fotografia dello stesso programma, o di quello dopo, gli identificativi
-- cambiano. Da qui una decisione ricorda anche le fermate del percorso scelto
-- (per codice, in ordine), e vale su ogni fotografia dove la linea ha un
-- percorso con quelle fermate.
--   polim_abbinamenti_percorsi.fermate   vuota per le decisioni di prima:
--                                        si riempie qui dalle fotografie che
--                                        hanno quel percorso (la più recente)
--
-- Lock: un attimo su polim_imports e polim_abbinamenti_percorsi (poche righe).
-- ══════════════════════════════════════════════════════════════════════
DO $programma$
BEGIN
  ALTER TABLE public.polim_imports ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'gtfs'
    CONSTRAINT polim_imports_fonte CHECK (fonte IN ('gtfs', 'programma'));
  ALTER TABLE public.polim_imports ADD COLUMN IF NOT EXISTS progetto_id uuid;
  ALTER TABLE public.polim_imports ADD COLUMN IF NOT EXISTS progetto_nome text
    CONSTRAINT polim_imports_progetto_nome CHECK (char_length(progetto_nome) BETWEEN 1 AND 300 AND progetto_nome !~ '[[:cntrl:]]');
  ALTER TABLE public.polim_imports ADD COLUMN IF NOT EXISTS stato_programma text
    CONSTRAINT polim_imports_stato_programma CHECK (stato_programma IN ('in esercizio', 'programmato', 'bozza'));
  -- una fotografia di un programma ne dice il nome e lo stato; uno ZIP no
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.polim_imports') AND conname = 'polim_imports_programma_coerente') THEN
    ALTER TABLE public.polim_imports ADD CONSTRAINT polim_imports_programma_coerente
      CHECK ((fonte = 'programma') = (progetto_nome IS NOT NULL AND stato_programma IS NOT NULL)
             AND (fonte = 'programma' OR progetto_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.polim_imports') AND conname = 'polim_imports_progetto_id_fkey') THEN
    ALTER TABLE public.polim_imports ADD CONSTRAINT polim_imports_progetto_id_fkey
      FOREIGN KEY (progetto_id) REFERENCES public.ps_projects(id) ON DELETE SET NULL;
  END IF;
  IF pg_catalog.to_regclass('public.polim_imports_progetto') IS NULL THEN
    CREATE INDEX polim_imports_progetto ON public.polim_imports (progetto_id) WHERE progetto_id IS NOT NULL;
  END IF;
  ALTER TABLE public.polim_abbinamenti_percorsi ADD COLUMN IF NOT EXISTS fermate text[];
END $programma$;
--> statement-breakpoint
-- I dati come cerbero_owner, solo se la tabella è già sua e se può già usare
-- lo schema (dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni).
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.polim_abbinamenti_percorsi'), pg_catalog.to_regclass('public.polim_imports'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- le fermate delle decisioni di prima: dalla fotografia più recente che ha quel percorso
UPDATE public.polim_abbinamenti_percorsi a
   SET fermate = t.fermate
  FROM (
    SELECT DISTINCT ON (d.linea_ufficiale, d.percorso, d.direzione) d.linea_ufficiale, d.percorso, d.direzione,
           (SELECT pg_catalog.array_agg(s.value->>'stopId' ORDER BY s.n)
              FROM pg_catalog.jsonb_array_elements(p.value->'stops') WITH ORDINALITY AS s(value, n)) AS fermate
      FROM public.polim_abbinamenti_percorsi d
      CROSS JOIN public.polim_imports i
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(i.payload->'lines') AS l(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(l.value->'percorsi') AS p(value)
     WHERE d.fermate IS NULL
       AND p.value->>'variantId' = d.variant_id
       AND (p.value->>'routeId' = d.route_id OR p.value->'routeIds' @> pg_catalog.jsonb_build_array(d.route_id))
     ORDER BY d.linea_ufficiale, d.percorso, d.direzione, i.created_at DESC
  ) t
 WHERE a.linea_ufficiale = t.linea_ufficiale AND a.percorso = t.percorso AND a.direzione = t.direzione
   AND a.fermate IS NULL AND t.fermate IS NOT NULL;
--> statement-breakpoint
RESET ROLE;
