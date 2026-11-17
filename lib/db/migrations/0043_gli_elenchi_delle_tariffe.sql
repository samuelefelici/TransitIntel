-- ════════════════════════════════════════════════════════════════════════
-- 0043 — Gli elenchi di partenza delle tariffe e l'agenzia dei GTFS (tappa 6.10)
-- ────────────────────────────────────────────────────────────────────────
-- Nella pagina Tariffe restavano nel codice quattro cose di una sola
-- azienda. Da qui sono dati:
--   categorie_catalogo   le categorie di passeggero con cui si riempie un
--                        feed (ordinario, studente…). Una sola è quella
--                        predefinita: vale quando il titolo non ne dice una.
--   supporti_catalogo    i supporti su cui si carica un titolo, col tipo del
--                        GTFS: 0 nessuno (a bordo), 1 carta, 2 tessera, 3
--                        carta bancaria, 4 applicazione.
--   nodi_catalogo        i nodi tariffari ufficiali da cui parte il catalogo
--                        di un feed: codice, nome, punto e gli altri nomi con
--                        cui compaiono nelle fermate, separati da «;».
--   agenzia_gtfs         al più una riga: chi figura come agenzia nel GTFS
--                        della pagina Tariffe quando non è l'azienda stessa,
--                        per esempio il consorzio di cui fa parte. Senza la
--                        riga vale l'azienda (Amministrazione › Azienda).
-- Categorie e supporti si copiano in un feed dalla pagina Tariffe; li cambia
-- l'amministratore (Amministrazione › Azienda), come l'agenzia, e ogni
-- modifica resta nel registro. I nodi li copia in un feed la scheda dei nodi
-- della pagina Tariffe, che oggi è spenta: per ora non hanno una pagina per
-- cambiarli.
-- I valori di Conerobus entrano solo nell'installazione di Conerobus (la
-- riga di azienda con gtfs_agency_id «conerobus»), uguali a quelli che erano
-- nel codice. Una nuova parte con la sola categoria «ordinario».
-- ════════════════════════════════════════════════════════════════════════
DO $elenchi$
BEGIN
  IF pg_catalog.to_regclass('public.categorie_catalogo') IS NULL THEN
    CREATE TABLE public.categorie_catalogo (
      categoria    text PRIMARY KEY CONSTRAINT categorie_catalogo_categoria CHECK (categoria ~ '^[a-z][a-z0-9_]{1,39}$'),
      nome         text NOT NULL CONSTRAINT categorie_catalogo_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]"]'),
      predefinita  boolean NOT NULL DEFAULT false,
      url          text CONSTRAINT categorie_catalogo_url CHECK (url ~ '^https?://[^[:space:]",<>]{1,200}$'),
      ordine       integer NOT NULL DEFAULT 0 CONSTRAINT categorie_catalogo_ordine CHECK (ordine BETWEEN 0 AND 99999)
    );
  END IF;
  IF pg_catalog.to_regclass('public.categorie_catalogo_una_predefinita') IS NULL THEN
    CREATE UNIQUE INDEX categorie_catalogo_una_predefinita ON public.categorie_catalogo (predefinita) WHERE predefinita;
  END IF;
  IF pg_catalog.to_regclass('public.supporti_catalogo') IS NULL THEN
    CREATE TABLE public.supporti_catalogo (
      supporto  text PRIMARY KEY CONSTRAINT supporti_catalogo_supporto CHECK (supporto ~ '^[a-z][a-z0-9_]{1,39}$'),
      nome      text NOT NULL CONSTRAINT supporti_catalogo_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]"]'),
      tipo      smallint NOT NULL CONSTRAINT supporti_catalogo_tipo CHECK (tipo BETWEEN 0 AND 4),
      ordine    integer NOT NULL DEFAULT 0 CONSTRAINT supporti_catalogo_ordine CHECK (ordine BETWEEN 0 AND 99999)
    );
  END IF;
  IF pg_catalog.to_regclass('public.nodi_catalogo') IS NULL THEN
    CREATE TABLE public.nodi_catalogo (
      codice  text PRIMARY KEY CONSTRAINT nodi_catalogo_codice CHECK (codice ~ '^[A-Z0-9][A-Z0-9_]{0,39}$'),
      nome    text NOT NULL CONSTRAINT nodi_catalogo_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]",;]'),
      lat     double precision CONSTRAINT nodi_catalogo_lat CHECK (lat BETWEEN -90 AND 90),
      lon     double precision CONSTRAINT nodi_catalogo_lon CHECK (lon BETWEEN -180 AND 180),
      alias   text NOT NULL DEFAULT '' CONSTRAINT nodi_catalogo_alias CHECK (char_length(alias) <= 800 AND alias !~ '[[:cntrl:]",]'),
      ordine  integer NOT NULL DEFAULT 0 CONSTRAINT nodi_catalogo_ordine CHECK (ordine BETWEEN 0 AND 99999),
      CONSTRAINT nodi_catalogo_punto CHECK ((lat IS NULL) = (lon IS NULL))
    );
  END IF;
  IF pg_catalog.to_regclass('public.agenzia_gtfs') IS NULL THEN
    CREATE TABLE public.agenzia_gtfs (
      unica         boolean PRIMARY KEY DEFAULT true CONSTRAINT agenzia_gtfs_una_riga CHECK (unica),
      agency_id     text NOT NULL CONSTRAINT agenzia_gtfs_agency_id CHECK (agency_id ~ '^[A-Za-z0-9_.-]{1,40}$'),
      nome          text NOT NULL CONSTRAINT agenzia_gtfs_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]"]'),
      sito          text NOT NULL CONSTRAINT agenzia_gtfs_sito CHECK (sito ~ '^https?://[^[:space:]",<>]{1,200}$'),
      telefono      text CONSTRAINT agenzia_gtfs_telefono CHECK (telefono ~ '^[0-9+() ./-]{3,40}$'),
      email         text CONSTRAINT agenzia_gtfs_email CHECK (email ~ '^[^[:space:]",<>@]{1,64}@[^[:space:]",<>@]{1,190}$'),
      tariffe_url   text CONSTRAINT agenzia_gtfs_tariffe_url CHECK (tariffe_url ~ '^https?://[^[:space:]",<>]{1,200}$'),
      aggiornata_il timestamptz NOT NULL DEFAULT now()
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.categorie_catalogo OWNER TO cerbero_owner;
    ALTER TABLE public.supporti_catalogo OWNER TO cerbero_owner;
    ALTER TABLE public.nodi_catalogo OWNER TO cerbero_owner;
    ALTER TABLE public.agenzia_gtfs OWNER TO cerbero_owner;
  END IF;
