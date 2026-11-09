-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 · Il registro delle modifiche (PR 2.10)
-- ───────────────────────────────────────────────────────────────────────────
-- Chi ha cambiato cosa, e quando, sulle tabelle della prima ondata. Lo scrive
-- il database con trigger di istruzione: l'app non può dimenticarsene, e non
-- lo può leggere, cambiare, cancellare né spegnere.
--
-- Nasce SPENTO (registro.impostazioni.attivo = false): lo accende chi gestisce
-- il database quando Conerobus ha la base giuridica (art. 4 c.1 dello Statuto
-- dei lavoratori: accordo con le RSU o autorizzazione dell'Ispettorato,
-- informativa, valutazione d'impatto). DEPLOY.md, «Registro delle modifiche».
--
-- Le regole decise il 25/10:
--   - chi, quando, quale riga, quali campi;
--   - i valori prima e dopo solo per programmi, orari, turni e tariffe; mai per
--     anagrafica, roster e utenti (salvo ruolo e permessi degli utenti);
--   - dopo 12 mesi (mai meno di 6) si toglie chi l'ha fatto, resta la modifica.
--
-- Chi: cerbero.attore / cerbero.via / cerbero.richiesta, che il pool mette su
-- ogni connessione (PR 2.9, lib/db/src/contesto.ts), più session_user (che
-- l'app non può cambiare) e application_name.
--
-- Come: un'istruzione che tocca fino a 50 righe dà una riga per record, con i
-- soli campi cambiati. Oltre 50 righe, sotto una cascata delle chiavi esterne,
-- o col modo «riepilogo» (cerbero.registro, per le operazioni in blocco), un
-- solo riepilogo per transazione, tabella e operazione: quante righe, i campi,
-- un campione di 20 chiavi. Gli UPDATE che non cambiano niente di registrato
-- non scrivono.
--
-- Proprietario di tutto: cerbero_registro (NOLOGIN, non superutente). Le
-- funzioni girano come lui: l'app chiama solo manutenzione() e verifica().
-- Nessun default sulle partizioni (il controllo della 2.8 li guarda quando
-- manutenzione() le crea da una sessione dell'app).
--
-- Lock: CREATE TRIGGER prende SHARE ROW EXCLUSIVE sulle 21 tabelle, per poco:
-- le letture continuano, le scritture aspettano la fine della migrazione.
-- ═══════════════════════════════════════════════════════════════════════════
DO $ruolo$
BEGIN
  IF pg_catalog.to_regrole('cerbero_registro') IS NULL THEN
    CREATE ROLE cerbero_registro NOLOGIN;
  END IF;
END
$ruolo$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS registro AUTHORIZATION cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON SCHEMA registro FROM PUBLIC;
--> statement-breakpoint
-- una riga sola: si cambia solo da proprietario del database
CREATE TABLE IF NOT EXISTS registro.impostazioni (
  unica                boolean PRIMARY KEY DEFAULT true CHECK (unica),
  attivo               boolean NOT NULL DEFAULT false,
  base_giuridica       text NOT NULL DEFAULT '',
  anonimizza_dopo_mesi integer NOT NULL DEFAULT 12,
  conservazione_mesi   integer NOT NULL DEFAULT 60,
  attivato_il          timestamptz,
  CONSTRAINT impostazioni_mesi CHECK (anonimizza_dopo_mesi >= 6 AND conservazione_mesi >= anonimizza_dopo_mesi),
  CONSTRAINT impostazioni_base CHECK (NOT attivo OR base_giuridica <> '')
);
--> statement-breakpoint
ALTER TABLE registro.impostazioni OWNER TO cerbero_registro;
--> statement-breakpoint
INSERT INTO registro.impostazioni (unica) VALUES (true) ON CONFLICT (unica) DO NOTHING;
--> statement-breakpoint
-- le regole per tabella (le scrive registro.sorveglia)
CREATE TABLE IF NOT EXISTS registro.sorvegliate (
  tabella        text PRIMARY KEY,         -- schema.nome
  chiave         text[] NOT NULL,          -- colonne della chiave primaria
  ambito_tipo    text,                     -- progetto_ps, conducente, feed, …
  ambito_colonna text,                     -- la colonna che dà l'ambito della riga
  con_valori     boolean NOT NULL,         -- valori prima/dopo delle colonne semplici
  valori_di      text[] NOT NULL DEFAULT '{}',  -- colonne col valore anche se con_valori è falso (o jsonb)
  escluse        text[] NOT NULL DEFAULT '{}',  -- mai registrate (modelli LIKE)
  solo_nome      text[] NOT NULL DEFAULT '{}'   -- solo il nome, mai il valore (modelli LIKE)
);
--> statement-breakpoint
ALTER TABLE registro.sorvegliate OWNER TO cerbero_registro;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS registro.modifiche (
  ts          timestamptz NOT NULL,   -- inizio della transazione
  transazione xid8 NOT NULL,
  richiesta   text,                   -- cerbero.richiesta (id della richiesta o del lavoro)
  attore      text,                   -- cerbero.attore (id dell'utente); a NULL dopo anonimizza_dopo_mesi
  via         text,                   -- cerbero.via
  ruolo_db    text NOT NULL,          -- session_user: l'app non lo può cambiare
  origine     text,                   -- application_name
  tabella     text NOT NULL,
  operazione  text NOT NULL,          -- INSERT, UPDATE, DELETE, TRUNCATE
  chiave      jsonb,                  -- la chiave primaria della riga (non nei riepiloghi)
  ambito_tipo text,
  ambito_id   text,
  campi       text[],                 -- i campi cambiati (UPDATE)
  prima       jsonb,                  -- solo dove le regole ammettono i valori
  dopo        jsonb,
  riepilogo   boolean NOT NULL,
  righe       integer,
  campione    jsonb,                  -- al più 20 chiavi (riepiloghi)
  a_cascata   boolean NOT NULL
) PARTITION BY RANGE (ts);
--> statement-breakpoint
ALTER TABLE registro.modifiche OWNER TO cerbero_registro;
--> statement-breakpoint
-- riserva: una scrittura non fallisce mai per una partizione che manca (manutenzione() poi le sposta)
CREATE TABLE IF NOT EXISTS registro.modifiche_altro PARTITION OF registro.modifiche DEFAULT;
--> statement-breakpoint
ALTER TABLE registro.modifiche_altro OWNER TO cerbero_registro;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modifiche_ts ON registro.modifiche USING brin (ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modifiche_tabella ON registro.modifiche (tabella, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modifiche_ambito ON registro.modifiche (ambito_id, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modifiche_attore ON registro.modifiche (attore, ts);
--> statement-breakpoint
-- un riepilogo per transazione, tabella e operazione (ts = now() è costante nella transazione)
CREATE UNIQUE INDEX IF NOT EXISTS modifiche_riepiloghi ON registro.modifiche (ts, transazione, tabella, operazione, a_cascata) WHERE riepilogo;
--> statement-breakpoint
-- Aggiunge a un riepilogo (o lo crea). La chiama solo cattura().
CREATE OR REPLACE FUNCTION registro.riepiloga(p_tabella text, p_operazione text, p_cascata boolean, p_righe bigint,
                                              p_campione jsonb, p_campi text[], p_ambito_tipo text, p_ambito text, p_ctx text[])
  RETURNS void LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $riepiloga$
  INSERT INTO registro.modifiche AS m (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                       ambito_tipo, ambito_id, campi, riepilogo, righe, campione, a_cascata)
  VALUES (pg_catalog.now(), pg_catalog.pg_current_xact_id(), p_ctx[3], p_ctx[1], p_ctx[2], session_user, p_ctx[4],
          p_tabella, p_operazione, p_ambito_tipo, p_ambito, p_campi, true, p_righe::integer, p_campione, p_cascata)
  ON CONFLICT (ts, transazione, tabella, operazione, a_cascata) WHERE riepilogo DO UPDATE SET
    righe = m.righe + EXCLUDED.righe,
    campione = (SELECT pg_catalog.jsonb_agg(e.v ORDER BY e.i)
                  FROM (SELECT x.v, x.i
                          FROM pg_catalog.jsonb_array_elements(coalesce(m.campione, '[]') || coalesce(EXCLUDED.campione, '[]'))
                               WITH ORDINALITY AS x(v, i)
                         ORDER BY x.i LIMIT 20) e),
    campi = CASE WHEN m.campi IS NULL AND EXCLUDED.campi IS NULL THEN NULL
                 ELSE ARRAY(SELECT DISTINCT c FROM pg_catalog.unnest(coalesce(m.campi, '{}') || coalesce(EXCLUDED.campi, '{}')) AS c ORDER BY 1) END,
    ambito_id = CASE WHEN m.ambito_id IS NOT DISTINCT FROM EXCLUDED.ambito_id THEN m.ambito_id END
$riepiloga$;
--> statement-breakpoint
ALTER FUNCTION registro.riepiloga(text, text, boolean, bigint, jsonb, text[], text, text, text[]) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.riepiloga(text, text, boolean, bigint, jsonb, text[], text, text, text[]) FROM PUBLIC;
--> statement-breakpoint
-- Il trigger di tutte le tabelle sorvegliate (di istruzione, con le tabelle di
-- transizione nuove/vecchie). Nessun blocco EXCEPTION: un errore qui è un
-- errore del database, non dei dati. Senza regola per la tabella scrive solo
-- un riepilogo senza campi.
CREATE OR REPLACE FUNCTION registro.cattura() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $cattura$
DECLARE
  acceso      boolean;
  nome        text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  segno       text := ' ' || TG_RELID::text || ':' || TG_OP;
  segni       text := coalesce(current_setting('cerbero.registro_cascata', true), '');
  ctx         text[];
  modo        text;
  regola      registro.sorvegliate;
  cascata     boolean := false;
  n           bigint;
  registrate  text[];
  col_valore  text[];
  campione    jsonb;
  amb_min     text;
  amb_max     text;
  sorgente    text;
  a_sql       text;
  diff        text[];
  campi_agg   text[];
BEGIN
  SELECT i.attivo INTO acceso FROM registro.impostazioni i;
  IF NOT coalesce(acceso, false) THEN
    RETURN NULL;
  END IF;

  -- BEFORE: un'istruzione lanciata da una chiave esterna (profondità > 1) è una cascata
  IF TG_WHEN = 'BEFORE' THEN
    IF pg_trigger_depth() > 1 AND position(segno IN segni) = 0 THEN
      PERFORM set_config('cerbero.registro_cascata', segni || segno, true);
    END IF;
    RETURN NULL;
  END IF;
  IF position(segno IN segni) > 0 THEN
    cascata := true;
    PERFORM set_config('cerbero.registro_cascata', replace(segni, segno, ''), true);
  END IF;
  ctx := ARRAY[nullif(current_setting('cerbero.attore', true), ''), nullif(current_setting('cerbero.via', true), ''),
               nullif(current_setting('cerbero.richiesta', true), ''), current_setting('application_name', true)];
  modo := coalesce(current_setting('cerbero.registro', true), '');

  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione, riepilogo, righe, a_cascata)
    VALUES (now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'TRUNCATE', false, NULL, false);
    RETURN NULL;
  END IF;

  -- SQL statico dove si può (i piani restano in cache): una scrittura di una
  -- riga costa poco. Il dinamico solo per le istruzioni grandi.
  IF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO n FROM vecchie;
  ELSE
    SELECT count(*) INTO n FROM nuove;
  END IF;
  IF n = 0 THEN
    RETURN NULL;
  END IF;

  SELECT s.* INTO regola FROM registro.sorvegliate s WHERE s.tabella = nome;
  IF NOT FOUND THEN
    PERFORM registro.riepiloga(nome, TG_OP, cascata, n, NULL, NULL, NULL, NULL, ctx);
    RETURN NULL;
  END IF;
  -- una colonna della chiave o dell'ambito che non c'è più (rinominata in una
  -- migrazione senza aggiornare la regola) si ignora: la scrittura non deve
  -- fallire per il registro. La segnala registro.verifica().
  regola.chiave := ARRAY(SELECT c FROM unnest(regola.chiave) AS c
                          WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = TG_RELID AND a.attname::text = c
                                                                      AND a.attnum > 0 AND NOT a.attisdropped));
  IF regola.ambito_colonna IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a WHERE a.attrelid = TG_RELID AND a.attname::text = regola.ambito_colonna
                                      AND a.attnum > 0 AND NOT a.attisdropped) THEN
    regola.ambito_colonna := NULL;
  END IF;

  -- le colonne: registrate (non escluse) e, fra queste, quelle col valore
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE NOT a.esclusa), '{}'),
         coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE NOT a.esclusa AND a.valore), '{}')
    INTO registrate, col_valore
    FROM (SELECT a.attname, a.attnum,
                 EXISTS (SELECT 1 FROM unnest(regola.escluse) AS e(p) WHERE a.attname::text LIKE e.p) AS esclusa,
                 a.attname::text = ANY (regola.valori_di)
                 OR (regola.con_valori
                     AND t.typcategory NOT IN ('A', 'U') AND t.typname NOT IN ('json', 'jsonb', 'bytea', 'xml')
                     AND NOT EXISTS (SELECT 1 FROM unnest(regola.solo_nome) AS s(p) WHERE a.attname::text LIKE s.p)) AS valore
            FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
           WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped) a;

  -- ── fino a 50 righe, senza cascata né modo riepilogo: una riga per record ──
  IF n <= 50 AND NOT cascata AND modo <> 'riepilogo' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'INSERT',
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
             r.v ->> regola.ambito_colonna, NULL, NULL,
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_valore) AS c), false, 1, false
        FROM (SELECT to_jsonb(x) AS v FROM nuove x OFFSET 0) r;  -- OFFSET 0: to_jsonb una volta per riga
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'DELETE',
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
             r.v ->> regola.ambito_colonna, NULL,
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_valore) AS c), NULL, false, 1, false
        FROM (SELECT to_jsonb(x) AS v FROM vecchie x OFFSET 0) r;
    ELSE
      -- vecchie e nuove per chiave (FULL JOIN: una chiave cambiata non si perde); solo le righe con un campo registrato cambiato
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'UPDATE',
             z.k, regola.ambito_tipo, coalesce(z.vn, z.vo) ->> regola.ambito_colonna, z.campi,
             (SELECT jsonb_object_agg(c, z.vo -> c) FROM unnest(z.campi) AS c WHERE c = ANY (col_valore)),
             (SELECT jsonb_object_agg(c, z.vn -> c) FROM unnest(z.campi) AS c WHERE c = ANY (col_valore)),
             false, 1, false
        FROM (SELECT coalesce(b.k, a.k) AS k, a.v AS vo, b.v AS vn,
                     ARRAY(SELECT c FROM unnest(registrate) AS c WHERE (a.v -> c) IS DISTINCT FROM (b.v -> c)) AS campi
                FROM (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                        FROM (SELECT to_jsonb(o) AS v FROM vecchie o OFFSET 0) w OFFSET 0) a
                FULL JOIN (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                             FROM (SELECT to_jsonb(x) AS v FROM nuove x OFFSET 0) w OFFSET 0) b ON a.k = b.k
              OFFSET 0) z  -- OFFSET 0: ogni riga si converte e si confronta una volta sola
       WHERE cardinality(z.campi) > 0;
    END IF;
    RETURN NULL;
  END IF;

  -- ── istruzioni grandi, cascate, modo riepilogo: un riepilogo per transazione e tabella ──
  -- il campione: le prime 20 righe toccate
  IF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(k) INTO campione
      FROM (SELECT (SELECT jsonb_object_agg(c, to_jsonb(x) -> c) FROM unnest(regola.chiave) AS c) AS k FROM vecchie x LIMIT 20) y;
  ELSE
    SELECT jsonb_agg(k) INTO campione
      FROM (SELECT (SELECT jsonb_object_agg(c, to_jsonb(x) -> c) FROM unnest(regola.chiave) AS c) AS k FROM nuove x LIMIT 20) y;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF regola.ambito_colonna IS NOT NULL THEN
      EXECUTE format('SELECT min(x.%1$I::text), max(x.%1$I::text) FROM %2$I x', regola.ambito_colonna,
                     CASE TG_OP WHEN 'DELETE' THEN 'vecchie' ELSE 'nuove' END) INTO amb_min, amb_max;
    END IF;
    PERFORM registro.riepiloga(nome, TG_OP, cascata, n, campione, NULL, regola.ambito_tipo,
                               CASE WHEN amb_min = amb_max THEN amb_min END, ctx);
    RETURN NULL;
  END IF;

  -- UPDATE grande: un passaggio tipizzato su vecchie e nuove. Quante righe
  -- cambiano davvero, quali campi, se hanno tutte lo stesso ambito; ogni
  -- confronto si calcola una volta per riga (d1…dN, OFFSET 0 non lascia appiattire)
  IF cardinality(registrate) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(
           CASE WHEN t.typname IN ('json', 'xml') OR t.typcategory IN ('G', 'U')
                THEN format('o.%1$I::text IS DISTINCT FROM n.%1$I::text', a.attname)
                ELSE format('o.%1$I IS DISTINCT FROM n.%1$I', a.attname) END ORDER BY a.attnum)
    INTO diff
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attname::text = ANY (registrate);
  sorgente := 'vecchie o FULL JOIN nuove n ON ' || coalesce(
                (SELECT string_agg(format('o.%1$I = n.%1$I', k), ' AND ') FROM unnest(regola.chiave) AS k), 'false');
  a_sql := CASE WHEN regola.ambito_colonna IS NULL THEN 'NULL::text'
                ELSE format('coalesce(n.%1$I, o.%1$I)::text', regola.ambito_colonna) END;
  EXECUTE format(
    'SELECT count(*) FILTER (WHERE %1$s), %2$s, min(z.a) FILTER (WHERE %1$s), max(z.a) FILTER (WHERE %1$s)
       FROM (SELECT %3$s, %4$s AS a FROM %5$s OFFSET 0) z',
    '(' || array_to_string(ARRAY(SELECT format('z.d%s', i) FROM generate_series(1, cardinality(diff)) AS i), ' OR ') || ')',
    'array_remove(ARRAY[' || array_to_string(ARRAY(
       SELECT format('CASE WHEN bool_or(z.d%s) THEN %L END', i, registrate[i]) FROM generate_series(1, cardinality(diff)) AS i), ', ')
       || ']::text[], NULL)',
    array_to_string(ARRAY(SELECT format('%s AS d%s', diff[i], i) FROM generate_series(1, cardinality(diff)) AS i), ', '),
    a_sql, sorgente) INTO n, campi_agg, amb_min, amb_max;
  IF n = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM registro.riepiloga(nome, 'UPDATE', cascata, n, campione, campi_agg, regola.ambito_tipo,
                             CASE WHEN amb_min = amb_max THEN amb_min END, ctx);
  RETURN NULL;
