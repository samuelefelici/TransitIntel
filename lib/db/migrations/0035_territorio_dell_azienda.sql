-- ════════════════════════════════════════════════════════════════════════
-- 0035 — Il territorio dell'azienda in tabella (tappa 6.1)
-- ────────────────────────────────────────────────────────────────────────
-- Il territorio di Conerobus era scritto nel codice: la provincia ISTAT
-- «042» negli import, i nomi dei comuni in sei copie (una con i nomi
-- sfasati sui codici), i luoghi dove si cercano i punti d'interesse, i punti
-- del meteo, i poli di lavoro dell'analisi della rete. Qui diventano dati:
--   azienda.provincia_istat          la provincia degli import ISTAT;
--   territorio_comuni                i comuni (codice ISTAT a 6 cifre), anche
--                                    quelli soppressi che i dati del 2011
--                                    nominano ancora; centroide, superficie e
--                                    popolazione di riferimento per l'import
--                                    della popolazione;
--   territorio_luoghi                i luoghi di riferimento, per uso.
-- I valori di Conerobus entrano solo nell'installazione di Conerobus (la riga
-- di azienda con gtfs_agency_id «conerobus»): una nuova parte vuota, e
-- l'amministratore la compila dalla pagina Azienda. Nel registro, coi valori.
-- ════════════════════════════════════════════════════════════════════════
DO $territorio$
BEGIN
  ALTER TABLE public.azienda ADD COLUMN IF NOT EXISTS provincia_istat text
    CONSTRAINT azienda_provincia_istat CHECK (provincia_istat ~ '^[0-9]{3}$');
  IF pg_catalog.to_regclass('public.territorio_comuni') IS NULL THEN
    CREATE TABLE public.territorio_comuni (
      codice_istat        text PRIMARY KEY CONSTRAINT territorio_comuni_codice CHECK (codice_istat ~ '^[0-9]{6}$'),
      nome                text NOT NULL CONSTRAINT territorio_comuni_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 80),
      soppresso           boolean NOT NULL DEFAULT false,
      lat                 double precision CONSTRAINT territorio_comuni_lat CHECK (lat BETWEEN -90 AND 90),
      lng                 double precision CONSTRAINT territorio_comuni_lng CHECK (lng BETWEEN -180 AND 180),
      area_km2            double precision CONSTRAINT territorio_comuni_area CHECK (area_km2 > 0 AND area_km2 < 100000),
      popolazione         integer CONSTRAINT territorio_comuni_popolazione CHECK (popolazione BETWEEN 0 AND 20000000),
      -- la riga in census_sections che l'import della popolazione tiene per il comune
      sezione_censimento  text CONSTRAINT territorio_comuni_sezione CHECK (sezione_censimento ~ '^[A-Za-z0-9]{1,20}$'),
      aggiornato_il       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT territorio_comuni_centroide CHECK ((lat IS NULL) = (lng IS NULL)),
      CONSTRAINT territorio_comuni_sezione_unica UNIQUE (sezione_censimento)
    );
  END IF;
  IF pg_catalog.to_regclass('public.territorio_luoghi') IS NULL THEN
    CREATE TABLE public.territorio_luoghi (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nome           text NOT NULL CONSTRAINT territorio_luoghi_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120),
      uso            text NOT NULL CONSTRAINT territorio_luoghi_uso CHECK (uso IN ('punti_interesse', 'meteo', 'polo_lavoro')),
      lat            double precision NOT NULL CONSTRAINT territorio_luoghi_lat CHECK (lat BETWEEN -90 AND 90),
      lng            double precision NOT NULL CONSTRAINT territorio_luoghi_lng CHECK (lng BETWEEN -180 AND 180),
      -- il raggio della ricerca dei punti d'interesse
      raggio_m       integer CONSTRAINT territorio_luoghi_raggio CHECK (raggio_m BETWEEN 100 AND 50000),
      ordine         integer NOT NULL DEFAULT 0 CONSTRAINT territorio_luoghi_ordine CHECK (ordine BETWEEN 0 AND 99999),
      aggiornato_il  timestamptz NOT NULL DEFAULT now()
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.territorio_comuni OWNER TO cerbero_owner;
    ALTER TABLE public.territorio_luoghi OWNER TO cerbero_owner;
  END IF;
