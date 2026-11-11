/**
 * Con chi lavora il processo sul database (PR 2.8, «Ruoli del database»)?
 *
 * In produzione l'API e il lavoratore si collegano come `cerbero_app`, che
 * lavora come `cerbero_owner` (il proprietario delle tabelle) grazie
 * all'impostazione `role` del ruolo. Il processo NON parte (esce con 1, e il
 * container vecchio resta in servizio) se:
 * - le credenziali sono sbagliate, il ruolo non può entrare o il database non
 *   c'è (prima della 2.8 lo fermava il migratore, che usava la stessa URL);
 * - è `cerbero_app` ma la sessione non lavora come `cerbero_owner`
 *   (impostazione del ruolo tolta, appartenenza senza SET): senza diritti
 *   sulle tabelle tutto fallirebbe a metà richiesta;
 * - è `cerbero_app` e manca, o è spento, uno dei due event trigger che gli
 *   impediscono di creare funzioni, viste, trigger… e di mettere funzioni non
 *   ammesse in default, vincoli e indici: senza, un oggetto o un'espressione
 *   dell'app potrebbero girare come superutente;
 * - è `cerbero_app` e una relazione del catalogo di Cerbero (quelle che il
 *   riallineamento passa a cerbero_owner, lib/db/scripts/catalogo-incluso.mjs)
 *   è ancora di un superutente: il riallineamento del migratore non è finito
 *   (login e altre richieste darebbero «permission denied» mentre
 *   /api/healthz dice 200).
 *
 * Il resto finisce nel log: una riga con l'utente, e un avviso se si è ancora
 * superutenti (prima del cambio di DATABASE_URL), se una relazione di Cerbero
 * è di un altro ruolo (per esempio il sistema AVM) o se c'è una relazione di
 * un superutente fuori dal catalogo (un backup fatto a mano: l'app non la usa).
 *
 * Se il database non risponde (rete, riavvio di Postgres) non si ferma niente:
 * si riprova ogni 15 s finché la lettura riesce, e allora si giudica.
 */
import { pool } from "@workspace/db";
import { APP, PROPRIETARIO, ESCLUSE, EVENTO_DDL, EVENTO_DDL_FINE } from "../../../../lib/db/scripts/ruoli-nomi.mjs";
import { RELAZIONI_DEL_CATALOGO } from "../../../../lib/db/scripts/catalogo-incluso.mjs";
import { logger } from "./logger";

export interface Identita {
  sessione: string;
  corrente: string;
  superutente: boolean;
  /** i due event trigger che fermano il DDL dell'app ci sono e sono accesi sempre */
  eventoAcceso: boolean;
  /**
   * relazioni negli schemi di Cerbero (public, caronte, coda) che non sono del
   * ruolo corrente; `delCatalogo`: è una di quelle che il riallineamento sposta
   */
  altrui: { nome: string; diSuperutente: boolean; delCatalogo: boolean }[];
}

export type Giudizio =
  | { esito: "fatale"; messaggio: string }
  | { esito: "avviso"; messaggio: string }
  | { esito: "ok"; messaggio: string };

const elenco = (v: string[]) => `${v.slice(0, 10).join(", ")}${v.length > 10 ? ` e altre ${v.length - 10}` : ""}`;

