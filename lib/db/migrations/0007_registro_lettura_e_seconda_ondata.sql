-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 · Il registro delle modifiche: lettura e seconda ondata (PR 2.11)
-- ───────────────────────────────────────────────────────────────────────────
-- 1. Leggerlo. L'app continua a non avere diritti sulle tabelle del registro:
--    lo legge solo con registro.leggi(), che gira come cerbero_registro, ha un
--    periodo e un numero di righe limitati, non filtra né ordina per persona, e
--    annota ogni consultazione in registro.letture. registro.stato() dice se è
--    acceso e quali tabelle sorveglia. Li chiama la pagina dell'amministratore
--    (GET /api/admin/registro).
--
-- 2. La seconda ondata: gli orari di dettaglio di Planning Studio.
--    - ps_stop_times, ps_variant_stops, ps_calendar_dates sono «sempre in
--      riepilogo» (regola nuova, sorvegliate.riepilogo_sempre): l'app le salva
--      cancellando tutto e reinserendo una riga per volta, e una riga di
--      registro per fermata sarebbe solo rumore. Un riepilogo per transazione,
--      tabella e operazione: chi, quando, quale corsa (se è una sola), quante
--      righe. Niente valori.
--    - ps_shapes, ps_service_periods, ps_stop_clusters, ps_no_go_zones,
--      ps_pending_activations: come la prima ondata, con i valori.
--    Restano fuori le tabelle della validità (ps_trip_day_validity e le altre:
--    una sincronizzazione le riscrive anche durante le letture) e le tariffe a
--    zone (rigenerate una riga per volta senza transazione): DEPLOY.md,
--    «Registro delle modifiche».
--
-- 3. cattura(): le istruzioni piccole che vanno in riepilogo (una cascata, il
--    modo «riepilogo», una tabella sempre in riepilogo) si contano con SQL
--    statico, come le righe per record; il passaggio tipizzato resta per le
--    istruzioni oltre le 50 righe.
--
-- 4. manutenzione(): a 12 mesi, dove chi ha fatto la modifica è anche la riga
--    modificata (la propria password), si tolgono anche ambito, chiave e
--    campione; le consultazioni si cancellano alla stessa scadenza.
--
-- 5. ps_pending_activations.via: il canale di chi programma un'attivazione
--    (il giro delle attivazioni scrive poi con quel canale).
--
-- Il registro resta SPENTO finché non lo accende chi gestisce il database.
--
-- Lock: CREATE TRIGGER prende SHARE ROW EXCLUSIVE sulle 8 tabelle, per poco.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE registro.sorvegliate ADD COLUMN IF NOT EXISTS riepilogo_sempre boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Un numero per riga, nell'ordine in cui le righe sono state scritte: la
-- lettura scorre dal più recente per (ts, transazione, id), senza salti e senza
-- un tetto alle righe di una transazione. Un BRIN quell'ordine non lo dà.
-- Il registro è spento: tabelle e indici sono vuoti.
ALTER TABLE registro.modifiche ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;
--> statement-breakpoint
DROP INDEX IF EXISTS registro.modifiche_ts;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modifiche_ordine ON registro.modifiche (ts, transazione, id);
--> statement-breakpoint
-- L'indice per chi ha fatto la modifica serviva solo a cercare per persona:
-- il registro non si legge così (decisione del 25/10), e ogni riga lo pagava.
DROP INDEX IF EXISTS registro.modifiche_attore;
--> statement-breakpoint
-- ── I riepiloghi si sommano a fine transazione ───────────────────────────
-- Nella 0006 ogni istruzione in riepilogo riscriveva la riga del riepilogo.
-- Mille istruzioni da una riga nella stessa transazione (le fermate in blocco,
-- gli orari di molte corse) riscrivevano mille volte la stessa riga, che la
-- transazione non può ancora ripulire: un costo che cresce col quadrato.
-- Ora ogni istruzione accoda un parziale (solo inserimenti) e un trigger
-- differito li somma una volta sola, al COMMIT. Un savepoint annullato porta
-- via i suoi parziali, come prima portava via la sua parte del riepilogo.
-- La tabella non conserva niente oltre la transazione: non serve il WAL.
CREATE UNLOGGED TABLE IF NOT EXISTS registro.parziali (
  n           bigint GENERATED ALWAYS AS IDENTITY,
  ts          timestamptz NOT NULL,
  transazione xid8 NOT NULL,
  primo       boolean NOT NULL,      -- il primo della transazione: fa partire la somma al COMMIT
  richiesta   text,
  attore      text,
  via         text,
  ruolo_db    text NOT NULL,
  origine     text,
  tabella     text NOT NULL,
  operazione  text NOT NULL,
  a_cascata   boolean NOT NULL,
  ambito_tipo text,
  ambito_id   text,
  campi       text[],
  righe       bigint NOT NULL,
  campione    jsonb
);
--> statement-breakpoint
ALTER TABLE registro.parziali OWNER TO cerbero_registro;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS parziali_transazione ON registro.parziali (transazione);
--> statement-breakpoint
-- Un parziale: lo chiama cattura() al posto di riepiloga(), con gli stessi argomenti.
CREATE OR REPLACE FUNCTION registro.accoda(p_tabella text, p_operazione text, p_cascata boolean, p_righe bigint,
                                           p_campione jsonb, p_campi text[], p_ambito_tipo text, p_ambito text, p_ctx text[])
  RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $accoda$
