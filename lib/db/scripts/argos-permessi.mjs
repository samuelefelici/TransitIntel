#!/usr/bin/env node
// I permessi di argos_ro, il ruolo con cui Argos legge il database di Cerbero,
// riportati al contratto (lib/db/contratti/argos-lettura.mjs). Lo fa già il
// migratore a ogni avvio dell'API; questo serve a mano, dal container
// dell'API, per esempio dopo che qualcuno ha rilanciato lo script di Argos:
//   node lib/db/scripts/argos-permessi.mjs             riallinea
//   node lib/db/scripts/argos-permessi.mjs --verifica  dice solo cosa non va
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL: serve il
// proprietario delle tabelle (o un superutente). Esce con 1 se resta
// qualcosa fuori posto (con --verifica: se c'è qualcosa da fare).
import { setTimeout as attendi } from "node:timers/promises";
import pg from "pg";
import { ARGOS_LETTURA, RUOLO_ARGOS } from "../contratti/argos-lettura.mjs";
import { allinea, verifica } from "./argos-permessi-regole.mjs";
import { descriviErrore, ritentabile } from "./migrazioni-regole.mjs";

const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const soloVerifica = process.argv.includes("--verifica");
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
  await client.connect();
  try {
    if (soloVerifica) {
      const e = await verifica(client);
      return { ...e, fatte: e.daFare };
    }
    return await allinea(client);
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

if (esito.assente) log(`${RUOLO_ARGOS} non c'è: niente da fare`);
else if (!esito.fatte.length && !esito.errori.length) log(`${RUOLO_ARGOS} in regola: legge le ${ARGOS_LETTURA.length} tabelle del contratto e nient'altro`);
for (const a of esito.fatte) log(`${soloVerifica ? "da fare" : "fatto"}: ${a.perche}`);
if (soloVerifica && esito.fatte.length) log("per sistemare: node lib/db/scripts/argos-permessi.mjs");
for (const a of esito.avvisi) log(`ATTENZIONE: ${a}`);
for (const a of esito.errori) console.error(`[permessi] DA SISTEMARE A MANO: ${a}`);
process.exit(esito.errori.length || (soloVerifica && esito.fatte.length) ? 1 : 0);
