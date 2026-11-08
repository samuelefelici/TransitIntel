/**
 * Con chi lavora il processo sul database (PR 2.8, «Ruoli del database»)?
 *
 * In produzione l'API e il lavoratore si collegano come `cerbero_app`, che
 * lavora come `cerbero_owner` (il proprietario delle tabelle) grazie
 * all'impostazione `role` del ruolo. Se quell'impostazione non si applica
 * (tolta per sbaglio, o un ruolo con la membership senza SET) la sessione
 * resta `cerbero_app`, che non ha diritti sulle tabelle: tutto fallirebbe a
 * metà richiesta. Meglio non partire: il processo esce con 1 e il container
 * vecchio resta in servizio.
 *
 * Il resto finisce nel log: una riga con l'utente, e un avviso se si è ancora
 * superutenti (prima del cambio di DATABASE_URL) o se qualche relazione di
 * Cerbero non è del ruolo con cui si lavora (il riallineamento del migratore
 * non è ancora passato da lì: `node lib/db/scripts/ruoli.mjs`).
 */
import { pool } from "@workspace/db";
import { APP, PROPRIETARIO, ESCLUSE } from "../../../../lib/db/scripts/ruoli-nomi.mjs";
import { logger } from "./logger";

export interface Identita {
  sessione: string;
  corrente: string;
  superutente: boolean;
  /** relazioni di Cerbero (public, caronte, coda) che non sono del ruolo corrente */
  altrui: string[];
}

export type Giudizio =
  | { esito: "fatale"; messaggio: string }
  | { esito: "avviso"; messaggio: string }
  | { esito: "ok"; messaggio: string };

/** Puro: cosa dire (o se fermarsi) per un'identità. */
export function giudica(i: Identita): Giudizio {
  if (i.sessione === APP && i.corrente !== PROPRIETARIO) {
    return {
      esito: "fatale",
      messaggio: `collegato come ${APP} ma la sessione lavora come ${i.corrente}, non come ${PROPRIETARIO}: `
        + `manca l'impostazione «role = ${PROPRIETARIO}» del ruolo ${APP}, o la sua appartenenza a ${PROPRIETARIO} con SET. `
        + "Le rimette il migratore all'avvio dell'API (o a mano: node lib/db/scripts/ruoli.mjs)",
    };
  }
  if (i.superutente) {
    return {
      esito: "avviso",
      messaggio: `collegato al database come ${i.corrente}, superutente: l'app dovrebbe usare ${APP} `
        + "(DEPLOY.md, «Ruoli del database»)",
    };
  }
  if (i.altrui.length) {
    const n = i.altrui.length;
    return {
      esito: "avviso",
      messaggio: `${n} ${n === 1 ? "relazione" : "relazioni"} di Cerbero non ${n === 1 ? "è" : "sono"} di ${i.corrente}: `
        + `${i.altrui.slice(0, 10).join(", ")}${n > 10 ? ` e altre ${n - 10}` : ""}. `
        + "Dal container dell'API: node lib/db/scripts/ruoli.mjs",
    };
  }
  return { esito: "ok", messaggio: `database: collegato come ${i.sessione}, lavora come ${i.corrente}` };
}

export async function leggiIdentita(): Promise<Identita> {
  const { rows: [io] } = await pool.query(`
    SELECT session_user AS sessione, current_user AS corrente,
           (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente`);
  const { rows } = await pool.query(`
    SELECT n.nspname || '.' || c.relname AS nome
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'caronte', 'coda') AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND n.nspname || '.' || c.relname <> ALL ($1)
     ORDER BY 1`, [[...ESCLUSE]]);
  return { sessione: io.sessione, corrente: io.corrente, superutente: Boolean(io.superutente), altrui: rows.map((r) => r.nome) };
}

/**
 * All'avvio: una riga nel log, e l'uscita se il ruolo non si è applicato. Un
 * database che non risponde non ferma niente (lo dice la guardia di versione).
 */
export async function controllaIdentita(processo: string): Promise<void> {
  let i: Identita;
  try {
    i = await leggiIdentita();
  } catch (err) {
    logger.warn({ err, processo }, "Con chi lavoro sul database? Non riesco a leggerlo");
    return;
  }
  const g = giudica(i);
  const dati = { processo, sessione: i.sessione, ruolo: i.corrente, superutente: i.superutente };
  if (g.esito === "fatale") {
    logger.fatal(dati, g.messaggio);
    process.exit(1);
  }
  if (g.esito === "avviso") logger.warn(dati, g.messaggio);
  else logger.info(dati, g.messaggio);
}
