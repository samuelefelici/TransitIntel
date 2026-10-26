// I permessi di argos_ro, il ruolo con cui Argos legge il database di Cerbero,
// confrontati col contratto (lib/db/contratti/argos-lettura.mjs) e riportati
// lì: SELECT sulle tabelle dell'elenco, nient'altro negli schemi di Cerbero,
// niente oggetti futuri.
//
// leggiStato legge il catalogo; piano (puro) dice cosa non è in regola e con
// quale istruzione si sistema; allinea esegue il piano; verifica lo riporta
// soltanto. Si tocca solo ciò che è fuori posto: su un database in regola
// allinea non scrive niente. Quello che toccherebbe altri ruoli (PUBLIC, un
// ruolo di cui argos_ro è membro, il proprietario) non si corregge da solo:
// diventa un errore con l'istruzione da eseguire.
//
// Oltre alle voci di permesso, piano guarda i permessi effettivi
// (has_table_privilege & c., che contano anche PUBLIC, appartenenze e
// proprietà): «in regola» vuol dire che argos_ro non può fare niente fuori dal
// contratto, qualunque sia il motivo.
//
// Il contratto in vigore è il più nuovo fra quello del codice e quello salvato
// nel database (cerbero_migrazioni.contratti, migrazione 0002): un'immagine
// vecchia di Cerbero non toglie ad Argos le tabelle date da una più nuova.
//
// Niente import.meta né JSON letti a runtime: l'API importa questo modulo e
// viene impacchettata da esbuild in CommonJS.

import { ARGOS_LETTURA, ARGOS_VERSIONE, RUOLO_ARGOS } from "../contratti/argos-lettura.mjs";
import { CHIAVE_LUCCHETTO, TRACCIAMENTO, descriviErrore, ritentabile } from "./migrazioni-regole.mjs";

/** Gli schemi di Cerbero: quelli che l'allineamento governa. */
export const SCHEMI = Object.freeze(["public", "caronte"]);

/** Una voce del contratto: schema di Cerbero, punto, nome semplice. */
export const FORMATO = new RegExp(`^(${SCHEMI.join("|")})\\.[a-z0-9_]+$`);

/** Il contratto del codice. */
export const CONTRATTO = Object.freeze({ nome: "argos_lettura", versione: ARGOS_VERSIONE, elenco: ARGOS_LETTURA });

const TIPI_PREDEFINITI = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS", L: "LARGE OBJECTS" };
const ATTRIBUTI = [["replica", "REPLICATION"], ["bypassrls", "BYPASSRLS"], ["crearuoli", "CREATEROLE"]];

const id = (s) => `"${String(s).replace(/"/g, '""')}"`;
/** Il grantee 0 è PUBLIC, che non va tra virgolette: "PUBLIC" sarebbe un ruolo che non esiste. */
const chi = (nome) => (nome === "PUBLIC" ? "PUBLIC" : id(nome));
/** Chiave di una relazione: lo schema viene da SCHEMI, senza punti, quindi è univoca. */
const chiave = (o) => `${o.schema}.${o.tabella}`;
const relSql = (o) => `${id(o.schema)}.${id(o.tabella)}`;
/** Solo per le voci del contratto, già controllate con FORMATO. */
const nomeSql = (voce) => {
  const i = voce.indexOf(".");
  return `${id(voce.slice(0, i))}.${id(voce.slice(i + 1))}`;
};
const oggettoSql = (tipo) => (tipo === "S" ? "SEQUENCE" : "TABLE");
const elencoBreve = (v, n = 10) => v.slice(0, n).join(", ") + (v.length > n ? ` e altre ${v.length - n}` : "");

