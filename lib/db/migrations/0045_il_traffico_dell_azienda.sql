-- ════════════════════════════════════════════════════════════════════════
-- 0045 — Il traffico dell'azienda (tappa 6.15)
-- ────────────────────────────────────────────────────────────────────────
-- Tre cose del traffico erano scritte nel codice per la provincia di Ancona:
--   - i 37 punti stradali di cui si legge il traffico ogni mezz'ora;
--   - le cinque zone della pagina Traffico, come rettangoli di coordinate;
--   - il centro da cui il modello teorico misura la distanza.
-- Qui diventano luoghi del territorio dell'azienda (tabella territorio_luoghi,
-- migrazione 0035), con due usi nuovi:
--   traffico        un punto stradale. Il nome è l'identificativo delle sue
--                   rilevazioni (traffic_snapshots.segment_id), quindi è unico
--                   fra i punti; la zona è un attributo del punto.
--   centro_urbano   un centro per il modello del traffico: il modello misura
--                   la distanza dal più vicino. Senza, vale il centro delle
--                   mappe dell'azienda.
-- Per Conerobus entrano i punti di prima, ognuno con la zona in cui lo metteva
-- la regola di prima, e il centro di prima: i numeri non cambiano.
-- ════════════════════════════════════════════════════════════════════════
DO $traffico$
BEGIN
  ALTER TABLE public.territorio_luoghi DROP CONSTRAINT IF EXISTS territorio_luoghi_uso;
  ALTER TABLE public.territorio_luoghi ADD CONSTRAINT territorio_luoghi_uso
    CHECK (uso IN ('punti_interesse', 'meteo', 'polo_lavoro', 'traffico', 'centro_urbano'));
  -- la zona di un punto stradale: un nome libero, lo stesso per i punti che stanno insieme nella pagina Traffico
  ALTER TABLE public.territorio_luoghi ADD COLUMN IF NOT EXISTS zona text
    CONSTRAINT territorio_luoghi_zona CHECK (char_length(btrim(zona)) BETWEEN 1 AND 60);
  ALTER TABLE public.territorio_luoghi DROP CONSTRAINT IF EXISTS territorio_luoghi_zona_del_traffico;
  ALTER TABLE public.territorio_luoghi ADD CONSTRAINT territorio_luoghi_zona_del_traffico
    CHECK (zona IS NULL OR uso = 'traffico');
  -- due punti stradali con lo stesso nome confonderebbero le loro rilevazioni
  IF pg_catalog.to_regclass('public.territorio_luoghi_punto_di_traffico') IS NULL THEN
    CREATE UNIQUE INDEX territorio_luoghi_punto_di_traffico ON public.territorio_luoghi (nome) WHERE uso = 'traffico';
  END IF;
