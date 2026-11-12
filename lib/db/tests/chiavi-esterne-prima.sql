-- ============================================================
-- Le chiavi esterne di Planning Studio (migrazioni 0010, 0011 e 0013, PR 2.15
-- e 2.15c): quello che c'è in un database PRIMA della migrazione.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/chiavi-esterne-prima.sql
-- Va caricato su una copia dello schema di produzione non ancora migrata, poi
-- si migra e si controlla con chiavi-esterne-dopo.sql.
--   - righe vere (una corsa con la sua categoria, una zona vietata del suo
--     progetto): devono restare;
--   - righe orfane (corse e progetti che non esistono più): devono sparire.
-- Niente righe con una categoria cancellata: con quelle la 0013 non mette la
-- chiave sulla categoria, e questo database deve arrivare allo schema atteso.
-- Quel caso lo prova chiave-categoria-rimandata.test.sql.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-0000000000ff', 'Prova chiavi esterne');
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'K1');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
VALUES ('c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'andata');
INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
VALUES ('c1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003');
INSERT INTO public.ps_validity_categories (id, code, name, color)
VALUES ('c1000000-0000-4000-8000-000000000005', 'prova_chiavi_esterne', 'Prova chiavi esterne', '#000000');

-- righe vere
INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
VALUES ('c1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000005');
INSERT INTO public.ps_no_go_zones (id, project_id, name, polygon)
VALUES ('c1000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'zona vera', '[]'::jsonb);

-- righe orfane: la corsa e il progetto non esistono
INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
SELECT ('c1000000-0000-4000-8000-0000000a' || pg_catalog.lpad(g::text, 4, '0'))::uuid, 'c1000000-0000-4000-8000-000000000005'
  FROM pg_catalog.generate_series(1, 25) AS g;
INSERT INTO public.ps_no_go_zones (id, project_id, name, polygon)
VALUES ('c1000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-0000000000aa', 'zona di un progetto cancellato', '[]'::jsonb),
       ('c1000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-0000000000ab', 'zona di un altro progetto cancellato', '[]'::jsonb);
COMMIT;
