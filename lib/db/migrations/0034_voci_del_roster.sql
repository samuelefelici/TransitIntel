-- ════════════════════════════════════════════════════════════════════════
-- 0034 — Il catalogo delle voci del roster in tabella (tappa 5.5)
-- ────────────────────────────────────────────────────────────────────────
-- Le voci di assenza e di presenza del roster (R, ASS, MA, D1…) erano
-- scritte nel codice, con le regole che ci girano intorno. Qui diventano una
-- tabella, una riga per codice:
--   sanitaria       un dato sulla salute (GDPR art. 9): chi non ha il permesso
--                   la legge come ASS, e non la scrive;
--   libera_turno    il conducente manca: il suo turno torna «da coprire» (5.1).
--                   Spento per il riposo;
--   a_disposizione  la presenza dice «a disposizione» (vestizione, sostituti);
--   codice_paghe    il codice per le paghe (BDROP), per la tappa delle presenze;
--   attiva          si offre nel roster; una voce spenta resta dove c'è già;
--   di_sistema      R (il riposo delle rotazioni) e ASS (l'assenza che maschera
--                   le voci sanitarie): non si spengono né si cancellano.
--
-- I 12 codici di prima entrano con le regole di prima: il comportamento non
-- cambia. Un codice che c'è nelle voci o nelle rotazioni ma non nel catalogo
-- entra spento, col codice per nome, e le regole di prima (un'assenza libera
-- il turno). Poi una chiave esterna: una voce usata non si cancella.
-- Nel registro delle modifiche, coi valori.
-- ════════════════════════════════════════════════════════════════════════
DO $voci$
BEGIN
  IF pg_catalog.to_regclass('public.roster_voci') IS NULL THEN
    CREATE TABLE public.roster_voci (
      codice          text PRIMARY KEY,
      categoria       text NOT NULL,
      nome            text NOT NULL,
      sanitaria       boolean NOT NULL DEFAULT false,
      libera_turno    boolean NOT NULL DEFAULT false,
      a_disposizione  boolean NOT NULL DEFAULT false,
      codice_paghe    text,
      attiva          boolean NOT NULL DEFAULT true,
      ordine          integer NOT NULL DEFAULT 0,
      di_sistema      boolean NOT NULL DEFAULT false,
      aggiornata_il   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT roster_voci_categoria CHECK (categoria IN ('assenza', 'presenza')),
      CONSTRAINT roster_voci_codice CHECK (char_length(codice) BETWEEN 1 AND 40),
      CONSTRAINT roster_voci_nome CHECK (char_length(nome) BETWEEN 1 AND 80),
      CONSTRAINT roster_voci_codice_paghe CHECK (codice_paghe IS NULL OR char_length(codice_paghe) BETWEEN 1 AND 20),
      CONSTRAINT roster_voci_ordine CHECK (ordine BETWEEN 0 AND 9999),
      CONSTRAINT roster_voci_regole CHECK (
        (NOT sanitaria OR categoria = 'assenza')
        AND (NOT libera_turno OR categoria = 'assenza')
        AND (NOT a_disposizione OR categoria = 'presenza')
        AND (NOT di_sistema OR (attiva AND NOT sanitaria))
      )
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.roster_voci OWNER TO cerbero_owner;
  END IF;
END $voci$;
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_voci', ARRAY['codice'], NULL, NULL, true, '{}', ARRAY['aggiornata_il'], '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tre tabelle che gli INSERT
-- toccano (su un database appena creato sono ancora di chi migra).
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.roster_voci'), pg_catalog.to_regclass('public.roster_entries'),
                                  pg_catalog.to_regclass('public.roster_rotazioni_riposi'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
INSERT INTO public.roster_voci (codice, categoria, nome, sanitaria, libera_turno, a_disposizione, ordine, di_sistema) VALUES
  ('R',    'assenza',  'Riposo',                     false, false, false,  10, true),
  ('ASS',  'assenza',  'Assenza',                    false, true,  false,  20, true),
  ('MA3',  'assenza',  'Malattia primi 3 giorni',    true,  true,  false,  30, false),
  ('MA',   'assenza',  'Malattia giorni successivi', true,  true,  false,  40, false),
  ('I',    'assenza',  'Infortunio',                 true,  true,  false,  50, false),
  ('PAD',  'assenza',  'Permesso 104',               true,  true,  false,  60, false),
  ('STRA', 'presenza', 'Straordinario',              false, false, false, 110, false),
  ('D1',   'presenza', 'Disposizione mattinale',     false, false, true,  120, false),
  ('D2',   'presenza', 'Disposizione pomeridiana',   false, false, true,  130, false),
  ('DISP', 'presenza', 'Disposizione',               false, false, false, 140, false),
  ('DAM1', 'presenza', 'Controllerie mattinali',     false, false, false, 150, false),
  ('DAM2', 'presenza', 'Controllerie pomeridiane',   false, false, false, 160, false)
ON CONFLICT (codice) DO NOTHING;
--> statement-breakpoint
-- i codici già usati fuori dal catalogo: entrano spenti, con le regole di prima
INSERT INTO public.roster_voci (codice, categoria, nome, libera_turno, attiva, ordine)
SELECT u.codice, u.categoria, left(u.codice, 80), u.categoria = 'assenza', false, 900
  FROM (
    SELECT DISTINCT ON (x.codice) x.codice, x.categoria
      FROM (
        SELECT e.code AS codice, CASE WHEN e.category = 'presenza' THEN 'presenza' ELSE 'assenza' END AS categoria
          FROM public.roster_entries e
        UNION ALL
        SELECT c, 'assenza'
          FROM public.roster_rotazioni_riposi r,
               jsonb_array_elements(CASE WHEN jsonb_typeof(r.pattern) = 'array' THEN r.pattern ELSE '[]'::jsonb END) s,
               jsonb_array_elements_text(CASE WHEN jsonb_typeof(s) = 'array' THEN s ELSE '[]'::jsonb END) c
         WHERE c IS NOT NULL AND c <> ''
      ) x
     WHERE char_length(x.codice) BETWEEN 1 AND 40
     ORDER BY x.codice, x.categoria
  ) u
ON CONFLICT (codice) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- la chiave esterna, da chi migra (come cerbero_owner il DDL è fermato)
DO $chiave$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.roster_entries'::regclass AND conname = 'roster_entries_code_fkey') THEN
    ALTER TABLE public.roster_entries
      ADD CONSTRAINT roster_entries_code_fkey FOREIGN KEY (code) REFERENCES public.roster_voci (codice)
      ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
    ALTER TABLE public.roster_entries VALIDATE CONSTRAINT roster_entries_code_fkey;
  END IF;
END $chiave$;
--> statement-breakpoint
-- di nuovo chi migra fino alla fine (è già così: la regola del README vuole che il file lo dica)
RESET ROLE;
