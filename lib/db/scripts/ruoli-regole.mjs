// I ruoli del database di Cerbero (PR 2.8): l'app non si collega più come
// superutente.
//
//   cerbero_owner  NOLOGIN, proprietario delle tabelle, viste e sequenze di
//                  Cerbero (quelle del catalogo, meta/catalogo.json).
//   cerbero_app    l'utente dell'app (API e lavoratore): membro di
//                  cerbero_owner senza ereditarne i diritti (INHERIT FALSE) ma
//                  con SET, e con `role = cerbero_owner` come impostazione
//                  del ruolo: ogni sessione lavora come cerbero_owner, e le
//                  unità pigre (DDL a runtime, fino alla 2.16) creano oggetti
//                  suoi. Nasce NOLOGIN e senza password: la password e il
//                  LOGIN li dà chi gestisce il database (DEPLOY.md, «Ruoli del
//                  database»); qui non si toccano più.
//
// Gli schemi restano di chi li ha creati (postgres): a cerbero_owner vanno
// USAGE e CREATE su public, caronte e coda (CREATE perché `CREATE ... IF NOT
// EXISTS` controlla il diritto prima di vedere che l'oggetto c'è; USAGE su
// public perché in produzione lo schema è stato ricreato e PUBLIC potrebbe non
// averlo: senza, falliscono anche i controlli delle chiavi esterne), USAGE su
// cerbero_migrazioni e SELECT sulla tabella di tracciamento (la guardia di
// versione) e sui contratti (il controllo di Argos). cerbero_migrazioni resta
// di chi migra: il contratto di Argos lo scrive solo lui (regola «fidato»,
// argos-permessi-regole.mjs).
//
// La proprietà passa oggetto per oggetto (`REASSIGN OWNED BY postgres` è
// rifiutato per il superutente d'installazione), e solo dagli oggetti di un
// superutente o di cerbero_app: un oggetto di un altro ruolo (per esempio del
// sistema AVM in caronte) non si tocca, è un errore con la cura scritta. Mai:
// oggetti di estensioni, caronte.app_users, cerbero_migrazioni. ALTER ...
// OWNER riscrive le ACL: i permessi dati da postgres (ad argos_ro,
// caronte_app, fleetcare_app) restano, col nuovo proprietario come concedente.
// Prima le tabelle; una vista solo quando tutte le sue relazioni sono già di
// cerbero_owner (altrimenti chi la legge come postgres riceverebbe «permission
// denied» sulle tabelle sotto); le sequenze legate a una tabella la seguono da
// sole e non si toccano mai direttamente.
//
// leggiStato legge il catalogo; piano (puro) dice cosa fare; allinea lo fa,
// un'istruzione per transazione con un lock_timeout breve e un tetto di tempo
// (gli oggetti occupati si riprovano al prossimo avvio); verifica lo riporta
// soltanto. Su un database in regola allinea non scrive niente.
//
// Niente import.meta né JSON letti qui: l'elenco delle relazioni lo passa chi
// chiama (elencoDalCatalogo).

import { CHIAVE_LUCCHETTO, TRACCIAMENTO, descriviErrore, ritentabile } from "./migrazioni-regole.mjs";
import {
  APP, ESCLUSE, EVENTO_DDL, EVENTO_DDL_FINE, FUNZIONE_EVENTO_DDL, PROPRIETARIO, REGISTRO, SCHEMA_REGISTRO, elencoDalCatalogo,
} from "./ruoli-nomi.mjs";

export { APP, ESCLUSE, EVENTO_DDL, EVENTO_DDL_FINE, FUNZIONE_EVENTO_DDL, PROPRIETARIO, REGISTRO, SCHEMA_REGISTRO, elencoDalCatalogo };

/** I soli comandi di DDL che l'app può eseguire: quelli delle unità pigre, fino alla 2.16. */
export const COMANDI_DELL_APP = Object.freeze(["CREATE TABLE", "CREATE TABLE AS", "CREATE INDEX", "ALTER TABLE"]);

/**
 * Le funzioni che possono stare nei default, nei vincoli CHECK, nelle colonne
 * generate e negli indici delle tabelle che l'app può cambiare, oltre a quelle
 * degli operatori e dei cast di sistema (pg_catalog: confronti, somme,
 * conversioni). Un'espressione di una tabella la esegue chi scrive la riga, il
 * migratore che cambia la colonna (ALTER COLUMN … TYPE rivaluta i CHECK), il
 * ripristino di un backup: a volte un superutente. Una funzione che esegue SQL
 * passato come testo (query_to_xml, ts_stat), legge tabelle o file
 * (table_to_xml, pg_read_file, lo_export) o cambia impostazioni (set_config)
 * sarebbe lì codice dell'app eseguito come superutente: la revisione lo ha
 * riprodotto con un CHECK aggiunto da cerbero_app. Sono le funzioni che usano
 * oggi le migrazioni e le unità pigre (nomi come li scrive regprocedure con
 * search_path = pg_catalog). Una nuova va guardata e aggiunta qui: la CI la
 * segnala (ruoli.mjs --verifica sulla copia della produzione e le unità pigre
 * come cerbero_app).
 */
export const FUNZIONI_AMMESSE = Object.freeze([
  "btrim(text)", "char_length(text)", "float8(integer)", "float8(numeric)", "gen_random_uuid()", "int2(integer)",
  "lower(text)", "nextval(regclass)", "now()",
]);

/**
 * Le espressioni (default e colonne generate, vincoli, indici, statistiche,
 * chiavi di partizione) e le colonne delle tabelle in `tabelle` (un'espressione
 * SQL di tipo oid[]) che fanno girare codice non ammesso:
 * - una funzione chiamata: si legge dall'albero salvato dell'espressione
 *   (:funcid, :opfuncid…, e gli operatori per :opno/:opnos), non dalle
 *   dipendenze, che verso gli oggetti di sistema non si registrano. Ammesse:
 *   FUNZIONI_AMMESSE, le funzioni degli operatori di pg_catalog e i cast di
 *   sistema;
 * - una funzione chiamata attraverso un tipo: il CHECK o il DEFAULT di un
 *   dominio, l'input o l'output di un tipo (una conversione, una colonna). Si
 *   seguono i tipi delle colonne e quelli nominati nelle espressioni, fino al
 *   tipo base dei domini, agli elementi degli array, agli attributi dei tipi
 *   composti e ai range. Ammessi i domini di sistema (pg_catalog,
 *   information_schema), i tipi con funzioni tutte di pg_catalog e i tipi delle
 *   estensioni (PostGIS). La terza revisione lo ha provato con un dominio con
 *   CHECK (pg_read_file(…)) creato da un superutente: la colonna dell'app
 *   passava, e l'INSERT da superutente leggeva il file.
 */