/** Lo stato dei permessi di un ruolo, letto dal catalogo (nessuna scrittura). */
export async function leggiStato(client, ruolo = RUOLO_ARGOS, elenco = ARGOS_LETTURA) {
  const q = async (testo, params) => (await client.query(testo, params)).rows;
  const r = await q(`
    SELECT oid, rolsuper, rolreplication, rolbypassrls, rolcreaterole, rolcanlogin,
           current_setting('server_version_num')::int AS versione_pg
      FROM pg_roles WHERE rolname = $1`, [ruolo]);
  if (!r.length) return { ruolo, esiste: false };
  const oid = r[0].oid;
  const schemi = [...SCHEMI];
  const P = [oid, schemi];

  // le voci di permesso, del ruolo (grantee = oid) e di tutti (grantee 0)
  const voci = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, c.relkind AS tipo,
           a.grantee = 0 AS a_tutti, a.privilege_type AS privilegio, a.is_grantable AS con_opzione,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(c.relowner)) AS dato_da, false AS colonna,
           EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                     AND d.objid = c.oid AND d.deptype = 'e') AS estensione
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = ANY($2) AND a.grantee IN ($1, 0)
    UNION ALL
    SELECT DISTINCT n.nspname, c.relname, c.relkind, a.grantee = 0, a.privilege_type, a.is_grantable,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(c.relowner)), true,
           EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                     AND d.objid = c.oid AND d.deptype = 'e')
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE n.nspname = ANY($2) AND a.grantee IN ($1, 0)
     ORDER BY 1, 2, 5`, P);

  // permessi che il ruolo ha passato ad altri: REVOKE senza CASCADE fallirebbe
  const concessiDaLui = await q(`
    SELECT DISTINCT 'relazione' AS genere, c.relkind::text AS tipo, n.nspname::text AS schema, c.relname::text AS tabella,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS a_chi
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = ANY($2) AND a.grantor = $1 AND a.grantee <> $1
    UNION
    SELECT DISTINCT 'relazione', c.relkind::text, n.nspname::text, c.relname::text,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
      FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE n.nspname = ANY($2) AND a.grantor = $1 AND a.grantee <> $1
    UNION
    SELECT DISTINCT 'schema', NULL::text, n.nspname::text, NULL::text,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
     WHERE n.nspname = ANY($2) AND a.grantor = $1 AND a.grantee <> $1
     ORDER BY 3, 4, 5`, P);

  // tutto ciò che il ruolo possiede in questo database, e il database stesso
  const possiede = await q(`
    SELECT pg_describe_object(s.classid, s.objid, s.objsubid) AS oggetto,
           n.nspname AS schema, c.relname AS tabella
      FROM pg_shdepend s
      LEFT JOIN pg_class c ON s.classid = 'pg_class'::regclass AND c.oid = s.objid
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = $1 AND s.deptype = 'o'
       AND (s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            OR (s.dbid = 0 AND s.classid = 'pg_database'::regclass
                AND s.objid = (SELECT oid FROM pg_database WHERE datname = current_database())))
     ORDER BY 1`, [oid]);

  // ALTER DEFAULT PRIVILEGES FOR ROLE x vuole i privilegi di x (PG ≥ 16:
  // has_privs_of_role, cioè USAGE) oppure un superutente
  const predefiniti = await q(`
    SELECT pg_get_userbyid(d.defaclrole) AS proprietario, n.nspname AS schema, d.defaclobjtype AS tipo,
           bool_or(a.grantee = $1) AS suo, bool_or(a.grantee = 0) AS a_tutti,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, d.defaclrole, 'USAGE') AS gestibile
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE a.grantee IN ($1, 0)
     GROUP BY d.oid, d.defaclrole, n.nspname, d.defaclobjtype
     ORDER BY 1, 2 NULLS FIRST, 3`, [oid]);

  const schemiStato = await q(`
    SELECT n.nspname AS schema,
           has_schema_privilege($1::oid, n.oid, 'USAGE') AS uso,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = $1 AND a.privilege_type = 'CREATE') AS crea,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = $1 AND a.is_grantable) AS con_opzione,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS tutti_creano,
           has_schema_privilege($1::oid, n.oid, 'CREATE') AS crea_eff,
           has_schema_privilege($1::oid, n.oid, 'USAGE WITH GRANT OPTION, CREATE WITH GRANT OPTION') AS opzione_eff,
           CASE WHEN pg_has_role($1::oid, n.nspowner, 'MEMBER') THEN pg_get_userbyid(n.nspowner) END AS possiede_via
      FROM pg_namespace n WHERE n.nspname = ANY($2) ORDER BY 1`, P);

  const [database] = await q(`
    SELECT d.datname AS nome,
           CASE WHEN pg_has_role($1::oid, d.datdba, 'MEMBER') THEN pg_get_userbyid(d.datdba) END AS possiede_via,
           has_database_privilege($1::oid, d.oid, 'CREATE') AS crea_eff,
           has_database_privilege($1::oid, d.oid, 'CONNECT') AS connette,
           EXISTS (SELECT 1 FROM aclexplode(d.datacl) a WHERE a.grantee = $1 AND a.privilege_type = 'CREATE') AS crea,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS tutti_creano
      FROM pg_database d WHERE d.datname = current_database()`, [oid]);

  // permessi effettivi su ogni relazione degli schemi di Cerbero. CASE e non
  // AND: has_sequence_privilege su una tabella dà errore, e solo CASE
  // garantisce l'ordine di valutazione. MAINTAIN esiste da PG 17.
  const scrittura = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
    ...(r[0].versione_pg >= 170000 ? ["MAINTAIN"] : [])];
  const opzione = ["SELECT", ...scrittura].map((p) => `${p} WITH GRANT OPTION`);
  const effettivi = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, c.relkind AS tipo,
           EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                     AND d.objid = c.oid AND d.deptype = 'e') AS estensione,
           CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1::oid, c.oid, 'SELECT, USAGE, UPDATE')
                ELSE has_any_column_privilege($1::oid, c.oid, 'SELECT') END AS legge,
           CASE WHEN c.relkind = 'S' THEN false
                ELSE has_table_privilege($1::oid, c.oid, $3)
                  OR has_any_column_privilege($1::oid, c.oid, 'INSERT, UPDATE, REFERENCES') END AS scrive,
           CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1::oid, c.oid,
                  'SELECT WITH GRANT OPTION, USAGE WITH GRANT OPTION, UPDATE WITH GRANT OPTION')
                ELSE has_table_privilege($1::oid, c.oid, $4)
                  OR has_any_column_privilege($1::oid, c.oid,
                       'SELECT WITH GRANT OPTION, INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION, REFERENCES WITH GRANT OPTION') END AS opzione
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 1, 2`, [oid, schemi, scrittura.join(", "), opzione.join(", ")]);

  // fuori dagli schemi di Cerbero, nello stesso database: solo per avvisare
  const altrove = await q(`
    SELECT n.nspname || '.' || c.relname AS nome
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname <> ALL($2) AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_schema_privilege($1::oid, n.oid, 'USAGE')
       AND has_any_column_privilege($1::oid, c.oid, 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                         AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY 1`, P);

  const membroDi = await q(
    "SELECT pg_get_userbyid(roleid) AS ruolo FROM pg_auth_members WHERE member = $1 ORDER BY 1", [oid],
  );
  const esistenti = await q(
    "SELECT t FROM unnest($1::text[]) t WHERE to_regclass(t) IS NOT NULL",
    [[...elenco].filter((t) => FORMATO.test(t))],
  );

  return {
    ruolo, esiste: true,
    attributi: {
      superutente: r[0].rolsuper, replica: r[0].rolreplication, bypassrls: r[0].rolbypassrls,
      crearuoli: r[0].rolcreaterole, login: r[0].rolcanlogin,
    },
    voci, concessiDaLui, possiede, predefiniti, schemi: schemiStato, database: database ?? null,
    effettivi, altrove: altrove.map((x) => x.nome),
    membroDi: membroDi.map((x) => x.ruolo), esistenti: esistenti.map((x) => x.t),
  };
}