END
$cattura$;
--> statement-breakpoint
ALTER FUNCTION registro.cattura() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.cattura() FROM PUBLIC;
--> statement-breakpoint
-- Solo per le migrazioni (le esegue chi migra): la regola della tabella e i
-- suoi sei trigger, accesi sempre (anche con session_replication_role).
CREATE OR REPLACE FUNCTION registro.sorveglia(p_tabella regclass, p_chiave text[], p_ambito_tipo text, p_ambito_colonna text,
                                              p_con_valori boolean, p_valori_di text[] DEFAULT '{}',
                                              p_escluse text[] DEFAULT '{}', p_solo_nome text[] DEFAULT '{}')
  RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $sorveglia$
DECLARE
  nome  text;
  t     record;
  c     text;
BEGIN
  SELECT n.nspname || '.' || r.relname INTO nome
    FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace WHERE r.oid = p_tabella;
  FOREACH c IN ARRAY p_chiave || coalesce(p_ambito_colonna, p_chiave[1]) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tabella AND attname = c AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'registro.sorveglia: % non ha la colonna %', nome, c;
    END IF;
  END LOOP;
  INSERT INTO registro.sorvegliate (tabella, chiave, ambito_tipo, ambito_colonna, con_valori, valori_di, escluse, solo_nome)
  VALUES (nome, p_chiave, p_ambito_tipo, p_ambito_colonna, p_con_valori, p_valori_di,
          -- escluse sempre: date di servizio, cache, segni di ricalcolo
          p_escluse || ARRAY['updated_at', 'last_opened_at', 'stale_since', '%\_cached'], p_solo_nome)
  ON CONFLICT (tabella) DO UPDATE SET chiave = EXCLUDED.chiave, ambito_tipo = EXCLUDED.ambito_tipo,
    ambito_colonna = EXCLUDED.ambito_colonna, con_valori = EXCLUDED.con_valori, valori_di = EXCLUDED.valori_di,
    escluse = EXCLUDED.escluse, solo_nome = EXCLUDED.solo_nome;
  FOR t IN SELECT * FROM (VALUES
      ('registro_inserisce',      'AFTER INSERT',  'REFERENCING NEW TABLE AS nuove'),
      ('registro_cambia',         'AFTER UPDATE',  'REFERENCING OLD TABLE AS vecchie NEW TABLE AS nuove'),
      ('registro_cancella',       'AFTER DELETE',  'REFERENCING OLD TABLE AS vecchie'),
      ('registro_svuota',         'AFTER TRUNCATE', ''),
      ('registro_prima_cambia',   'BEFORE UPDATE', ''),
      ('registro_prima_cancella', 'BEFORE DELETE', '')) AS v(nome, quando, transizione)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = p_tabella AND tgname = t.nome) THEN
      EXECUTE format('CREATE TRIGGER %I %s ON %s %s FOR EACH STATEMENT EXECUTE FUNCTION registro.cattura()',
                     t.nome, t.quando, p_tabella, t.transizione);
    END IF;
    EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', p_tabella, t.nome);
  END LOOP;
