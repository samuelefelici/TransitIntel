#!/usr/bin/env node
// I ruoli del database di Cerbero (ruoli-regole.mjs): cerbero_owner
// proprietario delle tabelle, cerbero_app l'utente dell'app. Lo fa già il
// migratore a ogni avvio dell'API; questo serve a mano, dal Terminal del
// container dell'API:
//   node lib/db/scripts/ruoli.mjs                     riallinea (senza tetto di tempo)
//   node lib/db/scripts/ruoli.mjs --verifica          dice solo cosa non va
//   node lib/db/scripts/ruoli.mjs --imposta-password  dà a cerbero_app una password nuova e
//                                                     l'accesso, prova l'URL e lo stampa
//   node lib/db/scripts/ruoli.mjs --prova-url         prova un URL dell'app scritto a mano
//                                                     (DEPLOY.md, «Ruoli del database», passi 3 e 4)
//
// Usa DATABASE_MIGRATOR_URL se c'è, altrimenti DATABASE_URL: serve un
// superutente (l'utente postgres). Esce con 1 se resta qualcosa da sistemare
// (con --verifica: anche se c'è qualcosa da fare).
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  APP, EVENTO_DDL, EVENTO_DDL_FINE, PROPRIETARIO, allinea, calcolateDaControllare, elencoDalCatalogo, migrazioniApplicate, verifica,
} from "./ruoli-regole.mjs";
import { improntaScram, nuovaPassword, urlDellApp } from "./ruoli-password.mjs";
import { descriviErrore, leggiCatalogo, leggiDiario } from "./migrazioni-regole.mjs";

const url = process.env.DATABASE_MIGRATOR_URL || process.env.DATABASE_URL;
const argomenti = process.argv.slice(2);
const MODI = ["--verifica", "--prova-url", "--imposta-password"];
/* Con --imposta-password: cambiarla anche se l'app è collegata, e stamparla
 * anche se l'output non è un terminale (la CI). */
const CON_LA_PASSWORD = ["--anche-se-collegata", "--senza-terminale"];
const modi = argomenti.filter((a) => MODI.includes(a));
const altre = argomenti.filter((a) => !MODI.includes(a));
if (modi.length > 1 || altre.some((a) => !(modi[0] === "--imposta-password" && CON_LA_PASSWORD.includes(a)))
  || new Set(argomenti).size !== argomenti.length) {
  // un'opzione scritta male non deve diventare un riallineamento
  console.error(`[ruoli] opzione sconosciuta: ${argomenti.join(" ")}. Uso: node lib/db/scripts/ruoli.mjs `
    + "[--verifica | --prova-url | --imposta-password [--anche-se-collegata]]");
  process.exit(2);
}
// solo con PGSSL_NO_VERIFY=1, per un Postgres esposto con un certificato autofirmato (come run-sql.mjs)
const ssl = process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined; // scan-ok: dietro una variabile, mai di default

/** Prova un URL dell'app: entra, e dice chi è la sessione, come chi lavora e se gli event trigger sono accesi. */
async function provaUrl(urlNuovo, seNonEntra) {
  let prova;
  try {
    // dentro il try: un URL che pg non riesce a leggere è un errore con il suo messaggio, non una traccia
    prova = new pg.Client({ connectionString: urlNuovo, ssl, application_name: "cerbero-prova-url", connectionTimeoutMillis: 10_000 });
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
    return buono;
  } catch (err) {
    console.error(`[ruoli] l'URL non funziona: ${descriviErrore(err).motivo}${seNonEntra ? `. ${seNonEntra}` : ""}`);
    return false;
  } finally {
    await prova?.end().catch(() => {});
  }
}

/* --prova-url: prima di cambiare DATABASE_URL su API e lavoratore, un URL
 * scritto a mano si prova da qui, dove c'è node e non psql. Si legge
 * dall'input, non dalla riga di comando: così non resta nella cronologia né
 * nell'elenco dei processi. */
if (modi[0] === "--prova-url") {
  process.stdout.write("[ruoli] incolla il nuovo DATABASE_URL e premi Invio: ");
  const righe = (await import("node:readline")).createInterface({ input: process.stdin });
  const urlNuovo = (await new Promise((fine) => righe.once("line", fine)).finally(() => righe.close())).trim();
  const buono = await provaUrl(urlNuovo,
    "Password con caratteri come @ : / # % va codificata nell'URL; il ruolo deve avere LOGIN (passo 3). "
    + "Per non scriverlo a mano: node lib/db/scripts/ruoli.mjs --imposta-password");
  process.exit(buono ? 0 : 1);
}

/* --imposta-password: la password di cerbero_app e il suo URL in un passo
 * solo. Genera la password, ne manda al database l'impronta (come \password
 * di psql: la password non viaggia e non finisce nei log del server), dà
 * LOGIN, prova l'URL e lo stampa. L'URL è quello del migratore con utente e
 * password cambiati: non si compone niente a mano. */