/**
 * Che cosa fare per portare lo stato al contratto (puro: niente database).
 * azioni: istruzioni che l'allineamento esegue, col perché e la relazione;
 * errori: cose da sistemare a mano (toccano altri ruoli, o servono i diritti
 * di un altro ruolo), con l'istruzione; avvisi: cose da sapere che non
 * allargano quello che argos_ro può fare negli schemi di Cerbero.
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
  const bloccate = new Set(); // relazioni su cui un REVOKE fallirebbe o non serve
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
  if (stato.possiede.length) {
    errore(`${ruolo} è proprietario di ${elencoBreve(stato.possiede.map((p) => p.oggetto))}: ci può fare tutto `
      + `(REASSIGN OWNED BY ${R} TO <proprietario delle tabelle>)`);
    for (const p of stato.possiede) if (p.schema && p.tabella) { bloccate.add(chiave(p)); spiegate.add(chiave(p)); }
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
  if (stato.database?.possiede_via) {
    if (!stato.possiede.some((p) => p.oggetto === `database ${stato.database.nome}`)) {
      errore(`${ruolo} ha i diritti del proprietario del database ${stato.database.nome} (${stato.database.possiede_via}), `
        + "quindi anche dello schema public");
    }
    globali.push("database");
  }

  // 3. permessi passati ad altri: REVOKE senza CASCADE fallirebbe
  const passati = new Map();
  for (const d of stato.concessiDaLui) {
    const k = d.genere === "schema" ? `schema ${d.schema}` : `${d.schema}.${d.tabella}`;
    const v = passati.get(k) ?? { ...d, a_chi: [] };
    v.a_chi.push(d.a_chi);
    passati.set(k, v);
  }
  for (const [k, d] of passati) {
    const oggetto = d.genere === "schema" ? `SCHEMA ${id(d.schema)}` : `${oggettoSql(d.tipo)} ${relSql(d)}`;
    if (d.genere === "schema") schemiBloccati.add(d.schema);
    else { bloccate.add(k); spiegate.add(k); }
    errore(`${ruolo} ha passato a ${d.a_chi.join(", ")} permessi su ${k}: toglili insieme ai suoi `
      + `(REVOKE GRANT OPTION FOR ALL ON ${oggetto} FROM ${R} CASCADE), poi riallinea`);
  }

  // 4. voci di permesso del ruolo, raggruppate per relazione
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
    const nelContratto = ammesse.has(k) && g.tipo !== "S";
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
        + `(SET ROLE ${id(da)}; REVOKE ALL ON ${oggettoSql(g.tipo)} ${relSql(g)} FROM ${R}; RESET ROLE;)`);
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
    if (!esistenti.has(t)) avviso(`${t} è nel contratto ma non esiste`);
    else if (!giaInRegola.has(t) && !bloccate.has(t)) {
      azione(`GRANT SELECT ON TABLE ${nomeSql(t)} TO ${R}`,
        ridotte.has(t) ? `${t}: rimessa la sola lettura` : `${t}: nel contratto, manca la lettura`, t);
    }
  }

  // 6. schemi
  for (const s of stato.schemi) {
    if (!s.uso) azione(`GRANT USAGE ON SCHEMA ${id(s.schema)} TO ${R}`, `schema ${s.schema}: serve per leggerne le tabelle`);
    if (s.tutti_creano) {
      errore(`schema ${s.schema}: tutti i ruoli (PUBLIC) ci possono creare tabelle, compreso ${ruolo}. `
        + `Toglierlo tocca tutti i ruoli: REVOKE CREATE ON SCHEMA ${id(s.schema)} FROM PUBLIC`);
    }
    if (schemiBloccati.has(s.schema)) continue;
    if (s.crea) azione(`REVOKE CREATE ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${ruolo} ci può creare tabelle`);
    if (s.con_opzione) azione(`REVOKE GRANT OPTION FOR ALL ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${ruolo} può passare ad altri i suoi permessi`);
    const spiegato = s.crea || s.con_opzione || s.tutti_creano;
    if ((s.crea_eff || s.opzione_eff) && !spiegato && !globali.length) {
      errore(`schema ${s.schema}: ${ruolo} ${s.crea_eff ? "ci può creare tabelle" : "può passare ad altri i permessi"}, `
        + `e non lo spiegano né i suoi permessi né quelli di PUBLIC (guarda \\dn+ ${s.schema})`);
    }
  }

  // 7. permessi di default
  for (const d of stato.predefiniti) {
    const tipo = TIPI_PREDEFINITI[d.tipo] ?? d.tipo;
    const dove = d.schema ? ` in ${d.schema}` : " in tutti gli schemi";
    const forRole = `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(d.proprietario)}${d.schema ? ` IN SCHEMA ${id(d.schema)}` : ""}`;
    const cosa = `permessi di default di ${d.proprietario}${dove} (${tipo})`;
    if (d.schema && !SCHEMI.includes(d.schema)) {
      if (d.suo) avviso(`${cosa}: danno a ${ruolo} gli oggetti futuri di uno schema che non è di Cerbero; non li tocco`);
      continue;
    }
    if (d.suo) {
      if (d.gestibile) azione(`${forRole} REVOKE ALL ON ${tipo} FROM ${R}`, `${cosa}: darebbero a ${ruolo} gli oggetti che verranno creati`);
      else errore(`${cosa}: danno a ${ruolo} gli oggetti futuri; per toglierli servono i diritti di ${d.proprietario} o un superutente (${forRole} REVOKE ALL ON ${tipo} FROM ${R})`);
    }
    if (d.a_tutti && (d.tipo === "r" || d.tipo === "S")) {
      errore(`${cosa}: gli oggetti futuri saranno di tutti i ruoli (PUBLIC), compreso ${ruolo}. Toglierlo tocca tutti i ruoli: ${forRole} REVOKE ALL ON ${tipo} FROM PUBLIC`);
    }
  }

  // 8. appartenenze
  for (const m of stato.membroDi) {
    errore(`${ruolo} è membro di ${m}: può tutto quello che può quel ruolo, fuori dal contratto (REVOKE ${id(m)} FROM ${R})`);
    globali.push(`membro di ${m}`);
  }

  // 9. database
  const db = stato.database;
  if (db) {
    if (db.crea) azione(`REVOKE CREATE ON DATABASE ${id(db.nome)} FROM ${R}`, `database ${db.nome}: ${ruolo} ci può creare schemi`);
    if (db.tutti_creano) {
      errore(`database ${db.nome}: tutti i ruoli (PUBLIC) ci possono creare schemi, compreso ${ruolo}. `
        + `Toglierlo tocca tutti i ruoli: REVOKE CREATE ON DATABASE ${id(db.nome)} FROM PUBLIC`);
    }
    if (db.crea_eff && !db.crea && !db.tutti_creano && !globali.length) {
      errore(`database ${db.nome}: ${ruolo} ci può creare schemi, e non lo spiegano né i suoi permessi né quelli di PUBLIC`);
    }
  }

  // 10. permessi effettivi: quello che argos_ro può davvero fare, per qualunque motivo
  const conAzione = new Set(esito.azioni.map((a) => a.oggetto).filter(Boolean));
  const perAltriMotivi = [];
  for (const e of stato.effettivi) {
    const k = chiave(e);
    const nelContratto = ammesse.has(k) && e.tipo !== "S";
    const cosa = [];
    if (e.legge && !nelContratto) cosa.push(e.tipo === "S" ? "usa la sequenza" : "legge");
    if (e.scrive) cosa.push("scrive");
    if (e.opzione) cosa.push("può passare ad altri i permessi");
    if (!cosa.length || conAzione.has(k) || spiegate.has(k) || bloccate.has(k)) continue;
    if (e.estensione) avviso(`${k}: ${ruolo} ${cosa.join(", ")} (oggetto di un'estensione)`);
    else if (globali.length) perAltriMotivi.push(`${k} (${cosa.join(", ")})`);
    else errore(`${k}: ${ruolo} ${cosa.join(", ")}, e non lo spiegano né i suoi permessi né quelli di PUBLIC (guarda \\dp ${k})`);
  }
  if (perAltriMotivi.length) errore(`per i motivi qui sopra ${ruolo} può anche: ${elencoBreve(perAltriMotivi)}`);

  // 11. fuori dagli schemi di Cerbero
  if (stato.altrove.length) {
    avviso(`${ruolo} legge anche tabelle fuori dagli schemi di Cerbero: ${elencoBreve(stato.altrove)}`);
  }
  return esito;
}

/** Il contratto salvato nel database, se c'è e si può leggere (senza mai far fallire la transazione). */
export async function leggiContrattoSalvato(client, nome = CONTRATTO.nome) {
  const schema = TRACCIAMENTO.migrationsSchema;
  const { rows } = await client.query(`
    SELECT c.oid IS NOT NULL AS c_e,
           has_schema_privilege(n.oid, 'USAGE') AND (c.oid IS NULL OR has_table_privilege(c.oid, 'SELECT')) AS leggibile
      FROM pg_namespace n
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'contratti' AND c.relkind = 'r'
     WHERE n.nspname = $1`, [schema]);
  if (!rows.length || !rows[0].c_e) return { disponibile: false, motivo: `manca ${schema}.contratti (migrazione 0002)` };
  if (!rows[0].leggibile) return { disponibile: false, motivo: `${schema}.contratti non è leggibile da questo utente` };
  const r = await client.query(`SELECT versione, elenco FROM ${id(schema)}.contratti WHERE nome = $1`, [nome]);
  return { disponibile: true, riga: r.rows[0] ?? null };
}

