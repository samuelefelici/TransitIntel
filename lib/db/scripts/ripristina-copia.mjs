#!/usr/bin/env node
// Ripristino di una copia del database fatta dal lavoratore (tappa 7.23).
// Gira sul computer di chi ha la chiave PRIVATA: il server ha solo la
// pubblica e non può decifrare. Serve Node 20 o più; per «ripristina» anche
// pg_restore e psql della versione del server (17), o più nuovi.
//
//   node lib/db/scripts/ripristina-copia.mjs elenco
//       le copie nello storage (servono le variabili BACKUP_S3_*, come nel lavoratore)
//   node lib/db/scripts/ripristina-copia.mjs decifra <copia> <file.dump> --chiave <privata.pem>
//       <copia> è un file .dump.enc già scaricato o il nome di una copia nello storage
//   node lib/db/scripts/ripristina-copia.mjs ripristina <file.dump> [--come-originale]
//       in un database VUOTO, il cui indirizzo si scrive quando lo chiede (o in RIPRISTINO_URL)
//
// La frase della chiave privata si scrive quando la chiede (o in BACKUP_FRASE).
// «ripristina» rifiuta un database che ha già tabelle di Cerbero: non si
// ripristina sopra i dati. Senza --come-originale gli oggetti diventano di
// chi ripristina e senza i GRANT (va bene per la prova su un computer
// qualunque); con --come-originale tengono proprietari e diritti, e i ruoli
// devono esistere (DEPLOY.md, «Copia del database fuori dal server»).
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { chiavePrivata, configS3, decifraFile, elenca, scaricaInFile } from "./copia-cifrata.mjs";

const SCHEMI = ["public", "caronte", "coda", "registro", "cerbero_migrazioni"];
const [comando, ...resto] = process.argv.slice(2);
const opzione = (nome) => {
  const i = resto.indexOf(nome);
  if (i < 0) return null;
  const v = resto[i + 1];
  resto.splice(i, 2);
  return v ?? "";
};
const bandiera = (nome) => {
  const i = resto.indexOf(nome);
  if (i < 0) return false;
  resto.splice(i, 1);
  return true;
};
const esci = (msg, codice = 1) => {
  console.error(`[ripristino] ${msg}`);
  process.exit(codice);
};

/** Chiede un valore; con `nascosto` non lo ripete sullo schermo (frase, password). */
async function chiedi(domanda, nascosto = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (nascosto) rl._writeToOutput = (s) => { if (s.includes(domanda)) process.stdout.write(s); };
  try {
    return (await new Promise((ok) => rl.question(domanda, ok))).trim();
  } finally {
    rl.close();
    if (nascosto) process.stdout.write("\n");
  }
}

function storage() {
  const s = configS3(process.env);
  if (s.mancano.length) esci(`mancano le variabili dello storage: ${s.mancano.join(", ")}`);
  if (s.errore) esci(s.errore);
  return s.config;
}

/** Esegue un programma senza shell; restituisce l'uscita standard. */
function esegui(programma, argomenti, env = {}) {
  return new Promise((ok, ko) => {
    const p = spawn(programma, argomenti, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err.push(d); process.stderr.write(d); });
    p.on("error", (e) => ko(new Error(`${programma} non parte (${e.code ?? e.message}): va installato, o indicato con BACKUP_PG_RESTORE / BACKUP_PSQL`)));
    p.on("close", (codice) => (codice === 0 ? ok(Buffer.concat(out).toString("utf8"))
      : ko(Object.assign(new Error(`${programma} è uscito con ${codice}`), { uscita: Buffer.concat(out).toString("utf8") }))));
  });
}

/** L'indirizzo senza password (va in PGPASSWORD, non nella riga di comando). */
function senzaPassword(url) {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  return { url: u.toString(), password };
}

