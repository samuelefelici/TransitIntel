-- ══════════════════════════════════════════════════════════════════════
-- 0063 — Via bus_stops, se è vuota (tappa 7.15)
-- ──────────────────────────────────────────────────────────────────────
-- bus_stops è la tabella delle fermate del primo modello di dati. La leggeva
-- solo la pagina delle analisi, che dalla 7.15 usa le fermate del feed in
-- esercizio: nessun codice la usa più, nessuna chiave esterna o vista punta a
-- lei. Era sempre vuota. La si toglie solo se è ancora vuota: se avesse righe
-- resta com'è, e il log lo dice (nessun dato perso senza deciderlo).
-- ══════════════════════════════════════════════════════════════════════
DO $fermate$
BEGIN
  IF pg_catalog.to_regclass('public.bus_stops') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.bus_stops) THEN
    RAISE NOTICE 'bus_stops ha delle righe: resta com''è (non la usa più nessuno: decidere a mano se toglierla)';
  ELSE
    DROP TABLE public.bus_stops;
  END IF;
END $fermate$;