export const sqlEspressioniVietate = (tabelle) => `
WITH RECURSIVE espr AS (
    SELECT a.adrelid AS rel, pg_catalog.format('il default di %I', t.attname) AS oggetto,
           pg_catalog.format('ALTER TABLE %s ALTER COLUMN %I DROP %s', a.adrelid::pg_catalog.regclass, t.attname,
                             CASE WHEN t.attgenerated <> '' THEN 'EXPRESSION' ELSE 'DEFAULT' END) AS cura,
           a.adbin::text AS albero
      FROM pg_catalog.pg_attrdef a
      JOIN pg_catalog.pg_attribute t ON t.attrelid = a.adrelid AND t.attnum = a.adnum
     WHERE a.adrelid = ANY (${tabelle})
    UNION ALL
    SELECT k.conrelid, pg_catalog.format('il vincolo %I', k.conname),
           pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', k.conrelid::pg_catalog.regclass, k.conname), k.conbin::text
      FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = ANY (${tabelle}) AND k.conbin IS NOT NULL
    UNION ALL
    SELECT i.indrelid, pg_catalog.format('l''indice %s', i.indexrelid::pg_catalog.regclass),
           pg_catalog.format('DROP INDEX %s', i.indexrelid::pg_catalog.regclass),
           pg_catalog.concat_ws(' ', i.indexprs::text, i.indpred::text)
      FROM pg_catalog.pg_index i
     WHERE i.indrelid = ANY (${tabelle}) AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL)
    UNION ALL
    SELECT x.stxrelid, pg_catalog.format('la statistica %I', x.stxname),
           pg_catalog.format('DROP STATISTICS %I.%I', xn.nspname, x.stxname), x.stxexprs::text
      FROM pg_catalog.pg_statistic_ext x
      JOIN pg_catalog.pg_namespace xn ON xn.oid = x.stxnamespace
     WHERE x.stxrelid = ANY (${tabelle}) AND x.stxexprs IS NOT NULL
    UNION ALL
    SELECT pt.partrelid, 'la chiave di partizione', 'la tabella va ricreata', pt.partexprs::text
      FROM pg_catalog.pg_partitioned_table pt
     WHERE pt.partrelid = ANY (${tabelle}) AND pt.partexprs IS NOT NULL
), funzioni AS (
  SELECT e.rel, e.oggetto, e.cura, p.oid::pg_catalog.regprocedure::text AS cosa
    FROM espr e
   CROSS JOIN LATERAL (
     SELECT m[1]::oid AS f
       FROM pg_catalog.regexp_matches(e.albero, ':(?:funcid|opfuncid|hashfuncid|negfuncid|aggfnoid|winfnoid) ([0-9]+)', 'g') AS m
     UNION
     SELECT o.oprcode::oid
       FROM pg_catalog.regexp_matches(e.albero, ':opno ([0-9]+)', 'g') AS m
       JOIN pg_catalog.pg_operator o ON o.oid = m[1]::oid
     UNION
     SELECT o.oprcode::oid
       FROM pg_catalog.regexp_matches(e.albero, ':opnos [(]o([0-9 ]+)[)]', 'g') AS m
      CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(pg_catalog.btrim(m[1]), ' ')) AS n(numero)
       JOIN pg_catalog.pg_operator o ON o.oid = n.numero::oid
   ) u
    JOIN pg_catalog.pg_proc p ON p.oid = u.f
   WHERE NOT (p.oid::pg_catalog.regprocedure::text = ANY (ARRAY[${FUNZIONI_AMMESSE.map((f) => `'${f}'`).join(", ")}]::text[]))
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_operator o
                      WHERE o.oprcode = p.oid AND o.oprnamespace = 'pg_catalog'::pg_catalog.regnamespace)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_cast c
                      WHERE c.castfunc = p.oid AND p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace)
), tipi (rel, oggetto, cura, tipo) AS (
    SELECT t.attrelid, pg_catalog.format('la colonna %I', t.attname),
           pg_catalog.format('ALTER TABLE %s DROP COLUMN %I', t.attrelid::pg_catalog.regclass, t.attname), t.atttypid
      FROM pg_catalog.pg_attribute t
     WHERE t.attrelid = ANY (${tabelle}) AND t.attnum > 0 AND NOT t.attisdropped
    UNION
    SELECT e.rel, e.oggetto, e.cura, m[1]::oid
      FROM espr e
     CROSS JOIN LATERAL pg_catalog.regexp_matches(e.albero, ':[a-z_]*typ(?:e|id|eid)? ([0-9]+)', 'g') AS m
    UNION
    SELECT c.rel, c.oggetto, c.cura, x.tipo
      FROM tipi c
      JOIN pg_catalog.pg_type y ON y.oid = c.tipo
     CROSS JOIN LATERAL (
       SELECT y.typbasetype WHERE y.typtype = 'd'
       UNION ALL SELECT y.typelem WHERE y.typelem <> 0
       UNION ALL SELECT a.atttypid FROM pg_catalog.pg_attribute a
                  WHERE y.typrelid <> 0 AND a.attrelid = y.typrelid AND a.attnum > 0 AND NOT a.attisdropped
       UNION ALL SELECT r.rngsubtype FROM pg_catalog.pg_range r WHERE r.rngtypid = y.oid
       UNION ALL SELECT r.rngtypid FROM pg_catalog.pg_range r WHERE r.rngmultitypid = y.oid
     ) AS x(tipo)
), tipi_vietati AS (
  SELECT c.rel, c.oggetto, c.cura,
         pg_catalog.format(CASE WHEN y.typtype = 'd' THEN 'il dominio %s' ELSE 'il tipo %s' END, y.oid::pg_catalog.regtype) AS cosa
    FROM tipi c
    JOIN pg_catalog.pg_type y ON y.oid = c.tipo
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid = y.oid AND d.deptype = 'e')
     AND ((y.typtype = 'd' AND y.typnamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                                    'information_schema'::pg_catalog.regnamespace))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc f
                      WHERE f.oid IN (y.typinput::oid, y.typoutput::oid, y.typreceive::oid, y.typsend::oid, y.typmodin::oid,
                                      y.typmodout::oid, y.typanalyze::oid, y.typsubscript::oid)
                        AND f.pronamespace <> 'pg_catalog'::pg_catalog.regnamespace)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_range r
                       JOIN pg_catalog.pg_proc f ON f.oid IN (r.rngcanonical::oid, r.rngsubdiff::oid)
                      WHERE r.rngtypid = y.oid AND f.pronamespace <> 'pg_catalog'::pg_catalog.regnamespace))
)
SELECT v.rel::pg_catalog.regclass::text AS tabella, v.oggetto, v.cura, pg_catalog.string_agg(DISTINCT v.cosa, ', ') AS funzioni
  FROM (SELECT * FROM funzioni UNION ALL SELECT * FROM tipi_vietati) v
 GROUP BY 1, 2, 3
 ORDER BY 1, 2`;