END $traffico$;
--> statement-breakpoint
-- I dati come cerbero_owner, solo se la tabella è già sua e se può già usare
-- lo schema (dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni).
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.territorio_luoghi'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- I punti stradali di Conerobus, com'erano nel codice (routes/cron.ts). La
-- zona è quella che dava la regola di routes/traffic.ts, la prima che
-- corrisponde:
--   lat 43.59-43.62 e lng 13.50-13.52  Centro storico
--   lat 43.60-43.63 e lng 13.52-13.57  Porto / Lido
--   lat 43.60-43.65 e lng 13.42-13.50  Zona Ovest
--   lat 43.62-43.69 e lng 13.38-13.52  Nord / Falconara
--   tutto il resto                     Entroterra
-- L'ordine tiene insieme i punti di una zona, e le zone nell'ordine dei
-- colori che avevano nella pagina.
INSERT INTO public.territorio_luoghi (nome, uso, lat, lng, zona, ordine)
SELECT v.nome, 'traffico', v.lat, v.lng, v.zona, v.ordine FROM (VALUES
  ('Tangenzia-E', 43.6000, 13.5100, 'Centro storico', 1000),
  ('ViaFlaminiaAnc', 43.6050, 13.5060, 'Centro storico', 1010),
  ('ViaXXSett', 43.6190, 13.5130, 'Centro storico', 1020),
  ('ViaRossi-Anc', 43.6070, 13.5250, 'Porto / Lido', 1030),
  ('A14-AnconaNo-N', 43.6420, 13.4350, 'Zona Ovest', 1040),
  ('A14-AnconaNo-S', 43.6200, 13.4410, 'Zona Ovest', 1050),
  ('SS16-AncCentro-N', 43.6320, 13.4700, 'Zona Ovest', 1060),
  ('SS16-AncCentro', 43.6120, 13.4900, 'Zona Ovest', 1070),
  ('Tangenzia-N', 43.6180, 13.4820, 'Zona Ovest', 1080),
  ('Porto-Anc', 43.6260, 13.4950, 'Zona Ovest', 1090),
  ('SS16-Falconara', 43.6300, 13.3980, 'Nord / Falconara', 1100),
  ('SS16-Palombina', 43.6560, 13.4180, 'Nord / Falconara', 1110),
  ('A14-AnconaSud', 43.5350, 13.4480, 'Entroterra', 1120),
  ('A14-Falconara', 43.6180, 13.4110, 'Entroterra', 1130),
  ('A14-Senigallia', 43.6950, 13.2650, 'Entroterra', 1140),
  ('A14-Loreto', 43.4400, 13.5900, 'Entroterra', 1150),
  ('SS16-Senigallia-N', 43.7250, 13.2120, 'Entroterra', 1160),
  ('SS16-Senigallia-S', 43.7020, 13.2200, 'Entroterra', 1170),
  ('SS16-AncSud', 43.5800, 13.4950, 'Entroterra', 1180),
  ('SS16-Osimo', 43.4850, 13.4810, 'Entroterra', 1190),
  ('SS16-Loreto-N', 43.4600, 13.5620, 'Entroterra', 1200),
  ('SS16-PortoRecanati', 43.4300, 13.6050, 'Entroterra', 1210),
  ('SS76-Jesi-E', 43.5230, 13.2520, 'Entroterra', 1220),
  ('SS76-Jesi-W', 43.5180, 13.2050, 'Entroterra', 1230),
  ('SS76-Mid', 43.5640, 13.3550, 'Entroterra', 1240),
  ('SS76-AncW', 43.5760, 13.4350, 'Entroterra', 1250),
  ('SS76-Torrette', 43.5980, 13.4520, 'Entroterra', 1260),
  ('SS3-Fabriano-N', 43.3450, 12.9080, 'Entroterra', 1270),
  ('SS3-Fabriano-S', 43.3250, 12.8970, 'Entroterra', 1280),
  ('SS361-Osimo-N', 43.4950, 13.4750, 'Entroterra', 1290),
  ('SS361-Castelf', 43.4620, 13.5470, 'Entroterra', 1300),
  ('SP-Sirolo', 43.5620, 13.5380, 'Entroterra', 1310),
  ('Jesi-Centro', 43.5220, 13.2430, 'Entroterra', 1320),
  ('Jesi-Ring', 43.5150, 13.2610, 'Entroterra', 1330),
  ('Chiaravalle', 43.5980, 13.3230, 'Entroterra', 1340),
  ('Senigallia-Ctr', 43.7150, 13.2180, 'Entroterra', 1350),
  ('Senigallia-SS', 43.7080, 13.2250, 'Entroterra', 1360)
) AS v(nome, lat, lng, zona, ordine)
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.territorio_luoghi WHERE uso = 'traffico');
--> statement-breakpoint
-- Il centro del modello del traffico di Conerobus, com'era nel codice
-- (ANCONA_CENTER in routes/gtfs-helpers.ts).
INSERT INTO public.territorio_luoghi (nome, uso, lat, lng, ordine)
SELECT 'Ancona centro', 'centro_urbano', 43.616, 13.516, 900
 WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')
   AND NOT EXISTS (SELECT 1 FROM public.territorio_luoghi WHERE uso = 'centro_urbano');
--> statement-breakpoint
RESET ROLE;