END
$sorveglia$;
--> statement-breakpoint
ALTER FUNCTION registro.sorveglia(regclass, text[], text, text, boolean, text[], text[], text[]) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.sorveglia(regclass, text[], text, text, boolean, text[], text[], text[]) FROM PUBLIC;
--> statement-breakpoint
-- Ogni giorno dal lavoratore (e alla fine di questa migrazione): le
-- partizioni del mese e dei due successivi, le righe rimaste nella riserva,
-- l'anonimizzazione, la conservazione. Senza parametri: chi la chiama non
-- sceglie cosa togliere. Dalla sessione dell'app crea con LIKE + ATTACH (il
-- controllo della 2.8 lo permette) e svuota con TRUNCATE (il DROP no).
CREATE OR REPLACE FUNCTION registro.manutenzione() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $manutenzione$
DECLARE
  imp          record;
  mese         date := date_trunc('month', now())::date;
  inizio       date;
  fine         date;
  nome         text;
  create_      text[] := '{}';
  svuotate     text[] := '{}';
  spostate     bigint := 0;
  anonimizzate bigint := 0;
  cancellate   bigint := 0;
  k            bigint;
  piena        boolean;
  p            record;
  limite       timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('cerbero:registro', 0)) THEN
    RETURN jsonb_build_object('saltata', true);
  END IF;
  SELECT * INTO imp FROM registro.impostazioni;
  FOR i IN 0..2 LOOP
    inizio := (mese + make_interval(months => i))::date;
    fine := (inizio + interval '1 month')::date;
    nome := 'modifiche_' || to_char(inizio, 'YYYY_MM');
    IF to_regclass('registro.' || nome) IS NULL THEN
      EXECUTE format('CREATE TABLE registro.%I (LIKE registro.modifiche)', nome);
      EXECUTE format('WITH m AS (DELETE FROM registro.modifiche_altro WHERE ts >= %L AND ts < %L RETURNING *)
                      INSERT INTO registro.%I SELECT * FROM m', inizio, fine, nome);
      GET DIAGNOSTICS k = ROW_COUNT;
      spostate := spostate + k;
      EXECUTE format('ALTER TABLE registro.modifiche ATTACH PARTITION registro.%I FOR VALUES FROM (%L) TO (%L)', nome, inizio, fine);
      create_ := create_ || nome;
    END IF;
  END LOOP;

  limite := date_trunc('day', now()) - make_interval(months => imp.anonimizza_dopo_mesi);
  UPDATE registro.modifiche SET attore = NULL, richiesta = NULL
   WHERE ts < limite AND (attore IS NOT NULL OR richiesta IS NOT NULL);
  GET DIAGNOSTICS anonimizzate = ROW_COUNT;

  limite := date_trunc('month', now()) - make_interval(months => imp.conservazione_mesi);
  FOR p IN SELECT c.relname
             FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'registro.modifiche'::regclass AND c.relname ~ '^modifiche_[0-9]{4}_[0-9]{2}$'
            ORDER BY 1 LOOP
    IF to_date(substr(p.relname, 11), 'YYYY_MM') + interval '1 month' <= limite THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM registro.%I)', p.relname) INTO piena;
      IF piena THEN
        EXECUTE format('TRUNCATE registro.%I', p.relname);
        svuotate := svuotate || p.relname::text;
      END IF;
    END IF;
  END LOOP;
  DELETE FROM registro.modifiche WHERE ts < limite;
  GET DIAGNOSTICS cancellate = ROW_COUNT;

  RETURN jsonb_build_object('partizioni', create_, 'spostate', spostate, 'anonimizzate', anonimizzate,
                            'svuotate', svuotate, 'cancellate', cancellate);
