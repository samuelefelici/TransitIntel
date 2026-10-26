// I permessi di argos_ro, il ruolo con cui Argos legge il database di Cerbero,
// confrontati col contratto (lib/db/contratti/argos-lettura.mjs) e riportati
// lì: SELECT sulle tabelle dell'elenco e USAGE sui loro schemi, nient'altro.
//
// leggiStato legge il catalogo; piano (puro) dice cosa non è in regola e con
// quale istruzione si sistema; allinea esegue il piano; verifica lo riporta
// soltanto. Si tocca solo ciò che è fuori posto: su un database in regola
// allinea non scrive niente.
//
// Cosa si corregge da solo: i permessi dati ad argos_ro dal proprietario
// dell'oggetto (tabelle, colonne, sequenze, funzioni, schemi, database,
// parametri, permessi di default), in qualunque schema. Cosa diventa un errore
// con l'istruzione da eseguire: quello che toccherebbe altri ruoli o vuole i
// loro diritti (PUBLIC, appartenenze, proprietà, permessi dati da un terzo
// ruolo, funzioni SECURITY DEFINER eseguibili da tutti, attributi del ruolo).
//
// Oltre alle voci di permesso, piano guarda i permessi effettivi
// (has_*_privilege, che contano PUBLIC, appartenenze e proprietà): «in regola»
// vuol dire che argos_ro non può fare niente fuori dal contratto, qualunque
// sia il motivo. Per gli oggetti di sistema il riferimento sono i permessi
// che avevano all'installazione (pg_init_privs): argos_ro non deve poter fare
// più di quanto poteva PUBLIC (per esempio leggere pg_authid o file del
// server con pg_read_binary_file).
//
// Il contratto in vigore è il più nuovo fra quello del codice e quello salvato
// nel database (cerbero_migrazioni.contratti, migrazione 0002): un'immagine
// vecchia di Cerbero non toglie ad Argos le tabelle date da una più nuova.
// Quello salvato si usa solo se nessuno, oltre al proprietario, lo può
// modificare.
//
// Niente import.meta né JSON letti a runtime: l'API importa questo modulo e
// viene impacchettata da esbuild in CommonJS.

import { ARGOS_LETTURA, ARGOS_VERSIONE, RUOLO_ARGOS } from "../contratti/argos-lettura.mjs";
import { CHIAVE_LUCCHETTO, TRACCIAMENTO, descriviErrore, ritentabile } from "./migrazioni-regole.mjs";

/** Gli schemi di Cerbero: quelli in cui stanno le tabelle del contratto. */
export const SCHEMI = Object.freeze(["public", "caronte"]);

/** Una voce del contratto: schema di Cerbero, punto, nome semplice. */
export const FORMATO = new RegExp(`^(${SCHEMI.join("|")})\\.[a-z0-9_]+$`);

/** Il contratto del codice. */
export const CONTRATTO = Object.freeze({ nome: "argos_lettura", versione: ARGOS_VERSIONE, elenco: ARGOS_LETTURA });

const TIPI_PREDEFINITI = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS", L: "LARGE OBJECTS" };
const ATTRIBUTI = [["replica", "REPLICATION"], ["bypassrls", "BYPASSRLS"], ["crearuoli", "CREATEROLE"], ["creadb", "CREATEDB"]];
/** Uno schema dell'utente, non di sistema (SQL, sulla colonna n.nspname). */
const NON_DI_SISTEMA = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";

const id = (s) => `"${String(s).replace(/"/g, '""')}"`;
/** Il grantee 0 è PUBLIC, che non va tra virgolette: "PUBLIC" sarebbe un ruolo che non esiste. */
const chi = (nome) => (nome === "PUBLIC" ? "PUBLIC" : id(nome));
/** Chiave di una relazione per i confronti col contratto. */
const chiave = (o) => `${o.schema}.${o.tabella}`;
const relSql = (o) => `${id(o.schema)}.${id(o.tabella)}`;
const routineSql = (f) => `${id(f.schema)}.${id(f.nome)}(${f.argomenti})`;
/** Solo per le voci del contratto, già controllate con FORMATO. */
const nomeSql = (voce) => {
  const i = voce.indexOf(".");
  return `${id(voce.slice(0, i))}.${id(voce.slice(i + 1))}`;
};
const oggettoSql = (tipo) => (tipo === "S" ? "SEQUENCE" : "TABLE");
const elencoBreve = (v, n = 10) => v.slice(0, n).join(", ") + (v.length > n ? ` e altre ${v.length - n}` : "");
const comeTerzo = (da, sql) => `SET ROLE ${id(da)}; ${sql}; RESET ROLE;`;

