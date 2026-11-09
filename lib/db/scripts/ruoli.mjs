#!/usr/bin/env node
// I ruoli del database di Cerbero (ruoli-regole.mjs): cerbero_owner
// proprietario delle tabelle, cerbero_app l'utente dell'app. Lo fa già il
// migratore a ogni avvio dell'API; questo serve a mano, dal Terminal del
// container dell'API:
//   node lib/db/scripts/ruoli.mjs              riallinea (senza tetto di tempo)
//   node lib/db/scripts/ruoli.mjs --verifica   dice solo cosa non va
//   node lib/db/scripts/ruoli.mjs --prova-url  prova l'URL nuovo dell'app
//                                              (DEPLOY.md, «Ruoli del database», passo 4)
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL: serve un
// superutente (l'utente postgres). Esce con 1 se resta qualcosa da sistemare
// (con --verifica: anche se c'è qualcosa da fare).
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { APP, EVENTO_DDL, EVENTO_DDL_FINE, PROPRIETARIO, allinea, elencoDalCatalogo, verifica } from "./ruoli-regole.mjs";
import { descriviErrore, leggiCatalogo } from "./migrazioni-regole.mjs";

const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const argomenti = process.argv.slice(2);
const ignoti = argomenti.filter((a) => a !== "--verifica" && a !== "--prova-url");
if (ignoti.length || argomenti.length > 1) {
  // un'opzione scritta male non deve diventare un riallineamento
  console.error(`[ruoli] opzione sconosciuta: ${argomenti.join(" ")}. Uso: node lib/db/scripts/ruoli.mjs [--verifica | --prova-url]`);
  process.exit(2);
}

/* --prova-url: prima di cambiare DATABASE_URL su API e lavoratore, l'URL nuovo
 * (con la password di cerbero_app) si prova da qui, dove c'è node e non psql.
 * Si legge dall'input, non dalla riga di comando: così non resta nella
 * cronologia né nell'elenco dei processi. */
if (argomenti.includes("--prova-url")) {
  process.stdout.write("[ruoli] incolla il nuovo DATABASE_URL e premi Invio: ");
  const righe = (await import("node:readline")).createInterface({ input: process.stdin });
  const urlNuovo = (await new Promise((fine) => righe.once("line", fine)).finally(() => righe.close())).trim();
  const prova = new pg.Client({
    connectionString: urlNuovo,
    ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
    application_name: "cerbero-prova-url",
    connectionTimeoutMillis: 10_000,
  });
  try {
    await prova.connect();
    const { rows: [io] } = await prova.query(`
      SELECT session_user AS sessione, current_user AS corrente,
             (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente,
             (SELECT count(*)::int FROM pg_catalog.pg_event_trigger
               WHERE evtname = ANY ($1::text[]) AND evtenabled = 'A') AS eventi`, [[EVENTO_DDL, EVENTO_DDL_FINE]]);
    console.log(`[ruoli] collegato come ${io.sessione}, lavora come ${io.corrente}`
      + `${io.superutente ? ", superutente" : ""}; event trigger accesi: ${io.eventi} su 2`);
    const buono = io.sessione === APP && io.corrente === PROPRIETARIO && !io.superutente && io.eventi === 2;
    console.log(buono
      ? "[ruoli] l'URL va bene: si può mettere in DATABASE_URL di API e lavoratore"
      : `[ruoli] NON va bene: serve ${APP} che lavora come ${PROPRIETARIO}, con i due event trigger accesi (prima: node lib/db/scripts/ruoli.mjs)`);
    process.exit(buono ? 0 : 1);
  } catch (err) {
    console.error(`[ruoli] l'URL non funziona: ${descriviErrore(err).motivo}. `
      + "Password con caratteri come @ : / # % va codificata nell'URL; il ruolo deve avere LOGIN (passo 3)");
    process.exit(1);
  } finally {
    await prova.end().catch(() => {});
  }
}
const soloVerifica = argomenti.includes("--verifica");
/* I programmi che possono lavorare da superutente su questo database: il
 * migratore e gli strumenti di Cerbero, psql, e l'app di Cerbero finché non è
 * passata a cerbero_app. Ogni altro programma da superutente (per esempio
 * Caronte) che scrive nelle tabelle di Cerbero ne eseguirebbe i default e i
 * vincoli come superutente: va spostato su un suo ruolo (caronte_app). */