END
$manutenzione$;
--> statement-breakpoint
ALTER FUNCTION registro.manutenzione() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.manutenzione() FROM PUBLIC;
--> statement-breakpoint
-- Cosa non va nel registro (vuoto se tutto è a posto). La leggono ruoli.mjs
-- --verifica (errori) e il lavoratore (avvisi).
CREATE OR REPLACE FUNCTION registro.verifica() RETURNS SETOF text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $verifica$
DECLARE
  s     record;
  t     record;
  nomi  text[] := ARRAY['registro_inserisce', 'registro_cambia', 'registro_cancella', 'registro_svuota',
                        'registro_prima_cambia', 'registro_prima_cancella'];
  n     text;
BEGIN
  -- dal catalogo, non per nome: cerbero_registro non ha USAGE su public (in
  -- produzione PUBLIC non ce l'ha), e to_regclass('public.…') fallirebbe
  FOR s IN SELECT r.tabella, c.oid AS relid
             FROM registro.sorvegliate r
             LEFT JOIN (pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace)
                    ON ns.nspname || '.' || c.relname = r.tabella AND c.relkind IN ('r', 'p')
            ORDER BY 1 LOOP
    IF s.relid IS NULL THEN
      RETURN NEXT format('%s è sorvegliata ma non esiste', s.tabella);
      CONTINUE;
    END IF;
    -- le colonne nominate dalla regola ci sono ancora
    FOR t IN SELECT DISTINCT c FROM registro.sorvegliate r,
                    unnest(r.chiave || r.valori_di || coalesce(r.ambito_colonna, r.chiave[1])) AS c
              WHERE r.tabella = s.tabella
                AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = s.relid AND a.attname::text = c
                                                               AND a.attnum > 0 AND NOT a.attisdropped)
              ORDER BY 1 LOOP
      RETURN NEXT format('%s: la regola del registro nomina la colonna %s, che non c''è: va aggiornata con registro.sorveglia in una migrazione',
                         s.tabella, t.c);
    END LOOP;
    FOREACH n IN ARRAY nomi LOOP
      SELECT tg.tgenabled AS acceso, tg.tgfoid = 'registro.cattura()'::regprocedure AS sua INTO t
        FROM pg_trigger tg WHERE tg.tgrelid = s.relid AND tg.tgname = n;
      IF NOT FOUND THEN
        RETURN NEXT format('%s: manca il trigger %s del registro', s.tabella, n);
      ELSIF NOT t.sua THEN
        RETURN NEXT format('%s: il trigger %s non è quello del registro', s.tabella, n);
      ELSIF t.acceso <> 'A' THEN
        RETURN NEXT format('%s: il trigger %s del registro non è acceso sempre (%s): ALTER TABLE %s ENABLE ALWAYS TRIGGER %s',
                           s.tabella, n, t.acceso, s.tabella, n);
      END IF;
    END LOOP;
  END LOOP;
  IF to_regclass(format('registro.modifiche_%s', to_char(now(), 'YYYY_MM'))) IS NULL THEN
    RETURN NEXT 'manca la partizione di questo mese del registro: SELECT registro.manutenzione()';
  END IF;
  IF EXISTS (SELECT 1 FROM registro.modifiche_altro) THEN
    RETURN NEXT 'ci sono righe nella partizione di riserva del registro: SELECT registro.manutenzione() le sposta';
  END IF;
  FOR t IN SELECT format('%s %s', CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, c.oid::regclass) AS oggetto,
                  pg_get_userbyid(c.relowner) AS chi
             FROM pg_class c
            WHERE c.relnamespace = 'registro'::regnamespace AND c.relkind IN ('r', 'p', 'S')
              AND pg_get_userbyid(c.relowner) <> 'cerbero_registro'
           UNION ALL
           SELECT format('FUNCTION %s', p.oid::regprocedure), pg_get_userbyid(p.proowner)
             FROM pg_proc p
            WHERE p.pronamespace = 'registro'::regnamespace AND pg_get_userbyid(p.proowner) <> 'cerbero_registro'
           UNION ALL
           SELECT 'SCHEMA registro', pg_get_userbyid(nspowner) FROM pg_namespace
            WHERE nspname = 'registro' AND pg_get_userbyid(nspowner) <> 'cerbero_registro' LOOP
    RETURN NEXT format('%s è di %s, non di cerbero_registro: ALTER %s OWNER TO cerbero_registro', t.oggetto, t.chi, t.oggetto);
  END LOOP;