/**
 * Il corpo della funzione dei due event trigger. Per l'app (sessione
 * cerbero_app, o chiunque lavori come cerbero_owner o cerbero_app):
 * - all'inizio del comando passano solo i comandi delle unità pigre, e
 *   CREATE INDEX non CONCURRENTLY (che si chiude in più transazioni: il
 *   controllo di fine comando non potrebbe più annullare l'indice). Tutto il
 *   resto (CREATE FUNCTION anche in pg_temp, VIEW, OPERATOR, AGGREGATE, TYPE,
 *   CAST, RULE, TRIGGER, POLICY, DROP, GRANT…) si ferma con 42501. Senza, un
 *   oggetto messo dall'app in public (dove ha CREATE per le unità pigre) o un
 *   trigger su una sua tabella girerebbero come superutente quando un
 *   superutente li incontra: il migratore, un amministratore in psql, una
 *   funzione SECURITY DEFINER di FleetCare;
 * - alla fine del comando, le espressioni e le colonne delle tabelle toccate
 *   (anche con ALTER TABLE, CREATE TABLE … LIKE, CREATE INDEX) usano solo
 *   funzioni ammesse (FUNZIONI_AMMESSE) e tipi di sistema
 *   (sqlEspressioniVietate), altrimenti 42501 e il comando si annulla. Le
 *   tabelle temporanee non contano: le vede solo la sessione che le crea.
 */
export const CORPO_EVENTO_DDL = `
DECLARE
  tabelle oid[];
  vietate text;
BEGIN
  IF NOT (session_user = '${APP}' OR current_user IN ('${PROPRIETARIO}', '${APP}')) THEN
    RETURN;
  END IF;
  IF tg_event = 'ddl_command_start' THEN
    IF tg_tag NOT IN (${COMANDI_DELL_APP.map((c) => `'${c}'`).join(", ")}) THEN
      RAISE EXCEPTION '${APP} non può eseguire %: lo schema lo cambiano solo le migrazioni (lib/db/migrations)', tg_tag
        USING ERRCODE = '42501';
    END IF;
    IF tg_tag = 'CREATE INDEX' AND coalesce(pg_catalog.current_query(), '') ~* '\\mconcurrently\\M' THEN
      RAISE EXCEPTION '${APP} non può eseguire CREATE INDEX CONCURRENTLY: va in più transazioni, e un indice rifiutato a fine comando resterebbe lì'
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT coalesce(i.indrelid, c.oid)) INTO tabelle
    FROM pg_catalog.pg_event_trigger_ddl_commands() x
    JOIN pg_catalog.pg_class c ON c.oid = x.objid
    LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
   WHERE x.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND c.relpersistence <> 't';
  IF tabelle IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_catalog.string_agg(pg_catalog.format('%s, %s: %s', v.tabella, v.oggetto, v.funzioni), '; ') INTO vietate
    FROM (${sqlEspressioniVietate("tabelle")}) v;
  IF vietate IS NOT NULL THEN
    RAISE EXCEPTION '${APP} non può usare queste funzioni o tipi in colonne, default, vincoli o indici: %', vietate
      USING ERRCODE = '42501',
            HINT = 'Un''espressione o il tipo di una colonna li esegue anche chi scrive da superutente. '
                   || 'Ammesse: FUNZIONI_AMMESSE in lib/db/scripts/ruoli-regole.mjs, operatori, cast e tipi di sistema';
  END IF;
  -- il registro delle modifiche (PR 2.10): l'app, proprietaria delle tabelle,
  -- non ne spegne i trigger (ALTER TABLE … DISABLE TRIGGER / ENABLE REPLICA
  -- passano il controllo d'inizio) e non sostituisce né rinomina una tabella
  -- sorvegliata (ne creerebbe una senza trigger al suo posto)
  IF pg_catalog.to_regclass('${SCHEMA_REGISTRO}.sorvegliate') IS NOT NULL THEN
    SELECT pg_catalog.string_agg(pg_catalog.format('%s %s', t.tgrelid::pg_catalog.regclass, t.tgname), ', ') INTO vietate
      FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = ANY (tabelle) AND t.tgname LIKE 'registro\\_%' AND t.tgenabled <> 'A';
    IF vietate IS NOT NULL THEN
      RAISE EXCEPTION '${APP} non può spegnere i trigger del registro delle modifiche: %', vietate USING ERRCODE = '42501';
    END IF;
    SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO vietate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = ANY (tabelle)
       AND EXISTS (SELECT 1 FROM ${SCHEMA_REGISTRO}.sorvegliate s WHERE s.tabella = n.nspname || '.' || c.relname)
           <> EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'registro_inserisce');
    IF vietate IS NOT NULL THEN
      RAISE EXCEPTION '${APP} non può rinominare, spostare o sostituire una tabella del registro delle modifiche: %', vietate
        USING ERRCODE = '42501';
    END IF;
    -- né ne rinomina le colonne: le regole le nominano (role → role_cached
    -- finirebbe tra le escluse, e i cambi di ruolo non si vedrebbero più)
    SELECT pg_catalog.string_agg(x.object_identity, ', ') INTO vietate
      FROM pg_catalog.pg_event_trigger_ddl_commands() x
      JOIN pg_catalog.pg_class c ON c.oid = x.objid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE x.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND x.object_type = 'table column'
       AND EXISTS (SELECT 1 FROM ${SCHEMA_REGISTRO}.sorvegliate s WHERE s.tabella = n.nspname || '.' || c.relname);
    IF vietate IS NOT NULL THEN
      RAISE EXCEPTION '${APP} non può rinominare le colonne di una tabella del registro delle modifiche: %', vietate
        USING ERRCODE = '42501';
    END IF;
  END IF;
END
`;
/** Gli schemi delle tabelle di Cerbero: USAGE e CREATE al proprietario. */
export const SCHEMI_DATI = Object.freeze(["public", "caronte", "coda"]);
/** Le funzioni di FleetCare che Cerbero chiama (lib/officina.ts): le concede FleetCare (0073, 0083, 0089). */
export const FUNZIONI_FLEETCARE = Object.freeze([
  "fleetcare.parco_per_avm()",
  "fleetcare.interventi_avm(timestamp with time zone)",
]);
/**
 * Chi altro legge dati di Cerbero, e quali colonne: le funzioni di FleetCare
 * che leggono utenti e depositi sono di fleetcare_legge_cerbero (FleetCare,
 * migrazione 0089), che non è superutente e legge solo questo. I diritti li dà
 * il proprietario dei dati a ogni avvio (e la 0089 la prima volta): restano
 * anche se una tabella si ricrea. Se il ruolo non c'è (FleetCare prima della
 * 0089, o assente) non si fa niente.
 */
export const LETTORI = Object.freeze({
  fleetcare_legge_cerbero: Object.freeze({
    "public.users": Object.freeze(["id", "email", "full_name", "role", "fleetcare_role", "active", "permissions",
      "sessione_versione", "deve_cambiare_password", "mfa_attiva"]),
    "public.depots": Object.freeze(["name"]),
  }),
});
/** Le tabelle di cerbero_migrazioni che l'app legge (guardia di versione, controllo di Argos). */
export const DA_LEGGERE = Object.freeze([`${TRACCIAMENTO.migrationsSchema}.${TRACCIAMENTO.migrationsTable}`, `${TRACCIAMENTO.migrationsSchema}.contratti`,
  // le regole del registro: le legge l'event trigger dell'app (PR 2.10)
  `${SCHEMA_REGISTRO}.sorvegliate`]);
