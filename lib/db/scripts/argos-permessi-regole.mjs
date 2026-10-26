// I permessi di argos_ro, il ruolo con cui Argos legge il database di Cerbero,
// confrontati col contratto (lib/db/contratti/argos-lettura.mjs) e riportati
// lì: SELECT sulle tabelle dell'elenco, nient'altro negli schemi di Cerbero,
// niente oggetti futuri.
//
// leggiStato legge il catalogo, piano (puro) dice cosa non è in regola e con
// quale istruzione si sistema, allinea esegue il piano, verifica lo riporta
// soltanto. Si tocca solo ciò che non è in regola: su un database già
// allineato allinea non scrive niente, quindi non riscrive pg_class a ogni
// avvio. La usano il migratore (migra.mjs, a ogni avvio), la riga di comando
// (argos-permessi.mjs) e il controllo all'avvio dell'API.

import { ARGOS_LETTURA, RUOLO_ARGOS } from "../contratti/argos-lettura.mjs";
import { CHIAVE_LUCCHETTO } from "./migrazioni-regole.mjs";

/** Gli schemi di Cerbero: quelli che l'allineamento governa. */
export const SCHEMI = Object.freeze(["public", "caronte"]);

const TIPI_PREDEFINITI = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS", L: "LARGE OBJECTS" };

const id = (s) => `"${String(s).replace(/"/g, '""')}"`;
/** "schema.tabella" → "schema"."tabella" */
const nomeSql = (nome) => nome.split(".").map(id).join(".");

/** Lo stato dei permessi di un ruolo, letto dal catalogo (nessuna scrittura). */
export async function leggiStato(client, ruolo = RUOLO_ARGOS, contratto = ARGOS_LETTURA) {
  const q = async (testo, params) => (await client.query(testo, params)).rows;
  const r = await q("SELECT oid, rolsuper FROM pg_roles WHERE rolname = $1", [ruolo]);
  if (!r.length) return { ruolo, esiste: false };
  const oid = r[0].oid;
  const schemi = [...SCHEMI];

  const relazioni = await q(`
    SELECT n.nspname || '.' || c.relname AS nome, c.relkind AS tipo,
           a.privilege_type AS privilegio, a.is_grantable AS con_opzione,
           NULLIF(pg_get_userbyid(a.grantor), pg_get_userbyid(c.relowner)) AS dato_da
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = ANY($2) AND a.grantee = $1`, [oid, schemi]);
  const colonne = await q(`
    SELECT DISTINCT n.nspname || '.' || c.relname AS nome
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE n.nspname = ANY($2) AND a.grantee = $1`, [oid, schemi]);
  // permessi che il ruolo ha passato ad altri: REVOKE senza CASCADE fallirebbe
  const concessiDaLui = await q(`
    SELECT DISTINCT n.nspname || '.' || c.relname AS nome, pg_get_userbyid(a.grantee) AS a_chi
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = ANY($2) AND a.grantor = $1 AND a.grantee <> $1
    UNION
    SELECT DISTINCT n.nspname || '.' || c.relname, pg_get_userbyid(a.grantee)
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE n.nspname = ANY($2) AND a.grantor = $1 AND a.grantee <> $1`, [oid, schemi]);
  const possiede = await q(`
    SELECT n.nspname || '.' || c.relname AS nome
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($2) AND c.relowner = $1`, [oid, schemi]);
  const aTutti = await q(`
    SELECT DISTINCT n.nspname || '.' || c.relname AS nome
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = ANY($1) AND a.grantee = 0 AND a.privilege_type = 'SELECT'`, [schemi]);
  // ALTER DEFAULT PRIVILEGES FOR ROLE x vuole i privilegi di x (PG ≥ 16:
  // has_privs_of_role, cioè USAGE) oppure un superutente
  const predefiniti = await q(`
    SELECT pg_get_userbyid(d.defaclrole) AS proprietario, n.nspname AS schema, d.defaclobjtype AS tipo,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
             OR pg_has_role(current_user, d.defaclrole, 'USAGE') AS gestibile
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = $1)
     ORDER BY 1, 2 NULLS FIRST, 3`, [oid]);
  const schemiStato = await q(`
    SELECT n.nspname AS schema,
           has_schema_privilege($1::oid, n.oid, 'USAGE') AS uso,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = $1 AND a.privilege_type = 'CREATE') AS crea,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = $1 AND a.is_grantable) AS con_opzione,
           EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS tutti_creano
      FROM pg_namespace n WHERE n.nspname = ANY($2) ORDER BY 1`, [oid, schemi]);
  const membroDi = await q(
    "SELECT pg_get_userbyid(roleid) AS ruolo FROM pg_auth_members WHERE member = $1 ORDER BY 1", [oid],
  );
  const esistenti = await q(
    "SELECT t FROM unnest($1::text[]) t WHERE to_regclass(t) IS NOT NULL", [[...contratto]],
  );

  return {
    ruolo, esiste: true, superutente: r[0].rolsuper,
    relazioni, colonne: colonne.map((x) => x.nome), concessiDaLui, possiede: possiede.map((x) => x.nome),
    aTutti: aTutti.map((x) => x.nome), predefiniti, schemi: schemiStato,
    membroDi: membroDi.map((x) => x.ruolo), esistenti: esistenti.map((x) => x.t),
  };
}