BEGIN
  INSERT INTO registro.parziali (ts, transazione, primo, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                 a_cascata, ambito_tipo, ambito_id, campi, righe, campione)
  VALUES (now(), pg_current_xact_id(),
          NOT EXISTS (SELECT 1 FROM registro.parziali q WHERE q.transazione = pg_current_xact_id()),
          p_ctx[3], p_ctx[1], p_ctx[2], session_user, p_ctx[4], p_tabella, p_operazione,
          p_cascata, p_ambito_tipo, p_ambito, p_campi, p_righe, p_campione);
END
$accoda$;
--> statement-breakpoint
ALTER FUNCTION registro.accoda(text, text, boolean, bigint, jsonb, text[], text, text, text[]) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.accoda(text, text, boolean, bigint, jsonb, text[], text, text, text[]) FROM PUBLIC;
--> statement-breakpoint
-- La somma dei parziali di una transazione: un riepilogo per tabella,
-- operazione e cascata. Le righe si sommano; i campi si uniscono; il campione
-- sono le prime 20 chiavi; l'ambito resta solo se è lo stesso per tutti; chi e
-- da dove sono quelli del primo parziale. Se un riepilogo c'è già (i vincoli
-- resi immediati fanno partire la somma a ogni istruzione) si sommano.
CREATE OR REPLACE FUNCTION registro.somma(p_transazione xid8) RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $somma$
DECLARE
  quanti integer;