/** Le funzioni del registro che l'app chiama: la manutenzione del lavoratore e la verifica (PR 2.10). */
export const DA_ESEGUIRE = Object.freeze([`${SCHEMA_REGISTRO}.manutenzione()`, `${SCHEMA_REGISTRO}.verifica()`]);

const ATTRIBUTI_VIETATI = [
  ["superutente", "SUPERUSER"], ["bypassrls", "BYPASSRLS"], ["crearuoli", "CREATEROLE"],
  ["creadb", "CREATEDB"], ["replica", "REPLICATION"],
];
const TIPI = { r: "TABLE", p: "TABLE", v: "VIEW", m: "MATERIALIZED VIEW", S: "SEQUENCE" };

const id = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const relSql = (r) => `${id(r.schema)}.${id(r.nome)}`;
const nomeSql = (voce) => {
  const i = voce.indexOf(".");
  return `${id(voce.slice(0, i))}.${id(voce.slice(i + 1))}`;
};
const elencoBreve = (v, n = 8) => v.slice(0, n).join(", ") + (v.length > n ? ` e altri ${v.length - n}` : "");

/**
 * Le espressioni con funzioni non ammesse nelle tabelle che l'app può
 * cambiare: quelle del catalogo e ogni tabella (non temporanea) di
 * cerbero_owner o cerbero_app negli schemi di Cerbero. Le legge anche il
 * migratore prima di migrare: una migrazione da superutente le eseguirebbe.
 */
export async function espressioniVietate(client, elenco) {
  const { rows } = await client.query(sqlEspressioniVietate(`ARRAY(
    SELECT c.oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     WHERE c.relkind IN ('r', 'p') AND c.relpersistence <> 't'
       AND (c.oid IN (SELECT pg_catalog.to_regclass(v) FROM pg_catalog.unnest($1::text[]) AS v)
            OR (n.nspname = ANY ($2::text[]) AND o.rolname IN (${lit(PROPRIETARIO)}, ${lit(APP)}))))`),
  [elenco.map((v) => nomeSql(v)), [...SCHEMI_DATI]]);
  return rows;
}

/**
 * Il registro delle modifiche (PR 2.10), se c'è: i diritti di chi non ne è il
 * proprietario (sulle tabelle e sulle funzioni) e i problemi che riporta
 * registro.verifica(). Ammessi solo la lettura delle regole e l'esecuzione di
 * manutenzione() e verifica() a cerbero_owner.
 */
async function leggiRegistro(client) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const [c] = await q(`SELECT to_regnamespace($1) IS NOT NULL AS c`, [SCHEMA_REGISTRO]);
  if (!c?.c) return null;
  const diritti = await q(`
    SELECT 'TABLE' AS tipo, c.oid::regclass::text AS oggetto, coalesce(g.rolname, 'PUBLIC') AS a_chi, a.privilege_type AS diritto
      FROM pg_catalog.pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE c.relnamespace = to_regnamespace($1) AND c.relkind IN ('r', 'p') AND a.grantee <> c.relowner
       AND NOT (c.relname = 'sorvegliate' AND g.rolname = $2 AND a.privilege_type = 'SELECT')
    UNION ALL
    SELECT 'FUNCTION', p.oid::regprocedure::text, coalesce(g.rolname, 'PUBLIC'), a.privilege_type
      FROM pg_catalog.pg_proc p
     CROSS JOIN LATERAL aclexplode(p.proacl) a
      LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
     WHERE p.pronamespace = to_regnamespace($1) AND a.grantee <> p.proowner
       AND NOT (p.oid::regprocedure::text = ANY ($3::text[]) AND g.rolname = $2)
     ORDER BY 1, 2, 3`, [SCHEMA_REGISTRO, PROPRIETARIO, DA_ESEGUIRE]);
  const [f] = await q(`SELECT to_regprocedure($1) IS NOT NULL AS c`, [`${SCHEMA_REGISTRO}.verifica()`]);
  const problemi = f?.c ? (await q(`SELECT v AS problema FROM ${SCHEMA_REGISTRO}.verifica() AS v`)).map((r) => r.problema) : [];
  return { diritti, problemi };
}

/**
 * Lo stato del database per i due ruoli. Solo letture del catalogo di sistema
 * (leggibili da tutti), nessun lock.
 */