/** Lo stato dei permessi di un ruolo, letto dal catalogo (nessuna scrittura). */
export async function leggiStato(client, ruolo = RUOLO_ARGOS, elenco = ARGOS_LETTURA) {
  const q = async (testo, params) => (await client.query(testo, params)).rows;
  const r = await q(`
    SELECT oid, rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin,
           current_setting('server_version_num')::int AS versione_pg
      FROM pg_roles WHERE rolname = $1`, [ruolo]);
  if (!r.length) return { ruolo, esiste: false };
  const oid = r[0].oid;
  const pgv = r[0].versione_pg;
  const schemi = [...SCHEMI];
  const P = [oid, schemi];
  const estensione = (classe, colonna) => `EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classe}'::regclass
                     AND d.objid = ${colonna} AND d.deptype = 'e')`;

  // le voci di permesso sulle relazioni: del ruolo ovunque, di PUBLIC negli schemi di Cerbero
  const voci = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, c.relkind AS tipo,
           a.grantee = 0 AS a_tutti, a.privilege_type AS privilegio, a.is_grantable AS con_opzione,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(c.relowner)) AS dato_da, false AS colonna,
           ${estensione("pg_class", "c.oid")} AS estensione
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = $1 OR (a.grantee = 0 AND n.nspname = ANY($2))
    UNION ALL
    SELECT DISTINCT n.nspname, c.relname, c.relkind, a.grantee = 0, a.privilege_type, a.is_grantable,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(c.relowner)), true,
           ${estensione("pg_class", "c.oid")}
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE a.grantee = $1 OR (a.grantee = 0 AND n.nspname = ANY($2))
     ORDER BY 1, 2, 5`, P);

  // le voci di permesso sulle routine (funzioni, procedure, aggregati), ovunque
  const routine = await q(`
    SELECT n.nspname AS schema, p.proname AS nome, oidvectortypes(p.proargtypes) AS argomenti,
           a.privilege_type AS privilegio, a.is_grantable AS con_opzione,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(p.proowner)) AS dato_da
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee = $1
     ORDER BY 1, 2, 3`, [oid]);

  // permessi che il ruolo ha passato ad altri: REVOKE senza CASCADE fallirebbe
  const aChi = "CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END";
  const concessiDaLui = await q(`
    SELECT DISTINCT 'relazione' AS genere, c.relkind::text AS tipo, n.nspname::text AS schema, c.relname::text AS tabella,
           NULL::text AS argomenti, ${aChi} AS a_chi
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE a.grantor = $1 AND a.grantee <> $1 AND c.relowner <> $1
    UNION
    SELECT DISTINCT 'relazione', c.relkind::text, n.nspname::text, c.relname::text, NULL, ${aChi}
      FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE a.grantor = $1 AND a.grantee <> $1 AND c.relowner <> $1
    UNION
    SELECT DISTINCT 'routine', NULL, n.nspname::text, p.proname::text, oidvectortypes(p.proargtypes), ${aChi}
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantor = $1 AND a.grantee <> $1 AND p.proowner <> $1
    UNION
    SELECT DISTINCT 'schema', NULL, n.nspname::text, NULL, NULL, ${aChi}
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
     WHERE a.grantor = $1 AND a.grantee <> $1 AND n.nspowner <> $1
    UNION
    SELECT DISTINCT 'database', NULL, d.datname::text, NULL, NULL, ${aChi}
      FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
     WHERE d.datname = current_database() AND a.grantor = $1 AND a.grantee <> $1 AND d.datdba <> $1
    UNION
    SELECT DISTINCT 'largeobject', NULL, NULL, l.oid::text, NULL, ${aChi}
      FROM pg_largeobject_metadata l CROSS JOIN LATERAL aclexplode(l.lomacl) a
     WHERE a.grantor = $1 AND a.grantee <> $1 AND l.lomowner <> $1
    ${pgv >= 150000 ? `UNION
    SELECT DISTINCT 'parametro', NULL, p.parname::text, NULL, NULL, ${aChi}
      FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
     WHERE a.grantor = $1 AND a.grantee <> $1` : ""}
     ORDER BY 1, 3, 4, 6`, [oid]);

  // tutto ciò che il ruolo possiede in questo database, e il database stesso
  // (i suoi permessi di default si guardano a parte)
  const possiede = await q(`
    SELECT pg_describe_object(s.classid, s.objid, s.objsubid) AS oggetto,
           n.nspname AS schema, c.relname AS tabella
      FROM pg_shdepend s
      LEFT JOIN pg_class c ON s.classid = 'pg_class'::regclass AND c.oid = s.objid
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = $1 AND s.deptype = 'o'
       AND s.classid <> 'pg_default_acl'::regclass
       AND (s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            OR (s.dbid = 0 AND s.classid = 'pg_database'::regclass
                AND s.objid = (SELECT oid FROM pg_database WHERE datname = current_database())))
     ORDER BY 1`, [oid]);

  // permessi di default che danno qualcosa al ruolo (ovunque), che danno a
  // tutti tabelle e sequenze di Cerbero, o che sono del ruolo stesso.
  // ALTER DEFAULT PRIVILEGES FOR ROLE x vuole i privilegi di x (PG ≥ 16:
  // has_privs_of_role, cioè USAGE) oppure un superutente
  const predefiniti = await q(`
    SELECT pg_get_userbyid(d.defaclrole) AS proprietario, n.nspname AS schema, d.defaclobjtype AS tipo,
           bool_or(a.grantee = $1) AS suo, bool_or(a.grantee = 0) AS a_tutti, d.defaclrole = $1 AS del_ruolo,
           array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
             FILTER (WHERE a.grantee <> d.defaclrole) AS a_chi,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, d.defaclrole, 'USAGE') AS gestibile
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     GROUP BY d.oid, d.defaclrole, n.nspname, d.defaclobjtype
    HAVING bool_or(a.grantee = $1) OR d.defaclrole = $1
        OR (bool_or(a.grantee = 0) AND (n.nspname IS NULL OR n.nspname = ANY($2)))
     ORDER BY 1, 2 NULLS FIRST, 3`, P);

  // gli schemi: quelli di Cerbero sempre, gli altri non di sistema per i permessi in più
  const schemiStato = await q(`
    SELECT n.nspname AS schema, n.nspname = ANY($2) AS cerbero,
           has_schema_privilege($1::oid, n.oid, 'USAGE') AS uso,
           coalesce((SELECT json_agg(json_build_object(
               'privilegio', a.privilege_type, 'con_opzione', a.is_grantable,
               'dato_da', NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(n.nspowner))))
             FROM aclexplode(n.nspacl) a WHERE a.grantee = $1), '[]') AS voci,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS tutti_creano,
           has_schema_privilege($1::oid, n.oid, 'CREATE') AS crea_eff,
           has_schema_privilege($1::oid, n.oid, 'USAGE WITH GRANT OPTION, CREATE WITH GRANT OPTION') AS opzione_eff,
           CASE WHEN pg_has_role($1::oid, n.nspowner, 'MEMBER') THEN pg_get_userbyid(n.nspowner) END AS possiede_via
      FROM pg_namespace n WHERE n.nspname = ANY($2) OR (${NON_DI_SISTEMA})
     ORDER BY 2 DESC, 1`, P);

  const [database] = await q(`
    SELECT d.datname AS nome,
           CASE WHEN pg_has_role($1::oid, d.datdba, 'MEMBER') THEN pg_get_userbyid(d.datdba) END AS possiede_via,
           has_database_privilege($1::oid, d.oid, 'CREATE') AS crea_eff,
           has_database_privilege($1::oid, d.oid, 'CONNECT') AS connette,
           has_database_privilege($1::oid, d.oid,
             'CREATE WITH GRANT OPTION, CONNECT WITH GRANT OPTION, TEMPORARY WITH GRANT OPTION') AS opzione_eff,
           coalesce((SELECT json_agg(json_build_object(
               'privilegio', a.privilege_type, 'con_opzione', a.is_grantable,
               'dato_da', NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(d.datdba))))
             FROM aclexplode(d.datacl) a WHERE a.grantee = $1), '[]') AS voci,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS tutti_creano
      FROM pg_database d WHERE d.datname = current_database()`, [oid]);

  // permessi effettivi su ogni relazione non di sistema. CASE e non AND:
  // has_sequence_privilege su una tabella dà errore, e solo CASE garantisce
  // l'ordine di valutazione. MAINTAIN esiste da PG 17.
  const scrittura = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", ...(pgv >= 170000 ? ["MAINTAIN"] : [])];
  const opzione = ["SELECT", ...scrittura].map((p) => `${p} WITH GRANT OPTION`);
  const effettivi = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, c.relkind AS tipo, n.nspname = ANY($2) AS cerbero,
           ${estensione("pg_class", "c.oid")} AS estensione,
           -- has_*_privilege non guarda lo schema: senza USAGE il permesso non serve a niente
           has_schema_privilege($1::oid, n.oid, 'USAGE') AND
           CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1::oid, c.oid, 'SELECT, USAGE, UPDATE')
                ELSE has_any_column_privilege($1::oid, c.oid, 'SELECT') END AS legge,
           has_schema_privilege($1::oid, n.oid, 'USAGE') AND
           CASE WHEN c.relkind = 'S' THEN false
                ELSE has_table_privilege($1::oid, c.oid, $3)
                  OR has_any_column_privilege($1::oid, c.oid, 'INSERT, UPDATE, REFERENCES') END AS scrive,
           has_schema_privilege($1::oid, n.oid, 'USAGE') AND
           CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1::oid, c.oid,
                  'SELECT WITH GRANT OPTION, USAGE WITH GRANT OPTION, UPDATE WITH GRANT OPTION')
                ELSE has_table_privilege($1::oid, c.oid, $4)
                  OR has_any_column_privilege($1::oid, c.oid,
                       'SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION, REFERENCES WITH GRANT OPTION') END AS opzione
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${NON_DI_SISTEMA} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 1, 2`, [oid, schemi, scrittura.join(", "), opzione.join(", ")]);

  // funzioni SECURITY DEFINER che il ruolo può eseguire: girano coi diritti
  // del proprietario, quindi gli danno quello che fanno
  const definer = await q(`
    SELECT n.nspname AS schema, p.proname AS nome, oidvectortypes(p.proargtypes) AS argomenti,
           ${estensione("pg_proc", "p.oid")} AS estensione,
           p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS di_tutti
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND ${NON_DI_SISTEMA} AND has_function_privilege($1::oid, p.oid, 'EXECUTE')
       AND has_schema_privilege($1::oid, n.oid, 'USAGE')
     ORDER BY 1, 2, 3`, [oid]);

  // oggetti di sistema riservati all'installazione (pg_init_privs senza PUBLIC)
  // che il ruolo può usare: pg_authid, pg_read_binary_file, lo_import, ...
  const sistema = await q(`
    SELECT 'relazione' AS genere, n.nspname AS schema, c.relname AS nome, NULL AS argomenti
      FROM pg_init_privs i JOIN pg_class c ON c.oid = i.objoid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.classoid = 'pg_class'::regclass AND i.objsubid = 0
       AND NOT EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'SELECT')
       AND (has_table_privilege($1::oid, c.oid, 'SELECT')
            OR EXISTS (SELECT 1 FROM pg_attribute at
                        WHERE at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped
                          AND has_column_privilege($1::oid, c.oid, at.attnum, 'SELECT')
                          AND NOT EXISTS (SELECT 1 FROM pg_init_privs ic CROSS JOIN LATERAL aclexplode(ic.initprivs) x
                                           WHERE ic.classoid = i.classoid AND ic.objoid = c.oid AND ic.objsubid = at.attnum
                                             AND x.grantee = 0 AND x.privilege_type = 'SELECT')))
    UNION ALL
    SELECT 'routine', n.nspname, p.proname, oidvectortypes(p.proargtypes)
      FROM pg_init_privs i JOIN pg_proc p ON p.oid = i.objoid JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE i.classoid = 'pg_proc'::regclass
       AND NOT EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
       AND has_function_privilege($1::oid, p.oid, 'EXECUTE')
     ORDER BY 1, 2, 3, 4`, [oid]);

  // parametri che il ruolo (o chiunque) può impostare: pg_parameter_acl, da PG 15
  const parametri = pgv >= 150000 ? await q(`
    SELECT p.parname AS nome, a.grantee = 0 AS a_tutti, a.privilege_type AS privilegio
      FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
     WHERE a.grantee IN ($1, 0) ORDER BY 1, 3`, [oid]) : [];

  // large object: i permessi del ruolo e di tutti (quelli suoi li copre la proprietà)
  const largeObject = await q(`
    SELECT l.oid::text AS oid, a.grantee = 0 AS a_tutti, a.privilege_type AS privilegio, a.is_grantable AS con_opzione,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(l.lomowner)) AS dato_da
      FROM pg_largeobject_metadata l CROSS JOIN LATERAL aclexplode(l.lomacl) a
     WHERE a.grantee IN ($1, 0) AND l.lomowner <> $1
     ORDER BY 1, 3`, [oid]);
  const [{ lo_compat: loCompat }] = await q("SELECT current_setting('lo_compat_privileges')::boolean AS lo_compat");

  const membroDi = await q(`
    SELECT pg_get_userbyid(roleid) AS ruolo, pg_get_userbyid(grantor) AS da,
           (SELECT rolsuper FROM pg_roles WHERE oid = grantor) AS da_superutente
      FROM pg_auth_members WHERE member = $1 ORDER BY 1, 2`, [oid]);
  const esistenti = await q(`
    SELECT t FROM unnest($1::text[]) t JOIN pg_class c ON c.oid = to_regclass(t)
     WHERE c.relkind IN ('r', 'p')`, [[...elenco].filter((t) => FORMATO.test(t))]);

  return {
    ruolo, esiste: true,
    attributi: {
      superutente: r[0].rolsuper, replica: r[0].rolreplication, bypassrls: r[0].rolbypassrls,
      crearuoli: r[0].rolcreaterole, creadb: r[0].rolcreatedb, login: r[0].rolcanlogin,
    },
    voci, routine, concessiDaLui, possiede, predefiniti, schemi: schemiStato, database: database ?? null,
    effettivi: effettivi.filter((e) => e.cerbero), altrove: effettivi.filter((e) => !e.cerbero),
    definer, sistema, parametri, largeObject, loCompat, membroDi, esistenti: esistenti.map((x) => x.t),
  };
}