/**
 * Che cosa fare per portare lo stato al contratto (puro: niente database).
 * azioni: istruzioni da eseguire, col perché; avvisi: cose che l'allineamento
 * non corregge da solo perché toccano altri ruoli; errori: cose da sistemare a
 * mano prima che l'allineamento possa finire.
 */
export function piano(stato, contratto = ARGOS_LETTURA) {
  const esito = { assente: !stato.esiste, azioni: [], avvisi: [], errori: [] };
  if (!stato.esiste) return esito;
  const R = id(stato.ruolo);
  const ammesse = new Set(contratto);
  const esistenti = new Set(stato.esistenti);
  const azione = (sql, perche) => esito.azioni.push({ sql, perche });

  if (stato.superutente) {
    esito.errori.push(`${stato.ruolo} è superutente: legge tutto a prescindere dai permessi (ALTER ROLE ${stato.ruolo} NOSUPERUSER)`);
  }
  for (const t of stato.possiede) {
    esito.errori.push(`${stato.ruolo} è proprietario di ${t}: ci può fare tutto (ALTER TABLE ${t} OWNER TO <proprietario delle tabelle>)`);
  }

  const bloccate = new Set();
  for (const d of stato.concessiDaLui) {
    bloccate.add(d.nome);
    esito.errori.push(`${stato.ruolo} ha passato a ${d.a_chi} permessi su ${d.nome}: toglili (REVOKE ALL ON ${d.nome} FROM ${d.a_chi}), poi riallinea`);
  }

  const perRelazione = new Map();
  for (const p of stato.relazioni) {
    const v = perRelazione.get(p.nome) ?? { tipo: p.tipo, privilegi: [] };
    v.privilegi.push(p);
    perRelazione.set(p.nome, v);
  }
  const colonne = new Set(stato.colonne);
  const giaInRegola = new Set();
  const ridotte = new Set();

  for (const nome of [...new Set([...perRelazione.keys(), ...colonne])].sort()) {
    if (bloccate.has(nome)) continue;
    const info = perRelazione.get(nome);
    const sequenza = info?.tipo === "S";
    const descr = [
      info?.privilegi.map((p) => p.privilegio + (p.con_opzione ? " con opzione" : "") + (p.dato_da ? ` dato da ${p.dato_da}` : "")).join(", "),
      colonne.has(nome) ? "permessi su colonne" : "",
    ].filter(Boolean).join("; ");
    if (!ammesse.has(nome) || sequenza) {
      azione(`REVOKE ALL ON ${sequenza ? "SEQUENCE" : "TABLE"} ${nomeSql(nome)} FROM ${R}`, `${nome}: fuori dal contratto (${descr})`);
    } else if (!colonne.has(nome) && info?.privilegi.every((p) => p.privilegio === "SELECT" && !p.con_opzione)) {
      giaInRegola.add(nome);
    } else {
      // REVOKE ALL sulla tabella toglie anche i permessi sulle colonne
      azione(`REVOKE ALL ON TABLE ${nomeSql(nome)} FROM ${R}`, `${nome}: nel contratto ma con permessi in più (${descr})`);
      ridotte.add(nome);
    }
  }

  for (const t of [...contratto].sort()) {
    if (!esistenti.has(t)) esito.avvisi.push(`${t} è nel contratto ma non esiste`);
    else if (!giaInRegola.has(t) && !bloccate.has(t)) {
      azione(`GRANT SELECT ON TABLE ${nomeSql(t)} TO ${R}`, ridotte.has(t) ? `${t}: rimessa la sola lettura` : `${t}: nel contratto, manca la lettura`);
    }
  }

  for (const s of stato.schemi) {
    if (s.crea) azione(`REVOKE CREATE ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${stato.ruolo} ci può creare tabelle`);
    if (s.con_opzione) azione(`REVOKE GRANT OPTION FOR ALL ON SCHEMA ${id(s.schema)} FROM ${R}`, `schema ${s.schema}: ${stato.ruolo} può passare ad altri i suoi permessi`);
    if (!s.uso) azione(`GRANT USAGE ON SCHEMA ${id(s.schema)} TO ${R}`, `schema ${s.schema}: serve per leggerne le tabelle`);
    if (s.tutti_creano) esito.avvisi.push(`schema ${s.schema}: tutti i ruoli ci possono creare tabelle (REVOKE CREATE ON SCHEMA ${s.schema} FROM PUBLIC)`);
  }

  for (const d of stato.predefiniti) {
    const tipo = TIPI_PREDEFINITI[d.tipo] ?? d.tipo;
    const dove = d.schema ? ` in ${d.schema}` : " in tutti gli schemi";
    const cosa = `permessi di default di ${d.proprietario}${dove} (${tipo})`;
    if (d.schema && !SCHEMI.includes(d.schema)) {
      esito.avvisi.push(`${cosa}: lo schema non è di Cerbero, non li tocco`);
    } else if (!d.gestibile) {
      esito.avvisi.push(`${cosa}: per toglierli serve ${d.proprietario} o un superutente (ALTER DEFAULT PRIVILEGES FOR ROLE ${d.proprietario}${d.schema ? ` IN SCHEMA ${d.schema}` : ""} REVOKE ALL ON ${tipo} FROM ${stato.ruolo})`);
    } else {
      azione(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${id(d.proprietario)}${d.schema ? ` IN SCHEMA ${id(d.schema)}` : ""} REVOKE ALL ON ${tipo} FROM ${R}`,
        `${cosa}: darebbero a ${stato.ruolo} gli oggetti che verranno creati`,
      );
    }
  }

  for (const m of stato.membroDi) {
    esito.errori.push(`${stato.ruolo} è membro di ${m}: legge anche con i permessi di quel ruolo, fuori dal contratto (REVOKE ${m} FROM ${stato.ruolo})`);
  }
  const aTuttiFuori = stato.aTutti.filter((t) => !ammesse.has(t));
  if (aTuttiFuori.length) {
    esito.avvisi.push(`leggibili da tutti i ruoli (GRANT … TO PUBLIC), quindi anche da ${stato.ruolo}: ${aTuttiFuori.join(", ")}`);
  }
  return esito;
}

/**
 * Riporta i permessi al contratto in una transazione, poi ricontrolla. Quello
 * che resta fuori posto (un permesso dato da un ruolo diverso dal proprietario,
 * che il REVOKE del proprietario non tocca) diventa un errore da sistemare a
 * mano, ma il resto si salva: è sempre meglio di prima. Il lucchetto è quello
 * delle migrazioni: migratore e riga di comando non si accavallano (dentro il
 * migratore, che lo tiene già, passa subito).
 */
export async function allinea(client, ruolo = RUOLO_ARGOS, contratto = ARGOS_LETTURA) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CHIAVE_LUCCHETTO]);
    const prima = piano(await leggiStato(client, ruolo, contratto), contratto);
    for (const a of prima.azioni) await client.query(a.sql);
    const dopo = piano(await leggiStato(client, ruolo, contratto), contratto);
    const restano = dopo.azioni.map((a) => `${a.perche}: è rimasto dopo «${a.sql}» (se l'ha dato un altro ruolo, va tolto da quel ruolo)`);
    await client.query("COMMIT");
    const fatte = prima.azioni.filter((a) => !dopo.azioni.some((d) => d.sql === a.sql));
    return { assente: prima.assente, fatte, avvisi: dopo.avvisi, errori: [...dopo.errori, ...restano] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Solo lettura: che cosa non è in regola. */
export async function verifica(client, ruolo = RUOLO_ARGOS, contratto = ARGOS_LETTURA) {
  const p = piano(await leggiStato(client, ruolo, contratto), contratto);
  return { assente: p.assente, daFare: p.azioni, avvisi: p.avvisi, errori: p.errori };
}