END
$verifica$;
--> statement-breakpoint
ALTER FUNCTION registro.verifica() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.verifica() FROM PUBLIC;
--> statement-breakpoint
-- ── La prima ondata ──────────────────────────────────────────────────────
-- Utenti: solo i nomi dei campi, salvo ruolo e permessi; mai la verifica in
-- due passaggi, l'ultimo accesso e i contatori della sessione (un login non
-- scrive niente). password_hash: solo il nome.
SELECT registro.sorveglia('public.users', ARRAY['id'], 'utente', 'id', false, ARRAY['role', 'permissions'],
  ARRAY['mfa\_%', 'last_login_at', 'sessione_versione', 'dispositivi_versione', 'password_controllata']);
--> statement-breakpoint
SELECT registro.sorveglia('public.app_settings', ARRAY['key'], NULL, NULL, true, ARRAY['value']);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_feeds', ARRAY['id'], 'feed', 'id', true, '{}', ARRAY['%\_count']);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_projects', ARRAY['id'], 'progetto_ps', 'id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_project_members', ARRAY['project_id', 'user_id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_routes', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_route_variants', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_stops', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_trips', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_calendars', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_validity_units', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.scheduling_projects', ARRAY['id'], 'progetto_turni', 'id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.service_program_scenarios', ARRAY['id'], 'progetto_turni', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.driver_shift_scenarios', ARRAY['id'], 'scenario', 'service_program_scenario_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.depots', ARRAY['id'], 'progetto_ps', 'ps_project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.gtfs_fare_products', ARRAY['id'], 'feed', 'feed_id', true);
--> statement-breakpoint
-- Roster e anagrafica: solo i nomi dei campi (i codici sanitari stanno in
-- roster_entries.code: mai un valore, e la chiave è l'id).
SELECT registro.sorveglia('public.roster_drivers', ARRAY['id'], 'conducente', 'id', false, '{}', ARRAY['versione']);
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_driver_history', ARRAY['id'], 'conducente', 'driver_id', false);
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_assignments', ARRAY['id'], 'conducente', 'driver_id', false);
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_entries', ARRAY['id'], 'conducente', 'driver_id', false);
--> statement-breakpoint
SELECT registro.sorveglia('public.roster_pubblicazioni', ARRAY['id'], 'progetto_ps', 'ps_project_id', false);
--> statement-breakpoint
-- L'app: chiama manutenzione() e verifica(), legge le regole (il suo event
-- trigger le usa); nient'altro. Li ridà anche il riallineamento dei ruoli a
-- ogni avvio (su un server nuovo cerbero_owner nasce dopo le migrazioni).
DO $diritti$
BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA registro TO cerbero_owner;
    GRANT SELECT ON TABLE registro.sorvegliate TO cerbero_owner;
    GRANT EXECUTE ON FUNCTION registro.manutenzione() TO cerbero_owner;
    GRANT EXECUTE ON FUNCTION registro.verifica() TO cerbero_owner;
  END IF;
END
$diritti$;
--> statement-breakpoint
SELECT registro.manutenzione();