/**
 * Che cosa fare per portare lo stato al contratto (puro: niente database).
 * azioni: istruzioni che l'allineamento esegue, col perché e l'oggetto;
 * errori: cose da sistemare a mano (toccano altri ruoli, o servono i diritti
 * di un altro ruolo), con l'istruzione; avvisi: cose da sapere che non
 * allargano quello che argos_ro può fare sui dati di Cerbero.
 */
export function piano(stato, elenco = ARGOS_LETTURA) {
  const esito = { assente: !stato.esiste, azioni: [], avvisi: [], errori: [] };
  if (!stato.esiste) return esito;
  const ruolo = stato.ruolo;
  const R = id(ruolo);
  const ammesse = new Set(elenco.filter((t) => FORMATO.test(t)));
  const esistenti = new Set(stato.esistenti);
  const azione = (sql, perche, oggetto = null) => esito.azioni.push({ sql, perche, oggetto });
  const errore = (m) => esito.errori.push(m);
  const avviso = (m) => esito.avvisi.push(m);
  const spiegate = new Set(); // relazioni la cui violazione ha già un errore o un avviso con la causa
  const bloccate = new Set(); // relazioni su cui un'azione fallirebbe o non serve
  const schemiBloccati = new Set();
  const globali = []; // cause che valgono per tutto: superutente, appartenenze, proprietà

  for (const t of elenco.filter((t) => !FORMATO.test(t))) errore(`voce del contratto non valida, ignorata: ${t}`);

  // 1. attributi del ruolo
  const at = stato.attributi;
  if (at.superutente) {
    errore(`${ruolo} è superutente: legge e scrive tutto a prescindere dai permessi (ALTER ROLE ${R} NOSUPERUSER)`);
    globali.push("superutente");
  }
  for (const [k, nome] of ATTRIBUTI) {
    if (at[k]) errore(`${ruolo} ha l'attributo ${nome}, che a un ruolo di sola lettura non serve (ALTER ROLE ${R} NO${nome})`);
  }
  if (!at.login) avviso(`${ruolo} non può collegarsi (NOLOGIN): Argos non entra. ALTER ROLE ${R} LOGIN, poi \\password ${ruolo}`);
  if (stato.database && !stato.database.connette) {
    avviso(`${ruolo} non ha CONNECT sul database ${stato.database.nome}: Argos non entra (GRANT CONNECT ON DATABASE ${id(stato.database.nome)} TO ${R})`);
  }

  // 2. proprietà: il proprietario fa tutto, e i REVOKE sui suoi oggetti non servono
  const posseduti = new Set(stato.possiede.filter((p) => p.schema && p.tabella).map(chiave));
  if (stato.possiede.length) {
    errore(`${ruolo} è proprietario di ${elencoBreve(stato.possiede.map((p) => p.oggetto))}: ci può fare tutto `
      + `(REASSIGN OWNED BY ${R} TO <proprietario delle tabelle>)`);
    for (const k of posseduti) { bloccate.add(k); spiegate.add(k); }
    globali.push("proprietà");
  }
  for (const s of stato.schemi) {
    if (!s.possiede_via) continue;
    schemiBloccati.add(s.schema);
    globali.push(`schema ${s.schema}`);
    // public è di pg_database_owner: lo dice già l'errore sul database
    if (s.possiede_via === "pg_database_owner" && stato.database?.possiede_via) continue;
    if (s.possiede_via !== ruolo) {
      errore(`${ruolo} ha i diritti del proprietario dello schema ${s.schema} (${s.possiede_via}): può cancellarne le tabelle e crearne di nuove`);
    } else if (!stato.possiede.some((p) => p.oggetto === `schema ${s.schema}`)) {
      errore(`${ruolo} è proprietario dello schema ${s.schema} (ALTER SCHEMA ${id(s.schema)} OWNER TO <proprietario delle tabelle>)`);
    }
  }
  const dbPosseduto = !!stato.database?.possiede_via;
  if (dbPosseduto) {
    if (!stato.possiede.some((p) => p.oggetto === `database ${stato.database.nome}`)) {
      errore(`${ruolo} ha i diritti del proprietario del database ${stato.database.nome} (${stato.database.possiede_via}), `
        + "quindi anche dello schema public");
    }
    globali.push("database");
  }

  // 2b. appartenenze (su PG ≥ 16 un REVOKE toglie solo quella concessa da chi lo esegue)
  const perRuolo = new Map();
  for (const m of stato.membroDi) perRuolo.set(m.ruolo, [...(perRuolo.get(m.ruolo) ?? []), m]);
  for (const [m, vv] of perRuolo) {
    const comandi = vv.map((v) => `REVOKE ${id(m)} FROM ${R}${v.da_superutente ? "" : ` GRANTED BY ${id(v.da)}`}`);
    errore(`${ruolo} è membro di ${m}: può tutto quello che può quel ruolo, fuori dal contratto (${comandi.join("; ")})`);
    globali.push(`membro di ${m}`);
  }

  // 3. permessi passati ad altri: REVOKE senza CASCADE fallirebbe (sugli
  //    oggetti suoi invece il CASCADE non serve: lo copre la proprietà)
  const passati = new Map();
  for (const d of stato.concessiDaLui) {
    const k = {
      schema: `schema ${d.schema}`, database: `database ${d.schema}`, parametro: `parametro ${d.schema}`,
      largeobject: `large object ${d.tabella}`, routine: `${d.schema}.${d.tabella}(${d.argomenti})`,
    }[d.genere] ?? `${d.schema}.${d.tabella}`;
    if (d.genere === "relazione" && posseduti.has(k)) continue;
    const v = passati.get(k) ?? { ...d, a_chi: [] };
    v.a_chi.push(d.a_chi);
    passati.set(k, v);
  }
  const routineBloccate = new Set();
  const altriBloccati = new Set(); // database, parametri, large object con permessi passati ad altri
  for (const [k, d] of passati) {
    let oggetto;
    if (d.genere === "schema") { oggetto = `SCHEMA ${id(d.schema)}`; schemiBloccati.add(d.schema); }
    else if (d.genere === "routine") { oggetto = `ROUTINE ${routineSql({ schema: d.schema, nome: d.tabella, argomenti: d.argomenti })}`; routineBloccate.add(k); }
    else if (d.genere === "database") { oggetto = `DATABASE ${id(d.schema)}`; altriBloccati.add(k); }
    else if (d.genere === "parametro") { oggetto = `PARAMETER ${d.schema}`; altriBloccati.add(k); }
    else if (d.genere === "largeobject") { oggetto = `LARGE OBJECT ${d.tabella}`; altriBloccati.add(k); }
    else { oggetto = `${oggettoSql(d.tipo)} ${relSql(d)}`; bloccate.add(k); spiegate.add(k); }
    errore(`${ruolo} ha passato a ${d.a_chi.join(", ")} permessi su ${k}: toglili insieme ai suoi `
      + `(REVOKE GRANT OPTION FOR ALL ON ${oggetto} FROM ${R} CASCADE), poi riallinea`);
  }

  // 4. voci di permesso sulle relazioni, raggruppate
  const gruppi = new Map();
  for (const v of stato.voci) {
    const k = chiave(v);
    const g = gruppi.get(k) ?? { schema: v.schema, tabella: v.tabella, tipo: v.tipo, estensione: v.estensione, suoi: [], terzi: [], tutti: [] };
    if (v.a_tutti) g.tutti.push(v);
    else if (v.dato_da) g.terzi.push(v);
    else g.suoi.push(v);
    gruppi.set(k, g);
  }
  const descrivi = (vv) => [...new Set(vv.map((p) => p.privilegio + (p.colonna ? " su colonne" : "") + (p.con_opzione ? " con opzione" : "")))].join(", ");
  const giaInRegola = new Set();
  const ridotte = new Set();

  for (const [k, g] of [...gruppi].sort(([a], [b]) => a.localeCompare(b))) {
    const nelContratto = ammesse.has(k) && esistenti.has(k) && SCHEMI.includes(g.schema);
    const ok = (p) => nelContratto && p.privilegio === "SELECT" && !p.con_opzione;

    if (g.suoi.length && !bloccate.has(k)) {
      if (g.suoi.every(ok)) {
        // SELECT sulla tabella: in regola (un SELECT su colonne in più non allarga niente);
        // solo SELECT su colonne: manca quello sulla tabella, lo dà il passo 5
        if (g.suoi.some((p) => !p.colonna)) giaInRegola.add(k);
      } else {
        // REVOKE ALL sulla tabella toglie anche i permessi sulle colonne
        azione(`REVOKE ALL ON ${oggettoSql(g.tipo)} ${relSql(g)} FROM ${R}`,
          nelContratto ? `${k}: nel contratto ma con permessi in più (${descrivi(g.suoi)})` : `${k}: fuori dal contratto (${descrivi(g.suoi)})`, k);
        if (nelContratto) ridotte.add(k);
      }
    }

    // dati da un ruolo diverso dal proprietario: il REVOKE del proprietario non li tocca
    const perChi = new Map();
    for (const p of g.terzi.filter((p) => !ok(p))) perChi.set(p.dato_da, [...(perChi.get(p.dato_da) ?? []), p]);
    for (const [da, vv] of perChi) {
      errore(`${k}: ${descrivi(vv)} concessi a ${ruolo} da ${da}, non dal proprietario: il riallineamento non li può togliere `
        + `(${comeTerzo(da, `REVOKE ALL ON ${oggettoSql(g.tipo)} ${relSql(g)} FROM ${R}`)})`);
      spiegate.add(k);
    }

    // dati a tutti (PUBLIC), quindi anche ad argos_ro: toglierli tocca tutti i ruoli.
    // Quelli che ha dato argos_ro stesso li toglie il CASCADE del passo 3.
    const troppo = g.tutti.filter((p) => !(nelContratto && p.privilegio === "SELECT") && p.dato_da !== ruolo);
    if (troppo.length) {
      const sql = nelContratto
        ? `REVOKE ${[...new Set(troppo.map((p) => p.privilegio))].join(", ")} ON TABLE ${relSql(g)} FROM PUBLIC`
        : `REVOKE ALL ON ${oggettoSql(g.tipo)} ${relSql(g)} FROM PUBLIC`;
      const da = [...new Set(troppo.map((p) => p.dato_da).filter(Boolean))];
      const come = da.length ? ` (concessi da ${da.join(", ")}: SET ROLE prima del REVOKE)` : "";
      const testo = `${k}: ${descrivi(troppo)} concessi a tutti i ruoli (PUBLIC), compreso ${ruolo}. `
        + `Toglierli tocca tutti i ruoli: ${sql}${come}`;
      if (g.estensione) avviso(`${testo} (è un oggetto di un'estensione)`);
      else errore(testo);
      spiegate.add(k);
    }
  }

  // 5. le tabelle del contratto
  for (const t of [...ammesse].sort()) {
    if (!esistenti.has(t)) avviso(`${t} è nel contratto ma non esiste, o non è una tabella`);
    else if (!giaInRegola.has(t) && !bloccate.has(t)) {
      azione(`GRANT SELECT ON TABLE ${nomeSql(t)} TO ${R}`,
        ridotte.has(t) ? `${t}: rimessa la sola lettura` : `${t}: nel contratto, manca la lettura`, t);
    }
  }

  // 6. routine: i permessi dati al ruolo si tolgono (dal proprietario) o si segnalano
  const routineDirette = new Set();
  const perRoutine = new Map();
  for (const f of stato.routine) {
    const k = `${f.schema}.${f.nome}(${f.argomenti})`;
    perRoutine.set(k, [...(perRoutine.get(k) ?? []), f]);
  }
  for (const [k, vv] of perRoutine) {
    routineDirette.add(k);
    if (routineBloccate.has(k)) continue;
    const sql = `REVOKE ALL ON ROUTINE ${routineSql(vv[0])} FROM ${R}`;
    if (vv.some((f) => !f.dato_da)) azione(sql, `${k}: ${ruolo} la può eseguire, ma il contratto non lo prevede`, k);
    for (const da of new Set(vv.map((f) => f.dato_da).filter(Boolean))) {
      errore(`${k}: EXECUTE concesso a ${ruolo} da ${da}, non dal proprietario (${comeTerzo(da, sql)})`);
    }
  }
  for (const f of stato.definer) {
    const k = `${f.schema}.${f.nome}(${f.argomenti})`;
    if (routineDirette.has(k)) continue;
    const testo = `${k} è SECURITY DEFINER (gira coi diritti del suo proprietario) e ${ruolo} la può eseguire`
      + (f.di_tutti ? `, come tutti i ruoli: REVOKE EXECUTE ON ROUTINE ${routineSql(f)} FROM PUBLIC, poi dalla solo a chi serve` : "");
    if (f.estensione) avviso(`${testo} (è di un'estensione)`);
    else if (f.di_tutti || !globali.length) errore(testo);
  }
  const sistemaNonSpiegati = stato.sistema
    .map((o) => (o.genere === "routine" ? `${o.schema}.${o.nome}(${o.argomenti})` : `${o.schema}.${o.nome}`))
    .filter((k) => !routineDirette.has(k) && !gruppi.has(k));
  if (sistemaNonSpiegati.length && !globali.length) {
    errore(`${ruolo} può usare oggetti di sistema riservati, che all'installazione PUBLIC non poteva usare: ${elencoBreve(sistemaNonSpiegati)} `
      + "(guarda \\dp e \\df+ su quegli oggetti: qualcuno li ha dati a PUBLIC o a un ruolo di cui è membro)");
  }

  // 7. schemi: quelli di Cerbero servono in USAGE; negli altri niente
  for (const s of stato.schemi) {
    if (s.cerbero && !s.uso) azione(`GRANT USAGE ON SCHEMA ${id(s.schema)} TO ${R}`, `schema ${s.schema}: serve per leggerne le tabelle`);
    if (s.tutti_creano) {
      errore(`schema ${s.schema}: tutti i ruoli (PUBLIC) ci possono creare oggetti, compreso ${ruolo}. `
        + `Toglierlo tocca tutti i ruoli: REVOKE CREATE ON SCHEMA ${id(s.schema)} FROM PUBLIC`);
    }
    if (schemiBloccati.has(s.schema)) continue;
    const voci = s.voci ?? [];
    const inPiu = (v) => !s.cerbero || v.privilegio !== "USAGE" || v.con_opzione;
    const suoi = voci.filter((v) => !v.dato_da && inPiu(v));
    if (suoi.length && !s.cerbero) {
      azione(`REVOKE ALL ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: non è di Cerbero, ${ruolo} non ci deve avere permessi`);
    } else {
      if (suoi.some((v) => v.privilegio === "CREATE")) {
        azione(`REVOKE CREATE ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${ruolo} ci può creare oggetti`);
      }
      if (suoi.some((v) => v.con_opzione)) {
        azione(`REVOKE GRANT OPTION FOR ALL ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${ruolo} può passare ad altri i suoi permessi`);
      }
    }
    for (const da of new Set(voci.filter((v) => v.dato_da && inPiu(v)).map((v) => v.dato_da))) {
      errore(`schema ${s.schema}: permessi concessi a ${ruolo} da ${da}, non dal proprietario `
        + `(${comeTerzo(da, `REVOKE ALL ON SCHEMA ${id(s.schema)} FROM ${R}`)})`);
    }
    const spiegato = voci.some((v) => v.privilegio === "CREATE" || v.con_opzione) || s.tutti_creano;
    if ((s.crea_eff || s.opzione_eff) && !spiegato && !globali.length) {
      errore(`schema ${s.schema}: ${ruolo} ${s.crea_eff ? "ci può creare oggetti" : "può passare ad altri i permessi"}, `
        + `e non lo spiegano né i suoi permessi né quelli di PUBLIC (guarda \\dn+ ${s.schema})`);
    }
  }

  // 8. permessi di default
  for (const d of stato.predefiniti) {
    const tipo = TIPI_PREDEFINITI[d.tipo] ?? d.tipo;
    const dove = d.schema ? ` in ${d.schema}` : " in tutti gli schemi";
    const forRole = `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(d.proprietario)}${d.schema ? ` IN SCHEMA ${id(d.schema)}` : ""}`;
    const cosa = `permessi di default di ${d.proprietario}${dove} (${tipo})`;
    if (d.del_ruolo) {
      // del ruolo stesso: darebbero ad altri gli oggetti che argos_ro creasse
      const altri = (d.a_chi ?? []).filter((x) => x !== ruolo);
      if (altri.length) errore(`${cosa}: darebbero a ${altri.join(", ")} gli oggetti che ${ruolo} creasse (${forRole} REVOKE ALL ON ${tipo} FROM ${altri.map(chi).join(", ")})`);
      continue;
    }
    if (d.suo) {
      if (d.gestibile) azione(`${forRole} REVOKE ALL ON ${tipo} FROM ${R}`, `${cosa}: darebbero a ${ruolo} gli oggetti che verranno creati`);
      else errore(`${cosa}: danno a ${ruolo} gli oggetti futuri; per toglierli servono i diritti di ${d.proprietario} o un superutente (${forRole} REVOKE ALL ON ${tipo} FROM ${R})`);
    }
    if (d.a_tutti && (d.tipo === "r" || d.tipo === "S") && (!d.schema || SCHEMI.includes(d.schema))) {
      errore(`${cosa}: gli oggetti futuri saranno di tutti i ruoli (PUBLIC), compreso ${ruolo}. Toglierlo tocca tutti i ruoli: ${forRole} REVOKE ALL ON ${tipo} FROM PUBLIC`);
    }
  }

  // 9. database
  const db = stato.database;
  if (db) {
    const voci = db.voci ?? [];
    const inPiu = (v) => v.privilegio === "CREATE" || v.con_opzione;
    if (!dbPosseduto && !altriBloccati.has(`database ${db.nome}`)) {
      const suoi = voci.filter((v) => !v.dato_da && inPiu(v));
      if (suoi.some((v) => v.privilegio === "CREATE")) {
        azione(`REVOKE CREATE ON DATABASE ${id(db.nome)} FROM ${R}`, `database ${db.nome}: ${ruolo} ci può creare schemi`);
      }
      if (suoi.some((v) => v.con_opzione)) {
        azione(`REVOKE GRANT OPTION FOR ALL ON DATABASE ${id(db.nome)} FROM ${R}`, `database ${db.nome}: ${ruolo} può passare ad altri i suoi permessi`);
      }
      for (const da of new Set(voci.filter((v) => v.dato_da && inPiu(v)).map((v) => v.dato_da))) {
        errore(`database ${db.nome}: permessi concessi a ${ruolo} da ${da}, non dal proprietario `
          + `(${comeTerzo(da, `REVOKE ALL ON DATABASE ${id(db.nome)} FROM ${R}`)})`);
      }
    }
    if (db.tutti_creano) {
      errore(`database ${db.nome}: tutti i ruoli (PUBLIC) ci possono creare schemi, compreso ${ruolo}. `
        + `Toglierlo tocca tutti i ruoli: REVOKE CREATE ON DATABASE ${id(db.nome)} FROM PUBLIC`);
    }
    const spiegato = voci.some(inPiu) || db.tutti_creano;
    if ((db.crea_eff || db.opzione_eff) && !spiegato && !globali.length) {
      errore(`database ${db.nome}: ${ruolo} ${db.crea_eff ? "ci può creare schemi" : "può passare ad altri i permessi"}, `
        + "e non lo spiegano né i suoi permessi né quelli di PUBLIC");
    }
  }

  // 10. parametri del server (SET e ALTER SYSTEM concessi)
  for (const p of stato.parametri.filter((p) => p.a_tutti)) {
    errore(`parametro ${p.nome}: ${p.privilegio} concesso a tutti i ruoli (PUBLIC), compreso ${ruolo} (REVOKE ${p.privilegio} ON PARAMETER ${p.nome} FROM PUBLIC)`);
  }
  for (const nome of new Set(stato.parametri.filter((p) => !p.a_tutti && !altriBloccati.has(`parametro ${p.nome}`)).map((p) => p.nome))) {
    azione(`REVOKE ALL ON PARAMETER ${nome} FROM ${R}`, `parametro ${nome}: ${ruolo} lo può cambiare`);
  }

  // 10b. large object: dati applicativi, leggibili e scrivibili con lo_get/lo_put
  if (stato.loCompat) {
    errore(`lo_compat_privileges è acceso: tutti i ruoli, compreso ${ruolo}, leggono e scrivono ogni large object (ALTER SYSTEM SET lo_compat_privileges = off)`);
  }
  const perLo = new Map();
  for (const l of stato.largeObject) perLo.set(l.oid, [...(perLo.get(l.oid) ?? []), l]);
  const loDiTutti = [];
  for (const [oidLo, vv] of perLo) {
    if (altriBloccati.has(`large object ${oidLo}`)) continue;
    const sql = `REVOKE ALL ON LARGE OBJECT ${oidLo} FROM ${R}`;
    if (vv.some((l) => !l.a_tutti && !l.dato_da)) azione(sql, `large object ${oidLo}: ${ruolo} lo può leggere o scrivere`);
    for (const da of new Set(vv.filter((l) => !l.a_tutti && l.dato_da).map((l) => l.dato_da))) {
      errore(`large object ${oidLo}: permessi concessi a ${ruolo} da ${da}, non dal proprietario (${comeTerzo(da, sql)})`);
    }
    if (vv.some((l) => l.a_tutti)) loDiTutti.push(oidLo);
  }
  if (loDiTutti.length) {
    errore(`large object leggibili o scrivibili da tutti i ruoli (PUBLIC), compreso ${ruolo}: ${elencoBreve(loDiTutti)}. `
      + `Toglierlo tocca tutti i ruoli: REVOKE ALL ON LARGE OBJECT <oid> FROM PUBLIC`);
  }

  // 11. permessi effettivi: quello che argos_ro può davvero fare, per qualunque motivo
  const conAzione = new Set(esito.azioni.map((a) => a.oggetto).filter(Boolean));
  const perAltriMotivi = [];
  const fuoriLetti = [];
  for (const e of [...stato.effettivi, ...stato.altrove]) {
    const k = chiave(e);
    const nelContratto = e.cerbero && ammesse.has(k) && esistenti.has(k);
    const cosa = [];
    if (e.legge && !nelContratto) cosa.push(e.tipo === "S" ? "usa la sequenza" : "legge");
    if (e.scrive) cosa.push("scrive");
    if (e.opzione) cosa.push("può passare ad altri i permessi");
    if (!cosa.length || conAzione.has(k) || spiegate.has(k) || bloccate.has(k)) continue;
    if (e.estensione) avviso(`${k}: ${ruolo} ${cosa.join(", ")} (oggetto di un'estensione)`);
    else if (globali.length) perAltriMotivi.push(`${k} (${cosa.join(", ")})`);
    else if (!e.cerbero && cosa.length === 1 && cosa[0] === "legge") fuoriLetti.push(e);
    else errore(`${k}: ${ruolo} ${cosa.join(", ")}, e non lo spiegano né i suoi permessi né quelli di PUBLIC (guarda \\dp ${k})`);
  }
  if (perAltriMotivi.length) errore(`per i motivi qui sopra ${ruolo} può anche: ${elencoBreve(perAltriMotivi)}`);
  // fuori dagli schemi di Cerbero: lette perché date a tutti (PUBLIC). Anche lì
  // una vista può mostrare tabelle di Cerbero, quindi è un errore, per schema
  const perSchema = new Map();
  for (const e of fuoriLetti) perSchema.set(e.schema, [...(perSchema.get(e.schema) ?? []), e.tabella]);
  for (const [sc, tt] of perSchema) {
    errore(`schema ${sc}: ${ruolo} legge ${elencoBreve(tt)}, perché sono date a tutti i ruoli (PUBLIC). `
      + `Toglierlo tocca tutti i ruoli: REVOKE SELECT ON ALL TABLES IN SCHEMA ${id(sc)} FROM PUBLIC, `
      + `oppure REVOKE USAGE ON SCHEMA ${id(sc)} FROM PUBLIC se lo schema non serve a tutti`);
  }
  return esito;
}

