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

  -- 6. fuori dagli schemi di Cerbero (e negli oggetti aggiunti a quelli di
  --    sistema dopo l'installazione): niente letture fuori dalle estensioni,
  --    niente scrittura, niente sequenze. Anche senza USAGE sullo schema:
  --    pg_stats mostra i valori, le sequenze si usano per OID, MAINTAIN vale
  --    per VACUUM e ANALYZE senza elenco, BEGIN ATOMIC non passa dal nome
  FOR r IN SELECT c.oid::regclass AS t, c.relkind,
                  EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS ext
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('public', 'caronte') AND n.nspname !~ '^pg_(toast_)?temp_'
              AND ((n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR c.oid >= 16384)
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
  LOOP
    IF r.relkind = 'S' THEN
      IF NOT r.ext AND has_sequence_privilege(argos, r.t, 'USAGE, SELECT, UPDATE') THEN
        RAISE EXCEPTION 'argos_ro usa la sequenza %', r.t;
      END IF;
    ELSIF has_table_privilege(argos, r.t, scrittura) OR has_any_column_privilege(argos, r.t, 'INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'argos_ro può scrivere su %', r.t;
    ELSIF NOT r.ext AND has_any_column_privilege(argos, r.t, 'SELECT') THEN
      RAISE EXCEPTION 'argos_ro legge % fuori dagli schemi di Cerbero', r.t;
    END IF;
  END LOOP;
  -- sui cataloghi di sistema dell'installazione: niente scrittura né MAINTAIN
  -- oltre a quello che PUBLIC poteva già (per esempio UPDATE su pg_settings)
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               CROSS JOIN unnest(string_to_array(scrittura, ', ')) p(priv)
              WHERE n.nspname IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.oid < 16384
                AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
                AND (has_table_privilege(argos, c.oid, p.priv)
                     OR (p.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(argos, c.oid, p.priv)))
                AND NOT EXISTS (SELECT 1 FROM pg_init_privs i, aclexplode(i.initprivs) a
                                 WHERE i.classoid = 'pg_class'::regclass AND i.objoid = c.oid AND i.objsubid = 0
                                   AND a.grantee = 0 AND a.privilege_type = p.priv)) THEN
    RAISE EXCEPTION 'argos_ro può scrivere o fare MAINTAIN su un catalogo di sistema';
  END IF;
  -- large object: dati applicativi, leggibili e scrivibili con lo_get/lo_put
  --    (lo_compat_privileges come lo vede argos_ro: database+ruolo, ruolo,
  --    database, tutti, poi il valore del server)
  IF coalesce((SELECT lower(split_part(c, '=', 2)) NOT IN ('off', 'of', 'false', 'fals', 'fal', 'fa', 'f', 'no', 'n', '0')
                 FROM pg_db_role_setting s, unnest(s.setconfig) c
                WHERE s.setrole IN (argos, 0)
                  AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
                  AND lower(split_part(c, '=', 1)) = 'lo_compat_privileges'
                ORDER BY (s.setrole = argos) DESC, (s.setdatabase <> 0) DESC LIMIT 1),
              current_setting('lo_compat_privileges')::boolean)
     OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l, aclexplode(l.lomacl) a WHERE a.grantee IN (argos, 0) OR l.lomowner = argos) THEN
    RAISE EXCEPTION 'argos_ro può leggere o scrivere large object';
  END IF;
  -- nessun CREATE in nessuno schema, quelli di sistema compresi (un CREATE su
  -- pg_catalog permette di dirottare le query di tutti)
  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_(toast_)?temp_'
                AND has_schema_privilege(argos, n.oid, 'CREATE')) THEN
    RAISE EXCEPTION 'argos_ro può creare oggetti in uno schema';
  END IF;
  -- nessun server esterno usabile e nessuna user mapping (si leggerebbe e
  -- scriverebbe come un altro utente)
  IF EXISTS (SELECT 1 FROM pg_foreign_server s WHERE has_server_privilege(argos, s.oid, 'USAGE'))
     OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper w WHERE has_foreign_data_wrapper_privilege(argos, w.oid, 'USAGE'))
     OR EXISTS (SELECT 1 FROM pg_user_mappings WHERE umuser = argos) THEN
    RAISE EXCEPTION 'argos_ro può usare un server esterno o ha una user mapping';
  END IF;
  -- il contratto salvato: argos_ro, o chiunque, non lo può toccare; scritto_da
  -- non si può falsificare (vincolo); nessun trigger estraneo
  IF to_regclass('cerbero_migrazioni.contratti') IS NOT NULL THEN
    IF has_table_privilege(argos, 'cerbero_migrazioni.contratti', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
       OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                   WHERE c.oid = 'cerbero_migrazioni.contratti'::regclass AND a.grantee = 0
                     AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')) THEN
      RAISE EXCEPTION 'argos_ro, o chiunque, può modificare cerbero_migrazioni.contratti';
    END IF;
    -- il vincolo può essere NOT VALID (pg_dump lo ricrea dopo i dati): vale comunque
    -- su ogni scrittura. L'unico trigger ammesso è il suo, con la sua funzione
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cerbero_migrazioni.contratti'::regclass
                      AND contype = 'c'
                      AND pg_get_constraintdef(oid) IN ('CHECK ((scritto_da = SESSION_USER))',
                                                        'CHECK ((scritto_da = SESSION_USER)) NOT VALID'))
       OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid LEFT JOIN pg_proc f ON f.oid = t.tgfoid
                   WHERE t.tgrelid = 'cerbero_migrazioni.contratti'::regclass AND NOT t.tgisinternal
                     AND NOT (t.tgname = 'contratti_chi_scrive' AND f.proname = 'contratti_chi_scrive'
                              AND f.pronamespace = c.relnamespace AND f.pronargs = 0
                              AND (f.proowner = c.relowner
                                   OR (SELECT rolsuper FROM pg_roles WHERE oid = f.proowner)))) THEN
      RAISE EXCEPTION 'cerbero_migrazioni.contratti: manca il vincolo su scritto_da, ha un trigger estraneo o la funzione del trigger è di un altro ruolo';
    END IF;
  END IF;

  -- 7. funzioni: nessuna SECURITY DEFINER che argos_ro possa far girare:
  --    - con l'EXECUTE, sempre (anche senza USAGE sullo schema: operatori,
  --      cast, viste, indici e policy la raggiungono senza nominarla), tranne
  --      le funzioni di event trigger, che si chiamano solo come trigger;
  --    - senza EXECUTE, se la usa un aggregato, un event trigger acceso o un
  --      oggetto che la chiama senza controllare l'EXECUTE: qualunque
  --      operatore o cast, classi di operatori, stime di selettività, supporto
  --      del planner, I/O dei tipi, range, conversioni, ricerca testuale,
  --      linguaggi, wrapper, metodi d'accesso, trasformazioni.
  --    Nessun oggetto di sistema riservato all'installazione (pg_init_privs
  --    senza PUBLIC) usabile
  IF EXISTS (WITH sd AS MATERIALIZED (
               SELECT p.oid, p.prorettype FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.prosecdef AND n.nspname !~ '^pg_(toast_)?temp_'
                  AND ((n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR p.oid >= 16384)
                  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
             ), senza_controllo AS MATERIALIZED (
               SELECT f FROM (
                 SELECT amproc::oid AS f FROM pg_amproc
                 UNION ALL SELECT oprcode::oid FROM pg_operator
                 UNION ALL SELECT oprrest::oid FROM pg_operator
                 UNION ALL SELECT oprjoin::oid FROM pg_operator
                 UNION ALL SELECT castfunc FROM pg_cast
                 UNION ALL SELECT prosupport::oid FROM pg_proc
                 UNION ALL SELECT x::oid FROM pg_type, LATERAL (VALUES (typinput), (typoutput), (typreceive), (typsend),
                                                                      (typmodin), (typmodout), (typanalyze), (typsubscript)) v(x)
                 UNION ALL SELECT x::oid FROM pg_range, LATERAL (VALUES (rngcanonical), (rngsubdiff)) v(x)
                 UNION ALL SELECT conproc::oid FROM pg_conversion
                 UNION ALL SELECT x::oid FROM pg_ts_parser, LATERAL (VALUES (prsstart), (prstoken), (prsend), (prsheadline), (prslextype)) v(x)
                 UNION ALL SELECT x::oid FROM pg_ts_template, LATERAL (VALUES (tmplinit), (tmpllexize)) v(x)
                 UNION ALL SELECT x FROM pg_language, LATERAL (VALUES (lanplcallfoid), (laninline), (lanvalidator)) v(x)
                 UNION ALL SELECT x FROM pg_foreign_data_wrapper, LATERAL (VALUES (fdwhandler), (fdwvalidator)) v(x)
                 UNION ALL SELECT amhandler::oid FROM pg_am
                 UNION ALL SELECT x::oid FROM pg_transform, LATERAL (VALUES (trffromsql), (trftosql)) v(x)
               ) u WHERE f IN (SELECT oid FROM sd)
             )
             SELECT 1 FROM sd
              WHERE (has_function_privilege(argos, sd.oid, 'EXECUTE') AND sd.prorettype <> 'event_trigger'::regtype)
                 OR sd.oid IN (SELECT f FROM senza_controllo)
                 OR EXISTS (SELECT 1 FROM pg_aggregate g
                             WHERE sd.oid IN (g.aggtransfn, g.aggfinalfn, g.aggcombinefn, g.aggserialfn, g.aggdeserialfn,
                                              g.aggmtransfn, g.aggminvtransfn, g.aggmfinalfn)
                               AND has_function_privilege(argos, g.aggfnoid, 'EXECUTE'))
                 OR EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtfoid = sd.oid AND e.evtenabled <> 'D')) THEN
    RAISE EXCEPTION 'argos_ro può far girare funzioni SECURITY DEFINER';
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
