#!/usr/bin/env node
// Applica le migrazioni di lib/db/migrations. Lo lancia docker/avvio.sh prima
// dell'API; a mano: `pnpm --filter @workspace/db run migra`.
//
// È il migrator di drizzle (lo stesso strumento di FleetCare) con quello che
// gli manca: un lucchetto perché due container non migrino insieme,
// lock_timeout perché un ALTER non resti in coda dietro una lettura lunga
// bloccando tutti, il controllo che le migrazioni già applicate non siano
// cambiate e l'uscita con errore (fail-closed): se la migrazione fallisce il
// container nuovo non parte e resta quello vecchio.
//
// Dopo le migrazioni riporta al contratto i permessi di argos_ro, il ruolo con
// cui Argos legge (argos-permessi-regole.mjs): se non ci riesce lo scrive nel
// log e l'API parte lo stesso.
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL. L'utente deve
// essere il proprietario delle tabelle (o un superutente): le migrazioni le
// modificano.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as attendi } from "node:timers/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  CHIAVE_LUCCHETTO, TRACCIAMENTO, controllaApplicate, daApplicare, descriviErrore, leggiDiario, ritentabile,
} from "./migrazioni-regole.mjs";
import { allinea } from "./argos-permessi-regole.mjs";

const cartella = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const log = (m) => console.log(`[migrazioni] ${m}`);

if (!url) {
  console.error("[migrazioni] né DATABASE_MIGRATOR_URL né DATABASE_URL: non so dove migrare");
  process.exit(1);
}

/* Arresto durante la migrazione (deploy annullato, container fermato):
 * chiudere la connessione fa annullare a Postgres la transazione in corso e
 * libera il lucchetto, invece di lasciarli appesi fino alla fine
 * dell'istruzione. */
let clientCorrente = null;
for (const segnale of ["SIGTERM", "SIGINT"]) {
  process.on(segnale, () => {
    log(`${segnale}: interrompo, la transazione viene annullata`);
    const fine = () => process.exit(143);
    if (clientCorrente) clientCorrente.end().then(fine, fine);
    else fine();
  });
}

async function leggiApplicate(client) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS c`,
    [`${TRACCIAMENTO.migrationsSchema}.${TRACCIAMENTO.migrationsTable}`],
  );
  if (!rows[0].c) return [];
  return (await client.query(`SELECT hash, created_at FROM ${TRACCIAMENTO.migrationsSchema}.${TRACCIAMENTO.migrationsTable} ORDER BY created_at`)).rows;
}

async function prendiLucchetto(client) {
  // pg_try in un ciclo invece di pg_advisory_lock: un'attesa lunga si vede nel
  // log e finisce, invece di restare appesa senza dire niente.
  for (let i = 0; i < 120; i++) {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [CHIAVE_LUCCHETTO]);
    if (rows[0].ok) return;
    if (i % 10 === 0) log("un altro processo sta migrando: aspetto");
    await attendi(1000);
  }
  throw new Error("lucchetto delle migrazioni non ottenuto in 2 minuti");
}

/* Non blocca l'avvio: un permesso fuori posto si corregge anche dopo, a mano
 * (argos-permessi.mjs), e l'API lo segnala comunque all'avvio. */
async function permessiArgos(client) {
  for (let tentativo = 1; ; tentativo++) {
    try {
      const e = await allinea(client);
      if (e.contratto.nota) log(`argos_ro: ${e.contratto.nota}`);
      if (e.assente) return;
      if (e.fatte.length) {
        log(`permessi di argos_ro riportati al contratto (${e.fatte.length} correzioni):`);
        for (const a of e.fatte) log(`  ${a.perche}`);
      }
      for (const a of [...e.errori, ...e.avvisi]) log(`ATTENZIONE: argos_ro: ${a}`);
      return;
    } catch (err) {
      if (ritentabile(err) && tentativo < 3) {
        await attendi(tentativo * 2000);
        continue;
      }
      log(`ATTENZIONE: permessi di argos_ro non riallineati: ${descriviErrore(err).motivo}. `
        + "Nessun permesso è cambiato; l'API parte lo stesso. A mano: node lib/db/scripts/argos-permessi.mjs");
      return;
    }
  }
}

async function unGiro() {
  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
    application_name: "cerbero-migrazioni",
  });
  // I WARNING delle migrazioni (per esempio un indice unico che i dati non
  // permettono) devono finire nel log del container, non sparire.
  const avvisi = [];
  // senza, una connessione che cade fa uscire il processo da sé (evento
  // 'error' non gestito), anche durante il passo dei permessi che non deve
  // bloccare l'avvio; la query in corso fallisce comunque e arriva al catch
  client.on("error", (err) => log(`connessione al database persa: ${err.message}`));
  client.on("notice", (n) => {
    if (n.severity === "WARNING") {
      avvisi.push(n.message);
      log(`ATTENZIONE: ${n.message}`);
    }
  });
  await client.connect();
  clientCorrente = client;
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '15min'");
    // se questo processo muore, Postgres se ne accorge entro 2 s e annulla
    await client.query("SET client_connection_check_interval = '2s'").catch(() => {});
    await prendiLucchetto(client);

    const diario = leggiDiario(cartella);
    const prima = await leggiApplicate(client);
    const { errori, sconosciute } = controllaApplicate(diario, prima);
    if (errori.length) throw new Error(errori.join("; "));
    if (sconosciute.length) log(`il database ha ${sconosciute.length} migrazioni più nuove di questo codice: proseguo (codice N-1)`);

    const nuove = daApplicare(diario, prima);
    if (!nuove.length) {
      log(`nessuna migrazione da applicare (ultima: ${diario.at(-1)?.tag ?? "—"})`);
    } else {
      // stessa connessione per lucchetto, SET e transazione di drizzle
      await migrate(drizzle(client), { migrationsFolder: cartella, ...TRACCIAMENTO });
      for (const e of nuove) log(`${e.tag} applicata`);
      if (avvisi.length) log(`${avvisi.length} avvisi qui sopra: controllali, gli oggetti saltati non verranno ricreati da soli`);
    }
    await permessiArgos(client);
  } finally {
    clientCorrente = null;
    await client.query("SELECT pg_advisory_unlock($1)", [CHIAVE_LUCCHETTO]).catch(() => {});
    await client.end().catch(() => {});
  }
}

for (let tentativo = 1; ; tentativo++) {
  try {
    await unGiro();
    process.exit(0);
  } catch (err) {
    if (ritentabile(err) && tentativo < 3) {
      log(`una tabella è occupata, riprovo fra ${tentativo * 5} s`);
      await attendi(tentativo * 5000);
      continue;
    }
    const { motivo, query } = descriviErrore(err);
    console.error(`[migrazioni] FALLITA: ${motivo}`);
    if (query) console.error(`[migrazioni] istruzione: ${query}`);
    console.error("[migrazioni] il database non è cambiato (la transazione è annullata); l'API non parte.");
    process.exit(1);
  }
}