BEGIN
  WITH mie AS MATERIALIZED (
    SELECT * FROM registro.parziali p WHERE p.transazione = p_transazione
  ), prime AS (
    SELECT DISTINCT ON (q.tabella, q.operazione, q.a_cascata)
           q.tabella, q.operazione, q.a_cascata, q.ts, q.richiesta, q.attore, q.via, q.ruolo_db, q.origine, q.ambito_tipo
      FROM mie q
     ORDER BY q.tabella, q.operazione, q.a_cascata, q.n
  ), somme AS (
    SELECT q.tabella, q.operazione, q.a_cascata, sum(q.righe) AS righe,
           CASE WHEN count(q.ambito_id) = count(*) AND min(q.ambito_id) = max(q.ambito_id) THEN min(q.ambito_id) END AS ambito_id
      FROM mie q
     GROUP BY q.tabella, q.operazione, q.a_cascata
  )
  INSERT INTO registro.modifiche AS m (ts, transazione, richiesta, attore, via, ruolo_db, origine, tabella, operazione,
                                       ambito_tipo, ambito_id, campi, riepilogo, righe, campione, a_cascata)
  SELECT f.ts, p_transazione, f.richiesta, f.attore, f.via, f.ruolo_db, f.origine, f.tabella, f.operazione,
         f.ambito_tipo, s.ambito_id,
         (SELECT array_agg(DISTINCT c ORDER BY c)
            FROM mie q CROSS JOIN LATERAL unnest(q.campi) AS c
           WHERE q.tabella = f.tabella AND q.operazione = f.operazione AND q.a_cascata = f.a_cascata),
         true, s.righe::integer,
         (SELECT jsonb_agg(e.v)
            FROM (SELECT x.v
                    FROM mie q CROSS JOIN LATERAL jsonb_array_elements(q.campione) WITH ORDINALITY AS x(v, i)
                   WHERE q.tabella = f.tabella AND q.operazione = f.operazione AND q.a_cascata = f.a_cascata
                   ORDER BY q.n, x.i LIMIT 20) e),
         f.a_cascata
    FROM prime f
    JOIN somme s ON s.tabella = f.tabella AND s.operazione = f.operazione AND s.a_cascata = f.a_cascata
  ON CONFLICT (ts, transazione, tabella, operazione, a_cascata) WHERE riepilogo DO UPDATE SET
    righe = m.righe + EXCLUDED.righe,
    campione = (SELECT jsonb_agg(e.v ORDER BY e.i)
                  FROM (SELECT x.v, x.i
                          FROM jsonb_array_elements(coalesce(m.campione, '[]'::jsonb) || coalesce(EXCLUDED.campione, '[]'::jsonb))
                               WITH ORDINALITY AS x(v, i)
                         ORDER BY x.i LIMIT 20) e),
    campi = CASE WHEN m.campi IS NULL AND EXCLUDED.campi IS NULL THEN NULL
                 ELSE ARRAY(SELECT DISTINCT c FROM unnest(coalesce(m.campi, '{}') || coalesce(EXCLUDED.campi, '{}')) AS c ORDER BY 1) END,
    ambito_id = CASE WHEN m.ambito_id IS NOT DISTINCT FROM EXCLUDED.ambito_id THEN m.ambito_id END;
  GET DIAGNOSTICS quanti = ROW_COUNT;
  DELETE FROM registro.parziali p WHERE p.transazione = p_transazione;
  RETURN quanti;
END
$somma$;
--> statement-breakpoint
ALTER FUNCTION registro.somma(xid8) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.somma(xid8) FROM PUBLIC;
--> statement-breakpoint
-- Al COMMIT (o quando i vincoli diventano immediati): la somma della transazione.
CREATE OR REPLACE FUNCTION registro.chiudi() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $chiudi$
BEGIN
  PERFORM registro.somma(pg_current_xact_id());
  RETURN NULL;
END
$chiudi$;
--> statement-breakpoint
ALTER FUNCTION registro.chiudi() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.chiudi() FROM PUBLIC;
--> statement-breakpoint
-- Una volta per transazione: solo il primo parziale mette in coda la somma.
DO $chiude$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'registro.parziali'::pg_catalog.regclass AND tgname = 'registro_chiude') THEN
    CREATE CONSTRAINT TRIGGER registro_chiude AFTER INSERT ON registro.parziali
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.primo) EXECUTE FUNCTION registro.chiudi();
  END IF;
  ALTER TABLE registro.parziali ENABLE ALWAYS TRIGGER registro_chiude;