const SUPERUTENTI_AMMESSI = new Set(["cerbero-migrazioni", "cerbero-ruoli", "cerbero-permessi", "psql", "cerbero-api", "cerbero-lavoratore"]);
const log = (m) => console.log(`[ruoli] ${m}`);
const cartella = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

if (!url) {
  console.error("[ruoli] né DATABASE_MIGRATOR_URL né DATABASE_URL");
  process.exit(2);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
  application_name: "cerbero-ruoli",
});
client.on("error", (err) => log(`connessione al database persa: ${err.message}`));

let esito;
try {
  await client.connect();
  await client.query("SET search_path = pg_catalog, pg_temp");
  const elenco = elencoDalCatalogo(leggiCatalogo(cartella));
  esito = soloVerifica
    ? await verifica(client, elenco)
    : await allinea(client, elenco, { tettoMs: 10 * 60_000, lockMs: 5_000 });
  // chi è collegato oggi: dopo il cambio di DATABASE_URL, API e lavoratore come cerbero_app
  const { rows: collegati } = await client.query(`
    SELECT a.usename, a.application_name, coalesce(r.rolsuper, false) AS superutente, count(*)::int AS n
      FROM pg_catalog.pg_stat_activity a LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
     WHERE a.datname = current_database() AND a.backend_type = 'client backend' AND a.pid <> pg_catalog.pg_backend_pid()
     GROUP BY 1, 2, 3 ORDER BY 1, 2`);
  for (const c of collegati) {
    log(`collegati come ${c.usename}: ${c.n} (${c.application_name || "senza nome"})`);
    if (c.superutente && !SUPERUTENTI_AMMESSI.has(c.application_name)) {
      esito.errori.push(`${c.n} ${c.n === 1 ? "sessione" : "sessioni"} da superutente (${c.usename}) di «${c.application_name || "senza nome"}»: `
        + "se è un programma che scrive nelle tabelle di Cerbero (Caronte, il sistema AVM), ne eseguirebbe i default "
        + "come superutente. Va collegato col suo ruolo (caronte_app) prima di passare l'app a cerbero_app"
        + (c.application_name ? "" : ". Senza nome sono anche l'API e il lavoratore di prima della 2.8 (dopo un rollback dell'immagine)"));
    }
  }
} catch (err) {
  console.error(`[ruoli] FALLITO: ${descriviErrore(err).motivo}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

if (soloVerifica) {
  for (const a of esito.daFare) log(`da fare: ${a.perche} → ${a.sql}`);
  for (const a of esito.attese) log(`in attesa: ${a}`);
} else {
  for (const a of esito.fatte) log(`fatto: ${a.perche}`);
}
for (const a of esito.avvisi) log(`ATTENZIONE: ${a}`);
for (const a of esito.errori) console.error(`[ruoli] DA SISTEMARE A MANO: ${a}`);
const restano = soloVerifica ? esito.daFare.length + esito.attese.length : esito.daFare.length;
if (!restano && !esito.errori.length) {
  log(esito.avvisi.length
    ? `ruoli e proprietari in regola, con ${esito.avvisi.length === 1 ? "un avviso" : `${esito.avvisi.length} avvisi`} qui sopra`
    : `ruoli e proprietari in regola: le tabelle di Cerbero sono di ${PROPRIETARIO}, ${APP} lavora come ${PROPRIETARIO}`);
}
process.exit(esito.errori.length || restano ? 1 : 0);
