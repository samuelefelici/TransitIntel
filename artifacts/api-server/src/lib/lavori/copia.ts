/**
 * La copia del database fuori dal server (tappa 7.23), solo nel lavoratore:
 * ogni minuto (la prima volta tre minuti dopo l'avvio), con lo schema «ok».
 *
 * A ogni passaggio guarda se c'è una copia chiesta dall'amministratore, o se è ora
 * di quella della notte (dopo BACKUP_ORA, ora di Roma, se oggi non ce n'è
 * ancora una riuscita). Poi:
 * 1. pg_dump degli schemi di Cerbero (SCHEMI_COPIA: non quelli di altri
 *    programmi), come cerbero_backup, che legge tutto e non scrive niente.
 *    Una tabella che non può leggere (un avanzo fatto a mano da un
 *    superutente: il migratore non gliela dà) si salta, e l'esito lo dice;
 * 2. pg_restore --list: la copia si legge, e quante tabelle hanno dati;
 * 3. cifratura con la chiave PUBBLICA dell'azienda (lib/db/scripts/
 *    copia-cifrata.mjs): il server non sa decifrare; la copia in chiaro si
 *    cancella subito;
 * 4. caricamento nello storage S3 (lo storage controlla lo SHA-256 del corpo);
 * 5. verifica: la copia si riscarica e deve avere gli stessi byte e lo stesso
 *    SHA-256.
 * L'esito va in backup_copie (migrazione 0068). Una copia non riuscita si
 * riprova dopo un'ora, al più tre volte per notte; una rimasta «in corso» per
 * più di tre ore (il lavoratore si è fermato) diventa «interrotta».
 *
 * Il lavoratore non cancella copie: quanto tenerle lo decide lo storage
 * (regola di scadenza del bucket, DEPLOY.md). Così chi entrasse nel server
 * non potrebbe nemmeno toglierle.
 *
 * Senza le variabili BACKUP_* non fa niente, e lo dice nel log all'avvio;
 * una copia chiesta a mano diventa «fallita» col motivo. Senza la migrazione
 * 0068 (database indietro) non fa niente.
 */
import { spawn } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "@workspace/db";
import { inSistema } from "@workspace/db/contesto";
import {
  VARIABILI_S3, carica, chiavePubblica, cifratore, configS3, contatore, scarica, senzaSegreti, type ConfigS3,
} from "../../../../../lib/db/scripts/copia-cifrata.mjs";
import { COPIA, SCHEMI_COPIA } from "../../../../../lib/db/scripts/ruoli-nomi.mjs";

export const OGNI_MS = 60 * 1000;
const PRIMO_PASSAGGIO_MS = 3 * 60 * 1000;
/** Tentativi della copia della notte, e quanto aspettare fra uno e l'altro. */
export const TENTATIVI_PER_NOTTE = 3;
export const ATTESA_FRA_TENTATIVI_MIN = 60;
const DUMP_MAX_MS = 2 * 60 * 60 * 1000;
const ELENCO_MAX_MS = 10 * 60 * 1000;

interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export const VARIABILI = Object.freeze(["BACKUP_DATABASE_URL", "BACKUP_CHIAVE_PUBBLICA", ...VARIABILI_S3]);

export interface ConfigCopia {
  /** l'indirizzo del database senza password (la password va in PGPASSWORD) */
  url: string;
  password: string;
  chiave: KeyObject;
  s3: ConfigS3;
  /** l'ora di Roma da cui parte la copia della notte */
  ora: number;
  pgDump: string;
  pgRestore: string;
  /** i valori da non scrivere mai in un errore salvato o nel log */
  segreti: string[];
}

export type StatoConfig = { stato: "spenta" } | { stato: "incompleta"; motivo: string } | { stato: "pronta"; config: ConfigCopia };