/**
 * Il contratto salvato nel database, se c'è, si può leggere e ci si può
 * fidare. Chi lo scrive decide i permessi di argos_ro, quindi si usa solo se:
 * - tabella e schema sono di un superutente o di un ruolo di cui chi migra ha
 *   i diritti, e nessun altro (argos_ro compreso, o PUBLIC) ci può scrivere o
 *   mettere trigger;
 * - c'è il trigger che annota chi scrive (migrazione 0002), con la sua funzione,
 *   acceso anche in replica, e nessun altro trigger che possa cambiare le righe;
 * - la riga l'ha scritta un superutente o chi migra (scritto_da). Così anche
 *   dopo aver tolto un permesso concesso per sbaglio, quello che è stato
 *   scritto nel frattempo non vale finché non lo si riscrive (--forza).
 * I membri del ruolo proprietario valgono come il proprietario: hanno già i
 * suoi diritti su tutte le tabelle di Cerbero. (PR 2.8: con un proprietario e
 * un'app non superutenti, la regola «fidato» va rivista: oggi è ancorata a chi
 * esegue il controllo, che in produzione è postgres.)
 * Nessuna query qui può fallire: dentro la transazione di allinea la annullerebbe.
 */
export async function leggiContrattoSalvato(client, nome = CONTRATTO.nome, ruolo = RUOLO_ARGOS) {
  const schema = TRACCIAMENTO.migrationsSchema;
  const scrittura = "('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')";
  // fidato: un superutente, chi esegue il controllo o, se questi non è
  // superutente, un ruolo di cui ha i diritti (per un superutente
  // pg_has_role è sempre vero, quindi da solo non direbbe niente)
  const fidato = (oid) => `(SELECT x.rolsuper OR x.rolname = current_user
              OR (NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                  AND pg_has_role(current_user, x.oid, 'USAGE'))
              FROM pg_roles x WHERE x.oid = ${oid})`;
  const { rows } = await client.query(`
    SELECT c.oid IS NOT NULL AS c_e,
           has_schema_privilege(n.oid, 'USAGE') AND (c.oid IS NULL OR has_table_privilege(c.oid, 'SELECT')) AS leggibile,
           c.oid IS NOT NULL AND (
             -- proprietari di tabella e schema fidati
             NOT ${fidato("c.relowner")} OR NOT ${fidato("n.nspowner")}
             -- nessun altro ruolo, PUBLIC compreso, ci può scrivere o mettere trigger
             OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                         WHERE a.grantee <> c.relowner AND a.privilege_type IN ${scrittura})
             OR EXISTS (SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
                         WHERE at.attrelid = c.oid AND a.privilege_type IN ('INSERT', 'UPDATE'))
             -- e il ruolo governato non ne ha i diritti per nessuna via
             OR (r.oid IS NOT NULL AND (pg_has_role(r.oid, c.relowner, 'MEMBER') OR pg_has_role(r.oid, n.nspowner, 'MEMBER')
                 OR has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
                 OR has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE')))
             -- il trigger che annota chi scrive c'è, con la sua funzione, ed è acceso
             -- sempre (anche in replica); nessun altro trigger può cambiare le righe
             OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                             WHERE t.tgrelid = c.oid AND t.tgname = 'contratti_chi_scrive' AND t.tgenabled IN ('O', 'A')
                               AND t.tgfoid = to_regprocedure('${schema}.contratti_chi_scrive()') AND ${fidato("f.proowner")})
             OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                         AND t.tgname <> 'contratti_chi_scrive')
           ) AS sospetto
      FROM pg_namespace n
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'contratti' AND c.relkind = 'r'
      LEFT JOIN pg_roles r ON r.rolname = $2
     WHERE n.nspname = $1`, [schema, ruolo]);
  if (!rows.length || !rows[0].c_e) return { disponibile: false, motivo: `manca ${schema}.contratti (migrazione 0002)` };
  if (rows[0].sospetto) {
    return {
      disponibile: false, sospetto: true,
      motivo: `${schema}.contratti lo può modificare anche chi non dovrebbe, o il trigger che annota chi scrive manca, `
        + `è spento o ce n'è un altro (\\dp ${schema}.contratti, \\d ${schema}.contratti): non lo uso`,
    };
  }
  if (!rows[0].leggibile) return { disponibile: false, motivo: `${schema}.contratti non è leggibile da questo utente` };
  const r = await client.query(`
    SELECT c.versione, c.elenco, c.scritto_da,
           CASE WHEN w.oid IS NULL THEN false ELSE ${fidato("w.oid")} END AS fidato
      FROM ${id(schema)}.contratti c LEFT JOIN pg_roles w ON w.rolname = c.scritto_da
     WHERE c.nome = $1`, [nome]);
  const riga = r.rows[0] ?? null;
  if (riga && !riga.fidato) {
    return {
      disponibile: false, sospetto: true, rigaNonFidata: true,
      motivo: `il contratto salvato l'ha scritto ${riga.scritto_da}, che non è chi migra né un superutente: non lo uso. `
        + `Controlla (SELECT * FROM ${schema}.contratti) e riscrivilo da qui con: node lib/db/scripts/argos-permessi.mjs --forza`,
    };
  }
  return { disponibile: true, riga: riga && { versione: riga.versione, elenco: riga.elenco } };
}

