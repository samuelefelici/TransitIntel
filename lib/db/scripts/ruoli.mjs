#!/usr/bin/env node
// I ruoli del database di Cerbero (ruoli-regole.mjs): cerbero_owner
// proprietario delle tabelle, cerbero_app l'utente dell'app. Lo fa già il
// migratore a ogni avvio dell'API; questo serve a mano, dal Terminal del
// container dell'API:
//   node lib/db/scripts/ruoli.mjs              riallinea (senza tetto di tempo)
//   node lib/db/scripts/ruoli.mjs --verifica   dice solo cosa non va
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL: serve un
// superutente (l'utente postgres). Esce con 1 se resta qualcosa da sistemare
// (con --verifica: anche se c'è qualcosa da fare).
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { APP, PROPRIETARIO, allinea, elencoDalCatalogo, verifica } from "./ruoli-regole.mjs";
import { descriviErrore, leggiCatalogo } from "./migrazioni-regole.mjs";

const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const soloVerifica = process.argv.includes("--verifica");
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
    SELECT usename, application_name, count(*)::int AS n FROM pg_catalog.pg_stat_activity
     WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
     GROUP BY 1, 2 ORDER BY 1, 2`);
  for (const c of collegati) log(`collegati come ${c.usename}: ${c.n} (${c.application_name || "senza nome"})`);
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