/** La configurazione dall'ambiente del lavoratore. */
export function leggiConfig(env: Record<string, string | undefined> = process.env): StatoConfig {
  const c = (v: string) => String(env[v] ?? "").trim();
  const presenti = VARIABILI.filter((v) => c(v));
  if (!presenti.length) return { stato: "spenta" };
  const incompleta = (motivo: string): StatoConfig => ({ stato: "incompleta", motivo });
  const mancano = VARIABILI.filter((v) => !c(v));
  if (mancano.length) return incompleta(`mancano ${mancano.join(", ")}`);
  const s3 = configS3(env);
  if (s3.errore || !s3.config) return incompleta(s3.errore ?? "storage non impostato");
  let chiave: KeyObject;
  try {
    chiave = chiavePubblica(env.BACKUP_CHIAVE_PUBBLICA);
  } catch (err) {
    return incompleta(`BACKUP_CHIAVE_PUBBLICA: ${(err as Error).message}`);
  }
  let u: URL;
  try {
    u = new URL(c("BACKUP_DATABASE_URL"));
  } catch {
    return incompleta("BACKUP_DATABASE_URL non è un indirizzo postgres://…");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return incompleta("BACKUP_DATABASE_URL non è un indirizzo postgres://…");
  // solo il ruolo che legge e non scrive: mai il superutente né l'utente dell'app
  if (decodeURIComponent(u.username) !== COPIA) return incompleta(`BACKUP_DATABASE_URL deve entrare come ${COPIA}`);
  const password = decodeURIComponent(u.password);
  u.password = "";
  const ora = c("BACKUP_ORA") ? Number(c("BACKUP_ORA")) : 3;
  if (!Number.isInteger(ora) || ora < 0 || ora > 23) return incompleta("BACKUP_ORA è un'ora intera da 0 a 23");
  return {
    stato: "pronta",
    config: {
      url: u.toString(), password, chiave, s3: s3.config, ora,
      pgDump: c("BACKUP_PG_DUMP") || "pg_dump", pgRestore: c("BACKUP_PG_RESTORE") || "pg_restore",
      segreti: [password, s3.config.segreto, s3.config.accesso].filter(Boolean),
    },
  };
}

/** Un programma senza shell, con un ambiente minimo (nessun segreto dell'app) e un tempo massimo. */
function esegui(programma: string, argomenti: string[], env: Record<string, string>, maxMs: number): Promise<string> {
  return new Promise((risolvi, rifiuta) => {
    const p = spawn(programma, argomenti, {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C.UTF-8", PGPASSFILE: "/dev/null", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let errore = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => { errore = (errore + d.toString("utf8")).slice(-2000); });
    const tempo = setTimeout(() => p.kill("SIGKILL"), maxMs);
    p.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(tempo);
      rifiuta(new Error(`${programma} non parte (${e.code ?? e.message}): nel container serve postgresql-client della versione del server`));
    });
    p.on("close", (codice, segnale) => {
      clearTimeout(tempo);
      if (codice === 0) return risolvi(Buffer.concat(out).toString("utf8"));
      const perche = segnale ? `fermato dopo ${Math.round(maxMs / 60000)} minuti` : `uscito con ${codice}`;
      rifiuta(new Error(`${path.basename(programma)} ${perche}: ${errore.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

export interface EsitoCopia {
  oggetto: string; byte: number; sha256: string; voci: number; tabelle: number; versione: string;
  /** le relazioni saltate perché cerbero_backup non le legge */
  escluse: string[];
}

/** Le relazioni degli schemi della copia che cerbero_backup non legge: pg_dump si fermerebbe. */
export async function nonLeggibili(): Promise<{ schema: string; nome: string }[]> {
  const { rows } = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS nome
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY ($1::text[]) AND c.relkind IN ('r', 'p', 'S') AND c.relpersistence <> 't'
       AND pg_catalog.to_regrole($2) IS NOT NULL
       AND NOT pg_catalog.has_table_privilege($2, c.oid, 'SELECT')
     ORDER BY 1, 2`, [[...SCHEMI_COPIA], COPIA]);
  return rows;
}

/** Il nome per --exclude-table: fra virgolette, preso alla lettera. */
const fraVirgolette = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Il nome della copia nello storage: prefisso, data e ora UTC. */
export function nomeCopia(prefisso: string, quando: Date): string {
  return `${prefisso}cerbero-${quando.toISOString().slice(0, 19).replace(/:/g, "-")}Z.dump.enc`;
}

/** Una copia: dump, elenco, cifratura, caricamento, verifica. */
export async function faiCopia(cfg: ConfigCopia, quando: Date = new Date(),
  saltare: { schema: string; nome: string }[] = []): Promise<EsitoCopia> {
  const envPg = { PGPASSWORD: cfg.password, PGAPPNAME: "cerbero-copia", PGCONNECT_TIMEOUT: "20" };
  const versione = (await esegui(cfg.pgDump, ["--version"], {}, 30_000)).trim().slice(0, 200);
  const cartella = await mkdtemp(path.join(os.tmpdir(), "cerbero-copia-"));
  try {
    const dump = path.join(cartella, "copia.dump");
    await esegui(cfg.pgDump, [
      "--format=custom", "--no-password", "--lock-wait-timeout=120000",
      ...SCHEMI_COPIA.map((s) => `--schema=${s}`),
      ...saltare.map((r) => `--exclude-table=${fraVirgolette(r.schema)}.${fraVirgolette(r.nome)}`),
      `--file=${dump}`, `--dbname=${cfg.url}`,
    ], envPg, DUMP_MAX_MS);
    const elenco = (await esegui(cfg.pgRestore, ["--list", dump], {}, ELENCO_MAX_MS)).split("\n");
    const voci = elenco.filter((r) => r.trim() && !r.startsWith(";")).length;
    const tabelle = elenco.filter((r) => / TABLE DATA /.test(r)).length;
    if (!voci || !tabelle) throw new Error("la copia non ha dati: pg_restore non vi trova tabelle");
    const cifrata = path.join(cartella, "copia.dump.enc");
    const conta = contatore();
    await pipeline(createReadStream(dump), cifratore(cfg.chiave), conta, createWriteStream(cifrata, { mode: 0o600 }));
    // in chiaro solo il tempo di cifrarla
    await rm(dump, { force: true });
    const { byte, sha256 } = conta.risultato();
    const oggetto = nomeCopia(cfg.s3.prefisso, quando);
    await carica(cfg.s3, oggetto, cifrata, { byte, sha256 });
    // la verifica: quella nello storage è proprio questa
    const riletta = contatore();
    await pipeline(await scarica(cfg.s3, oggetto), riletta, new Writable({ write(_p, _c, fatto) { fatto(); } }));
    const r = riletta.risultato();
    if (r.byte !== byte || r.sha256 !== sha256) {
      throw new Error(`la copia riscaricata non è quella caricata: ${r.byte} byte invece di ${byte}, o SHA-256 diverso`);
    }
    return { oggetto, byte, sha256, voci, tabelle, versione, escluse: saltare.map((r) => `${r.schema}.${r.nome}`) };
  } finally {
    await rm(cartella, { recursive: true, force: true });
  }
}

export interface Notte { oraPassata: boolean; fatte: number; fallite: number; minutiDallUltima: number | null }

/** Se è ora della copia della notte (puro). */
export function dovuta(n: Notte): boolean {
  return n.oraPassata && n.fatte === 0 && n.fallite < TENTATIVI_PER_NOTTE
    && (n.minutiDallUltima == null || n.minutiDallUltima >= ATTESA_FRA_TENTATIVI_MIN);
}

/** Le copie da oggi alle `ora` di Roma: riuscite o in corso, e quelle della notte non riuscite. */
async function laNotte(ora: number, adesso: Date): Promise<Notte> {
  const { rows: [r] } = await pool.query(`
    WITH s AS (SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE 'Europe/Rome') + make_interval(hours => $2::int))
                      AT TIME ZONE 'Europe/Rome' AS soglia)
    SELECT s.soglia <= $1::timestamptz AS ora_passata,
           count(c.id) FILTER (WHERE c.stato IN ('riuscita', 'in_corso'))::int AS fatte,
           count(c.id) FILTER (WHERE c.chiesta_da IS NULL AND c.stato IN ('fallita', 'interrotta'))::int AS fallite,
           extract(epoch FROM $1::timestamptz - max(c.creata_il) FILTER (WHERE c.chiesta_da IS NULL)) / 60 AS minuti
      FROM s LEFT JOIN backup_copie c ON c.creata_il >= s.soglia
     GROUP BY s.soglia`, [adesso, ora]);
  return { oraPassata: !!r?.ora_passata, fatte: Number(r?.fatte ?? 0), fallite: Number(r?.fallite ?? 0),
    minutiDallUltima: r?.minuti == null ? null : Number(r.minuti) };
}

export type EsitoPassaggio = "senza tabella" | "spenta" | "incompleta" | "niente da fare" | "già in corso" | "riuscita" | "fallita";

/** Un passaggio. `fai` si sostituisce nei test. */
export function passaggioCopie(log: Log, letta: StatoConfig = leggiConfig(), adesso: Date = new Date(),
  fai: (cfg: ConfigCopia, quando: Date, saltare: { schema: string; nome: string }[]) => Promise<EsitoCopia> = faiCopia): Promise<EsitoPassaggio> {
  return inSistema("copia", async () => {
    const { rows: [t] } = await pool.query("SELECT pg_catalog.to_regclass('public.backup_copie') IS NOT NULL AS c");
    if (!t?.c) return "senza tabella";
    // una copia rimasta a metà: il lavoratore si è fermato mentre la faceva
    await pool.query(`
      UPDATE backup_copie SET stato = 'interrotta', finita_il = $1, errore = 'il lavoratore si è fermato durante la copia'
       WHERE stato = 'in_corso' AND iniziata_il < $1::timestamptz - interval '3 hours'`, [adesso]);
    const { rows: [chiesta] } = await pool.query(
      "SELECT id FROM backup_copie WHERE stato = 'chiesta' ORDER BY creata_il LIMIT 1");
    if (letta.stato !== "pronta") {
      if (chiesta) {
        const errore = letta.stato === "spenta"
          ? `la copia non è impostata nel lavoratore: mancano le variabili ${VARIABILI.join(", ")} (DEPLOY.md, «Copia del database fuori dal server»)`
          : `la copia non è impostata bene nel lavoratore: ${letta.motivo}`;
        await pool.query("UPDATE backup_copie SET stato = 'fallita', finita_il = $2, errore = $3 WHERE id = $1 AND stato = 'chiesta'",
          [chiesta.id, adesso, errore.slice(0, 2000)]);
      }
      return letta.stato;
    }
    const cfg = letta.config;
    let id: string | null = null;
    try {
      if (chiesta) {
        const { rows: [r] } = await pool.query(
          "UPDATE backup_copie SET stato = 'in_corso', iniziata_il = $2 WHERE id = $1 AND stato = 'chiesta' RETURNING id",
          [chiesta.id, adesso]);
        id = r?.id ?? null;
      } else {
        if (!dovuta(await laNotte(cfg.ora, adesso))) return "niente da fare";
        const { rows: [r] } = await pool.query(
          "INSERT INTO backup_copie (stato, creata_il, iniziata_il) VALUES ('in_corso', $1, $1) ON CONFLICT DO NOTHING RETURNING id",
          [adesso]);
        id = r?.id ?? null;
      }
    } catch (err) {
      // un'altra copia in corso (indice unico): la chiesta aspetta il passaggio dopo
      if ((err as { code?: string }).code === "23505") return "già in corso";
      throw err;
    }
    if (!id) return "già in corso";
    log.info({ id, chiesta: !!chiesta }, "copia del database: comincio");
    try {
      const saltare = await nonLeggibili();
      if (saltare.length) {
        log.warn({ id, escluse: saltare.map((r) => `${r.schema}.${r.nome}`) },
          "copia del database: salto le tabelle che cerbero_backup non legge (non sono di Cerbero, o il migratore non è ancora passato)");
      }
      const e = await fai(cfg, adesso, saltare);
      await pool.query(`
        UPDATE backup_copie SET stato = 'riuscita', finita_il = clock_timestamp(), oggetto = $2, byte = $3, sha256 = $4,
               voci = $5, tabelle = $6, versione = $7, escluse = $8
         WHERE id = $1`, [id, e.oggetto, e.byte, e.sha256, e.voci, e.tabelle, e.versione, e.escluse]);
      log.info({ id, oggetto: e.oggetto, mb: Math.round(e.byte / 1e5) / 10, tabelle: e.tabelle },
        "copia del database: fatta, cifrata, caricata e riscaricata uguale");
      return "riuscita";
    } catch (err) {
      const errore = senzaSegreti((err as Error)?.message ?? String(err), cfg.segreti).slice(0, 2000);
      await pool.query("UPDATE backup_copie SET stato = 'fallita', finita_il = clock_timestamp(), errore = $2 WHERE id = $1",
        [id, errore]);
      log.error({ id, errore }, "copia del database: non riuscita");
      return "fallita";
    }
  });
}

/** Ogni minuto, solo quando `puo()` (schema «ok»), una copia alla volta. Restituisce lo stop. */
export function avviaCopie(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS,
  letta: StatoConfig = leggiConfig()): () => void {
  if (letta.stato === "spenta") {
    log.warn({}, "copia del database fuori dal server: non impostata (DEPLOY.md, «Copia del database fuori dal server»)");
  } else if (letta.stato === "incompleta") {
    log.error({ motivo: letta.motivo }, "copia del database fuori dal server: impostata male, nessuna copia");
  } else {
    log.info({ ora: letta.config.ora, bucket: letta.config.s3.bucket, prefisso: letta.config.s3.prefisso },
      "copia del database fuori dal server: ogni notte dopo l'ora indicata (ora di Roma)");
  }
  let occupato = false;
  const passa = () => {
    if (!puo() || occupato) return;
    occupato = true;
    passaggioCopie(log, letta)
      .catch((err) => log.error({ errore: senzaSegreti((err as Error)?.message) }, "copia del database: controllo non riuscito"))
      .finally(() => { occupato = false; });
  };
  const primo = setTimeout(passa, PRIMO_PASSAGGIO_MS);
  const ciclo = setInterval(passa, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