/**
 * Il contratto in vigore (puro). Vince la versione più alta fra codice e
 * database; il codice scrive la sua solo se è più nuova. --forza applica e
 * scrive quella del codice comunque (per esempio se il contratto più nuovo era
 * sbagliato).
 */
export function contrattoEffettivo(codice, salvato, { forza = false } = {}) {
  const r = salvato?.riga ?? null;
  const dalCodice = {
    versione: codice.versione, elenco: [...codice.elenco], fonte: "codice", scrivi: false,
    salvata: r?.versione ?? null, nota: null, avvisi: [], errori: [],
  };
  if (!salvato?.disponibile) {
    // la tabella è a posto ma la riga l'ha scritta qualcun altro: --forza la riscrive
    if (forza && salvato?.rigaNonFidata) {
      return { ...dalCodice, scrivi: true, nota: `forzato: riscrivo il contratto salvato con la v${codice.versione} di questo codice` };
    }
    const testo = `contratto salvato non disponibile (${salvato?.motivo ?? "?"}): uso quello del codice, v${codice.versione}`;
    return salvato?.sospetto ? { ...dalCodice, errori: [testo] } : { ...dalCodice, avvisi: [testo] };
  }
  if (!r) return { ...dalCodice, scrivi: true, nota: `contratto v${codice.versione} registrato nel database` };
  if (forza) {
    return { ...dalCodice, scrivi: true, nota: r.versione > codice.versione ? `forzato: applico la v${codice.versione} del codice al posto della v${r.versione} del database` : null };
  }
  if (r.versione < codice.versione) {
    return { ...dalCodice, scrivi: true, nota: `contratto aggiornato dalla v${r.versione} alla v${codice.versione}` };
  }
  const elencoDb = [...(r.elenco ?? [])].filter((t) => t != null).sort();
  const validi = elencoDb.filter((t) => FORMATO.test(t));
  const scarti = elencoDb.filter((t) => !FORMATO.test(t)).map((t) => `voce non valida nel contratto salvato, ignorata: ${t}`);
  if (r.versione === codice.versione) {
    if (JSON.stringify(elencoDb) === JSON.stringify([...codice.elenco].sort())) return dalCodice;
    return {
      ...dalCodice, elenco: validi, fonte: "database",
      errori: [`il contratto v${r.versione} salvato nel database è diverso da quello del codice con la stessa versione: uso quello del database; alza ARGOS_VERSIONE`, ...scarti],
    };
  }
  // il database è più nuovo: un'immagine precedente (rollback) o un revert del
  // contratto. Per togliere una tabella non si torna indietro: si alza la versione
  return {
    ...dalCodice, versione: r.versione, elenco: validi, fonte: "database", errori: scarti,
    avvisi: [`uso il contratto v${r.versione} salvato nel database: questo codice ha la v${codice.versione}. `
      + "Se è un rollback va bene così; per togliere una tabella dal contratto si alza la versione, non si torna indietro"],
  };
}

