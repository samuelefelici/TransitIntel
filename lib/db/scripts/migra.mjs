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
// Dopo le migrazioni:
// - i ruoli del database (ruoli-regole.mjs): cerbero_owner proprietario delle
//   tabelle di Cerbero, cerbero_app l'utente dell'app, coi loro diritti;
// - i permessi di argos_ro, il ruolo con cui Argos legge
//   (argos-permessi-regole.mjs), riportati al contratto.
// Se non ci riesce lo scrive nel log e l'API parte lo stesso.
//
// Prima di migrare da superutente: se una tabella di Cerbero ha un default, un
// vincolo o un indice con una funzione fuori da quelle ammesse
// (FUNZIONI_AMMESSE in ruoli-regole.mjs), si ferma senza migrare. Una
// migrazione che cambia quella colonna (ALTER COLUMN … TYPE rivaluta i CHECK)
// eseguirebbe come superutente codice messo dall'app. L'event trigger lo
// impedisce da quando c'è; il controllo copre quello che c'era prima e un
// event trigger spento per errore.
//
// Tutto il giro, migrazioni comprese, gira con search_path = pg_catalog,
// pg_temp: chi migra è un superutente, e un nome non qualificato (o una
// funzione con un argomento di tipo incerto, come i parametri di node-pg) non
// deve poter trovare un oggetto in public. Le migrazioni qualificano tutto
// (README delle migrazioni).
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL. Serve un
// superutente (l'utente postgres): le migrazioni cambiano tabelle di
// cerbero_owner e i ruoli si creano qui. Come cerbero_app o cerbero_owner si
// ferma (manca DATABASE_MIGRATOR_URL); con un altro utente non superutente
// migra come prima, ma ruoli e proprietari non li tocca.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as attendi } from "node:timers/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  CHIAVE_LUCCHETTO, TRACCIAMENTO, controllaApplicate, daApplicare, descriviErrore, leggiCatalogo, leggiDiario, ritentabile,
} from "./migrazioni-regole.mjs";
import { allinea } from "./argos-permessi-regole.mjs";
import { APP, PROPRIETARIO, allinea as allineaRuoli, elencoDalCatalogo, espressioniVietate } from "./ruoli-regole.mjs";

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
    const { rows } = await client.query("SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS ok", [CHIAVE_LUCCHETTO]);
    if (rows[0].ok) return;
    if (i % 10 === 0) log("un altro processo sta migrando: aspetto");
    await attendi(1000);
  }
  throw new Error("lucchetto delle migrazioni non ottenuto in 2 minuti");
}

/* Chi migra: un superutente. Come l'utente dell'app (DATABASE_MIGRATOR_URL
 * dimenticata dopo il cambio di DATABASE_URL) ci si ferma subito, con il
 * motivo: le migrazioni fallirebbero a metà, o peggio creerebbero oggetti
 * dell'app senza i ruoli. Restituisce se è un superutente. */
async function chiMigra(client) {
  const { rows: [io] } = await client.query(`
    SELECT current_user AS utente, session_user AS sessione,
           (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente`);
  if ([APP, PROPRIETARIO].includes(io.utente) || [APP, PROPRIETARIO].includes(io.sessione)) {
    const e = new Error(`le migrazioni non si eseguono come ${io.sessione}: imposta DATABASE_MIGRATOR_URL `
      + "sull'utente postgres (DEPLOY.md, «Ruoli del database»)");
    e.nonRitentare = true;
    throw e;
  }
  if (!io.superutente) {
    log(`ATTENZIONE: migro come ${io.utente}, che non è un superutente: ruoli e proprietari del database non li tocco`);
  }
  return io.superutente;
}

/* Non blocca l'avvio: un ruolo o un proprietario fuori posto si sistema anche
 * dopo, a mano (ruoli.mjs); gli oggetti occupati si riprovano al prossimo avvio. */