END
$chiude$;
--> statement-breakpoint
-- Quante righe e quali campi per le istruzioni piccole in riepilogo: SQL statico.
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
-- Le regole di una tabella: in più, «sempre in riepilogo». La firma vecchia si
-- toglie (con i default resterebbe ambigua).
DROP FUNCTION IF EXISTS registro.sorveglia(regclass, text[], text, text, boolean, text[], text[], text[]);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION registro.sorveglia(p_tabella regclass, p_chiave text[], p_ambito_tipo text, p_ambito_colonna text,
                                              p_con_valori boolean, p_valori_di text[] DEFAULT '{}',
                                              p_escluse text[] DEFAULT '{}', p_solo_nome text[] DEFAULT '{}',
                                              p_riepilogo_sempre boolean DEFAULT false)
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
  INSERT INTO registro.sorvegliate (tabella, chiave, ambito_tipo, ambito_colonna, con_valori, valori_di, escluse, solo_nome,
                                    riepilogo_sempre)
  VALUES (nome, p_chiave, p_ambito_tipo, p_ambito_colonna, p_con_valori, p_valori_di,
          -- escluse sempre: date di servizio, cache, segni di ricalcolo
          p_escluse || ARRAY['updated_at', 'last_opened_at', 'stale_since', '%\_cached'],
          -- chi è proprietario o membro: una persona, non un dato della pianificazione
          p_solo_nome || ARRAY['%user\_id', 'added\_by', 'created\_by'], p_riepilogo_sempre)
  ON CONFLICT (tabella) DO UPDATE SET chiave = EXCLUDED.chiave, ambito_tipo = EXCLUDED.ambito_tipo,
    ambito_colonna = EXCLUDED.ambito_colonna, con_valori = EXCLUDED.con_valori, valori_di = EXCLUDED.valori_di,
    escluse = EXCLUDED.escluse, solo_nome = EXCLUDED.solo_nome, riepilogo_sempre = EXCLUDED.riepilogo_sempre;
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
ALTER FUNCTION registro.sorveglia(regclass, text[], text, text, boolean, text[], text[], text[], boolean) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.sorveglia(regclass, text[], text, text, boolean, text[], text[], text[], boolean) FROM PUBLIC;
--> statement-breakpoint
-- riepiloga() non la chiama più nessuno: la somma la fa registro.somma()
DROP FUNCTION IF EXISTS registro.riepiloga(text, text, boolean, bigint, jsonb, text[], text, text, text[]);
--> statement-breakpoint
-- La verifica: in più i riepiloghi rimasti da sommare.
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
    -- nessuna ereditarietà né partizione: le righe di una figlia si leggono dal
    -- padre, e un UPDATE dal padre cambia le figlie, senza questi trigger
    IF EXISTS (SELECT 1 FROM pg_inherits i WHERE s.relid IN (i.inhrelid, i.inhparent)) THEN
      RETURN NEXT format('%s è legata per ereditarietà o come partizione ad altre tabelle (%s): le loro scritture sfuggono al registro',
                         s.tabella, (SELECT string_agg(format('%s → %s', i.inhrelid::regclass, i.inhparent::regclass), ', ')
                                       FROM pg_inherits i WHERE s.relid IN (i.inhrelid, i.inhparent)));
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
  -- un parziale che si vede da fuori è di una transazione chiusa senza la somma
  IF EXISTS (SELECT 1 FROM registro.parziali p WHERE p.transazione IS DISTINCT FROM pg_current_xact_id_if_assigned()) THEN
    RETURN NEXT 'ci sono riepiloghi non sommati (registro.parziali): SELECT registro.manutenzione() li somma';
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
-- ── Le consultazioni ─────────────────────────────────────────────────────
-- Chi ha letto il registro, quando, con quali filtri, quante righe. La scrive
-- registro.leggi(); come attore e via, vale per i percorsi onesti (li mette
-- l'app sulla connessione), mentre ruolo_db è session_user.
CREATE TABLE IF NOT EXISTS registro.letture (
  ts        timestamptz NOT NULL,
  attore    text,
  via       text,
  richiesta text,
  ruolo_db  text NOT NULL,
  origine   text,
  filtri    jsonb NOT NULL,
  chieste   integer NOT NULL,   -- il limite della chiamata
  righe     integer NOT NULL    -- quante ne ha avute
);
--> statement-breakpoint
ALTER TABLE registro.letture OWNER TO cerbero_registro;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS letture_ts ON registro.letture (ts);
--> statement-breakpoint
-- La lettura. Filtri ammessi: da (compreso), a (escluso; periodo di 93 giorni
-- al più, e se mancano gli ultimi 7), tabella, operazione, ambito_tipo,
-- ambito_id (solo con un ambito che non è una persona). Ogni altra chiave è un
-- errore: il registro non si legge per persona. I valori sono testi corti.
-- Dal più recente; per andare avanti il cursore, cioè ts, transazione e id
-- dell'ultima riga vista. Le date escono in ISO 8601 (UTC, microsecondi),
-- qualunque sia il DateStyle. Solo SQL statico.
-- Annota la consultazione, salvo a registro spento e vuoto: lì non c'è niente
-- da leggere, e non c'è ancora la base per annotare chi guarda.
CREATE OR REPLACE FUNCTION registro.leggi(p_filtri jsonb, p_limite integer)
  RETURNS TABLE (id bigint, ts text, transazione text, richiesta text, attore text, via text, ruolo_db text,
                 origine text, tabella text, operazione text, chiave jsonb, ambito_tipo text, ambito_id text,
                 campi text[], prima jsonb, dopo jsonb, riepilogo boolean, righe integer, campione jsonb, a_cascata boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET plan_cache_mode = force_custom_plan AS $leggi$
DECLARE
  f        jsonb := coalesce(p_filtri, '{}'::jsonb);
  estranee text;
  v_da     timestamptz;
  v_a      timestamptz;
  v_tab    text;
  v_op     text;
  v_tipo   text;
  v_amb    text;
  v_cts    timestamptz;
  v_ctx    xid8;
  v_cid    bigint;
  quante   bigint;
BEGIN
  IF jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'registro.leggi: i filtri sono un oggetto' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO estranee
    FROM jsonb_object_keys(f) AS k
   WHERE k NOT IN ('da', 'a', 'tabella', 'operazione', 'ambito_tipo', 'ambito_id', 'cursore_ts', 'cursore_transazione', 'cursore_id');
  IF estranee IS NOT NULL THEN
    RAISE EXCEPTION 'registro.leggi: filtro non ammesso (%): il registro non si legge per persona', left(estranee, 200) USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(f) AS e
              WHERE jsonb_typeof(e.value) NOT IN ('string', 'null') OR length(e.value #>> '{}') > 100) THEN
    RAISE EXCEPTION 'registro.leggi: i valori dei filtri sono testi di 100 caratteri al più' USING ERRCODE = '22023';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 200 THEN
    RAISE EXCEPTION 'registro.leggi: da 1 a 200 righe per volta' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_a := coalesce((f ->> 'a')::timestamptz, now() + interval '1 second');
    v_da := coalesce((f ->> 'da')::timestamptz, v_a - interval '7 days');
    v_cts := (f ->> 'cursore_ts')::timestamptz;
    v_ctx := (f ->> 'cursore_transazione')::xid8;
    v_cid := (f ->> 'cursore_id')::bigint;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'registro.leggi: una data o un cursore non si leggono' USING ERRCODE = '22023';
  END;
  IF NOT (v_da < v_a) OR NOT isfinite(v_da) OR NOT isfinite(v_a) OR v_a - v_da > interval '93 days' THEN
    RAISE EXCEPTION 'registro.leggi: il periodo va da un giorno prima a uno dopo, 93 giorni al più' USING ERRCODE = '22023';
  END IF;
  v_tab := f ->> 'tabella';
  v_op := f ->> 'operazione';
  v_tipo := f ->> 'ambito_tipo';
  v_amb := f ->> 'ambito_id';
  IF v_amb IS NOT NULL AND coalesce(v_tipo, '') NOT IN ('progetto_ps', 'progetto_turni', 'feed', 'scenario', 'corsa', 'variante', 'calendario') THEN
    RAISE EXCEPTION 'registro.leggi: ambito_id si usa solo con un ambito che non è una persona' USING ERRCODE = '22023';
  END IF;
  IF num_nonnulls(v_cts, v_ctx, v_cid) NOT IN (0, 3) THEN
    RAISE EXCEPTION 'registro.leggi: il cursore ha ts, transazione e id insieme' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT m.id, to_char(m.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), m.transazione::text, m.richiesta, m.attore, m.via,
         m.ruolo_db, m.origine, m.tabella, m.operazione, m.chiave, m.ambito_tipo, m.ambito_id, m.campi, m.prima, m.dopo,
         m.riepilogo, m.righe, m.campione, m.a_cascata
    FROM registro.modifiche m
   WHERE m.ts >= v_da AND m.ts < v_a
     AND (v_tab IS NULL OR m.tabella = v_tab)
     AND (v_op IS NULL OR m.operazione = v_op)
     AND (v_tipo IS NULL OR m.ambito_tipo = v_tipo)
     AND (v_amb IS NULL OR m.ambito_id = v_amb)
     AND (v_cts IS NULL OR (m.ts, m.transazione, m.id) < (v_cts, v_ctx, v_cid))
   -- un ordine totale (l'id è di una riga sola): le pagine non si ripetono e non
   -- saltano niente; dentro una transazione, dall'ultima riga scritta alla prima
   ORDER BY m.ts DESC, m.transazione DESC, m.id DESC
   LIMIT p_limite;
  GET DIAGNOSTICS quante = ROW_COUNT;

  IF quante > 0 OR (SELECT i.attivo FROM registro.impostazioni i) THEN
    INSERT INTO registro.letture (ts, attore, via, richiesta, ruolo_db, origine, filtri, chieste, righe)
    VALUES (now(), nullif(current_setting('cerbero.attore', true), ''), nullif(current_setting('cerbero.via', true), ''),
            nullif(current_setting('cerbero.richiesta', true), ''), session_user, current_setting('application_name', true),
            f, p_limite, quante::integer);
  END IF;
END
$leggi$;
--> statement-breakpoint
ALTER FUNCTION registro.leggi(jsonb, integer) OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.leggi(jsonb, integer) FROM PUBLIC;
--> statement-breakpoint
-- Lo stato, per la pagina: acceso o no, da quando e con quale base giuridica,
-- i mesi, le tabelle sorvegliate. L'app non legge le tabelle del registro.
CREATE OR REPLACE FUNCTION registro.stato() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $stato$
  SELECT jsonb_build_object(
           'attivo', i.attivo, 'attivato_il', i.attivato_il, 'base_giuridica', i.base_giuridica,
           'anonimizza_dopo_mesi', i.anonimizza_dopo_mesi, 'conservazione_mesi', i.conservazione_mesi,
           'tabelle', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                'tabella', s.tabella, 'ambito_tipo', s.ambito_tipo,
                                'con_valori', s.con_valori OR cardinality(s.valori_di) > 0,
                                'riepilogo_sempre', s.riepilogo_sempre) ORDER BY s.tabella), '[]'::jsonb)
                         FROM registro.sorvegliate s))
    FROM registro.impostazioni i
