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
--   - `caronte.app_users`, gli utenti di Caronte, è una tabella SUA: non la
--     creano le migrazioni di Cerbero e il migratore non la tocca. Ne diventa
--     proprietario `caronte_app`;
--   - può creare nello schema `caronte`. Serve a Caronte com'è oggi: a ogni
--     login esegue `CREATE TABLE IF NOT EXISTS caronte.app_users`, e
--     PostgreSQL lo rifiuta a chi non può creare nello schema anche quando la
--     tabella c'è già. Le tabelle di Cerbero non le tocca lo stesso (non sono
--     sue). Quando Caronte controllerà prima se la tabella esiste, la riga
--     `GRANT CREATE` in fondo si toglie e il permesso si revoca:
--       REVOKE CREATE ON SCHEMA caronte FROM caronte_app;
--     Finché c'è, `ruoli.mjs --verifica` lo ricorda con un avviso.
-- Si può rieseguire: prima toglie tutto quello che la versione vecchia di
-- questo file dava (lettura di tutta public), poi ridà solo questo.
--
-- Eseguire come superutente (postgres), dopo il primo avvio dell'API. Dal
-- Terminal del container dell'API, dove DATABASE_URL è dell'app:
--   DATABASE_URL="$DATABASE_MIGRATOR_URL" node lib/db/scripts/run-sql.mjs caronte_setup.sql
-- oppure, dove c'è psql:
--   psql -v ON_ERROR_STOP=1 "<url di postgres>" -f caronte_setup.sql
-- Poi la password, da psql: `\password caronte_app` (manda al server solo
-- l'hash, non la password in chiaro), e `ALTER ROLE caronte_app LOGIN;`.
-- Caronte ha due variabili con l'URL del database, DATABASE_URL e CARONTE_URL:
-- vanno tutte e due su caronte_app (DEPLOY.md, «Ruoli del database»).
-- ═══════════════════════════════════════════════════════════════════════════
-- da superutente: niente public nel percorso (l'app di Cerbero può creare in public)
SET search_path = pg_catalog, pg_temp;
-- Tutto insieme o niente: fra il REVOKE e i GRANT Caronte non resta senza permessi
BEGIN;

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

-- La tabella degli utenti di Caronte: sua, e solo sua. Il REVOKE qui sopra ha
-- tolto i diritti anche al proprietario, quindi si ridanno, con quelli delle
-- sequenze delle sue colonne (se l'id è un serial).
DO $$
DECLARE s regclass;
BEGIN
  IF to_regclass('caronte.app_users') IS NOT NULL THEN
    ALTER TABLE caronte.app_users OWNER TO caronte_app;
    GRANT ALL ON TABLE caronte.app_users TO caronte_app;
    FOR s IN
      SELECT d.objid::regclass FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_class c ON c.oid = d.objid AND c.relkind = 'S'
       WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass
         AND d.refobjid = 'caronte.app_users'::regclass AND d.deptype IN ('a', 'i')
    LOOP
      EXECUTE format('GRANT ALL ON SEQUENCE %s TO caronte_app', s);
    END LOOP;
  END IF;
END$$;

-- Da togliere quando Caronte non crea più la sua tabella a ogni login (vedi in testa)
GRANT CREATE ON SCHEMA caronte TO caronte_app;

COMMIT;