export async function leggiStato(client, elenco) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const [io] = await q(`
    SELECT current_user AS utente, session_user AS sessione, current_database() AS database,
           (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente`);
  const ruoli = await q(`
    SELECT rolname AS nome, rolcanlogin AS login, rolsuper AS superutente, rolbypassrls AS bypassrls,
           rolcreaterole AS crearuoli, rolcreatedb AS creadb, rolreplication AS replica,
           EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
                    WHERE s.setrole = r.oid AND s.setdatabase = 0
                      AND ${lit(`role=${PROPRIETARIO}`)} = ANY (s.setconfig)) AS col_ruolo
      FROM pg_catalog.pg_roles r WHERE rolname = ANY ($1)`, [[PROPRIETARIO, APP, REGISTRO]]);
  // le appartenenze che toccano i due ruoli, in entrambe le direzioni (PG16+: opzioni INHERIT e SET)
  const appartenenze = await q(`
    SELECT g.rolname AS ruolo, m.rolname AS membro, a.admin_option AS admin,
           a.inherit_option AS eredita, a.set_option AS imposta
      FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = a.member
     WHERE g.rolname = ANY ($1) OR m.rolname = ANY ($1)`, [[PROPRIETARIO, APP, REGISTRO]]);
  const esiste = (n) => ruoli.some((r) => r.nome === n);
  const [db] = await q(`
    SELECT CASE WHEN $1 THEN has_database_privilege(${lit(APP)}, current_database(), 'CONNECT') END AS connette,
           CASE WHEN $2 THEN has_database_privilege(${lit(PROPRIETARIO)}, current_database(), 'TEMPORARY') END AS temporanee`,
  [esiste(APP), esiste(PROPRIETARIO)]);
  const schemi = await q(`
    SELECT s.nome, n.oid IS NOT NULL AS esiste,
           CASE WHEN n.oid IS NOT NULL AND $2 THEN has_schema_privilege(${lit(PROPRIETARIO)}, n.oid, 'USAGE') END AS uso,
           CASE WHEN n.oid IS NOT NULL AND $2 THEN has_schema_privilege(${lit(PROPRIETARIO)}, n.oid, 'CREATE') END AS crea
      FROM unnest($1::text[]) AS s(nome)
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = s.nome`,
  [[...SCHEMI_DATI, TRACCIAMENTO.migrationsSchema, SCHEMA_REGISTRO], esiste(PROPRIETARIO)]);
  const lettura = await q(`
    SELECT v.voce, to_regclass(v.voce) IS NOT NULL AS esiste,
           CASE WHEN to_regclass(v.voce) IS NOT NULL AND $2
                THEN has_table_privilege(${lit(PROPRIETARIO)}, to_regclass(v.voce), 'SELECT') END AS legge
      FROM unnest($1::text[]) AS v(voce)`, [DA_LEGGERE, esiste(PROPRIETARIO)]);
  // le funzioni del registro che l'app chiama, e i diritti in più su ciò che è del registro
  const esecuzione = await q(`
    SELECT f.firma, to_regprocedure(f.firma) IS NOT NULL AS esiste,
           CASE WHEN to_regprocedure(f.firma) IS NOT NULL AND $2
                THEN has_function_privilege(${lit(PROPRIETARIO)}, to_regprocedure(f.firma), 'EXECUTE') END AS esegue
      FROM unnest($1::text[]) AS f(firma)`, [DA_ESEGUIRE, esiste(PROPRIETARIO)]);
  const registro = await leggiRegistro(client);
  // le relazioni del catalogo che ci sono: proprietario, se è di un'estensione,
  // se è una sequenza legata a una tabella, e per le viste di chi sono le
  // relazioni da cui dipendono
  const relazioni = await q(`
    SELECT n.nspname AS schema, c.relname AS nome, c.relkind AS tipo, o.rolname AS proprietario,
           o.rolsuper AS di_superutente,
           EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS estensione,
           (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
                      AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i'))) AS legata,
           CASE WHEN c.relkind IN ('v', 'm') THEN (
             SELECT coalesce(array_agg(DISTINCT format('%s.%s|%s', bn.nspname, b.relname, bo.rolname)), '{}')
               FROM pg_catalog.pg_rewrite w
               JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = w.oid
                                          AND d.refclassid = 'pg_catalog.pg_class'::regclass
               JOIN pg_catalog.pg_class b ON b.oid = d.refobjid AND b.oid <> c.oid
               JOIN pg_catalog.pg_namespace bn ON bn.oid = b.relnamespace
               JOIN pg_catalog.pg_roles bo ON bo.oid = b.relowner
              WHERE w.ev_class = c.oid) END AS basi
      FROM unnest($1::text[]) AS v(voce)
      JOIN pg_catalog.pg_class c ON c.oid = to_regclass(v.voce)
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     ORDER BY 1, 2`, [elenco.map((v) => nomeSql(v))]);
  const fleetcare = await q(`
    SELECT f.firma, to_regprocedure(f.firma) IS NOT NULL AS esiste,
           CASE WHEN to_regprocedure(f.firma) IS NOT NULL AND $2
                THEN has_schema_privilege(${lit(PROPRIETARIO)}, 'fleetcare', 'USAGE')
                     AND has_function_privilege(${lit(PROPRIETARIO)}, to_regprocedure(f.firma), 'EXECUTE') END AS chiama
      FROM unnest($1::text[]) AS f(firma)`, [FUNZIONI_FLEETCARE, esiste(PROPRIETARIO)]);
  // le colonne che leggono gli altri (LETTORI), quelle che ci sono
  const voci = Object.entries(LETTORI).flatMap(([r, tabelle]) =>
    Object.entries(tabelle).flatMap(([t, colonne]) => colonne.map((c) => ({ r, t, c }))));
  const lettori = await q(`
    SELECT v.ruolo, v.tabella, v.colonna, has_schema_privilege(v.ruolo, split_part(v.tabella, '.', 1), 'USAGE') AS uso,
           has_column_privilege(v.ruolo, to_regclass(v.tabella), v.colonna, 'SELECT') AS legge
      FROM unnest($1::text[], $2::text[], $3::text[]) AS v(ruolo, tabella, colonna)
     WHERE to_regrole(v.ruolo) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass(v.tabella)
                      AND a.attname = v.colonna AND a.attnum > 0 AND NOT a.attisdropped)`,
  [voci.map((v) => v.r), voci.map((v) => v.t), voci.map((v) => v.c)]);
  // vie di fuga: funzioni SECURITY DEFINER di un superutente, fuori dalle
  // estensioni, che nominano tabelle di Cerbero. Con le tabelle di
  // cerbero_owner, l'app potrebbe metterci al posto una vista che chiama una
  // funzione sua, e farla girare come superutente (FleetCare 0089)
  // (nomi anche fra virgolette, e i corpi SQL standard, BEGIN ATOMIC, dalle
  // dipendenze registrate)
  const fughe = await q(`
    SELECT p.oid::regprocedure::text AS funzione, o.rolname AS proprietario
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND o.rolsuper
       AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND (p.prosrc ~* '\\m"?(public|caronte|coda)"?\\s*\\.'
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                         JOIN pg_catalog.pg_class c ON c.oid = d.refobjid
                         JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid
                          AND d.refclassid = 'pg_catalog.pg_class'::regclass
                          AND cn.nspname IN ('public', 'caronte', 'coda')))
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY 1`);
  // i due event trigger che tengono il DDL dell'app dentro le unità pigre
  const [evento] = await q(`
    SELECT to_regprocedure($1) IS NOT NULL AS funzione,
           (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure($1)) AS corpo,
           (SELECT o.rolsuper FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
             WHERE p.oid = to_regprocedure($1)) AS di_superutente,
           (SELECT has_function_privilege('public', to_regprocedure($1), 'EXECUTE')
             WHERE to_regprocedure($1) IS NOT NULL) AS di_tutti,
           e.evtenabled AS acceso, e.evtevent AS momento, e.evtfoid = to_regprocedure($1) AS sua,
           f.evtenabled AS fine_acceso, f.evtevent AS fine_momento, f.evtfoid = to_regprocedure($1) AS fine_sua
      FROM (SELECT 1) x
      LEFT JOIN pg_catalog.pg_event_trigger e ON e.evtname = $2
      LEFT JOIN pg_catalog.pg_event_trigger f ON f.evtname = $3`, [FUNZIONE_EVENTO_DDL, EVENTO_DDL, EVENTO_DDL_FINE]);
  // default, vincoli e indici con funzioni non ammesse
  const espressioni = await espressioniVietate(client, elenco);
  // relazioni di un superutente negli schemi di Cerbero che non sono nel
  // catalogo: l'app non le usa e il riallineamento non le sposta (un backup
  // fatto a mano, un avanzo); API e lavoratore le segnalano soltanto
  const estranee = await q(`
    SELECT n.nspname || '.' || c.relname AS nome, c.relkind AS tipo, o.rolname AS proprietario
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     WHERE n.nspname = ANY ($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm') AND o.rolsuper
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND n.nspname || '.' || c.relname <> ALL ($2::text[])
     ORDER BY 1`, [[...SCHEMI_DATI], [...elenco, ...ESCLUSE]]);
  return {
    io, ruoli, appartenenze, database: db, schemi, lettura, esecuzione, registro, lettori, fughe, evento, espressioni, estranee,
    relazioni: relazioni.map((r) => ({ ...r, basi: (r.basi ?? []).map((b) => {
      const [nome, proprietario] = b.split("|");
      return { nome, proprietario };
    }) })),
    fleetcare,
  };
}

