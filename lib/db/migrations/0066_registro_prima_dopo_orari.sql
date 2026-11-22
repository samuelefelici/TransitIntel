-- ══════════════════════════════════════════════════════════════════════
-- 0066 — Il registro tiene il prima e il dopo degli orari di dettaglio (tappa 7.20)
-- ──────────────────────────────────────────────────────────────────────
-- Gli orari alle fermate (ps_stop_times), le fermate delle varianti
-- (ps_variant_stops) e le date dei calendari (ps_calendar_dates) l'app li
-- salva cancellando tutto e reinserendo: dalla 0007 il registro ne teneva solo
-- un riepilogo (chi, quando, quante righe), senza dire che cosa era cambiato.
-- Ora, per le tabelle con la regola «confronto»:
--   - cattura() mette da parte le righe di prima e di dopo, per chiave, in
--     registro.confronti (tabella di passaggio, svuotata al COMMIT);
--   - al COMMIT un trigger differito chiama registro.confronta(), che per ogni
--     chiave confronta la riga com'era all'inizio della transazione con
--     com'è alla fine e scrive una riga per chiave cambiata davvero: fermata
--     aggiunta, tolta, o con i campi cambiati, col prima e il dopo. Le righe
--     cancellate e reinserite uguali non lasciano niente.
--   - Solo dove c'erano righe prima e ce ne sono dopo (gli orari di una corsa
--     cambiati): una corsa nuova o svuotata resta col solo riepilogo. Non per
--     le cascate (cancellare una corsa non elenca le sue fermate) e non oltre
--     2000 righe per tabella in una transazione: un import o una copia restano
--     col solo riepilogo, come prima.
-- Il riepilogo resta: dice quante righe sono state riscritte.
-- Gli orari sono dati del programma: coi valori (decisione del 25/10).
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE registro.sorvegliate ADD COLUMN IF NOT EXISTS confronto boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNLOGGED TABLE IF NOT EXISTS registro.confronti (
  n           bigint GENERATED ALWAYS AS IDENTITY,
  ts          timestamptz NOT NULL,
  transazione xid8 NOT NULL,
  primo       boolean NOT NULL,      -- il primo della transazione: fa partire il confronto al COMMIT
  richiesta   text,
  attore      text,
  via         text,
  ruolo_db    text,
  origine     text,
  tabella     text NOT NULL,
  chiave      jsonb,
  ambito_tipo text,
  ambito_id   text,
  lato        text NOT NULL CHECK (lato IN ('o', 'n', 'x')),  -- prima, dopo, troppe righe
  valori      jsonb
);
--> statement-breakpoint
ALTER TABLE registro.confronti OWNER TO cerbero_registro;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS confronti_transazione ON registro.confronti (transazione, tabella);
--> statement-breakpoint
-- Il confronto di una transazione: per chiave, la prima riga vista (se è «di
-- prima», la riga esisteva all'inizio) e l'ultima (se è «di dopo», la riga
-- esiste alla fine). Una riga di registro per chiave cambiata; le tabelle con
-- troppe righe nella transazione si saltano.
CREATE OR REPLACE FUNCTION registro.confronta(p_transazione xid8) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $confronta$
DECLARE
  quanti integer;
BEGIN
  WITH mie AS MATERIALIZED (
    SELECT * FROM registro.confronti q WHERE q.transazione = p_transazione
  ), eventi AS (
    SELECT * FROM mie e
     WHERE e.lato IN ('o', 'n')
       AND NOT EXISTS (SELECT 1 FROM mie x WHERE x.lato = 'x' AND x.tabella = e.tabella)
  ), primi AS (
    SELECT DISTINCT ON (e.tabella, e.chiave) e.tabella, e.chiave, e.lato, e.valori, e.ambito_id
      FROM eventi e ORDER BY e.tabella, e.chiave, e.n
  ), ultimi AS (
    SELECT DISTINCT ON (e.tabella, e.chiave) e.*
      FROM eventi e ORDER BY e.tabella, e.chiave, e.n DESC
  ), coppie AS (
    SELECT u.ts, u.richiesta, u.attore, u.via, u.ruolo_db, u.origine, u.tabella, u.chiave, u.ambito_tipo,
           coalesce(u.ambito_id, p.ambito_id) AS ambito_id,
           p.lato = 'o' AS c_era, u.lato = 'n' AS c_e,
           CASE WHEN p.lato = 'o' THEN p.valori END AS vo,
           CASE WHEN u.lato = 'n' THEN u.valori END AS vn
      FROM ultimi u JOIN primi p ON p.tabella = u.tabella AND p.chiave = u.chiave
  ), gruppi AS (
    -- solo dove c'erano righe prima e ce ne sono dopo (gli orari di una corsa
    -- cambiati): una corsa nuova, o svuotata, resta col solo riepilogo
    SELECT c.tabella, c.ambito_id FROM coppie c
     GROUP BY c.tabella, c.ambito_id
    HAVING bool_or(c.c_era) AND bool_or(c.c_e)
  ), cambi AS (
    SELECT c.*,
           ARRAY(SELECT k FROM jsonb_object_keys(coalesce(c.vo, '{}') || coalesce(c.vn, '{}')) AS k
                  WHERE (c.vo -> k) IS DISTINCT FROM (c.vn -> k) ORDER BY k) AS campi
      FROM coppie c
     WHERE (c.c_era OR c.c_e)
       AND EXISTS (SELECT 1 FROM gruppi g WHERE g.tabella = c.tabella AND g.ambito_id IS NOT DISTINCT FROM c.ambito_id)
  )
  INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                  chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
  SELECT c.ts, p_transazione, c.richiesta, c.attore, c.via, c.ruolo_db, c.origine, c.tabella,
         CASE WHEN NOT c.c_era THEN 'INSERT' WHEN NOT c.c_e THEN 'DELETE' ELSE 'UPDATE' END,
         c.chiave, c.ambito_tipo, c.ambito_id,
         CASE WHEN c.c_era AND c.c_e THEN c.campi END,
         CASE WHEN NOT c.c_era THEN NULL
              WHEN NOT c.c_e THEN c.vo
              ELSE (SELECT jsonb_object_agg(k, c.vo -> k) FROM unnest(c.campi) AS k) END,
         CASE WHEN NOT c.c_e THEN NULL
              WHEN NOT c.c_era THEN c.vn
              ELSE (SELECT jsonb_object_agg(k, c.vn -> k) FROM unnest(c.campi) AS k) END,
         false, 1, false
    FROM cambi c
   WHERE NOT (c.c_era AND c.c_e) OR cardinality(c.campi) > 0;
  GET DIAGNOSTICS quanti = ROW_COUNT;
  DELETE FROM registro.confronti q WHERE q.transazione = p_transazione;
  RETURN quanti;
