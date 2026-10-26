-- ═══════════════════════════════════════════════════════════════════════════
-- Ruolo `caronte_app` per il validatore Caronte (opzionale)
-- ───────────────────────────────────────────────────────────────────────────
-- Lo schema `caronte` e le sue tabelle li creano le migrazioni di Cerbero
-- (lib/db/migrations, applicate dall'API all'avvio): qui c'è solo il ruolo con
-- cui il validatore e l'AVM scrivono.
--   - scrive SOLO le tabelle del validatore e dell'AVM in `caronte`
--     (timbrature, viaggi, posizioni, corse attive, transiti); le altre
--     tabelle di caronte (archivi e correzioni di Cerbero) le legge soltanto;
--   - in `public` legge SOLO le tabelle GTFS (linee, fermate, corse, orari):
--     niente utenti, anagrafica, roster, registri.
-- Si può rieseguire: prima toglie tutto quello che la versione vecchia di
-- questo file dava (lettura di tutta public, CREATE sullo schema).
--
-- Eseguire come proprietario del database, dopo il primo avvio dell'API:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f caronte_setup.sql
-- Poi la password, da psql: `\password caronte_app` (manda al server solo
-- l'hash, non la password in chiaro), e `ALTER ROLE caronte_app LOGIN;`.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regnamespace('caronte') IS NULL THEN
    RAISE EXCEPTION 'lo schema caronte non c''è ancora: avvia prima l''API, che lo crea con le migrazioni, poi riesegui questo file';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caronte_app') THEN
    CREATE ROLE caronte_app NOLOGIN;
  ELSE
    RAISE WARNING 'caronte_app esisteva già: se è stato creato dalla versione vecchia di questo file ha la password CHANGE_ME, cambiala con \password caronte_app';
  END IF;
END$$;

-- Via i permessi della versione vecchia
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM caronte_app;
REVOKE ALL ON ALL TABLES IN SCHEMA caronte FROM caronte_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA caronte FROM caronte_app;
REVOKE CREATE ON SCHEMA caronte FROM caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA caronte REVOKE ALL ON TABLES FROM caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA caronte REVOKE ALL ON SEQUENCES FROM caronte_app;

GRANT USAGE ON SCHEMA caronte TO caronte_app;
GRANT USAGE ON SCHEMA public TO caronte_app;

DO $$
DECLARE t text;
BEGIN
  -- scrittura: solo le tabelle del validatore e dell'AVM
  FOREACH t IN ARRAY ARRAY['tap_events','journeys','vehicle_positions','active_trips','stop_transits'] LOOP
    IF to_regclass('caronte.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON caronte.%I TO caronte_app', t);
    END IF;
  END LOOP;
  -- lettura: le altre tabelle di caronte, che scrive Cerbero
  FOREACH t IN ARRAY ARRAY['avm_diario','avm_controllo_settimanale','journey_codes','journey_code_days',
                           'stop_alias_overrides','stop_predictions'] LOOP
    IF to_regclass('caronte.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON caronte.%I TO caronte_app', t);
    END IF;
  END LOOP;
  -- lettura: le tabelle GTFS di public, una per una
  FOREACH t IN ARRAY ARRAY['gtfs_feeds','gtfs_routes','gtfs_stops','gtfs_trips','gtfs_stop_times',
                           'gtfs_calendar','gtfs_calendar_dates','gtfs_shapes'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO caronte_app', t);
    END IF;
  END LOOP;
END$$;
