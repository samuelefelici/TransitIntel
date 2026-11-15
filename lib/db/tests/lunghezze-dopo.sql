-- ============================================================
-- La lunghezza dei percorsi la calcola il server (migrazione 0022, PR 3.5):
-- che cosa deve esserci DOPO la migrazione nei tracciati di
-- lunghezze-prima.sql. Le lunghezze attese sono quelle di
-- lunghezzaDellaGeometria (artifacts/api-server/src/lib/km-programmati.ts),
-- che ha lo stesso caso nei suoi test. Alla fine toglie le righe di prova.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/lunghezze-dopo.sql
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
DO $$
DECLARE
  -- un centesimo di grado sulla sfera di 6.371 km
  centesimo constant float8 := 1111.9492664455875;
  atteso record;
  d float8;
BEGIN
  FOR atteso IN
    SELECT * FROM (VALUES
      ('c3500000-0000-4000-8000-0000000000c1'::uuid, centesimo, 'la distanza del browser lascia il posto a quella del tracciato'),
      ('c3500000-0000-4000-8000-0000000000c2'::uuid, centesimo, 'i punti non validi si saltano'),
      ('c3500000-0000-4000-8000-0000000000c3'::uuid, NULL::float8, 'un Feature resta senza lunghezza'),
      ('c3500000-0000-4000-8000-0000000000c4'::uuid, 0::float8, 'un punto solo è lungo zero'),
      ('c3500000-0000-4000-8000-0000000000c5'::uuid, 0::float8, 'coordinate che non sono un elenco: zero')
    ) AS v(id, metri, perche)
  LOOP
    SELECT distance_m INTO d FROM public.ps_shapes WHERE id = atteso.id;
    IF atteso.metri IS NULL THEN
      IF d IS NOT NULL THEN RAISE EXCEPTION '%: distance_m = %, attesa nessuna', atteso.perche, d; END IF;
    ELSIF d IS NULL OR abs(d - atteso.metri) > 1e-6 THEN
      RAISE EXCEPTION '%: distance_m = %, attesa %', atteso.perche, d, atteso.metri;
    END IF;
  END LOOP;
END $$;
DELETE FROM public.ps_shapes WHERE project_id = 'c3500000-0000-4000-8000-000000000001';
DELETE FROM public.ps_route_variants WHERE project_id = 'c3500000-0000-4000-8000-000000000001';
DELETE FROM public.ps_routes WHERE project_id = 'c3500000-0000-4000-8000-000000000001';
DELETE FROM public.ps_projects WHERE id = 'c3500000-0000-4000-8000-000000000001';