async function ruoliDelDatabase(client) {
  const elenco = elencoDalCatalogo(leggiCatalogo(cartella));
  for (let tentativo = 1; ; tentativo++) {
    try {
      const e = await allineaRuoli(client, elenco);
      const spostati = e.fatte.filter((a) => a.fase >= 2);
      const altre = e.fatte.filter((a) => a.fase === 1);
      if (altre.length) {
        log(`ruoli del database sistemati (${altre.length}):`);
        for (const a of altre) log(`  ${a.perche}`);
      }
      if (spostati.length) log(`${spostati.length} oggetti passati a ${PROPRIETARIO}`);
      for (const a of [...e.errori, ...e.avvisi]) log(`ATTENZIONE: ruoli: ${a}`);
      if (!e.fatte.length && !e.errori.length && !e.daFare.length) log(`ruoli del database in regola (${PROPRIETARIO}, ${APP})`);
      return;
    } catch (err) {
      if (ritentabile(err) && tentativo < 3) {
        await attendi(tentativo * 2000);
        continue;
      }
      log(`ATTENZIONE: ruoli del database non riallineati: ${descriviErrore(err).motivo}. `
        + "L'API parte lo stesso. A mano: node lib/db/scripts/ruoli.mjs");
      return;
    }
  }
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
  let lucchetto = false;
  try {
    // prima di qualunque altra istruzione: niente public nel percorso del superutente
    await client.query("SET search_path = pg_catalog, pg_temp");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '15min'");
    // se questo processo muore, Postgres se ne accorge entro 2 s e annulla
    await client.query("SET client_connection_check_interval = '2s'").catch(() => {});
    const superutente = await chiMigra(client);
    await prendiLucchetto(client);
    lucchetto = true;

    const diario = leggiDiario(cartella);
    const prima = await leggiApplicate(client);
    const { errori, sconosciute } = controllaApplicate(diario, prima);
    if (errori.length) throw new Error(errori.join("; "));
    if (sconosciute.length) log(`il database ha ${sconosciute.length} migrazioni più nuove di questo codice: proseguo (codice N-1)`);

    const nuove = daApplicare(diario, prima);
    if (nuove.length && superutente) {
      const vietate = await espressioniVietate(client, elencoDalCatalogo(leggiCatalogo(cartella)));
      if (vietate.length) {
        const e = new Error(`non migro: ${vietate.length === 1
          ? "un'espressione di una tabella di Cerbero usa funzioni non ammesse, e una migrazione da superutente la eseguirebbe"
          : `${vietate.length} espressioni di tabelle di Cerbero usano funzioni non ammesse, e una migrazione da superutente le eseguirebbe`}: `
          + vietate.map((v) => `${v.tabella}, ${v.oggetto}: ${v.funzioni} (se non viene da una migrazione: ${v.cura})`).join("; ")
          + ". Dopo averle tolte, rilancia il deploy (DEPLOY.md, «Ruoli del database»)");
        e.nonRitentare = true;
        throw e;
      }
    }
    if (!nuove.length) {
      log(`nessuna migrazione da applicare (ultima: ${diario.at(-1)?.tag ?? "—"})`);
    } else {
      // stessa connessione per lucchetto, SET e transazione di drizzle
      await migrate(drizzle(client), { migrationsFolder: cartella, ...TRACCIAMENTO });
      for (const e of nuove) log(`${e.tag} applicata`);
      if (avvisi.length) log(`${avvisi.length} avvisi qui sopra: controllali, gli oggetti saltati non verranno ricreati da soli`);
    }
    if (superutente) await ruoliDelDatabase(client);
    await permessiArgos(client);
  } finally {
    clientCorrente = null;
    if (lucchetto) await client.query("SELECT pg_catalog.pg_advisory_unlock($1::bigint)", [CHIAVE_LUCCHETTO]).catch(() => {});
    await client.end().catch(() => {});
  }
}

for (let tentativo = 1; ; tentativo++) {
  try {
    await unGiro();
    process.exit(0);
  } catch (err) {
    if (ritentabile(err) && !err.nonRitentare && tentativo < 3) {
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