/**
 * Cosa fare (puro). Le azioni hanno una fase: 1 ruoli e diritti, 2 tabelle e
 * sequenze libere, 3 viste (solo quelle le cui relazioni sono già del
 * proprietario: le altre aspettano il giro dopo).
 */
export function piano(stato) {
  const azioni = [];
  const avvisi = [];
  const errori = [];
  const attese = [];
  const fai = (fase, sql, perche, oggetto = null) => azioni.push({ fase, sql, perche, oggetto });

  if (!stato.io.superutente) {
    return {
      azioni, attese, avvisi,
      errori: [`${stato.io.utente} non è un superutente: ruoli, diritti e proprietari li sistema solo il migratore `
        + "(DATABASE_MIGRATOR_URL, l'utente postgres)"],
    };
  }
  const ruolo = (n) => stato.ruoli.find((r) => r.nome === n);
  const proprietario = ruolo(PROPRIETARIO);
  const app = ruolo(APP);

  // ── fase 1: ruoli, appartenenza, impostazione del ruolo, diritti ──
  if (!proprietario) fai(1, `CREATE ROLE ${id(PROPRIETARIO)} NOLOGIN`, `manca il ruolo ${PROPRIETARIO}`);
  // nasce senza accesso: la password e il LOGIN li dà chi gestisce il database
  if (!app) fai(1, `CREATE ROLE ${id(APP)} NOLOGIN`, `manca il ruolo ${APP}`);
  for (const [r, nome] of [[proprietario, PROPRIETARIO], [app, APP]]) {
    if (!r) continue;
    const vietati = ATTRIBUTI_VIETATI.filter(([k]) => r[k]);
    if (vietati.length) {
      fai(1, `ALTER ROLE ${id(nome)} ${vietati.map(([, s]) => `NO${s}`).join(" ")}`,
        `${nome} ha ${vietati.map(([, s]) => s).join(", ")}: non deve`);
    }
  }
  if (proprietario?.login) fai(1, `ALTER ROLE ${id(PROPRIETARIO)} NOLOGIN`, `${PROPRIETARIO} non deve poter entrare`);

  const membro = stato.appartenenze.find((a) => a.ruolo === PROPRIETARIO && a.membro === APP);
  if (!membro || membro.eredita || !membro.imposta) {
    fai(1, `GRANT ${id(PROPRIETARIO)} TO ${id(APP)} WITH INHERIT FALSE, SET TRUE`,
      membro ? `${APP} è membro di ${PROPRIETARIO} con le opzioni sbagliate` : `${APP} non è membro di ${PROPRIETARIO}`);
  }
  if (membro?.admin) {
    fai(1, `REVOKE ADMIN OPTION FOR ${id(PROPRIETARIO)} FROM ${id(APP)}`, `${APP} può dare ${PROPRIETARIO} ad altri`);
  }
  // altri membri, o altri ruoli di cui i due sono membri: non li tocchiamo noi
  for (const a of stato.appartenenze) {
    if (a.ruolo === PROPRIETARIO && a.membro === APP) continue;
    errori.push(`${a.membro} è membro di ${a.ruolo}: non previsto. Se non serve: REVOKE ${id(a.ruolo)} FROM ${id(a.membro)};`);
  }
  if (!app?.col_ruolo) {
    fai(1, `ALTER ROLE ${id(APP)} SET role = ${lit(PROPRIETARIO)}`,
      `le sessioni di ${APP} devono lavorare come ${PROPRIETARIO}`);
  }
  // CONNECT si controlla su cerbero_app (prima che valga l'impostazione del
  // ruolo), TEMPORARY su cerbero_owner (tabelle temporanee di Planning Studio)
  if (app && stato.database?.connette === false) {
    fai(1, `GRANT CONNECT ON DATABASE ${id(stato.io.database)} TO ${id(APP)}`, `${APP} non può collegarsi al database`);
  }
  if (proprietario && stato.database?.temporanee === false) {
    fai(1, `GRANT TEMPORARY ON DATABASE ${id(stato.io.database)} TO ${id(PROPRIETARIO)}`,
      `${PROPRIETARIO} non può creare tabelle temporanee`);
  }
  for (const s of stato.schemi) {
    if (!s.esiste) continue;
    const diritti = SCHEMI_DATI.includes(s.nome) ? ["USAGE", "CREATE"] : ["USAGE"];
    const mancano = diritti.filter((d) => !proprietario || (d === "USAGE" ? !s.uso : !s.crea));
    if (mancano.length) {
      fai(1, `GRANT ${mancano.join(", ")} ON SCHEMA ${id(s.nome)} TO ${id(PROPRIETARIO)}`,
        `${PROPRIETARIO} non ha ${mancano.join(" e ")} su ${s.nome}`);
    }
  }
  for (const t of stato.lettura) {
    if (t.esiste && (!proprietario || !t.legge)) {
      fai(1, `GRANT SELECT ON TABLE ${nomeSql(t.voce)} TO ${id(PROPRIETARIO)}`, `${PROPRIETARIO} non legge ${t.voce}`);
    }
  }
  for (const f of stato.esecuzione ?? []) {
    if (f.esiste && (!proprietario || !f.esegue)) {
      fai(1, `GRANT EXECUTE ON FUNCTION ${f.firma} TO ${id(PROPRIETARIO)}`, `${PROPRIETARIO} non può chiamare ${f.firma}`);
    }
  }

  // ── il registro delle modifiche (PR 2.10): il suo ruolo e i suoi diritti ──
  if (stato.registro) {
    const reg = ruolo(REGISTRO);
    if (!reg) {
      fai(1, `CREATE ROLE ${id(REGISTRO)} NOLOGIN`, `manca il ruolo ${REGISTRO}, proprietario del registro delle modifiche`);
    } else {
      const vietati = ATTRIBUTI_VIETATI.filter(([k]) => reg[k]);
      if (vietati.length || reg.login) {
        fai(1, `ALTER ROLE ${id(REGISTRO)} ${[...vietati.map(([, x]) => `NO${x}`), ...(reg.login ? ["NOLOGIN"] : [])].join(" ")}`,
          `${REGISTRO} non deve poter entrare né avere attributi speciali`);
      }
    }
    for (const d of stato.registro.diritti) {
      fai(1, `REVOKE ${d.diritto} ON ${d.tipo} ${d.oggetto} FROM ${d.a_chi === "PUBLIC" ? "PUBLIC" : id(d.a_chi)}`,
        `${d.a_chi} non deve avere ${d.diritto} su ${d.oggetto}: il registro lo scrive e lo legge solo il suo proprietario`);
    }
    for (const p of stato.registro.problemi) errori.push(`registro delle modifiche: ${p}`);
  }

  // ── fasi 2 e 3: proprietà ──
  const daSpostare = (r) => r.proprietario !== PROPRIETARIO && (r.di_superutente || r.proprietario === APP);
  for (const r of stato.relazioni) {
    const nome = `${r.schema}.${r.nome}`;
    if (r.estensione || ESCLUSE.includes(nome) || r.schema === TRACCIAMENTO.migrationsSchema) continue;
    if (r.proprietario === PROPRIETARIO) continue;
    if (r.legata) {
      // segue la tabella: se questa è già passata e la sequenza no, qualcosa non va
      continue;
    }
    if (!daSpostare(r)) {
      errori.push(`${nome} è di ${r.proprietario}, non di ${PROPRIETARIO}: l'app non potrà usarla. `
        + `Se è di Cerbero: ALTER ${TIPI[r.tipo] ?? "TABLE"} ${relSql(r)} OWNER TO ${id(PROPRIETARIO)}; `
        + "se è di un'altra applicazione, va deciso con lei: le unità pigre dell'app (fino alla 2.16) ne vogliono la proprietà");
      continue;
    }
    if (r.tipo === "v" || r.tipo === "m") {
      const altrui = r.basi.filter((b) => b.proprietario !== PROPRIETARIO);
      const mai = altrui.filter((b) => !stato.relazioni.some((x) => `${x.schema}.${x.nome}` === b.nome && (x.di_superutente || x.proprietario === APP)));
      if (mai.length) {
        errori.push(`${nome} dipende da ${elencoBreve(mai.map((b) => `${b.nome} (di ${b.proprietario})`))}, `
          + `che non passa a ${PROPRIETARIO}: la vista resta di ${r.proprietario}`);
        continue;
      }
      if (altrui.length) {
        attese.push(`${nome}: aspetta ${elencoBreve(altrui.map((b) => b.nome))}`);
        continue;
      }
      fai(3, `ALTER ${TIPI[r.tipo]} ${relSql(r)} OWNER TO ${id(PROPRIETARIO)}`, `${nome} è di ${r.proprietario}`, nome);
      continue;
    }
    fai(2, `ALTER ${TIPI[r.tipo] ?? "TABLE"} ${relSql(r)} OWNER TO ${id(PROPRIETARIO)}`, `${nome} è di ${r.proprietario}`, nome);
  }
  // sequenze legate rimaste di un altro dopo che la tabella è passata
  const diProprietario = new Set(stato.relazioni.filter((r) => r.proprietario === PROPRIETARIO).map((r) => `${r.schema}.${r.nome}`));
  for (const r of stato.relazioni) {
    if (r.legata && r.proprietario !== PROPRIETARIO && diProprietario.size && !r.estensione) {
      avvisi.push(`la sequenza ${r.schema}.${r.nome} è di ${r.proprietario}: passa con la sua tabella`);
    }
  }

  // ── chi altro legge dati di Cerbero: solo le colonne dell'elenco ──
  const perTabella = new Map();
  for (const l of stato.lettori ?? []) {
    if (!l.uso) perTabella.set(`uso|${l.ruolo}|${l.tabella.split(".")[0]}`, { uso: true, ruolo: l.ruolo, schema: l.tabella.split(".")[0] });
    if (!l.legge) {
      const k = `${l.ruolo}|${l.tabella}`;
      perTabella.set(k, { ruolo: l.ruolo, tabella: l.tabella, colonne: [...(perTabella.get(k)?.colonne ?? []), l.colonna] });
    }
  }
  for (const v of perTabella.values()) {
    if (v.uso) fai(1, `GRANT USAGE ON SCHEMA ${id(v.schema)} TO ${id(v.ruolo)}`, `${v.ruolo} non può entrare in ${v.schema}`);
    else fai(1, `GRANT SELECT (${v.colonne.map(id).join(", ")}) ON TABLE ${nomeSql(v.tabella)} TO ${id(v.ruolo)}`,
      `${v.ruolo} non legge ${v.colonne.join(", ")} di ${v.tabella}`);
  }
  // ── l'event trigger che ferma il DDL pericoloso dell'app ──
  const ev = stato.evento;
  if (ev) {
    const normale = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
    if (ev.funzione && ev.di_superutente === false) {
      errori.push(`${FUNZIONE_EVENTO_DDL} non è di un superutente: la può cambiare chi la possiede. `
        + `DROP EVENT TRIGGER ${id(EVENTO_DDL)}; DROP FUNCTION ${FUNZIONE_EVENTO_DDL}; poi il migratore la ricrea`);
    } else if (!ev.funzione || normale(ev.corpo) !== normale(CORPO_EVENTO_DDL)) {
      fai(1, `CREATE OR REPLACE FUNCTION ${FUNZIONE_EVENTO_DDL} RETURNS event_trigger LANGUAGE plpgsql `
        + `SET search_path = pg_catalog, pg_temp AS $evento$${CORPO_EVENTO_DDL}$evento$`,
      ev.funzione ? "la funzione che ferma il DDL dell'app è diversa da quella del codice" : "manca la funzione che ferma il DDL dell'app");
    }
    if (!ev.funzione || ev.di_tutti) {
      fai(1, `REVOKE ALL ON FUNCTION ${FUNZIONE_EVENTO_DDL} FROM PUBLIC`, "la funzione dell'event trigger non serve a nessuno");
    }
    const trigger = (nome, momento, compito, t) => {
      const crea = () => {
        fai(1, `CREATE EVENT TRIGGER ${id(nome)} ON ${momento} EXECUTE FUNCTION ${FUNZIONE_EVENTO_DDL}`,
          `manca l'event trigger ${nome}, che ${compito}`);
        fai(1, `ALTER EVENT TRIGGER ${id(nome)} ENABLE ALWAYS`, `l'event trigger ${nome} va acceso sempre`);
      };
      if (t.acceso != null && (t.momento !== momento || !t.sua)) {
        fai(1, `DROP EVENT TRIGGER ${id(nome)}`, `l'event trigger ${nome} non è quello del codice`);
        crea();
      } else if (t.acceso == null) {
        crea();
      } else if (t.acceso !== "A") {
        fai(1, `ALTER EVENT TRIGGER ${id(nome)} ENABLE ALWAYS`,
          `l'event trigger ${nome} è ${t.acceso === "D" ? "spento" : "acceso solo in parte"}`);
      }
    };
    trigger(EVENTO_DDL, "ddl_command_start", "ferma il DDL dell'app",
      { acceso: ev.acceso, momento: ev.momento, sua: ev.sua });
    trigger(EVENTO_DDL_FINE, "ddl_command_end", "controlla le espressioni delle tabelle dell'app",
      { acceso: ev.fine_acceso, momento: ev.fine_momento, sua: ev.fine_sua });
  }

  for (const e of stato.espressioni ?? []) {
    errori.push(`${e.tabella}: ${e.oggetto} usa ${e.funzioni}, fuori da quello che è ammesso (FUNZIONI_AMMESSE e tipi di sistema, ruoli-regole.mjs). `
      + "La eseguirebbe come superutente chi scrive la riga da superutente, una migrazione che cambia la colonna, "
      + `il ripristino di un backup. Se non viene da una migrazione: ${e.cura}; finché c'è, il migratore non migra`);
  }
  for (const r of stato.estranee ?? []) {
    avvisi.push(`${r.nome} è di ${r.proprietario} (superutente) e non è nel catalogo di Cerbero: l'app non la usa `
      + `e il riallineamento non la sposta. Se è un avanzo: DROP ${TIPI[r.tipo] ?? "TABLE"} ${nomeSql(r.nome)}; `
      + `se serve all'app: ALTER ${TIPI[r.tipo] ?? "TABLE"} ${nomeSql(r.nome)} OWNER TO ${id(PROPRIETARIO)}`);
  }

  for (const f of stato.fughe ?? []) {
    errori.push(`${f.funzione} è SECURITY DEFINER di ${f.proprietario} (superutente) e nomina tabelle di Cerbero: `
      + `con le tabelle di ${PROPRIETARIO}, l'app potrebbe farla girare con codice suo come superutente. `
      + `Va data a un ruolo che non sia superutente e legga solo quello che serve (ALTER FUNCTION ${f.funzione} OWNER TO …; `
      + "per le funzioni di FleetCare il ruolo è fleetcare_legge_cerbero, migrazione 0089); "
      + `finché c'è, ${APP} non va usato`);
  }

  // ── FleetCare: le due funzioni le concede FleetCare (migrazione 0089) ──
  const nonChiama = stato.fleetcare.filter((f) => f.esiste && !f.chiama);
  if (nonChiama.length) {
    avvisi.push(`${PROPRIETARIO} non può chiamare ${nonChiama.map((f) => f.firma).join(" e ")}: `
      + "i dati dell'officina nell'AVM restano «non disponibili» finché FleetCare non applica la migrazione 0089. "
      + `A mano, come postgres: GRANT USAGE ON SCHEMA fleetcare TO ${id(PROPRIETARIO)}; `
      + nonChiama.map((f) => `GRANT EXECUTE ON FUNCTION ${f.firma} TO ${id(PROPRIETARIO)};`).join(" "));
  }
  return { azioni, attese, avvisi, errori };
}