async function impostaPassword() {
  if (!url) {
    console.error("[ruoli] né DATABASE_MIGRATOR_URL né DATABASE_URL");
    return 2;
  }
  if (!process.stdout.isTTY && !altre.includes("--senza-terminale")) {
    console.error("[ruoli] --imposta-password stampa l'URL con la password: si lancia da un terminale (il Terminal del container "
      + "dell'API), non dove l'output finisce in un file o in un log");
    return 2;
  }
  let admin, urlNuovo;
  try {
    admin = new pg.Client({ connectionString: url, ssl, application_name: "cerbero-ruoli", connectionTimeoutMillis: 10_000 });
    admin.on("error", (err) => console.error(`[ruoli] connessione al database persa: ${err.message}`));
    await admin.connect();
    const { rows: [io] } = await admin.query(`
      SELECT session_user AS utente,
             (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente,
             EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS ruolo,
             (SELECT count(*)::int FROM pg_catalog.pg_stat_activity
               WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()) AS collegate,
             -- quello che la prova dell'URL chiederà dopo: si guarda prima di cambiare la password
             EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
                       JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
                      WHERE r.rolname = $1 AND s.setdatabase = 0 AND ('role=' || $2) = ANY (s.setconfig))
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a
                             JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
                             JOIN pg_catalog.pg_roles m ON m.oid = a.member
                            WHERE g.rolname = $2 AND m.rolname = $1 AND a.set_option) AS lavora_come,
             (SELECT count(*)::int FROM pg_catalog.pg_event_trigger
               WHERE evtname = ANY ($3::text[]) AND evtenabled = 'A') AS eventi`, [APP, PROPRIETARIO, [EVENTO_DDL, EVENTO_DDL_FINE]]);
    if (!io.superutente) {
      console.error(`[ruoli] serve un superutente (postgres): qui ci si collega come ${io.utente}. `
        + "Va lanciato dal Terminal del container dell'API, dove c'è DATABASE_MIGRATOR_URL");
      return 1;
    }
    if (!io.ruolo) {
      console.error(`[ruoli] ${APP} non c'è ancora: lo crea il migratore all'avvio dell'API (o: node lib/db/scripts/ruoli.mjs)`);
      return 1;
    }
    if (!io.lavora_come || io.eventi !== 2) {
      // con la password già cambiata la prova dell'URL fallirebbe, e resterebbe una password che nessuno ha
      console.error(`[ruoli] i ruoli non sono in regola (${APP} deve lavorare come ${PROPRIETARIO}, con i due event trigger accesi): `
        + "prima node lib/db/scripts/ruoli.mjs. La password non è stata toccata");
      return 1;
    }
    if (io.collegate && !altre.includes("--anche-se-collegata")) {
      console.error(`[ruoli] ${APP} è collegato adesso (${io.collegate} ${io.collegate === 1 ? "sessione" : "sessioni"}): è la password che API e `
        + "lavoratore stanno usando. Cambiandola, le loro connessioni nuove vengono rifiutate finché DATABASE_URL non è aggiornato "
        + "sui due servizi e il deploy rifatto. Per cambiarla lo stesso: --imposta-password --anche-se-collegata");
      return 1;
    }
    const password = nuovaPassword();
    // l'URL prima del cambio: se non si riesce a costruirlo, la password resta quella di prima
    urlNuovo = urlDellApp(url, APP, password);
    const impronta = improntaScram(password);
    if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(impronta)) throw new Error("impronta SCRAM non valida");
    await admin.query(`ALTER ROLE "${APP}" LOGIN PASSWORD '${impronta}'`);
    console.log(`[ruoli] ${APP} ha una password nuova e può collegarsi: al database è andata solo l'impronta`);
  } catch (err) {
    console.error(err?.code === "ERR_INVALID_URL"
      ? "[ruoli] FALLITO: l'URL del migratore (DATABASE_MIGRATOR_URL, o DATABASE_URL) non si legge come URL: "
        + "una password con @ : / # % va codificata. La password di cerbero_app non è stata toccata"
      : `[ruoli] FALLITO: ${descriviErrore(err).motivo}`);
    return 1;
  } finally {
    await admin?.end().catch(() => {});
  }
  if (!await provaUrl(urlNuovo, "")) {
    console.error(`[ruoli] la password di ${APP} è già quella nuova e non è stata stampata: tolto il motivo qui sopra, `
      + "si rilancia il comando (ne genera un'altra)");
    return 1;
  }
  console.log("[ruoli] il nuovo DATABASE_URL, uguale per API e lavoratore. Contiene la password: va copiato solo nelle variabili dei due servizi");
  console.log(urlNuovo);
  console.log("[ruoli] DATABASE_MIGRATOR_URL dell'API resta quello di oggi (postgres). Poi il deploy dei due servizi");
  return 0;
}
if (modi[0] === "--imposta-password") process.exit(await impostaPassword());

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

const client = new pg.Client({ connectionString: url, ssl, application_name: "cerbero-ruoli" });
client.on("error", (err) => log(`connessione al database persa: ${err.message}`));

let esito;
try {
  await client.connect();
  await client.query("SET search_path = pg_catalog, pg_temp");
  const catalogo = leggiCatalogo(cartella);
  const elenco = elencoDalCatalogo(catalogo);
  // le colonne calcolate del catalogo valgono solo per un database alla stessa migrazione di questo codice
  const { calcolate, avviso } = calcolateDaControllare(catalogo, leggiDiario(cartella), await migrazioniApplicate(client));
  esito = soloVerifica
    ? await verifica(client, elenco, calcolate)
    : await allinea(client, elenco, { tettoMs: 10 * 60_000, lockMs: 5_000, calcolate });
  if (avviso) esito.avvisi.push(avviso);
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