async function salvaContratto(client, codice, forza) {
  await client.query(`
    INSERT INTO ${id(TRACCIAMENTO.migrationsSchema)}.contratti AS c (nome, versione, elenco) VALUES ($1, $2, $3)
    ON CONFLICT (nome) DO UPDATE SET versione = EXCLUDED.versione, elenco = EXCLUDED.elenco, aggiornato_il = now()
     WHERE $4::boolean OR c.versione < EXCLUDED.versione`,
  [codice.nome, codice.versione, [...codice.elenco].sort(), forza]);
}

/**
 * Esegue le azioni una per una, ognuna in un SAVEPOINT: un'azione che fallisce
 * (per esempio «dependent privileges exist») non annulla le altre. Gli errori
 * per cui ha senso riprovare (lucchetto, stallo) annullano tutto e risalgono.
 */
export async function eseguiAzioni(client, azioni) {
  const fallite = [];
  for (const a of azioni) {
    await client.query("SAVEPOINT argos_azione");
    try {
      await client.query(a.sql);
      await client.query("RELEASE SAVEPOINT argos_azione");
    } catch (err) {
      if (ritentabile(err)) throw err;
      await client.query("ROLLBACK TO SAVEPOINT argos_azione");
      await client.query("RELEASE SAVEPOINT argos_azione");
      fallite.push({ ...a, motivo: descriviErrore(err).motivo });
    }
  }
  return fallite;
}

