-- ============================================================
-- Un solo programma in esercizio (migrazione 0019, PR 3.2): lo stato che la
-- migrazione mette in regola, come lo lasciavano le due porte di prima.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/esercizio-prima.sql
-- Va caricato su un database non ancora migrato alla 0019, poi si migra e si
-- controlla con esercizio-dopo.sql:
--   - due feed accesi, di due proprietari («Metti in esercizio» spegneva
--     solo quelli dello stesso proprietario): resta acceso l'ultimo caricato,
--     quello che l'AVM leggeva già;
--   - il feed «di default» è un terzo feed: diventa quello acceso;
--   - un periodo dello storico aperto sul feed che si spegne: si chiude;
--   - il feed che resta acceso non ha un periodo aperto (attivato dalla
--     pagina GTFS): se ne apre uno.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
INSERT INTO public.users (id, email, password_hash) VALUES
  ('c3200000-0000-4000-8000-0000000000f1', 'prova-0019-uno@prova.local', 'x'),
  ('c3200000-0000-4000-8000-0000000000f2', 'prova-0019-due@prova.local', 'x');
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-0000000000f1', 'Prova un solo programma in esercizio');
INSERT INTO public.gtfs_feeds (id, filename, owner_user_id, is_active, is_default, uploaded_at) VALUES
  ('c3200000-0000-4000-8000-0000000000a1', 'prova-0019-ps.synthetic', 'c3200000-0000-4000-8000-0000000000f1', true,  false, '2026-01-01'),
  ('c3200000-0000-4000-8000-0000000000a2', 'prova-0019-maior.zip',    'c3200000-0000-4000-8000-0000000000f2', true,  false, '2026-02-01'),
  ('c3200000-0000-4000-8000-0000000000a3', 'prova-0019-vecchio.zip',  'c3200000-0000-4000-8000-0000000000f2', false, true,  '2025-06-01');
UPDATE public.ps_projects SET materialized_feed_id = 'c3200000-0000-4000-8000-0000000000a1'
 WHERE id = 'c3200000-0000-4000-8000-000000000001';
-- il periodo aperto del feed di Planning Studio, e uno vecchio già chiuso
INSERT INTO public.ps_activation_log (id, project_id, feed_id, user_id, activated_at, deactivated_at) VALUES
  ('c3200000-0000-4000-8000-0000000000b1', 'c3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-0000000000a1', NULL, '2026-01-01', NULL),
  ('c3200000-0000-4000-8000-0000000000b2', 'c3200000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-0000000000a3', NULL, '2025-06-01', '2026-01-01');
COMMIT;