END $territorio$;
--> statement-breakpoint
SELECT registro.sorveglia('public.territorio_comuni', ARRAY['codice_istat'], NULL, NULL, true, '{}', ARRAY['aggiornato_il'], '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.territorio_luoghi', ARRAY['id'], NULL, NULL, true, '{}', ARRAY['aggiornato_il'], '{}');
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra).
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.territorio_comuni'),
                                  pg_catalog.to_regclass('public.territorio_luoghi'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
UPDATE public.azienda SET provincia_istat = '042' WHERE gtfs_agency_id = 'conerobus' AND provincia_istat IS NULL;
--> statement-breakpoint
-- i comuni della provincia di Ancona: i 47 di oggi e i 3 soppressi che i dati
-- del 2011 nominano ancora; centroide, superficie e popolazione di
-- riferimento quelli che l'import della popolazione aveva nel codice
INSERT INTO public.territorio_comuni (codice_istat, nome, soppresso, lat, lng, area_km2, popolazione, sezione_censimento)
SELECT * FROM (VALUES
  ('042001', 'Agugliano', false, 43.5450, 13.3750, 16.1, 5070, 'AN002'),
  ('042002', 'Ancona', false, 43.6166, 13.5185, 124.2, 99470, 'AN001'),
  ('042003', 'Arcevia', false, NULL, NULL, NULL, NULL, NULL),
  ('042004', 'Barbara', false, 43.5800, 13.0280, 13.5, 1360, 'AN003'),
  ('042005', 'Belvedere Ostrense', false, 43.5640, 13.1630, 18.2, 2370, 'AN004'),
  ('042006', 'Camerano', false, 43.5280, 13.5350, 17.0, 7490, 'AN005'),
  ('042007', 'Camerata Picena', false, 43.5660, 13.3210, 15.0, 2810, 'AN006'),
  ('042008', 'Castelbellino', false, 43.5160, 13.1830, 8.6, 3310, 'AN007'),
  ('042010', 'Castelfidardo', false, 43.4616, 13.5492, 29.4, 19100, 'AN008'),
  ('042011', 'Castelleone di Suasa', false, 43.6020, 12.9830, 22.0, 1620, 'AN009'),
  ('042012', 'Castelplanio', false, 43.5270, 13.1350, 18.5, 3230, 'AN010'),
  ('042013', 'Cerreto d''Esi', false, 43.3390, 13.0520, 29.1, 3870, 'AN011'),
  ('042014', 'Chiaravalle', false, 43.5998, 13.3222, 24.7, 15200, 'AN012'),
  ('042015', 'Corinaldo', false, 43.6490, 13.0480, 47.5, 5180, 'AN013'),
  ('042016', 'Cupramontana', false, 43.4440, 13.1190, 29.9, 4590, 'AN014'),
  ('042017', 'Fabriano', false, 43.3368, 12.9078, 272.2, 29900, 'AN015'),
  ('042018', 'Falconara Marittima', false, 43.6280, 13.3940, 27.0, 27600, 'AN016'),
  ('042019', 'Filottrano', false, 43.4380, 13.3520, 51.1, 9220, 'AN017'),
  ('042020', 'Genga', false, 43.4280, 12.9410, 79.8, 1720, 'AN018'),
  ('042021', 'Jesi', false, 43.5222, 13.2436, 114.0, 39600, 'AN019'),
  ('042022', 'Loreto', false, 43.4413, 13.6075, 18.2, 11000, 'AN020'),
  ('042023', 'Maiolati Spontini', false, 43.4940, 13.1510, 27.9, 7230, 'AN021'),
  ('042024', 'Mergo', false, 43.4610, 13.0660, 8.8, 1050, 'AN022'),
  ('042025', 'Monsano', false, 43.5610, 13.2080, 9.5, 3670, 'AN023'),
  ('042026', 'Montecarotto', false, 43.5040, 13.0680, 20.4, 1930, 'AN024'),
  ('042027', 'Montemarciano', false, 43.6430, 13.3410, 22.4, 11100, 'AN025'),
  ('042029', 'Monte Roberto', false, 43.5040, 13.1760, 12.2, 3460, 'AN026'),
  ('042030', 'Monte San Vito', false, 43.6180, 13.3260, 21.8, 7060, 'AN027'),
  ('042031', 'Morro d''Alba', false, 43.5800, 13.1960, 16.9, 3320, 'AN028'),
  ('042032', 'Numana', false, 43.5080, 13.6260, 9.6, 3870, 'AN029'),
  ('042033', 'Offagna', false, 43.5200, 13.4130, 8.7, 1980, 'AN030'),
  ('042034', 'Osimo', false, 43.4834, 13.4810, 101.2, 34200, 'AN031'),
  ('042035', 'Ostra', false, 43.6190, 13.1550, 38.3, 7480, 'AN032'),
  ('042036', 'Ostra Vetere', false, 43.6000, 13.1020, 28.4, 3220, 'AN033'),
  ('042037', 'Poggio San Marcello', false, NULL, NULL, NULL, NULL, NULL),
  ('042038', 'Polverigi', false, 43.5570, 13.3960, 15.8, 4440, 'AN034'),
  ('042040', 'Rosora', false, 43.4770, 13.0870, 16.3, 1810, 'AN036'),
  ('042041', 'San Marcello', false, 43.5390, 13.2070, 8.6, 2260, 'AN037'),
  ('042042', 'San Paolo di Jesi', false, NULL, NULL, NULL, NULL, NULL),
  ('042043', 'Santa Maria Nuova', false, 43.4950, 13.3220, 21.3, 4330, 'AN038'),
  ('042044', 'Sassoferrato', false, 43.4360, 12.8570, 180.3, 7380, 'AN039'),
  ('042045', 'Senigallia', false, 43.7151, 13.2175, 119.0, 44400, 'AN040'),
  ('042046', 'Serra de'' Conti', false, 43.5420, 13.0460, 34.5, 3340, 'AN041'),
  ('042047', 'Serra San Quirico', false, 43.4500, 13.0780, 29.4, 2960, 'AN042'),
  ('042048', 'Sirolo', false, 43.5360, 13.6175, 10.6, 3890, 'AN043'),
  ('042049', 'Staffolo', false, 43.4180, 13.1760, 24.4, 2290, 'AN044'),
  ('042050', 'Trecastelli', false, NULL, NULL, NULL, NULL, NULL),
  ('042009', 'Castel Colonna', true, NULL, NULL, NULL, NULL, NULL),
  ('042028', 'Monterado', true, NULL, NULL, NULL, NULL, NULL),
  ('042039', 'Ripe', true, 43.5980, 13.1980, 9.4, 3170, 'AN035')
) AS v(codice_istat, nome, soppresso, lat, lng, area_km2, popolazione, sezione_censimento)
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
ON CONFLICT (codice_istat) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.territorio_luoghi (nome, uso, lat, lng, raggio_m, ordine)
SELECT * FROM (VALUES
  ('Ancona centro', 'punti_interesse', 43.6166, 13.5185, 5000, 10),
  ('Ancona Torrette', 'punti_interesse', 43.5980, 13.4520, 3000, 20),
  ('Ancona Baraccola', 'punti_interesse', 43.5590, 13.4860, 3000, 30),
  ('Jesi', 'punti_interesse', 43.5222, 13.2436, 4000, 40),
  ('Senigallia', 'punti_interesse', 43.7151, 13.2175, 4000, 50),
  ('Fabriano', 'punti_interesse', 43.3368, 12.9078, 4000, 60),
  ('Osimo', 'punti_interesse', 43.4834, 13.4810, 3000, 70),
  ('Falconara', 'punti_interesse', 43.6280, 13.3940, 3000, 80),
  ('Chiaravalle', 'punti_interesse', 43.5998, 13.3222, 2500, 90),
  ('Castelfidardo', 'punti_interesse', 43.4616, 13.5492, 2500, 100),
  ('Loreto', 'punti_interesse', 43.4413, 13.6075, 2500, 110),
  ('Camerano', 'punti_interesse', 43.5280, 13.5350, 2000, 120),
  ('Montemarciano', 'punti_interesse', 43.6430, 13.3410, 2000, 130),
  ('Filottrano', 'punti_interesse', 43.4380, 13.3520, 2000, 140),
  ('Sassoferrato', 'punti_interesse', 43.4360, 12.8570, 2500, 150),
  ('Ancona', 'meteo', 43.6158, 13.5189, NULL, 160),
  ('Jesi', 'meteo', 43.5222, 13.2436, NULL, 170),
  ('Senigallia', 'meteo', 43.7151, 13.2175, NULL, 180),
  ('Fabriano', 'meteo', 43.3368, 12.9078, NULL, 190),
  ('Falconara M.', 'meteo', 43.6280, 13.3940, NULL, 200),
  ('Zona Industriale Baraccola (Ikea, MediaWorld, negozi)', 'polo_lavoro', 43.5580, 13.4990, NULL, 210),
  ('Centro Comm. Emisfero / Conero (Baraccola)', 'polo_lavoro', 43.5757, 13.5041, NULL, 220),
  ('Angelini Pharma — Stabilimento Ancona', 'polo_lavoro', 43.5850, 13.4780, NULL, 230),
  ('Fincantieri — Cantiere Navale Ancona', 'polo_lavoro', 43.6250, 13.5080, NULL, 240),
  ('Zona Industriale Castelferretti / Falconara', 'polo_lavoro', 43.6300, 13.3800, NULL, 250),
  ('Fileni — Stabilimento Cingoli/Jesi', 'polo_lavoro', 43.5240, 13.2410, NULL, 260),
  ('Zona Industriale Osimo — Recanati', 'polo_lavoro', 43.4700, 13.5100, NULL, 270),
  ('Interporto Marche — Jesi', 'polo_lavoro', 43.5100, 13.2600, NULL, 280),
  ('Zona Produttiva Fabriano (Elica, Indesit)', 'polo_lavoro', 43.3380, 12.9060, NULL, 290),
  ('Centro Commerciale Vallemiano — Ancona', 'polo_lavoro', 43.6050, 13.5000, NULL, 300),
  ('Polo Commerciale Torrette (Auchan/CC Torrette 2000)', 'polo_lavoro', 43.6080, 13.4546, NULL, 310),
  ('Centro Commerciale Il Maestrale — Senigallia', 'polo_lavoro', 43.7150, 13.2200, NULL, 320),
  ('Zona Ind. Sentino — Sassoferrato/Fabriano', 'polo_lavoro', 43.4310, 12.8550, NULL, 330),
  ('Corso Garibaldi — Centro Commerciale Naturale Ancona', 'polo_lavoro', 43.6178, 13.5138, NULL, 340)
) AS v(nome, uso, lat, lng, raggio_m, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.territorio_luoghi);
--> statement-breakpoint
RESET ROLE;
