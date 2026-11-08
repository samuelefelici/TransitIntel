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
import { APP, ESCLUSE, PROPRIETARIO } from "./ruoli-nomi.mjs";

export { APP, ESCLUSE, PROPRIETARIO };
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
export const DA_LEGGERE = Object.freeze([`${TRACCIAMENTO.migrationsSchema}.${TRACCIAMENTO.migrationsTable}`, `${TRACCIAMENTO.migrationsSchema}.contratti`]);

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
 * Le relazioni di Cerbero dal catalogo atteso (meta/catalogo.json, già letto):
 * tabelle, viste e sequenze, tolte le escluse.
 */
export function elencoDalCatalogo(catalogo) {
  const da = (o) => Object.keys(o ?? {});
  const escluse = new Set(ESCLUSE);
  return [...new Set([...da(catalogo.tabelle), ...da(catalogo.viste), ...da(catalogo.sequenze)])]
    .filter((v) => /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(v) && !escluse.has(v))
    .sort();
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
      FROM pg_catalog.pg_roles r WHERE rolname = ANY ($1)`, [[PROPRIETARIO, APP]]);
  // le appartenenze che toccano i due ruoli, in entrambe le direzioni (PG16+: opzioni INHERIT e SET)
  const appartenenze = await q(`
    SELECT g.rolname AS ruolo, m.rolname AS membro, a.admin_option AS admin,
           a.inherit_option AS eredita, a.set_option AS imposta
      FROM pg_catalog.pg_auth_members a
      JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = a.member
     WHERE g.rolname = ANY ($1) OR m.rolname = ANY ($1)`, [[PROPRIETARIO, APP]]);
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
  [[...SCHEMI_DATI, TRACCIAMENTO.migrationsSchema], esiste(PROPRIETARIO)]);
  const lettura = await q(`
    SELECT v.voce, to_regclass(v.voce) IS NOT NULL AS esiste,
           CASE WHEN to_regclass(v.voce) IS NOT NULL AND $2
                THEN has_table_privilege(${lit(PROPRIETARIO)}, to_regclass(v.voce), 'SELECT') END AS legge
      FROM unnest($1::text[]) AS v(voce)`, [DA_LEGGERE, esiste(PROPRIETARIO)]);
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
  const fughe = await q(`
    SELECT p.oid::regprocedure::text AS funzione, o.rolname AS proprietario
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
     WHERE p.prosecdef AND o.rolsuper
       AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND p.prosrc ~* '\\m(public|caronte|coda)\\s*\\.'
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY 1`);
  return {
    io, ruoli, appartenenze, database: db, schemi, lettura, lettori, fughe,
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
        + `se è di un'altra applicazione, le dia i diritti che servono a ${PROPRIETARIO}`);
      continue;
    }
    if (r.tipo === "v" || r.tipo === "m") {
      const altrui = r.basi.filter((b) => b.proprietario !== PROPRIETARIO);
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
  for (const f of stato.fughe ?? []) {
    errori.push(`${f.funzione} è SECURITY DEFINER di ${f.proprietario} (superutente) e nomina tabelle di Cerbero: `
      + `con le tabelle di ${PROPRIETARIO}, l'app potrebbe farla girare con codice suo come superutente. `
      + "Va data a un ruolo che non sia superutente e legga solo quello che serve (per FleetCare: migrazione 0089); "
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
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [CHIAVE_LUCCHETTO]);
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
      const azioni = ultimo.azioni.filter((a) => giro === 1 || !fatte.some((f) => f.sql === a.sql));
      if (!azioni.length) break;
      for (const a of [...azioni].sort((x, y) => x.fase - y.fase)) {
        if (adesso() - inizio > tettoMs) {
          rimandate.push(a);
          continue;
        }
        const err = await esegui(client, a, lockMs);
        if (!err) fatte.push(a);
        else if (codiceDi(err) === ERRORE_LUCCHETTO) occupate.push(a);
        else if (codiceDi(err) === "42710" && /^CREATE ROLE /.test(a.sql)) fatte.push(a); // un altro database dello stesso server l'ha appena creato
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
    await client.query("SELECT pg_advisory_unlock($1)", [CHIAVE_LUCCHETTO]).catch(() => {});
  }
}

/** Solo lettura: cosa farebbe il prossimo allineamento. */
export async function verifica(client, elenco) {
  const p = piano(await leggiStato(client, elenco));
  return { daFare: p.azioni, attese: p.attese, avvisi: p.avvisi, errori: p.errori };
}
