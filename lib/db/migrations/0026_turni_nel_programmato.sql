-- ════════════════════════════════════════════════════════════════════════
-- 0026 — I turni nel programmato (tappa 4.3)
-- ────────────────────────────────────────────────────────────────────────
-- L'istantanea della giornata (0025) dice quali corse sono programmate. Da qui
-- dice anche chi le porta: per ogni corsa il turno macchina, il turno guida e
-- il deposito, presi dai turni pubblicati della giornata (il canale del
-- roster, roster_turni_pubblicati) com'erano all'inizio della giornata.
--
--   esercizio_corse            in più: UDP, turni guida (dss_id) e turni
--                              macchina (vss_id) pubblicati, il turno macchina,
--                              il turno guida e il deposito della corsa;
--   esercizio_turni_macchina   una riga per turno macchina della giornata:
--                              deposito, mezzo, uscita e rientro, corse, i
--                              vuoti programmati con i loro km;
--   esercizio_giornate.turni   il riepilogo dei turni della giornata: che cosa
--                              è pubblicato, le corse scoperte e perché, i
--                              turni superati, il programma diverso, i km a
--                              vuoto. NULL: turni non ancora calcolati (una
--                              giornata congelata prima di questa migrazione).
--
-- Gli id dei turni sono una fotografia, come il nome del programma: niente
-- chiavi esterne, l'istantanea resta leggibile anche se un giorno l'oggetto
-- non ci fosse più (oggi i turni pubblicati non si cancellano: il canale li
-- tiene con ON DELETE RESTRICT).
-- ════════════════════════════════════════════════════════════════════════
DO $turni$
BEGIN
  ALTER TABLE public.esercizio_giornate ADD COLUMN IF NOT EXISTS turni jsonb;

  ALTER TABLE public.esercizio_corse
    ADD COLUMN IF NOT EXISTS udp_id         uuid,
    ADD COLUMN IF NOT EXISTS dss_id         uuid,
    ADD COLUMN IF NOT EXISTS vss_id         uuid,
    ADD COLUMN IF NOT EXISTS turno_macchina text,
    ADD COLUMN IF NOT EXISTS turno_guida    text,
    ADD COLUMN IF NOT EXISTS deposito       text,
    ADD COLUMN IF NOT EXISTS deposito_id    uuid;

  IF pg_catalog.to_regclass('public.esercizio_turni_macchina') IS NULL THEN
    CREATE TABLE public.esercizio_turni_macchina (
      giorno            date NOT NULL REFERENCES public.esercizio_giornate(giorno) ON DELETE CASCADE,
      vss_id            uuid NOT NULL,
      turno_macchina    text NOT NULL,
      dss_id            uuid,
      udp_id            uuid,
      udp_nome          text,
      deposito          text,
      deposito_id       uuid,
      tipo_mezzo        text,
      uscita            text,
      rientro           text,
      corse             integer NOT NULL DEFAULT 0,
      corse_nel_giorno  integer NOT NULL DEFAULT 0,
      km_vuoto_prog     numeric(10, 3) NOT NULL DEFAULT 0,
      vuoti             jsonb NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (giorno, vss_id, turno_macchina),
      CONSTRAINT esercizio_turni_macchina_corse CHECK (corse >= 0 AND corse_nel_giorno BETWEEN 0 AND corse),
      CONSTRAINT esercizio_turni_macchina_km CHECK (km_vuoto_prog >= 0)
    );
  END IF;

  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_turni_macchina OWNER TO cerbero_owner;
  END IF;
END $turni$;
