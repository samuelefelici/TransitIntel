-- ════════════════════════════════════════════════════════════════════════
-- 0040 — Le reti dell'azienda e le regole delle linee (tappa 6.7)
-- ────────────────────────────────────────────────────────────────────────
-- Le reti (l'extraurbano e le urbane) e la regola che dal nome breve di una
-- linea ricava la sua rete erano scritte nel codice, con i nomi di una sola
-- azienda. Da qui sono dati dell'azienda:
--   reti          una riga per rete. L'extraurbana c'è sempre ed è una sola
--                 (rete «extraurbano»); le urbane le aggiunge
--                 l'amministratore. Di una rete urbana il programma ricava
--                 da sé l'identificativo («urbano_<luogo>»), la zona
--                 tariffaria («<luogo>_urban») e il codice con cui si
--                 classificano le sue fermate (da 2 a 9; con l'extraurbano,
--                 lo stesso più 10): restano quelli anche se cambia il nome.
--                 Il nome e il luogo finiscono nei file del GTFS e nelle
--                 esportazioni: niente virgolette, virgole, punti e virgola,
--                 segni di minore e maggiore, né caratteri di controllo.
--   reti_regole   le regole, in ordine: vale la prima che corrisponde al
--                 nome breve della linea; se non ne corrisponde nessuna la
--                 linea è extraurbana. I tipi sono un elenco chiuso:
--                   inizia             il nome comincia con il valore
--                   uguale             il nome è il valore
--                   inizia_poi_cifra   comincia con il valore, poi una cifra
--                   inizia_con_cifra   comincia con una cifra
--                   lettere_puntate    due lettere puntate («C.D.», «C.S»)
-- Le reti e le regole di Conerobus entrano solo nell'installazione di
-- Conerobus (la riga di azienda con gtfs_agency_id «conerobus»), uguali a
-- quelle che erano nel codice: lì non cambia niente. Una nuova parte con il
-- solo extraurbano.
-- ════════════════════════════════════════════════════════════════════════
DO $reti$
BEGIN
  IF pg_catalog.to_regclass('public.reti') IS NULL THEN
    CREATE TABLE public.reti (
      rete           text PRIMARY KEY CONSTRAINT reti_rete CHECK (rete ~ '^[a-z][a-z0-9_]{1,39}$'),
      tipo           text NOT NULL CONSTRAINT reti_tipo CHECK (tipo IN ('urbano', 'extraurbano')),
      nome           text NOT NULL CONSTRAINT reti_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 60 AND nome !~ '[[:cntrl:]",;<>]'),
      -- solo delle reti urbane
      luogo          text CONSTRAINT reti_luogo CHECK (char_length(btrim(luogo)) BETWEEN 1 AND 40 AND luogo !~ '[[:cntrl:]",;<>]'),
      sigla          text CONSTRAINT reti_sigla CHECK (sigla ~ '^[A-Z0-9]{1,4}$'),
      zona           text CONSTRAINT reti_zona CHECK (zona ~ '^[a-z0-9_]{1,40}_urban$'),
      codice         smallint CONSTRAINT reti_codice CHECK (codice BETWEEN 2 AND 9),
      colore         text NOT NULL CONSTRAINT reti_colore CHECK (colore ~ '^#[0-9a-f]{6}$'),
      ordine         smallint NOT NULL DEFAULT 0 CONSTRAINT reti_ordine CHECK (ordine BETWEEN 0 AND 9999),
      aggiornato_il  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reti_una_extraurbana CHECK ((tipo = 'extraurbano') = (rete = 'extraurbano')),
      CONSTRAINT reti_urbana_intera CHECK (
        tipo <> 'urbano' OR (rete ~ '^urbano_[a-z0-9_]+$' AND luogo IS NOT NULL AND sigla IS NOT NULL AND zona IS NOT NULL AND codice IS NOT NULL)),
      CONSTRAINT reti_extraurbana_senza_zona CHECK (
        tipo <> 'extraurbano' OR (luogo IS NULL AND sigla IS NULL AND zona IS NULL AND codice IS NULL))
    );
  END IF;
  IF pg_catalog.to_regclass('public.reti_sigla_unica') IS NULL THEN
    CREATE UNIQUE INDEX reti_sigla_unica ON public.reti (sigla);
  END IF;
  IF pg_catalog.to_regclass('public.reti_zona_unica') IS NULL THEN
    CREATE UNIQUE INDEX reti_zona_unica ON public.reti (zona);
  END IF;
  IF pg_catalog.to_regclass('public.reti_codice_unico') IS NULL THEN
    CREATE UNIQUE INDEX reti_codice_unico ON public.reti (codice);
  END IF;
  IF pg_catalog.to_regclass('public.reti_regole') IS NULL THEN
    CREATE TABLE public.reti_regole (
      ordine  smallint PRIMARY KEY CONSTRAINT reti_regole_ordine CHECK (ordine BETWEEN 1 AND 200),
      tipo    text NOT NULL CONSTRAINT reti_regole_tipo CHECK (tipo IN
                ('inizia', 'uguale', 'inizia_poi_cifra', 'inizia_con_cifra', 'lettere_puntate')),
      valore  text CONSTRAINT reti_regole_valore CHECK (valore ~ '^[A-Z0-9./ -]{1,12}$' AND valore = btrim(valore)),
      rete    text NOT NULL CONSTRAINT reti_regole_rete_fkey REFERENCES public.reti (rete) ON DELETE CASCADE,
      CONSTRAINT reti_regole_valore_dove_serve CHECK ((tipo IN ('inizia', 'uguale', 'inizia_poi_cifra')) = (valore IS NOT NULL))
    );
  END IF;
  IF pg_catalog.to_regclass('public.reti_regole_rete') IS NULL THEN
    CREATE INDEX reti_regole_rete ON public.reti_regole (rete);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.reti OWNER TO cerbero_owner;
    ALTER TABLE public.reti_regole OWNER TO cerbero_owner;
  END IF;
