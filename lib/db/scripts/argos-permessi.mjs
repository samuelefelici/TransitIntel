#!/usr/bin/env node
// I permessi di argos_ro, il ruolo con cui Argos legge il database di Cerbero,
// riportati al contratto (lib/db/contratti/argos-lettura.mjs). Lo fa già il
// migratore a ogni avvio dell'API; questo serve a mano, dal container
// dell'API, per esempio subito dopo che qualcuno ha rilanciato lo script di
// Argos:
//   node lib/db/scripts/argos-permessi.mjs             riallinea
//   node lib/db/scripts/argos-permessi.mjs --verifica  dice solo cosa non va
//   node lib/db/scripts/argos-permessi.mjs --forza     applica il contratto di
//       questo codice anche se nel database ce n'è uno più nuovo
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL: serve il
// proprietario delle tabelle (o un superutente). Esce con 1 se resta
// qualcosa da sistemare a mano (con --verifica: anche se c'è qualcosa da fare).
import { setTimeout as attendi } from "node:timers/promises";
import pg from "pg";
import { RUOLO_ARGOS } from "../contratti/argos-lettura.mjs";
import { allinea, verifica } from "./argos-permessi-regole.mjs";
import { descriviErrore, ritentabile } from "./migrazioni-regole.mjs";

const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const soloVerifica = process.argv.includes("--verifica");
const forza = process.argv.includes("--forza");
const log = (m) => console.log(`[permessi] ${m}`);

if (!url) {
  console.error("[permessi] né DATABASE_MIGRATOR_URL né DATABASE_URL");
  process.exit(2);
}

async function unGiro() {
  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
    application_name: "cerbero-permessi",
  });
  // senza, una connessione che cade fa uscire il processo con uno stack
  // trace invece che col messaggio qui sotto (la query in corso fallisce comunque)
  client.on("error", (err) => log(`connessione al database persa: ${err.message}`));
  await client.connect();
  try {
    if (soloVerifica) {
      const e = await verifica(client, { forza });
      return { ...e, fatte: e.daFare };
    }
    return await allinea(client, { forza });
  } finally {
    await client.end().catch(() => {});
  }
}

let esito;
for (let tentativo = 1; ; tentativo++) {
  try {
    esito = await unGiro();
    break;
  } catch (err) {
    if (ritentabile(err) && tentativo < 3) {
      log(`database occupato, riprovo fra ${tentativo * 5} s`);
      await attendi(tentativo * 5000);
      continue;
    }
    console.error(`[permessi] FALLITO: ${descriviErrore(err).motivo}`);
    if (!soloVerifica) console.error("[permessi] nessun permesso è cambiato (la transazione è annullata)");
    process.exit(1);
  }
}

const c = esito.contratto;
log(`contratto v${c.versione} (${c.fonte === "database" ? "salvato nel database" : "di questo codice"}, ${c.elenco.length} tabelle)`);
if (c.nota) log(c.nota);
if (esito.assente) log(`${RUOLO_ARGOS} non c'è: niente da fare`);
for (const a of esito.fatte) log(`${soloVerifica ? "da fare" : "fatto"}: ${a.perche}`);
for (const a of esito.avvisi) log(`ATTENZIONE: ${a}`);
for (const a of esito.errori) console.error(`[permessi] DA SISTEMARE A MANO: ${a}`);
const daFare = soloVerifica && esito.fatte.length > 0;
if (!esito.assente && !daFare && !esito.errori.length) {
  log(esito.avvisi.length
    ? `${RUOLO_ARGOS} in regola, con ${esito.avvisi.length === 1 ? "un avviso" : `${esito.avvisi.length} avvisi`} qui sopra`
    : `${RUOLO_ARGOS} in regola: legge le ${c.elenco.length} tabelle del contratto e nient'altro`);
}
if (daFare) log("per sistemare: node lib/db/scripts/argos-permessi.mjs");
process.exit(esito.errori.length || daFare ? 1 : 0);