$stato$;
--> statement-breakpoint
ALTER FUNCTION registro.stato() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.stato() FROM PUBLIC;
--> statement-breakpoint
-- La manutenzione: in più l'anonimizzazione di chi modifica la propria riga e
-- la scadenza delle consultazioni.
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
  letture_     bigint := 0;
  sommati      bigint := 0;
  k            bigint;
  piena        boolean;
  p            record;
  limite       timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('cerbero:registro', 0)) THEN
    RETURN jsonb_build_object('saltata', true);
  END IF;
  SELECT * INTO imp FROM registro.impostazioni;
  -- i parziali di transazioni chiuse senza la somma (non deve succedere: verifica() li segnala)
  FOR p IN SELECT DISTINCT q.transazione FROM registro.parziali q
            WHERE q.transazione IS DISTINCT FROM pg_current_xact_id_if_assigned() LOOP
    sommati := sommati + registro.somma(p.transazione);
  END LOOP;
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
  -- chi l'ha fatto non deve restare nemmeno come oggetto della modifica: dove la
  -- riga cambiata è la sua (la propria password, la propria verifica, sé stesso
  -- fra i membri di un progetto) si tolgono anche l'ambito, la chiave e il campione
  UPDATE registro.modifiche m
     SET ambito_id = CASE WHEN m.ambito_id = m.attore THEN NULL ELSE m.ambito_id END,
         -- (l'attore fra i valori, non nel testo: «id» non è la chiave {"id": …})
         chiave    = CASE WHEN EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(m.chiave) = 'object' THEN m.chiave ELSE '{}'::jsonb END) AS e
                                        WHERE e.value = m.attore) THEN NULL ELSE m.chiave END,
         campione  = CASE WHEN EXISTS (SELECT 1
                                         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.campione) = 'array' THEN m.campione ELSE '[]'::jsonb END) AS el
                                        CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(el) = 'object' THEN el ELSE '{}'::jsonb END) AS e
                                        WHERE e.value = m.attore) THEN NULL ELSE m.campione END,
         attore = NULL, richiesta = NULL
   WHERE m.ts < limite AND (m.attore IS NOT NULL OR m.richiesta IS NOT NULL);
  GET DIAGNOSTICS anonimizzate = ROW_COUNT;
  -- le consultazioni (registro.leggi) si conservano quanto il nome di chi modifica
  DELETE FROM registro.letture l WHERE l.ts < limite;
  GET DIAGNOSTICS letture_ = ROW_COUNT;

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
                            'svuotate', svuotate, 'cancellate', cancellate, 'letture_cancellate', letture_,
                            'riepiloghi_sommati', sommati);