END
$confronta$;
--> statement-breakpoint
ALTER FUNCTION registro.confronta(xid8) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.confronta(xid8) FROM PUBLIC;
--> statement-breakpoint
-- Al COMMIT (o quando i vincoli diventano immediati): il confronto della transazione.
CREATE OR REPLACE FUNCTION registro.confronta_al_commit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $al_commit$
BEGIN
  PERFORM registro.confronta(pg_current_xact_id());
  RETURN NULL;
END
$al_commit$;
--> statement-breakpoint
ALTER FUNCTION registro.confronta_al_commit() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.confronta_al_commit() FROM PUBLIC;
--> statement-breakpoint
-- Una volta per transazione: solo la prima riga messa da parte lo mette in coda.
DO $confronta_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'registro.confronti'::pg_catalog.regclass AND tgname = 'registro_confronta') THEN
    CREATE CONSTRAINT TRIGGER registro_confronta AFTER INSERT ON registro.confronti
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.primo) EXECUTE FUNCTION registro.confronta_al_commit();
  END IF;
  ALTER TABLE registro.confronti ENABLE ALWAYS TRIGGER registro_confronta;
END
$confronta_trigger$;
--> statement-breakpoint
-- cattura(): il corpo della 0007, con in più la parte del confronto.
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
  amb_vuoto   boolean;
  k_dentro    text;
  k_fuori     text;
  sorgente    text;
  a_sql       text;
  diff        text[];
  campi_agg   text[];
  per_record  boolean;
  col_conf    text[];
  conf_gia    bigint;
  conf_primo  boolean;
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
    PERFORM registro.accoda(nome, TG_OP, cascata, n, NULL, NULL, NULL, NULL, ctx);
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

  -- il prima e il dopo a fine transazione (0066): per le tabelle col confronto
  -- (gli orari di dettaglio, che l'app salva cancellando e reinserendo) le
  -- righe di prima e di dopo si mettono da parte per chiave; al COMMIT
  -- registro.confronta() scrive una riga per ogni chiave cambiata davvero. Non
  -- per le cascate; oltre 2000 righe per tabella in una transazione (un import,
  -- una copia) resta il solo riepilogo.
  IF regola.confronto AND NOT cascata AND NOT EXISTS (
       SELECT 1 FROM registro.confronti q
        WHERE q.transazione = pg_current_xact_id() AND q.tabella = nome AND q.lato = 'x') THEN
    SELECT count(*), NOT EXISTS (SELECT 1 FROM registro.confronti q2 WHERE q2.transazione = pg_current_xact_id())
      INTO conf_gia, conf_primo
      FROM registro.confronti q WHERE q.transazione = pg_current_xact_id() AND q.tabella = nome;
    -- (il CASE in un'assegnazione: dentro un IF il suo THEN chiuderebbe la condizione)
    conf_gia := conf_gia + n * (CASE WHEN TG_OP = 'UPDATE' THEN 2 ELSE 1 END);
    IF conf_gia > 2000 THEN
      DELETE FROM registro.confronti q WHERE q.transazione = pg_current_xact_id() AND q.tabella = nome;
      INSERT INTO registro.confronti (ts, transazione, primo, tabella, lato)
      VALUES (now(), pg_current_xact_id(),
              NOT EXISTS (SELECT 1 FROM registro.confronti q WHERE q.transazione = pg_current_xact_id()), nome, 'x');
    ELSE
      -- le colonne col valore, fuori la chiave (sta in chiave)
      SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum), '{}') INTO col_conf
        FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT a.attname::text = ANY (regola.chiave)
         AND NOT EXISTS (SELECT 1 FROM unnest(regola.escluse) AS e(p) WHERE a.attname::text LIKE e.p)
         AND (a.attname::text = ANY (regola.valori_di)
              OR (regola.con_valori
                  AND (t.typcategory NOT IN ('A', 'U') OR t.typname = 'uuid') AND t.typname NOT IN ('json', 'jsonb', 'bytea', 'xml')
                  AND NOT EXISTS (SELECT 1 FROM unnest(regola.solo_nome) AS s(p) WHERE a.attname::text LIKE s.p)));
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        INSERT INTO registro.confronti (ts, transazione, primo, richiesta, attore, via, ruolo_db, origine, tabella,
                                        chiave, ambito_tipo, ambito_id, lato, valori)
        SELECT now(), pg_current_xact_id(), conf_primo AND r.i = 1, ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome,
               (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
               r.v ->> regola.ambito_colonna, 'o',
               coalesce((SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_conf) AS c), '{}'::jsonb)
          FROM (SELECT to_jsonb(riga_del_registro.*) AS v, row_number() OVER () AS i FROM vecchie riga_del_registro OFFSET 0) r;
        conf_primo := false;
      END IF;
      IF TG_OP IN ('UPDATE', 'INSERT') THEN
        INSERT INTO registro.confronti (ts, transazione, primo, richiesta, attore, via, ruolo_db, origine, tabella,
                                        chiave, ambito_tipo, ambito_id, lato, valori)
        SELECT now(), pg_current_xact_id(), conf_primo AND r.i = 1, ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome,
               (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
               r.v ->> regola.ambito_colonna, 'n',
               coalesce((SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_conf) AS c), '{}'::jsonb)
          FROM (SELECT to_jsonb(riga_del_registro.*) AS v, row_number() OVER () AS i FROM nuove riga_del_registro OFFSET 0) r;
      END IF;
    END IF;
  END IF;

  -- una riga per record: fino a 50 righe, senza cascata né modo «riepilogo», e
  -- non su una tabella sempre in riepilogo (gli orari di dettaglio, 0007)
  per_record := n <= 50 AND NOT cascata AND modo <> 'riepilogo' AND NOT regola.riepilogo_sempre;

  IF per_record OR TG_OP = 'UPDATE' THEN
    -- le colonne: registrate (non escluse) e, fra queste, quelle col valore
    SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE NOT a.esclusa), '{}'),
           coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE NOT a.esclusa AND a.valore), '{}')
      INTO registrate, col_valore
      FROM (SELECT a.attname, a.attnum,
                   EXISTS (SELECT 1 FROM unnest(regola.escluse) AS e(p) WHERE a.attname::text LIKE e.p) AS esclusa,
                   a.attname::text = ANY (regola.valori_di)
                   OR (regola.con_valori
                       -- gli uuid sì (calendario, variante, progetto: dati della pianificazione;
                       -- i riferimenti alle persone sono «solo nome», vedi sorveglia())
                       AND (t.typcategory NOT IN ('A', 'U') OR t.typname = 'uuid') AND t.typname NOT IN ('json', 'jsonb', 'bytea', 'xml')
                       AND NOT EXISTS (SELECT 1 FROM unnest(regola.solo_nome) AS s(p) WHERE a.attname::text LIKE s.p)) AS valore
              FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
             WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped) a;
  END IF;

  -- ── una riga per record ──
  IF per_record THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'INSERT',
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
             r.v ->> regola.ambito_colonna, NULL, NULL,
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_valore) AS c), false, 1, false
        FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM nuove riga_del_registro OFFSET 0) r;  -- OFFSET 0: to_jsonb una volta per riga
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'DELETE',
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(regola.chiave) AS c), regola.ambito_tipo,
             r.v ->> regola.ambito_colonna, NULL,
             (SELECT jsonb_object_agg(c, r.v -> c) FROM unnest(col_valore) AS c), NULL, false, 1, false
        FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM vecchie riga_del_registro OFFSET 0) r;
    ELSE
      -- vecchie e nuove per chiave (FULL JOIN: una chiave cambiata non si perde); solo le righe con un campo registrato cambiato
      INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                      chiave, ambito_tipo, ambito_id, campi, prima, dopo, riepilogo, righe, a_cascata)
      SELECT now(), pg_current_xact_id(), ctx[3], ctx[1], ctx[2], session_user, ctx[4], nome, 'UPDATE',
             z.k, regola.ambito_tipo, coalesce(z.vn, z.vo) ->> regola.ambito_colonna, z.campi,
             (SELECT jsonb_object_agg(c, z.vo -> c) FROM unnest(z.campi) AS c WHERE c = ANY (col_valore) AND z.vo IS NOT NULL),
             (SELECT jsonb_object_agg(c, z.vn -> c) FROM unnest(z.campi) AS c WHERE c = ANY (col_valore) AND z.vn IS NOT NULL),
             false, 1, false
        FROM (SELECT coalesce(b.k, a.k) AS k, a.v AS vo, b.v AS vn,
                     ARRAY(SELECT c FROM unnest(registrate) AS c WHERE (a.v -> c) IS DISTINCT FROM (b.v -> c)) AS campi
                FROM (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                        FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM vecchie riga_del_registro OFFSET 0) w OFFSET 0) a
                FULL JOIN (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                             FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM nuove riga_del_registro OFFSET 0) w OFFSET 0) b ON a.k = b.k
              OFFSET 0) z  -- OFFSET 0: ogni riga si converte e si confronta una volta sola
       WHERE cardinality(z.campi) > 0;
    END IF;
    RETURN NULL;
  END IF;

  -- ── istruzioni grandi, cascate, modo riepilogo, tabelle sempre in riepilogo:
  -- un riepilogo per transazione e tabella. Fino a 50 righe i conti si fanno con
  -- SQL statico (i piani restano in cache): un ciclo di istruzioni da una riga,
  -- come gli orari di una corsa salvati fermata per fermata, non paga un piano
  -- nuovo ogni volta. Oltre, un passaggio tipizzato ──
  -- il campione: le prime 20 righe toccate (per un UPDATE lo fa il passaggio
  -- qui sotto, sulle sole righe cambiate)
  IF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(k) INTO campione
      FROM (SELECT (SELECT jsonb_object_agg(c, to_jsonb(riga_del_registro.*) -> c) FROM unnest(regola.chiave) AS c) AS k FROM vecchie riga_del_registro LIMIT 20) y;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(k) INTO campione
      FROM (SELECT (SELECT jsonb_object_agg(c, to_jsonb(riga_del_registro.*) -> c) FROM unnest(regola.chiave) AS c) AS k FROM nuove riga_del_registro LIMIT 20) y;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF regola.ambito_colonna IS NOT NULL THEN
      -- l'ambito solo se è lo stesso per tutte le righe (min e max non vedono i NULL)
      IF n <= 50 AND TG_OP = 'DELETE' THEN
        SELECT min(y.a), max(y.a), bool_or(y.a IS NULL) INTO amb_min, amb_max, amb_vuoto
          FROM (SELECT to_jsonb(riga_del_registro.*) ->> regola.ambito_colonna AS a FROM vecchie riga_del_registro) y;
      ELSIF n <= 50 THEN
        SELECT min(y.a), max(y.a), bool_or(y.a IS NULL) INTO amb_min, amb_max, amb_vuoto
          FROM (SELECT to_jsonb(riga_del_registro.*) ->> regola.ambito_colonna AS a FROM nuove riga_del_registro) y;
      ELSE
        EXECUTE format('SELECT min(x.%1$I::text), max(x.%1$I::text), bool_or(x.%1$I IS NULL) FROM %2$I x', regola.ambito_colonna,
                       CASE TG_OP WHEN 'DELETE' THEN 'vecchie' ELSE 'nuove' END) INTO amb_min, amb_max, amb_vuoto;
      END IF;
    END IF;
    PERFORM registro.accoda(nome, TG_OP, cascata, n, campione, NULL, regola.ambito_tipo,
                            CASE WHEN amb_min = amb_max AND NOT amb_vuoto THEN amb_min END, ctx);
    RETURN NULL;
  END IF;

  -- UPDATE: quante righe cambiano davvero, quali campi, se hanno tutte lo stesso ambito
  IF cardinality(registrate) = 0 THEN
    RETURN NULL;
  END IF;
  -- fino a 50 righe: come per le righe per record (vecchie e nuove in jsonb, per
  -- chiave), ma sommate. Una riga con la chiave cambiata compare da tutte e due
  -- le parti del FULL JOIN: si conta la nuova
  IF n <= 50 THEN
    WITH z AS MATERIALIZED (
      SELECT b.k AS kn, a.v AS vo, b.v AS vn,
             ARRAY(SELECT c FROM unnest(registrate) AS c WHERE (a.v -> c) IS DISTINCT FROM (b.v -> c)) AS campi
        FROM (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM vecchie riga_del_registro OFFSET 0) w OFFSET 0) a
        FULL JOIN (SELECT (SELECT jsonb_object_agg(c, w.v -> c) FROM unnest(regola.chiave) AS c) AS k, w.v
                     FROM (SELECT to_jsonb(riga_del_registro.*) AS v FROM nuove riga_del_registro OFFSET 0) w OFFSET 0) b ON a.k = b.k
    ), cambiate AS MATERIALIZED (
      SELECT z.kn, z.campi, z.vn IS NOT NULL AS nuova,
             z.vo ->> regola.ambito_colonna AS ao, z.vn ->> regola.ambito_colonna AS an
        FROM z
       WHERE cardinality(z.campi) > 0
    )
    SELECT (SELECT count(*) FROM cambiate q WHERE q.nuova),
           ARRAY(SELECT r FROM unnest(registrate) AS r WHERE EXISTS (SELECT 1 FROM cambiate q WHERE r = ANY (q.campi))),
           (SELECT jsonb_agg(y.kn) FROM (SELECT q.kn FROM cambiate q WHERE q.nuova AND q.kn IS NOT NULL LIMIT 20) y),
           (SELECT min(least(q.ao, q.an)) FROM cambiate q),
           (SELECT max(greatest(q.ao, q.an)) FROM cambiate q),
           (SELECT coalesce(bool_or(q.ao IS NULL OR q.an IS NULL), false) FROM cambiate q)
      INTO n, campi_agg, campione, amb_min, amb_max, amb_vuoto;
    IF n = 0 THEN
      RETURN NULL;
    END IF;
    PERFORM registro.accoda(nome, 'UPDATE', cascata, n, campione, campi_agg, regola.ambito_tipo,
                            CASE WHEN amb_min = amb_max AND NOT amb_vuoto THEN amb_min END, ctx);
    RETURN NULL;
  END IF;
  -- oltre 50 righe: un passaggio tipizzato su vecchie e nuove; ogni confronto si
  -- calcola una volta per riga (d1…dN, OFFSET 0 non lascia appiattire)
  -- il confronto tipizzato solo dove il tipo (risolti il dominio e l'elemento
  -- di un array) ha un'uguaglianza btree; gli altri (json, json[], xml, point,
  -- tipi composti…) come testo: un confronto impossibile farebbe fallire la scrittura
  SELECT array_agg(
           CASE WHEN EXISTS (SELECT 1 FROM pg_opclass oc JOIN pg_am am ON am.oid = oc.opcmethod
                              WHERE am.amname = 'btree' AND oc.opcdefault
                                AND oc.opcintype = CASE WHEN b.typcategory = 'A' THEN coalesce(nullif(e.typbasetype, 0), e.oid)
                                                        WHEN b.typtype IN ('b', 'e', 'r') THEN b.oid END)
                THEN format('o.%1$I IS DISTINCT FROM n.%1$I', a.attname)
                ELSE format('o.%1$I::text IS DISTINCT FROM n.%1$I::text', a.attname) END ORDER BY a.attnum)
    INTO diff
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_type b ON b.oid = coalesce(nullif(t.typbasetype, 0), t.oid)
    LEFT JOIN pg_type e ON e.oid = b.typelem AND b.typcategory = 'A'
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attname::text = ANY (registrate);
  sorgente := 'vecchie o FULL JOIN nuove n ON ' || coalesce(
                (SELECT string_agg(format('o.%1$I = n.%1$I', k), ' AND ') FROM unnest(regola.chiave) AS k), 'false');
  -- l'ambito vecchio e quello nuovo: si tiene solo se è uno per tutte le righe cambiate
  a_sql := CASE WHEN regola.ambito_colonna IS NULL THEN 'NULL::text AS ao, NULL::text AS an'
                ELSE format('o.%1$I::text AS ao, n.%1$I::text AS an', regola.ambito_colonna) END;
  -- la chiave della riga nuova: per contare una volta sola una riga con la
  -- chiave cambiata (FULL JOIN: compare da tutte e due le parti) e per il campione
  k_dentro := (SELECT string_agg(format('n.%I AS k%s', c, i), ', ') FROM unnest(regola.chiave) WITH ORDINALITY AS u(c, i));
  k_fuori := (SELECT 'jsonb_build_object(' || string_agg(format('%L, z.k%s', c, i), ', ') || ')'
                FROM unnest(regola.chiave) WITH ORDINALITY AS u(c, i));
  EXECUTE format(
    'SELECT count(*) FILTER (WHERE %1$s AND %6$s), %2$s,
            min(least(z.ao, z.an)) FILTER (WHERE %1$s), max(greatest(z.ao, z.an)) FILTER (WHERE %1$s),
            coalesce(bool_or(z.ao IS NULL OR z.an IS NULL) FILTER (WHERE %1$s), false),
            to_jsonb((array_agg(%7$s) FILTER (WHERE %1$s AND %6$s))[1:20])
       FROM (SELECT %3$s, %4$s%8$s FROM %5$s OFFSET 0) z',
    '(' || array_to_string(ARRAY(SELECT format('z.d%s', i) FROM generate_series(1, cardinality(diff)) AS i), ' OR ') || ')',
    'array_remove(ARRAY[' || array_to_string(ARRAY(
       SELECT format('CASE WHEN bool_or(z.d%s) THEN %L END', i, registrate[i]) FROM generate_series(1, cardinality(diff)) AS i), ', ')
       || ']::text[], NULL)',
    array_to_string(ARRAY(SELECT format('%s AS d%s', diff[i], i) FROM generate_series(1, cardinality(diff)) AS i), ', '),
    a_sql, sorgente,
    CASE WHEN k_dentro IS NULL THEN 'true' ELSE 'z.k1 IS NOT NULL' END,
    coalesce(k_fuori, 'NULL::jsonb'),
    coalesce(', ' || k_dentro, '')) INTO n, campi_agg, amb_min, amb_max, amb_vuoto, campione;
  IF n = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM registro.accoda(nome, 'UPDATE', cascata, n, campione, campi_agg, regola.ambito_tipo,
                          CASE WHEN amb_min = amb_max AND NOT amb_vuoto THEN amb_min END, ctx);
  RETURN NULL;
END
$cattura$;
--> statement-breakpoint
ALTER FUNCTION registro.cattura() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.cattura() FROM PUBLIC;
--> statement-breakpoint
-- Le tre tabelle di dettaglio: il confronto, coi valori.
UPDATE registro.sorvegliate SET confronto = true, con_valori = true
 WHERE tabella IN ('public.ps_stop_times', 'public.ps_variant_stops', 'public.ps_calendar_dates');