async function principale() {
  if (comando === "elenco") {
    const cfg = storage();
    const copie = await elenca(cfg);
    if (!copie.length) return console.log(`[ripristino] nessuna copia sotto ${cfg.prefisso} nel bucket ${cfg.bucket}`);
    for (const c of copie) console.log(`${c.data ?? ""}  ${(c.byte / 1e6).toFixed(1).padStart(8)} MB  ${c.chiave}`);
    return;
  }

  if (comando === "decifra") {
    const file = opzione("--chiave");
    const [copia, destinazione] = resto;
    if (!copia || !destinazione || !file) esci("uso: decifra <copia> <file.dump> --chiave <privata.pem>", 2);
    if (existsSync(destinazione)) esci(`${destinazione} esiste già: non lo sovrascrivo`);
    const frase = process.env.BACKUP_FRASE ?? await chiedi("Frase della chiave privata (vuota se non ce l'ha): ", true);
    const privata = chiavePrivata(await fsp.readFile(file, "utf8"), frase || undefined);
    let cifrata = copia;
    let temporanea = null;
    if (!existsSync(copia)) {
      const cfg = storage();
      temporanea = await fsp.mkdtemp(path.join(os.tmpdir(), "cerbero-ripristino-"));
      cifrata = path.join(temporanea, "copia.dump.enc");
      console.log(`[ripristino] scarico ${copia}…`);
      const { byte, sha256 } = await scaricaInFile(cfg, copia, cifrata);
      console.log(`[ripristino] scaricati ${(byte / 1e6).toFixed(1)} MB, SHA-256 ${sha256}`);
    }
    try {
      await decifraFile(cifrata, destinazione, privata);
    } finally {
      if (temporanea) await fsp.rm(temporanea, { recursive: true, force: true });
    }
    console.log(`[ripristino] decifrata in ${destinazione}: integrità controllata (il tag della cifratura torna)`);
    return;
  }

  if (comando === "ripristina") {
    const comeOriginale = bandiera("--come-originale");
    const [dump] = resto;
    if (!dump || resto.length > 1) esci("uso: ripristina <file.dump> [--come-originale]", 2);
    if (!existsSync(dump)) esci(`${dump} non c'è`);
    const pgRestore = process.env.BACKUP_PG_RESTORE || "pg_restore";
    const psql = process.env.BACKUP_PSQL || "psql";
    const indirizzo = process.env.RIPRISTINO_URL || await chiedi("Indirizzo del database VUOTO dove ripristinare (postgres://…): ", true);
    const { url, password } = senzaPassword(indirizzo);
    const env = { PGPASSWORD: password, PGAPPNAME: "cerbero-ripristino" };
    // mai sopra dei dati: il database deve essere vuoto negli schemi della copia
    const [occupate] = (await esegui(psql, ["--no-psqlrc", "-At", "-d", url, "-c",
      `SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN (${SCHEMI.map((s) => `'${s}'`).join(", ")})`], env)).trim().split("\n");
    if (Number(occupate) > 0) esci(`il database ha già ${occupate} tabelle negli schemi di Cerbero: serve un database vuoto (createdb)`);
    // lo schema public c'è già in ogni database nuovo: si toglie dall'elenco, il resto si ripristina così com'è
    const elenco = (await esegui(pgRestore, ["--list", dump])).split("\n");
    const tabelle = elenco.filter((r) => / TABLE DATA /.test(r)).length;
    const lista = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "cerbero-ripristino-")), "elenco.txt");
    await fsp.writeFile(lista, elenco.filter((r) => !/ SCHEMA - public /.test(r)).join("\n"), { mode: 0o600 });
    console.log(`[ripristino] ${elenco.filter((r) => r && !r.startsWith(";")).length} voci, dati di ${tabelle} tabelle; ripristino…`);
    try {
      await esegui(pgRestore, ["--dbname", url, "--use-list", lista, "--exit-on-error", "--single-transaction",
        ...(comeOriginale ? [] : ["--no-owner", "--no-acl"]), dump], env);
    } finally {
      await fsp.rm(path.dirname(lista), { recursive: true, force: true });
    }
    // la prova: quante tabelle e quante righe per schema
    const conti = await esegui(psql, ["--no-psqlrc", "-At", "-F", " ", "-d", url, "-c", `
      SELECT n.nspname, count(*), sum((pg_catalog.xpath('/row/c/text()',
               pg_catalog.query_to_xml(pg_catalog.format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint)
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname IN (${SCHEMI.map((s) => `'${s}'`).join(", ")})
       GROUP BY 1 ORDER BY 1`], env);
    console.log("[ripristino] fatto. Tabelle e righe per schema:");
    for (const r of conti.trim().split("\n")) {
      const [schema, n, righe] = r.split(" ");
      console.log(`  ${schema.padEnd(20)} ${n.padStart(4)} tabelle  ${Number(righe).toLocaleString("it-IT").padStart(12)} righe`);
    }
    return;
  }

  esci("comandi: elenco | decifra <copia> <file.dump> --chiave <privata.pem> | ripristina <file.dump> [--come-originale]", 2);
}

principale().catch((err) => esci(err?.message ?? String(err)));
