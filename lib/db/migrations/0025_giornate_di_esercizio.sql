-- ════════════════════════════════════════════════════════════════════════
-- 0025 — Le giornate di esercizio: il programmato congelato (tappa 4.2)
-- ────────────────────────────────────────────────────────────────────────
-- Il programmato di una giornata si ricalcolava ogni volta dal feed acceso
-- oggi: il passato cambiava col presente. Da qui ogni giornata di esercizio
-- (dalle 03:00 alle 03:00, lib/service-day.ts) ha la sua istantanea:
--
--   esercizio_giornate   una riga per giorno: il programma e il feed in
--                        esercizio all'inizio della giornata (dallo storico
--                        delle attivazioni), lo stato, i totali, gli avvisi;
--   esercizio_corse      una riga per corsa programmata quel giorno, con le
--                        sue identità (la chiave del feed, il codice stabile,
--                        il numero di corsa), linea, percorso, orari,
--                        capolinea e i km dalla geometria.
--
-- Stati:
--   preparata   si può rifare (il lavoratore la rifà a ogni giro, fino
--               all'inizio della giornata);
--   congelata   dall'inizio della giornata non cambia più: una nuova messa in
--               esercizio, una duplica o un feed caricato dopo non la toccano.
--
-- ricostruita: la giornata è stata preparata solo dopo il suo inizio (per
-- esempio una giornata passata aperta dopo il rilascio); il programma viene
-- comunque dallo storico all'inizio della giornata.
--
-- Le scrive solo il sistema (il lavoratore, o l'amministratore che chiede di
-- preparare una giornata): niente registro delle modifiche qui; il giornale
-- del consuntivo avrà il suo.
-- ════════════════════════════════════════════════════════════════════════
DO $giornate$
BEGIN
  IF pg_catalog.to_regclass('public.esercizio_giornate') IS NULL THEN
    CREATE TABLE public.esercizio_giornate (
      giorno        date PRIMARY KEY,
      stato         text NOT NULL DEFAULT 'preparata',
      ps_project_id uuid REFERENCES public.ps_projects(id) ON DELETE SET NULL,
      feed_id       uuid REFERENCES public.gtfs_feeds(id) ON DELETE SET NULL,
      programma     text,
      feed_file     text,
      ricostruita   boolean NOT NULL DEFAULT false,
      corse         integer NOT NULL DEFAULT 0,
      km_prog       numeric(12, 1) NOT NULL DEFAULT 0,
      avvisi        jsonb NOT NULL DEFAULT '[]'::jsonb,
      preparata_il  timestamptz NOT NULL DEFAULT now(),
      congelata_il  timestamptz,
      CONSTRAINT esercizio_giornate_stato CHECK (stato IN ('preparata', 'congelata')),
      CONSTRAINT esercizio_giornate_congelamento CHECK ((stato = 'congelata') = (congelata_il IS NOT NULL)),
      CONSTRAINT esercizio_giornate_totali CHECK (corse >= 0 AND km_prog >= 0)
    );
  END IF;
  IF pg_catalog.to_regclass('public.esercizio_corse') IS NULL THEN
    CREATE TABLE public.esercizio_corse (
      giorno      date NOT NULL REFERENCES public.esercizio_giornate(giorno) ON DELETE CASCADE,
      chiave      text NOT NULL,
      codice      text,
      numero      text NOT NULL,
      route_id    text,
      linea       text,
      variante    text,
      shape_id    text,
      direzione   smallint,
      partenza    text,
      arrivo      text,
      fermata_da  text,
      fermata_a   text,
      km_prog     numeric(9, 3),
      a_chiamata  boolean NOT NULL DEFAULT false,
      PRIMARY KEY (giorno, chiave),
      CONSTRAINT esercizio_corse_km CHECK (km_prog IS NULL OR km_prog >= 0)
    );
  END IF;
  IF pg_catalog.to_regclass('public.idx_esercizio_corse_numero') IS NULL THEN
    CREATE INDEX idx_esercizio_corse_numero ON public.esercizio_corse (giorno, numero);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_giornate OWNER TO cerbero_owner;
    ALTER TABLE public.esercizio_corse OWNER TO cerbero_owner;
  END IF;
END $giornate$;
