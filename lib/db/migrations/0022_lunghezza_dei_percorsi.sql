-- ════════════════════════════════════════════════════════════════════════
-- 0022 — La lunghezza dei percorsi la calcola il server (PR 3.5)
-- ────────────────────────────────────────────────────────────────────────
-- I km programmati di un programma sono, da qui, una funzione sola
-- (artifacts/api-server/src/lib/km-programmati.ts):
--
--   km = giorni in cui la corsa circola davvero × lunghezza del suo percorso
--
-- La lunghezza è ps_shapes.distance_m. Fino a qui la mandava il browser al
-- salvataggio del tracciato (la distanza del motore di instradamento, che non
-- è la lunghezza della linea disegnata), e l'import la calcolava a modo suo.
-- Da qui la scrivono solo l'API e l'import, con lunghezzaDellaGeometria():
-- somma delle distanze sulla sfera (raggio 6.371.000 m) fra i punti del
-- tracciato, saltando i punti non validi.
--
-- Qui si ricalcolano con la stessa formula le lunghezze già salvate. Un
-- tracciato che non è una LineString (non ne scrive nessuno, ma il tipo della
-- colonna lo permette) resta senza lunghezza: l'API la ricava dalla geometria
-- quando la legge.
--
-- Solo dati: come cerbero_owner, se la tabella è già sua (README, «Chi
-- possiede cosa»). Idempotente: una seconda volta non cambia niente.
-- ════════════════════════════════════════════════════════════════════════
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid = pg_catalog.to_regclass('public.ps_shapes')
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
DO $lunghezze$
DECLARE
  cambiate integer;
  senza integer;
BEGIN
  WITH punti AS (
    -- i punti validi di ogni tracciato, in ordine, col punto valido prima
    SELECT sh.id, p.n,
           (p.v->>0)::float8 AS lon, (p.v->>1)::float8 AS lat,
           pg_catalog.lag((p.v->>0)::float8) OVER (PARTITION BY sh.id ORDER BY p.n) AS lon0,
           pg_catalog.lag((p.v->>1)::float8) OVER (PARTITION BY sh.id ORDER BY p.n) AS lat0
      FROM public.ps_shapes sh
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
             CASE WHEN pg_catalog.jsonb_typeof(sh.geometry->'coordinates') = 'array'
                  THEN sh.geometry->'coordinates' ELSE '[]'::jsonb END) WITH ORDINALITY AS p(v, n)
     WHERE sh.geometry->>'type' = 'LineString'
       AND pg_catalog.jsonb_typeof(p.v) = 'array'
       AND pg_catalog.jsonb_typeof(p.v->0) = 'number'
       AND pg_catalog.jsonb_typeof(p.v->1) = 'number'
       AND abs((p.v->>0)::float8) <= 180
       AND abs((p.v->>1)::float8) <= 90
  ), lunghezze AS (
    SELECT sh.id,
           COALESCE((SELECT sum(2 * 6371000 * asin(least(1::float8, sqrt(
                       power(sin(radians(q.lat - q.lat0) / 2), 2)
                       + cos(radians(q.lat0)) * cos(radians(q.lat)) * power(sin(radians(q.lon - q.lon0) / 2), 2)))))
                       FROM punti q WHERE q.id = sh.id AND q.lat0 IS NOT NULL), 0) AS metri
      FROM public.ps_shapes sh
     WHERE sh.geometry->>'type' = 'LineString'
  )
  UPDATE public.ps_shapes s
     SET distance_m = l.metri
    FROM lunghezze l
   WHERE l.id = s.id
     AND s.distance_m IS DISTINCT FROM l.metri;
  GET DIAGNOSTICS cambiate = ROW_COUNT;

  UPDATE public.ps_shapes
     SET distance_m = NULL
   WHERE geometry->>'type' IS DISTINCT FROM 'LineString'
     AND distance_m IS NOT NULL;
  GET DIAGNOSTICS senza = ROW_COUNT;

  RAISE NOTICE '0022: lunghezza ricalcolata dal tracciato per % percorsi; % senza LineString lasciati senza lunghezza', cambiate, senza;
END $lunghezze$;
--> statement-breakpoint
RESET ROLE;