/**
 * Il contratto in vigore (puro). Vince la versione più alta fra codice e
 * database; il codice scrive la sua solo se è più nuova. --forza applica e
 * scrive quella del codice comunque (per esempio se il contratto più nuovo era
 * sbagliato).
 */
export function contrattoEffettivo(codice, salvato, { forza = false } = {}) {
  const dalCodice = { versione: codice.versione, elenco: [...codice.elenco], fonte: "codice", scrivi: false, nota: null, avvisi: [], errori: [] };
  if (!salvato?.disponibile) {
    return { ...dalCodice, avvisi: [`contratto salvato non disponibile (${salvato?.motivo ?? "?"}): uso quello del codice, v${codice.versione}`] };
  }
  const r = salvato.riga;
  if (!r) return { ...dalCodice, scrivi: true, nota: `contratto v${codice.versione} registrato nel database` };
  if (forza) {
    return { ...dalCodice, scrivi: true, nota: r.versione > codice.versione ? `forzato: applico la v${codice.versione} del codice al posto della v${r.versione} del database` : null };
  }
  if (r.versione < codice.versione) {
    return { ...dalCodice, scrivi: true, nota: `contratto aggiornato dalla v${r.versione} alla v${codice.versione}` };
  }
  const elencoDb = [...r.elenco].sort();
  const validi = elencoDb.filter((t) => FORMATO.test(t));
  const scarti = elencoDb.filter((t) => !FORMATO.test(t)).map((t) => `voce non valida nel contratto salvato, ignorata: ${t}`);
  if (r.versione === codice.versione) {
    if (JSON.stringify(elencoDb) === JSON.stringify([...codice.elenco].sort())) return dalCodice;
    return {
      versione: r.versione, elenco: validi, fonte: "database", scrivi: false, nota: null, avvisi: [],
      errori: [`il contratto v${r.versione} salvato nel database è diverso da quello del codice con la stessa versione: uso quello del database; alza ARGOS_VERSIONE`, ...scarti],
    };
  }
  return {
    versione: r.versione, elenco: validi, fonte: "database", scrivi: false, avvisi: [], errori: scarti,
    nota: `uso il contratto v${r.versione} salvato nel database: questo codice ha la v${codice.versione} (un'immagine precedente?)`,
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
    const contratto = contrattoEffettivo(codice, await leggiContrattoSalvato(client, codice.nome), { forza });
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
  const contratto = contrattoEffettivo(codice, await leggiContrattoSalvato(client, codice.nome), { forza });
  const p = piano(await leggiStato(client, ruolo, contratto.elenco), contratto.elenco);
  return {
    assente: p.assente, contratto, daFare: p.azioni,
    avvisi: [...contratto.avvisi, ...p.avvisi], errori: [...contratto.errori, ...p.errori],
  };
}