/**
 * Riporta i permessi al contratto in una transazione, poi ricontrolla dentro
 * la stessa transazione. Quello che resta fuori posto diventa un errore, ma il
 * resto si salva: è sempre meglio di prima. Il lucchetto è quello delle
 * migrazioni: migratore e riga di comando non si accavallano (dentro il
 * migratore, che lo tiene già, passa subito).
 */
export async function allinea(client, { ruolo = RUOLO_ARGOS, codice = CONTRATTO, forza = false } = {}) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CHIAVE_LUCCHETTO]);
    const contratto = contrattoEffettivo(codice, await leggiContrattoSalvato(client, codice.nome, ruolo), { forza });
    const prima = piano(await leggiStato(client, ruolo, contratto.elenco), contratto.elenco);
    const fallite = await eseguiAzioni(client, prima.azioni);
    if (contratto.scrivi) await salvaContratto(client, codice, forza);
    const dopo = piano(await leggiStato(client, ruolo, contratto.elenco), contratto.elenco);
    await client.query("COMMIT");
    const sqlFallite = new Set(fallite.map((f) => f.sql));
    const ancora = new Set(dopo.azioni.map((a) => a.sql));
    return {
      assente: prima.assente,
      contratto,
      fatte: prima.azioni.filter((a) => !sqlFallite.has(a.sql) && !ancora.has(a.sql)),
      avvisi: [...contratto.avvisi, ...dopo.avvisi],
      errori: [
        ...contratto.errori,
        ...fallite.map((f) => `${f.perche}: non riuscito «${f.sql}» (${f.motivo})`),
        ...dopo.errori,
        ...dopo.azioni.filter((a) => !sqlFallite.has(a.sql)).map((a) => `${a.perche}: è rimasto dopo «${a.sql}»`),
      ],
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Solo lettura: che cosa non è in regola. */
export async function verifica(client, { ruolo = RUOLO_ARGOS, codice = CONTRATTO, forza = false } = {}) {
  const contratto = contrattoEffettivo(codice, await leggiContrattoSalvato(client, codice.nome, ruolo), { forza });
  // qui non si scrive: la nota dice cosa farà il prossimo allineamento
  if (contratto.scrivi) {
    contratto.nota = `il database ha ${contratto.salvata ? `la v${contratto.salvata}` : "nessun contratto"}: `
      + `il prossimo allineamento registra la v${codice.versione}`;
  }
  const p = piano(await leggiStato(client, ruolo, contratto.elenco), contratto.elenco);
  return {
    assente: p.assente, contratto, daFare: p.azioni,
    avvisi: [...contratto.avvisi, ...p.avvisi], errori: [...contratto.errori, ...p.errori],
  };
}