END $elenchi$;
--> statement-breakpoint
SELECT registro.sorveglia('public.categorie_catalogo', ARRAY['categoria'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.supporti_catalogo', ARRAY['supporto'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.nodi_catalogo', ARRAY['codice'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.agenzia_gtfs', ARRAY['unica'], NULL, NULL, true, '{}', ARRAY['aggiornata_il']);
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.categorie_catalogo'),
                                        pg_catalog.to_regclass('public.supporti_catalogo'), pg_catalog.to_regclass('public.nodi_catalogo'),
                                        pg_catalog.to_regclass('public.agenzia_gtfs'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- Le sette categorie di Conerobus, come erano nel codice. Solo se la tabella
-- è ancora vuota: una seconda esecuzione non le rimette sopra a quelle che
-- l'amministratore ha cambiato.
INSERT INTO public.categorie_catalogo (categoria, nome, predefinita, url, ordine)
SELECT c.categoria, c.nome, c.predefinita, c.url, c.ordine
  FROM (VALUES
    ('ordinario',          'Tariffa Ordinaria',                   true,  NULL,                                                 10),
    ('studente',           'Studente (14+ anni)',                 false, 'https://www.atmaancona.it/abbonamenti-studenti',     20),
    ('studente_under14',   'Studente under 14',                   false, 'https://www.atmaancona.it/abbonamenti-studenti',     30),
    ('studente_agevolato', 'Studente ISEE < €18.000',             false, NULL,                                                 40),
    ('studente_univpm',    'Studente UNIVPM (quota studente)',    false, 'https://www.atmaancona.it/abbonamenti-universitari', 50),
    ('anziano',            'Over 65 / Argento (fascia morbida)',  false, NULL,                                                 60),
    ('agevolato',          'ISEE < €18.000 (tariffa agevolata)',  false, NULL,                                                 70)
  ) AS c(categoria, nome, predefinita, url, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.categorie_catalogo);
--> statement-breakpoint
-- Ovunque: la categoria di chi paga la tariffa piena, quella dei titoli che
-- non ne dicono un'altra.
INSERT INTO public.categorie_catalogo (categoria, nome, predefinita, ordine)
SELECT 'ordinario', 'Tariffa ordinaria', true, 10
 WHERE NOT EXISTS (SELECT 1 FROM public.categorie_catalogo);
--> statement-breakpoint
-- I sette supporti di Conerobus, come erano nel codice.
INSERT INTO public.supporti_catalogo (supporto, nome, tipo, ordine)
SELECT s.supporto, s.nome, s.tipo, s.ordine
  FROM (VALUES
    ('contanti',           'Pagamento a bordo (contanti/bancomat)', 0, 10),
    ('biglietto_cartaceo', 'Biglietto Cartaceo',                    1, 20),
    ('tessera_regionale',  'Tessera Regionale (€5,00 primo abb.)',  1, 30),
    ('tessera_agevolati',  'Tessera Agevolati (€2,10 / anno)',      1, 40),
    ('carta_contactless',  'Carta Trasporto Contactless',           2, 50),
    ('cemv',               'Carta Bancaria Contactless (cEMV)',     3, 60),
    ('app_mobile',         'App Mobile',                            4, 70)
  ) AS s(supporto, nome, tipo, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.supporti_catalogo);
--> statement-breakpoint
-- I quattordici nodi del tariffario del 2013, come erano nel codice.
INSERT INTO public.nodi_catalogo (codice, nome, lat, lon, alias, ordine)
SELECT n.codice, n.nome, n.lat, n.lon, n.alias, n.ordine
  FROM (VALUES
    ('ANCONA',        'Ancona',           43.6158, 13.5189, 'ANCONA STAZIONE;ANCONA CENTRO',      10),
    ('FALCONARA_M',   'Falconara M.',     43.6261, 13.4041, 'FALCONARA MARITTIMA;FALCONARA',      20),
    ('JESI',          'Jesi',             43.5217, 13.2434, 'JESI AUTOSTAZIONE;JESI CENTRO',      30),
    ('SENIGALLIA',    'Senigallia',       43.7156, 13.2147, '',                                   40),
    ('OSIMO',         'Osimo',            43.4869, 13.4839, '',                                   50),
    ('LORETO',        'Loreto Capolinea', 43.4406, 13.6111, 'LORETO',                             60),
    ('RECANATI',      'Recanati',         43.4022, 13.5511, '',                                   70),
    ('CASTELFIDARDO', 'Castelfidardo',    43.4639, 13.5469, '',                                   80),
    ('AGUGLIANO',     'Agugliano',        43.5611, 13.3897, '',                                   90),
    ('AEROPORTO',     'Aeroporto',        43.6164, 13.3625, 'AEROPORTO ANCONA;RAFFAELLO SANZIO', 100),
    ('ASPIO_TERME',   'Aspio Terme',      43.5450, 13.5483, '',                                  110),
    ('ASPIO_VECCHIO', 'Aspio Vecchio',    43.5489, 13.5414, '',                                  120),
    ('ABADIA',        'Abadia',           43.4969, 13.0631, 'ABBADIA',                           130),
    ('ARCHI_LORETO',  'Archi di Loreto',  43.4489, 13.6042, '',                                  140)
  ) AS n(codice, nome, lat, lon, alias, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.nodi_catalogo);
--> statement-breakpoint
-- L'agenzia dei GTFS di Conerobus è il consorzio: la riga che era nel codice.
INSERT INTO public.agenzia_gtfs (agency_id, nome, sito, telefono, email, tariffe_url)
SELECT 'ATMA', 'Atma Scpa', 'https://www.atmaancona.it', '0712837468', 'info@atmaancona.it',
       'https://www.atmaancona.it/tariffe/tariffe-generale/'
 WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')
ON CONFLICT (unica) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
