/**
 * La guardia di versione: il database ha tutte le migrazioni che questo codice
 * si aspetta?
 *
 * Dalla PR 2.4 l'API non crea e non altera più tabelle da sé: lo schema lo
 * fanno solo le migrazioni (lib/db/migrations), che l'immagine applica prima
 * di avviare l'API (docker/avvio.sh). Se il database resta indietro (l'API
 * avviata senza il migratore, DATABASE_MIGRATOR_URL su un altro database, un
 * backup vecchio rimesso sotto un'immagine nuova) il codice cercherebbe
 * tabelle o colonne che non ci sono: qui lo si vede subito, nel log e in
 * /api/healthz, invece che da un errore a metà di una richiesta.
 *
 * Il 503 di /api/healthz serve al deploy: un container nuovo che non è MAI
 * stato allineato non diventa sano, e Coolify non gli manda traffico. Un
 * container che era allineato e poi trova il database indietro (un ripristino)
 * non si toglie dal servizio: fuori dal deploy un container non sano esce dal
 * routing di Traefik, e tutta l'API risponderebbe 404. Lo dice nel log, come
 * errore, e /api/healthz mostra schema «indietro» con 200.
 *
 * Il diario è quello incorporato nel bundle (lib/db/scripts/diario-incluso.mjs):
 * le migrazioni della stessa immagine. Si controlla all'avvio, poi ogni 10
 * minuti se è tutto a posto, ogni 15 secondi se no (così, applicate le
 * migrazioni, torna sano in fretta). Solo in lettura. (PR 2.8: all'utente
 * dell'app servirà SELECT sulla tabella di tracciamento; senza, lo stato resta
 * «sconosciuto».)
 */
import { pool } from "@workspace/db";
import { statoSchema, TRACCIAMENTO } from "../../../../lib/db/scripts/migrazioni-regole.mjs";
import { DIARIO } from "../../../../lib/db/scripts/diario-incluso.mjs";
import { logger } from "./logger";

export type StatoDelloSchema = "ok" | "indietro" | "avanti" | "sconosciuto";

const OGNI = 10 * 60 * 1000;
const PRESTO = 15_000;
const TABELLA = `"${TRACCIAMENTO.migrationsSchema}"."${TRACCIAMENTO.migrationsTable}"`;

let stato: StatoDelloSchema = "sconosciuto";
/* vero finché, da quando è partito, il container non ha mai visto lo schema allineato */
let maiAllineato = true;
let giaDetto: string | null = null;
let primo: Promise<unknown> | null = null;
let timer: NodeJS.Timeout | null = null;

/** L'ultimo stato controllato («sconosciuto» prima del primo controllo o se il database non risponde). */
export function statoDelloSchema(): StatoDelloSchema {
  return stato;
}

/** /api/healthz risponde 503: lo schema è indietro e questo container non è mai stato allineato. */
export function fuoriServizio(): boolean {
  return stato === "indietro" && maiAllineato;
}

/** Aspetta il primo controllo, al massimo `ms`: così la prima sonda di salute non risponde «sconosciuto». */
export async function attendiPrimoControllo(ms: number): Promise<void> {
  if (!primo) return;
  let t: NodeJS.Timeout | undefined;
  await Promise.race([primo, new Promise((r) => { t = setTimeout(r, ms); })]);
  if (t) clearTimeout(t);
}

/** Solo per i test. */
export function azzeraGuardiaSchema(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  primo = null;
  stato = "sconosciuto";
  maiAllineato = true;
  giaDetto = null;
}

/* il log solo quando qualcosa cambia */
function dillo(chiave: string, scrivi: () => void): void {
  if (giaDetto === chiave) return;
  giaDetto = chiave;
  scrivi();
}

export async function controllaSchema(): Promise<StatoDelloSchema> {
  try {
    const c = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS c`, [TABELLA]);
    const righe = c.rows[0]?.c ? (await pool.query(`SELECT created_at FROM ${TABELLA}`)).rows : [];
    const e = statoSchema(DIARIO, righe);
    stato = e.stato;
    if (e.stato === "ok") {
      maiAllineato = false;
      dillo("ok", () => logger.info({ ultima: e.ultimaDelCodice }, "Schema del database allineato al codice"));
    } else if (e.stato === "avanti") {
      maiAllineato = false;
      dillo(`avanti:${e.sconosciute}`, () => logger.warn(
        { piuNuove: e.sconosciute, ultimaDelCodice: e.ultimaDelCodice },
        "Il database ha migrazioni più nuove di questo codice: va bene durante un deploy o dopo un rollback (le migrazioni restano compatibili all'indietro)",
      ));
    } else {
      const comeRimediare = "Riavvia il container (l'avvio applica le migrazioni, docker/avvio.sh) oppure lancia node lib/db/scripts/migra.mjs dal suo Terminal";
      dillo(`indietro:${maiAllineato}:${e.mancanti.join(",")}`, () => logger.error(
        { mancanti: e.mancanti },
        maiAllineato
          ? `Lo schema del database è indietro rispetto al codice: mancano delle migrazioni, e finché mancano /api/healthz risponde 503 (il container non diventa sano). ${comeRimediare}`
          : `Lo schema del database è tornato indietro rispetto al codice (un ripristino?): mancano delle migrazioni e alcune funzioni possono dare errore. Il container resta in servizio. ${comeRimediare}`,
      ));
    }
  } catch (err) {
    stato = "sconosciuto";
    dillo("sconosciuto", () => logger.warn({ err }, "Controllo dello schema del database non riuscito: riprovo fra 15 secondi"));
  }
  return stato;
}

export function avviaGuardiaSchema(): void {
  const giro = async () => {
    const s = await controllaSchema();
    timer = setTimeout(() => void giro(), s === "ok" || s === "avanti" ? OGNI : PRESTO);
    timer.unref();
  };
  primo = giro();
}
