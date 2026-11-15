-- ============================================================
-- La lunghezza dei percorsi la calcola il server (migrazione 0022, PR 3.5):
-- quello che c'è in un database PRIMA della migrazione.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/lunghezze-prima.sql
-- Va caricato su un database non ancora migrato alla 0022, poi si migra e si
-- controlla con lunghezze-dopo.sql. Tracciati come ne ha la produzione:
--   - salvato dal browser, con la distanza del motore di instradamento;
--   - senza lunghezza, con punti non validi in mezzo;
--   - un Feature invece di una LineString, con una lunghezza;
--   - un punto solo; coordinate che non sono un elenco.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000ff', 'Prova lunghezze dei percorsi');
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('c3500000-0000-4000-8000-0000000000a1', 'c3500000-0000-4000-8000-000000000001', '35');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
SELECT ('c3500000-0000-4000-8000-0000000000b' || n)::uuid, 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000a1', 'percorso ' || n
  FROM generate_series(1, 5) n;
INSERT INTO public.ps_shapes (id, project_id, variant_id, mode, geometry, distance_m) VALUES
  -- un centesimo di grado verso nord, ma il browser aveva mandato 99.999 m
  ('c3500000-0000-4000-8000-0000000000c1', 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000b1', 'driving',
   '{"type":"LineString","coordinates":[[13.5,43.6],[13.5,43.605],[13.5,43.61]]}', 99999),
  -- punti non validi in mezzo: si saltano
  ('c3500000-0000-4000-8000-0000000000c2', 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000b2', 'manual',
   '{"type":"LineString","coordinates":[[13.5,43.6],null,["13.5","43.605"],[200,43.605],[13.5,95],[13.5,43.61]]}', NULL),
  -- non una LineString: resta senza lunghezza (l'API la ricava quando legge)
  ('c3500000-0000-4000-8000-0000000000c3', 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000b3', 'manual',
   '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[13.5,43.6],[13.5,43.61]]}}', 500),
  ('c3500000-0000-4000-8000-0000000000c4', 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000b4', 'manual',
   '{"type":"LineString","coordinates":[[13.5,43.6]]}', 10),
  ('c3500000-0000-4000-8000-0000000000c5', 'c3500000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-0000000000b5', 'manual',
   '{"type":"LineString","coordinates":"non un elenco"}', 10);
COMMIT;
