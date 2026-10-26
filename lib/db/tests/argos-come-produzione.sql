-- Per la CI: dà ad argos_ro i permessi che argos/cerbero_readonly_user.sql dà
-- in produzione (lettura di tutto public e caronte, e delle tabelle future),
-- senza password né CONNECT. Così la migrazione 0002 si prova sullo stato
-- vero, non su un ruolo vuoto.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argos_ro') THEN
    CREATE ROLE argos_ro NOLOGIN;
  END IF;
END$$;
GRANT USAGE  ON SCHEMA public               TO argos_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO argos_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public   GRANT SELECT ON TABLES TO argos_ro;
GRANT USAGE  ON SCHEMA caronte               TO argos_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA caronte TO argos_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA caronte   GRANT SELECT ON TABLES TO argos_ro;
