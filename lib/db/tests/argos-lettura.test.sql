-- Dopo il migratore argos_ro legge esattamente le tabelle del contratto e
-- nient'altro. Controllato con le funzioni di Postgres (has_*_privilege), non
-- con la logica di argos-permessi-regole.mjs. L'elenco arriva dal contratto:
--   psql -v contratto=public.gtfs_feeds,public.gtfs_routes,... -f questo file
SET argos.contratto = :'contratto';

DO $$
DECLARE
  contratto text[] := string_to_array(current_setting('argos.contratto'), ',');
  leggibili text[];
  r record;
BEGIN
  IF cardinality(contratto) < 20 THEN
    RAISE EXCEPTION 'contratto non passato o troppo corto: %', contratto;
  END IF;

  -- 1. legge esattamente le tabelle del contratto
  SELECT coalesce(array_agg(n.nspname || '.' || c.relname ORDER BY 1), '{}') INTO leggibili
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND has_any_column_privilege('argos_ro', c.oid, 'SELECT');
  IF EXISTS (SELECT unnest(leggibili) EXCEPT SELECT unnest(contratto)) THEN
    RAISE EXCEPTION 'argos_ro legge tabelle fuori dal contratto: %',
      ARRAY(SELECT unnest(leggibili) EXCEPT SELECT unnest(contratto));
  END IF;
  IF EXISTS (SELECT unnest(contratto) EXCEPT SELECT unnest(leggibili)) THEN
    RAISE EXCEPTION 'argos_ro non legge tabelle del contratto: %',
      ARRAY(SELECT unnest(contratto) EXCEPT SELECT unnest(leggibili));
  END IF;

  -- 2. i dati personali, per nome, anche solo una colonna
  FOR r IN SELECT t FROM unnest(ARRAY['public.users', 'public.accessi_log', 'public.accessi_tentativi',
      'public.roster_drivers', 'public.roster_entries', 'caronte.app_users']) t
  LOOP
    IF to_regclass(r.t) IS NOT NULL AND has_any_column_privilege('argos_ro', r.t, 'SELECT') THEN
      RAISE EXCEPTION 'argos_ro legge %', r.t;
    END IF;
  END LOOP;

  -- 3. nessuna scrittura, su nessuna tabella; nessuna sequenza
  FOR r IN SELECT c.oid::regclass AS t, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
  LOOP
    IF r.relkind = 'S' THEN
      IF has_sequence_privilege('argos_ro', r.t, 'USAGE, SELECT, UPDATE') THEN
        RAISE EXCEPTION 'argos_ro usa la sequenza %', r.t;
      END IF;
    ELSIF has_table_privilege('argos_ro', r.t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege('argos_ro', r.t, 'INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'argos_ro può scrivere su %', r.t;
    END IF;
  END LOOP;

  -- 4. niente tabelle future e niente CREATE negli schemi
  IF EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = 'argos_ro'::regrole) THEN
    RAISE EXCEPTION 'restano permessi di default per argos_ro';
  END IF;
  IF has_schema_privilege('argos_ro', 'public', 'CREATE') OR has_schema_privilege('argos_ro', 'caronte', 'CREATE') THEN
    RAISE EXCEPTION 'argos_ro può creare tabelle';
  END IF;
  CREATE TABLE public.ci_tabella_nuova (id int);
  CREATE TABLE caronte.ci_tabella_nuova (id int);
  IF has_table_privilege('argos_ro', 'public.ci_tabella_nuova', 'SELECT')
     OR has_table_privilege('argos_ro', 'caronte.ci_tabella_nuova', 'SELECT') THEN
    RAISE EXCEPTION 'una tabella nuova è leggibile da argos_ro';
  END IF;
  DROP TABLE public.ci_tabella_nuova, caronte.ci_tabella_nuova;

  RAISE NOTICE 'argos_ro legge le % tabelle del contratto e nient''altro', cardinality(contratto);
END
$$;