const ERRORE_LUCCHETTO = "55P03";
const codiceDi = (err) => err?.code ?? err?.cause?.code;

/** Un'azione nella sua transazione, con un lock_timeout breve. */
async function esegui(client, azione, lockMs) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${Math.max(100, Math.round(lockMs))}ms'`);
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(azione.sql);
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return err;
  }
}

/**
 * Riallinea: ruoli e diritti, poi tabelle, poi viste. Ogni istruzione nella
 * sua transazione: un oggetto occupato (lock_timeout) si salta e si riprova
 * al prossimo avvio, senza tenere fermo il resto. Oltre `tettoMs` non si
 * cominciano altre istruzioni. Il lucchetto è quello delle migrazioni (il
 * migratore lo tiene già e passa subito; la riga di comando non si accavalla).
 */
export async function allinea(client, elenco, { tettoMs = 25_000, lockMs = 1_000, adesso = () => Date.now() } = {}) {
  const inizio = adesso();
  const { rows } = await client.query("SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS ok", [CHIAVE_LUCCHETTO]);
  if (!rows[0].ok) throw new Error("un altro processo sta migrando o riallineando: riprova fra poco");
  try {
    const fatte = [];
    const occupate = [];
    const fallite = [];
    const rimandate = [];
    let ultimo = null;
    // due giri: le viste entrano nel piano solo dopo che le loro tabelle sono passate
    for (let giro = 1; giro <= 2; giro++) {
      ultimo = piano(await leggiStato(client, elenco));
      if (ultimo.errori.length && !ultimo.azioni.length) break;
      // nel secondo giro solo il nuovo: non si riprova quello già fallito o già fatto
      const azioni = ultimo.azioni.filter((a) => giro === 1
        || (!fatte.some((f) => f.sql === a.sql) && !fallite.some((f) => f.sql === a.sql)));
      if (!azioni.length) break;
      for (const a of [...azioni].sort((x, y) => x.fase - y.fase)) {
        if (adesso() - inizio > tettoMs) {
          rimandate.push(a);
          continue;
        }
        const err = await esegui(client, a, lockMs);
        if (!err) fatte.push(a);
        else if (codiceDi(err) === ERRORE_LUCCHETTO) occupate.push(a);
        // un altro database dello stesso server ha appena creato il ruolo o cambiato la sua impostazione
        else if (["42710", "23505", "XX000"].includes(codiceDi(err)) && /^(CREATE|ALTER) ROLE /.test(a.sql)) fatte.push(a);
        else if (ritentabile(err)) throw err;
        else fallite.push({ ...a, motivo: descriviErrore(err).motivo });
      }
      if (rimandate.length) break;
    }
    const dopo = piano(await leggiStato(client, elenco));
    const saltate = new Set([...occupate, ...rimandate, ...fallite].map((a) => a.sql));
    // un oggetto occupato nel primo giro si riprova nel secondo: si conta una volta
    const occupateUna = [...new Map(occupate.filter((a) => !fatte.some((f) => f.sql === a.sql)).map((a) => [a.sql, a])).values()];
    occupate.splice(0, occupate.length, ...occupateUna);
    return {
      fatte,
      occupate,
      rimandate,
      avvisi: [
        ...dopo.avvisi,
        ...(occupate.length ? [`${occupate.length} oggetti occupati, si riprova al prossimo avvio: ${elencoBreve(occupate.map((a) => a.oggetto ?? a.sql))}`] : []),
        ...(rimandate.length ? [`tempo finito: ${rimandate.length} istruzioni rimandate al prossimo avvio (o: node lib/db/scripts/ruoli.mjs)`] : []),
        ...dopo.attese.filter(() => occupate.length || rimandate.length).map((a) => `in attesa: ${a}`),
      ],
      errori: [
        ...dopo.errori,
        ...fallite.map((f) => `${f.perche}: non riuscito «${f.sql}» (${f.motivo})`),
        ...dopo.azioni.filter((a) => !saltate.has(a.sql)).map((a) => `${a.perche}: è rimasto dopo «${a.sql}»`),
      ],
      daFare: dopo.azioni,
    };
  } finally {
    await client.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [CHIAVE_LUCCHETTO]).catch(() => {});
  }
}

/** Solo lettura: cosa farebbe il prossimo allineamento. */
export async function verifica(client, elenco) {
  const p = piano(await leggiStato(client, elenco));
  return { daFare: p.azioni, attese: p.attese, avvisi: p.avvisi, errori: p.errori };
}