END
$manutenzione$;
--> statement-breakpoint
ALTER FUNCTION registro.manutenzione() OWNER TO cerbero_registro;
--> statement-breakpoint
REVOKE ALL ON FUNCTION registro.manutenzione() FROM PUBLIC;
--> statement-breakpoint
-- ── Le attivazioni programmate: il canale di chi programma ───────────────
ALTER TABLE public.ps_pending_activations ADD COLUMN IF NOT EXISTS via text;
--> statement-breakpoint
-- ── La seconda ondata ────────────────────────────────────────────────────
-- Gli orari di dettaglio: sempre in riepilogo, senza valori. La chiave è
-- composta; l'ambito è la corsa, la variante, il calendario.
SELECT registro.sorveglia('public.ps_stop_times', ARRAY['trip_id', 'stop_seq'], 'corsa', 'trip_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_variant_stops', ARRAY['variant_id', 'seq'], 'variante', 'variant_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_calendar_dates', ARRAY['calendar_id', 'date'], 'calendario', 'calendar_id', false, '{}', '{}', '{}', true);
--> statement-breakpoint
-- Tracciati, periodi di servizio, nodi di interscambio, zone vietate,
-- attivazioni programmate: coi valori (geometrie e poligoni sono jsonb: solo il nome)
SELECT registro.sorveglia('public.ps_shapes', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_service_periods', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_stop_clusters', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_no_go_zones', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_pending_activations', ARRAY['id'], 'progetto_ps', 'project_id', true);
--> statement-breakpoint
-- L'app: in più legge il registro con leggi() e ne chiede lo stato. Niente
-- diritti sulle tabelle. Li ridà anche il riallineamento dei ruoli a ogni avvio.
DO $diritti$
BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION registro.leggi(jsonb, integer) TO cerbero_owner;
    GRANT EXECUTE ON FUNCTION registro.stato() TO cerbero_owner;
  END IF;
END
$diritti$;
