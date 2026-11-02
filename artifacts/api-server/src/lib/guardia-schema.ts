/**
 * La guardia di versione: il database ha tutte le migrazioni che questo codice
 * si aspetta?
 *
 * Dalla PR 2.4 l'API non crea e non altera più tabelle da sé: lo schema lo
 * fanno solo le migrazioni (lib/db/migrations), che l'immagine applica prima
 * di avviare l'API (docker/avvio.sh). Se il database resta indietro (l'API
 * avviata senza il migratore, un backup vecchio rimesso sotto un'immagine
 * nuova) il codice cercherebbe tabelle o colonne che non ci sono: qui lo si
 * vede subito, nel log e in /api/healthz, invece che da un errore a metà
 * di una richiesta.
 *
 * Il diario è quello incorporato nel bundle (lib/db/scripts/diario-incluso.mjs):
 * le migrazioni della stessa immagine. Si controlla all'avvio e ogni 10 minuti,
 * solo in lettura. (PR 2.8: all'utente dell'app servirà SELECT sulla tabella
 * di tracciamento; senza, lo stato resta «sconosciuto».)
 */
import { pool } from "@workspace/db";
import { statoSchema, TRACCIAMENTO } from "../../../../lib/db/scripts/migrazioni-regole.mjs";
import { DIARIO } from "../../../../lib/db/scripts/diario-incluso.mjs";
import { logger } from "./logger";

export type StatoDelloSchema = "ok" | "indietro" | "avanti" | "sconosciuto";

const OGNI = 10 * 60 * 1000;
const TABELLA = `"${TRACCIAMENTO.migrationsSchema}"."${TRACCIAMENTO.migrationsTable}"`;

let stato: StatoDelloSchema = "sconosciuto";
let giaDetto: string | null = null;

/** L'ultimo stato controllato («sconosciuto» prima del primo controllo o se il database non risponde). */
export function statoDelloSchema(): StatoDelloSchema {
  return stato;
}

/** Solo per i test. */
export function azzeraGuardiaSchema(): void {
  stato = "sconosciuto";
  giaDetto = null;
}

/* il log solo quando qualcosa cambia: il controllo gira ogni 10 minuti */
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
      dillo("ok", () => logger.info({ ultima: e.ultimaDelCodice }, "Schema del database allineato al codice"));
    } else if (e.stato === "indietro") {
      dillo(`indietro:${e.mancanti.join(",")}`, () => logger.error(
        { mancanti: e.mancanti },
        "Lo schema del database è indietro rispetto al codice: mancano delle migrazioni. "
        + "Si applicano con node lib/db/scripts/migra.mjs (nell'immagine lo fa l'avvio, docker/avvio.sh). "
        + "Finché mancano, /api/healthz risponde 503",
      ));
    } else {
      dillo(`avanti:${e.sconosciute}`, () => logger.warn(
        { piuNuove: e.sconosciute, ultimaDelCodice: e.ultimaDelCodice },
        "Il database ha migrazioni più nuove di questo codice: va bene durante un deploy o dopo un rollback (le migrazioni restano compatibili all'indietro)",
      ));
    }
  } catch (err) {
    stato = "sconosciuto";
    dillo("sconosciuto", () => logger.warn({ err }, "Controllo dello schema del database non riuscito: riprovo fra 10 minuti"));
  }
  return stato;
}

export function avviaGuardiaSchema(): void {
  void controllaSchema();
  setInterval(() => void controllaSchema(), OGNI).unref();
}
