-- Dopo il migratore argos_ro legge esattamente le tabelle del contratto e
-- nient'altro. Controllato con le funzioni di Postgres (has_*_privilege,
-- pg_has_role), non con la logica di argos-permessi-regole.mjs. L'elenco arriva
-- dal contratto:
--   psql -v contratto=public.gtfs_feeds,public.gtfs_routes,... -f questo file
SET argos.contratto = :'contratto';

DO $$
DECLARE
  contratto text[] := string_to_array(current_setting('argos.contratto'), ',');
  argos oid := 'argos_ro'::regrole;
  scrittura text := 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ', MAINTAIN' ELSE '' END;
  leggibili text[];
  r record;
  voce text;
BEGIN
  IF cardinality(contratto) < 20 THEN
    RAISE EXCEPTION 'contratto non passato o troppo corto: %', contratto;
  END IF;

  -- 1. il ruolo: niente attributi speciali, niente appartenenze, niente proprietà
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = argos AND (rolsuper OR rolreplication OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'argos_ro ha attributi speciali (SUPERUSER, REPLICATION, BYPASSRLS, CREATEROLE o CREATEDB)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = argos) THEN
    RAISE EXCEPTION 'argos_ro è membro di: %', ARRAY(SELECT roleid::regrole::text FROM pg_auth_members WHERE member = argos);
  END IF;
  IF pg_has_role(argos, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'MEMBER') THEN
    RAISE EXCEPTION 'argos_ro ha i diritti del proprietario del database';
  END IF;
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM pg_parameter_acl p, aclexplode(p.paracl) a WHERE a.grantee IN ($1, 0))'
      INTO r USING argos;
    IF r.exists THEN
      RAISE EXCEPTION 'argos_ro, o chiunque, può cambiare parametri del server (pg_parameter_acl)';
    END IF;
  END IF;
  IF has_database_privilege(argos, current_database(), 'CREATE')
     OR has_database_privilege(argos, current_database(), 'CREATE WITH GRANT OPTION, CONNECT WITH GRANT OPTION, TEMPORARY WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'argos_ro può creare schemi nel database o passarne i permessi';
  END IF;
  FOR r IN SELECT n.nspname, n.nspowner FROM pg_namespace n WHERE n.nspname IN ('public', 'caronte') LOOP
    IF pg_has_role(argos, r.nspowner, 'MEMBER') THEN
      RAISE EXCEPTION 'argos_ro ha i diritti del proprietario dello schema %', r.nspname;
    END IF;
    IF NOT has_schema_privilege(argos, r.nspname, 'USAGE') THEN
      RAISE EXCEPTION 'argos_ro non ha USAGE sullo schema %', r.nspname;
    END IF;
    IF has_schema_privilege(argos, r.nspname, 'CREATE')
       OR has_schema_privilege(argos, r.nspname, 'USAGE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'argos_ro può creare o passare permessi nello schema %', r.nspname;
    END IF;
  END LOOP;

  -- 2. legge esattamente le tabelle del contratto
  SELECT coalesce(array_agg(n.nspname || '.' || c.relname ORDER BY 1), '{}') INTO leggibili
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND has_any_column_privilege(argos, c.oid, 'SELECT');
  IF EXISTS (SELECT unnest(leggibili) EXCEPT SELECT unnest(contratto)) THEN
    RAISE EXCEPTION 'argos_ro legge tabelle fuori dal contratto: %',
      ARRAY(SELECT unnest(leggibili) EXCEPT SELECT unnest(contratto));
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(contratto) t LEFT JOIN pg_class c ON c.oid = to_regclass(t)
              WHERE c.relkind IS DISTINCT FROM 'r' AND c.relkind IS DISTINCT FROM 'p') THEN
    RAISE EXCEPTION 'nel contratto ci sono voci che non sono tabelle';
  END IF;
  IF EXISTS (SELECT unnest(contratto) EXCEPT SELECT unnest(leggibili)) THEN
    RAISE EXCEPTION 'argos_ro non legge tabelle del contratto: %',
      ARRAY(SELECT unnest(contratto) EXCEPT SELECT unnest(leggibili));
  END IF;

  -- 3. i dati personali, per nome, anche solo una colonna
  FOR r IN SELECT t FROM unnest(ARRAY['public.users', 'public.accessi_log', 'public.accessi_tentativi',
      'public.roster_drivers', 'public.roster_entries', 'caronte.app_users']) t
  LOOP
    IF to_regclass(r.t) IS NOT NULL AND has_any_column_privilege(argos, r.t, 'SELECT') THEN
      RAISE EXCEPTION 'argos_ro legge %', r.t;
    END IF;
  END LOOP;

  -- 4. nessuna scrittura (MAINTAIN compreso), nessuna grant option, nessuna sequenza
  FOR r IN SELECT c.oid::regclass AS t, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
  LOOP
    IF r.relkind = 'S' THEN
      IF has_sequence_privilege(argos, r.t, 'USAGE, SELECT, UPDATE') THEN
        RAISE EXCEPTION 'argos_ro usa la sequenza %', r.t;
      END IF;
    ELSIF has_table_privilege(argos, r.t, scrittura)
       OR has_any_column_privilege(argos, r.t, 'INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'argos_ro può scrivere su %', r.t;
    ELSIF has_any_column_privilege(argos, r.t, 'SELECT WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'argos_ro può passare ad altri la lettura di %', r.t;
    END IF;
  END LOOP;

  -- 5. niente tabelle future: permessi di default, suoi o di tutti (PUBLIC),
  --    negli schemi di Cerbero o globali; e una tabella nuova non è leggibile
  IF EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
              WHERE (d.defaclnamespace = 0 OR d.defaclnamespace IN ('public'::regnamespace, 'caronte'::regnamespace))
                AND (a.grantee = argos OR (a.grantee = 0 AND d.defaclobjtype IN ('r', 'S')))) THEN
    RAISE EXCEPTION 'restano permessi di default che danno ad argos_ro le tabelle future';
  END IF;
  CREATE TABLE public.ci_tabella_nuova (id int);
  CREATE TABLE caronte.ci_tabella_nuova (id int);
  IF has_table_privilege(argos, 'public.ci_tabella_nuova', 'SELECT')
     OR has_table_privilege(argos, 'caronte.ci_tabella_nuova', 'SELECT') THEN
    RAISE EXCEPTION 'una tabella nuova è leggibile da argos_ro';
  END IF;
  DROP TABLE public.ci_tabella_nuova, caronte.ci_tabella_nuova;

  -- 6. negli altri schemi non di sistema: niente letture fuori dalle estensioni,
  --    niente scrittura, niente CREATE. I permessi che passano dal nome contano
  --    solo con l'USAGE sullo schema; sequenze (per OID) e MAINTAIN (VACUUM e
  --    ANALYZE senza elenco) contano sempre
  FOR r IN SELECT c.oid::regclass AS t, c.relkind, has_schema_privilege(argos, n.oid, 'USAGE') AS uso,
                  EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS ext
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('public', 'caronte') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
  LOOP
    IF r.relkind = 'S' THEN
      IF NOT r.ext AND has_sequence_privilege(argos, r.t, 'USAGE, SELECT, UPDATE') THEN
        RAISE EXCEPTION 'argos_ro usa la sequenza %', r.t;
      END IF;
    ELSIF (current_setting('server_version_num')::int >= 170000 AND has_table_privilege(argos, r.t, 'MAINTAIN'))
       OR (r.uso AND (has_table_privilege(argos, r.t, scrittura)
                      OR has_any_column_privilege(argos, r.t, 'INSERT, UPDATE, REFERENCES'))) THEN
      RAISE EXCEPTION 'argos_ro può scrivere su %', r.t;
    ELSIF r.uso AND NOT r.ext AND has_any_column_privilege(argos, r.t, 'SELECT') THEN
      RAISE EXCEPTION 'argos_ro legge % fuori dagli schemi di Cerbero', r.t;
    END IF;
  END LOOP;
  -- large object: dati applicativi, leggibili e scrivibili con lo_get/lo_put
  IF current_setting('lo_compat_privileges')::boolean
     OR EXISTS (SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) c
                 WHERE s.setrole IN (argos, 0)
                   AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                   AND lower(split_part(c, '=', 1)) = 'lo_compat_privileges'
                   AND lower(split_part(c, '=', 2)) NOT IN ('off', 'of', 'false', 'fals', 'fal', 'fa', 'f', 'no', 'n', '0'))
     OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l, aclexplode(l.lomacl) a WHERE a.grantee IN (argos, 0) OR l.lomowner = argos) THEN
    RAISE EXCEPTION 'argos_ro può leggere o scrivere large object';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                AND has_schema_privilege(argos, n.oid, 'CREATE')) THEN
    RAISE EXCEPTION 'argos_ro può creare oggetti in uno schema';
  END IF;
  -- il contratto salvato non lo può toccare
  IF to_regclass('cerbero_migrazioni.contratti') IS NOT NULL
     AND (has_table_privilege(argos, 'cerbero_migrazioni.contratti', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
          OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                      WHERE c.oid = 'cerbero_migrazioni.contratti'::regclass AND a.grantee = 0
                        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'))) THEN
    RAISE EXCEPTION 'argos_ro, o chiunque, può modificare cerbero_migrazioni.contratti';
  END IF;
  -- e il trigger che annota chi scrive è l'unico, ed è sempre acceso
  IF to_regclass('cerbero_migrazioni.contratti') IS NOT NULL
     AND (NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'cerbero_migrazioni.contratti'::regclass
                       AND tgname = 'contratti_chi_scrive' AND tgenabled = 'A')
          OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'cerbero_migrazioni.contratti'::regclass
                      AND NOT tgisinternal AND tgname <> 'contratti_chi_scrive')) THEN
    RAISE EXCEPTION 'cerbero_migrazioni.contratti: il trigger che annota chi scrive manca, non è acceso sempre o non è il solo';
  END IF;

  -- 7. funzioni: nessuna SECURITY DEFINER eseguibile, nessun oggetto di sistema
  --    riservato all'installazione (pg_init_privs senza PUBLIC) usabile
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
                AND has_function_privilege(argos, p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'argos_ro può eseguire funzioni SECURITY DEFINER: %', ARRAY(
      SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_function_privilege(argos, p.oid, 'EXECUTE'));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_init_privs i
              WHERE (i.classoid = 'pg_proc'::regclass
                     AND NOT EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                     AND has_function_privilege(argos, i.objoid, 'EXECUTE'))
                 OR (i.classoid = 'pg_class'::regclass AND i.objsubid = 0
                     AND NOT EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'SELECT')
                     AND (has_table_privilege(argos, i.objoid, 'SELECT')
                          OR EXISTS (SELECT 1 FROM pg_attribute at
                                      WHERE at.attrelid = i.objoid AND at.attnum > 0 AND NOT at.attisdropped
                                        AND has_column_privilege(argos, i.objoid, at.attnum, 'SELECT')
                                        AND NOT EXISTS (SELECT 1 FROM pg_init_privs ic, aclexplode(ic.initprivs) x
                                                         WHERE ic.classoid = i.classoid AND ic.objoid = i.objoid
                                                           AND ic.objsubid = at.attnum AND x.grantee = 0 AND x.privilege_type = 'SELECT'))))) THEN
    RAISE EXCEPTION 'argos_ro può usare oggetti di sistema riservati';
  END IF;

  -- 8. una lettura vera, come argos_ro: le tabelle del contratto sì, users no
  EXECUTE 'SET LOCAL ROLE argos_ro';
  FOREACH voce IN ARRAY contratto LOOP
    EXECUTE format('SELECT 1 FROM %s LIMIT 0', voce::regclass);
  END LOOP;
  BEGIN
    PERFORM 1 FROM public.users LIMIT 0;
    RAISE EXCEPTION 'argos_ro legge public.users';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE 'RESET ROLE';

  RAISE NOTICE 'argos_ro legge le % tabelle del contratto e nient''altro', cardinality(contratto);
END
$$;