END $reti$;
--> statement-breakpoint
SELECT registro.sorveglia('public.reti', ARRAY['rete'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.reti_regole', ARRAY['ordine'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.reti'),
                                        pg_catalog.to_regclass('public.reti_regole'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- Le reti di Conerobus, come erano nel codice (lib/reti-linee.ts, tappa 6.6).
INSERT INTO public.reti (rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine)
SELECT r.rete, r.tipo, r.nome, r.luogo, r.sigla, r.zona, r.codice, r.colore, r.ordine
  FROM (VALUES
    ('urbano_ancona',        'urbano',      'Urbano di Ancona',                'Ancona',        'AN', 'ancona_urban',        2, '#3b82f6', 1),
    ('urbano_jesi',          'urbano',      'Urbano di Jesi',                  'Jesi',          'JE', 'jesi_urban',          3, '#8b5cf6', 2),
    ('urbano_falconara',     'urbano',      'Urbano di Falconara',             'Falconara',     'FA', 'falconara_urban',     4, '#06b6d4', 3),
    ('urbano_senigallia',    'urbano',      'Urbano di Senigallia',            'Senigallia',    'SE', 'senigallia_urban',    5, '#10b981', 4),
    ('urbano_castelfidardo', 'urbano',      'Urbano di Castelfidardo',         'Castelfidardo', 'CF', 'castelfidardo_urban', 6, '#f97316', 5),
    ('urbano_sassoferrato',  'urbano',      'Urbano di Sassoferrato',          'Sassoferrato',  'SS', 'sassoferrato_urban',  7, '#ec4899', 6),
    ('extraurbano',          'extraurbano', 'Extraurbano Provincia di Ancona', NULL,            NULL, NULL,                  NULL, '#f59e0b', 7)
  ) AS r(rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
ON CONFLICT (rete) DO NOTHING;
--> statement-breakpoint
-- L'extraurbano c'è in ogni installazione.
INSERT INTO public.reti (rete, tipo, nome, colore, ordine)
VALUES ('extraurbano', 'extraurbano', 'Extraurbano', '#f59e0b', 1)
ON CONFLICT (rete) DO NOTHING;
--> statement-breakpoint
-- Le regole di Conerobus, nell'ordine in cui il codice le provava. Solo se la
-- tabella è ancora vuota: una seconda esecuzione non le rimette sopra a
-- quelle che l'amministratore ha cambiato.
INSERT INTO public.reti_regole (ordine, tipo, valore, rete)
SELECT g.ordine, g.tipo, g.valore, g.rete
  FROM (VALUES
    (1, 'inizia',           'JE',    'urbano_jesi'),
    (2, 'inizia',           'Y',     'urbano_falconara'),
    (3, 'inizia_poi_cifra', 'BUS',   'urbano_senigallia'),
    (4, 'inizia_poi_cifra', 'BUSS',  'urbano_senigallia'),
    (5, 'uguale',           'CIRCA', 'urbano_castelfidardo'),
    (6, 'uguale',           'CIRCB', 'urbano_castelfidardo'),
    (7, 'inizia_con_cifra', NULL,    'urbano_ancona'),
    (8, 'lettere_puntate',  NULL,    'urbano_ancona')
  ) AS g(ordine, tipo, valore, rete)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.reti_regole)
   AND EXISTS (SELECT 1 FROM public.reti r WHERE r.rete = g.rete);
--> statement-breakpoint
RESET ROLE;