/** Puro: cosa dire (o se fermarsi) per un'identità. */
export function giudica(i: Identita): Giudizio {
  if (i.sessione === APP) {
    if (i.corrente !== PROPRIETARIO) {
      return {
        esito: "fatale",
        messaggio: `collegato come ${APP} ma la sessione lavora come ${i.corrente}, non come ${PROPRIETARIO}: `
          + `manca l'impostazione «role = ${PROPRIETARIO}» del ruolo ${APP}, o la sua appartenenza a ${PROPRIETARIO} con SET. `
          + "Le rimette il migratore all'avvio dell'API (o a mano: node lib/db/scripts/ruoli.mjs)",
      };
    }
    if (!i.eventoAcceso) {
      return {
        esito: "fatale",
        messaggio: `collegato come ${APP} senza gli event trigger ${EVENTO_DDL} e ${EVENTO_DDL_FINE} accesi: l'app potrebbe `
          + "cambiare la struttura del database (togliere colonne e regole, creare oggetti che girano come superutente). "
          + "Li crea il migratore all'avvio dell'API "
          + "(o a mano: node lib/db/scripts/ruoli.mjs)",
      };
    }
    const diSuperutente = i.altrui.filter((a) => a.diSuperutente && a.delCatalogo).map((a) => a.nome);
    if (diSuperutente.length) {
      return {
        esito: "fatale",
        messaggio: `collegato come ${APP} ma ${diSuperutente.length === 1 ? "una relazione" : `${diSuperutente.length} relazioni`} `
          + `di Cerbero ${diSuperutente.length === 1 ? "è" : "sono"} ancora di un superutente: ${elenco(diSuperutente)}. `
          + "Il riallineamento del migratore non è finito: dal container dell'API, node lib/db/scripts/ruoli.mjs",
      };
    }
  }
  if (i.superutente) {
    return {
      esito: "avviso",
      messaggio: `collegato al database come ${i.corrente}, superutente: l'app dovrebbe usare ${APP} `
        + "(DEPLOY.md, «Ruoli del database»)",
    };
  }
  const estranee = i.altrui.filter((a) => a.diSuperutente && !a.delCatalogo);
  const altrui = i.altrui.filter((a) => !estranee.includes(a));
  if (altrui.length) {
    const n = altrui.length;
    return {
      esito: "avviso",
      messaggio: `${n} ${n === 1 ? "relazione" : "relazioni"} di Cerbero non ${n === 1 ? "è" : "sono"} di ${i.corrente}: `
        + `${elenco(altrui.map((a) => a.nome))}. Dal container dell'API: node lib/db/scripts/ruoli.mjs --verifica`,
    };
  }
  if (estranee.length) {
    const n = estranee.length;
    return {
      esito: "avviso",
      messaggio: `${n} ${n === 1 ? "relazione" : "relazioni"} di un superutente fuori dal catalogo di Cerbero: `
        + `${elenco(estranee.map((a) => a.nome))}. L'app non le usa; se sono avanzi vanno tolte `
        + "(node lib/db/scripts/ruoli.mjs --verifica dice come)",
    };
  }
  return { esito: "ok", messaggio: `database: collegato come ${i.sessione}, lavora come ${i.corrente}` };
}

/** Errori di connessione che non passano da soli: credenziali, ruolo senza accesso, database che non c'è. */
export const ERRORI_DI_ACCESSO = new Set(["28P01", "28000", "3D000"]);

export async function leggiIdentita(): Promise<Identita> {
  const { rows: [io] } = await pool.query(`
    SELECT session_user AS sessione, current_user AS corrente,
           (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superutente,
           (SELECT count(*) FROM pg_catalog.pg_event_trigger
             WHERE evtname = ANY ($1::text[]) AND evtenabled = 'A') = 2 AS evento`, [[EVENTO_DDL, EVENTO_DDL_FINE]]);
  const { rows } = await pool.query(`
    SELECT n.nspname || '.' || c.relname AS nome, o.rolsuper AS di_superutente
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     WHERE n.nspname IN ('public', 'caronte', 'coda') AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND n.nspname || '.' || c.relname <> ALL ($1)
     ORDER BY 1`, [[...ESCLUSE]]);
  return {
    sessione: io.sessione, corrente: io.corrente, superutente: Boolean(io.superutente), eventoAcceso: Boolean(io.evento),
    altrui: rows.map((r) => ({
      nome: r.nome, diSuperutente: Boolean(r.di_superutente), delCatalogo: CATALOGO.has(r.nome),
    })),
  };
}

const CATALOGO = new Set(RELAZIONI_DEL_CATALOGO);
/** Ogni quanto si riprova se il database non risponde (come la guardia di versione). */
export const RIPROVA_MS = 15_000;

/**
 * All'avvio: una riga nel log, e l'uscita nei casi qui sopra. Un database che
 * non risponde (rete, riavvio) non ferma niente: si riprova ogni RIPROVA_MS
 * finché la lettura riesce, e allora si giudica (anche l'uscita). Il timer non
 * tiene in vita il processo.
 */
export async function controllaIdentita(processo: string, tentativo = 1): Promise<void> {
  let i: Identita;
  try {
    i = await leggiIdentita();
  } catch (err: any) {
    const codice = err?.code ?? err?.cause?.code;
    if (ERRORI_DI_ACCESSO.has(codice)) {
      logger.fatal({ processo, codice, err: err?.message },
        "Il database rifiuta l'accesso (credenziali, ruolo senza LOGIN o database sbagliato in DATABASE_URL): non parto. "
        + "Un URL già provato lo dà, dal container dell'API: node lib/db/scripts/ruoli.mjs --imposta-password "
        + "(DEPLOY.md, «Ruoli del database», passi 3 e 4)");
      process.exit(1);
    }
    if (tentativo === 1 || tentativo % 20 === 0) {
      logger.warn({ err, processo, tentativo }, `Con chi lavoro sul database? Non riesco a leggerlo: riprovo ogni ${RIPROVA_MS / 1000} s`);
    }
    setTimeout(() => void controllaIdentita(processo, tentativo + 1), RIPROVA_MS).unref();
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
