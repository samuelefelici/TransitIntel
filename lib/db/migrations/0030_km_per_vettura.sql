-- ════════════════════════════════════════════════════════════════════════
-- 0030 — I km per vettura e per giorno, per FleetCare (tappa 4.8)
-- ────────────────────────────────────────────────────────────────────────
-- FleetCare tiene la manutenzione a km e confronta i km con il contachilometri
-- dei buoni carburante. Da qui legge quelli del consuntivo, sulle sole
-- giornate CHIUSE (i numeri non cambiano più):
--
--   public.esercizio_km_per_vettura(da, a)
--     giorno, vettura (il codice dell'AVM, come in esercizio_corse.vettura),
--     corse         le corse contate per la vettura;
--     km_servizio   i km fatti dalle corse con quella vettura indicata;
--     km_dal_turno  i km fatti dalle corse SENZA vettura (per esempio le
--                   presunte) del turno macchina che quel giorno ha avuto
--                   una vettura sola: la sua;
--     km_vuoto      i km a vuoto PROGRAMMATI dello stesso turno macchina
--                   (uscite, rientri, trasferimenti; esercizio_turni_macchina).
--   Le tre colonne restano separate: cosa sommare lo decide FleetCare. Un
--   turno macchina con due vetture nello stesso giorno non attribuisce né le
--   corse senza vettura né i vuoti.
--
-- È SECURITY INVOKER: legge con i diritti di chi la chiama. FleetCare
-- (fleetcare_legge_cerbero) ha la lettura delle sole colonne che servono,
-- date a ogni avvio dal migratore (lib/db/scripts/ruoli-regole.mjs, LETTORI):
-- nessun dato delle persone (né turno guida né conducente). Per questo resta
-- eseguibile da tutti: chi non legge quelle colonne riceve un rifiuto.
--
-- Al più 367 giorni per chiamata.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.esercizio_km_per_vettura(p_da date, p_a date)
RETURNS TABLE (giorno date, vettura text, corse integer, km_servizio numeric, km_dal_turno numeric, km_vuoto numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $km$
#variable_conflict use_column
BEGIN
  IF p_da IS NULL OR p_a IS NULL OR p_a < p_da OR p_a - p_da > 366 THEN
    RAISE EXCEPTION 'periodo non valido: da % a % (al più 367 giorni)', p_da, p_a USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH fatte AS (
    SELECT c.giorno, c.vss_id, c.turno_macchina, NULLIF(btrim(c.vettura), '') AS vettura, COALESCE(c.km_eff, 0) AS km
      FROM public.esercizio_corse c
      JOIN public.esercizio_giornate g ON g.giorno = c.giorno AND g.stato = 'chiusa'
     WHERE c.giorno BETWEEN p_da AND p_a
       AND c.esito IN ('effettuata', 'presunta', 'parziale')
  ), del_turno AS (
    /* la vettura del turno macchina, quando quel giorno è una sola */
    SELECT f.giorno, f.vss_id, f.turno_macchina, min(f.vettura) AS vettura
      FROM fatte f
     WHERE f.turno_macchina IS NOT NULL AND f.vettura IS NOT NULL
     GROUP BY f.giorno, f.vss_id, f.turno_macchina
    HAVING count(DISTINCT f.vettura) = 1
  ), voci AS (
    SELECT f.giorno, f.vettura, f.km AS servizio, 0::numeric AS dal_turno, 0::numeric AS vuoto, 1 AS n
      FROM fatte f
     WHERE f.vettura IS NOT NULL
    UNION ALL
    SELECT f.giorno, t.vettura, 0::numeric, f.km, 0::numeric, 1
      FROM fatte f
      JOIN del_turno t ON t.giorno = f.giorno AND t.vss_id IS NOT DISTINCT FROM f.vss_id AND t.turno_macchina = f.turno_macchina
     WHERE f.vettura IS NULL
    UNION ALL
    SELECT m.giorno, t.vettura, 0::numeric, 0::numeric, COALESCE(m.km_vuoto_prog, 0), 0
      FROM public.esercizio_turni_macchina m
      JOIN del_turno t ON t.giorno = m.giorno AND t.vss_id = m.vss_id AND t.turno_macchina = m.turno_macchina
  )
  SELECT v.giorno, v.vettura, sum(v.n)::integer, round(sum(v.servizio), 3), round(sum(v.dal_turno), 3), round(sum(v.vuoto), 3)
    FROM voci v
   GROUP BY v.giorno, v.vettura
   ORDER BY v.giorno, v.vettura;
END
$km$;
--> statement-breakpoint
DO $proprietario$
BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER FUNCTION public.esercizio_km_per_vettura(date, date) OWNER TO cerbero_owner;
  END IF;
END $proprietario$;
