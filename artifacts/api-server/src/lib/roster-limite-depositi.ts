/**
 * Il limite per deposito sulla scrittura del roster (PR 2.14c).
 *
 * Un utente può avere un elenco di depositi (users.depositi, migrazione 0012;
 * si scelgono in Amministrazione › Utenti e accessi). Chi ne ha scrive sul
 * roster solo per i conducenti di quei depositi: è il caso del Capo deposito.
 * **Nessun deposito vuol dire nessun limite**, e l'amministratore non ne ha
 * mai. La regola è in @workspace/permessi (limiteDepositi, scriveSulDeposito).
 *
 * Che cosa limita: le scritture che toccano un conducente sul tabellone
 * (turni, scambi, voci di assenza e presenza, rotazioni dei riposi, riposi
 * generati) e i conducenti fittizi creati da chi non scrive il «Personale».
 * Che cosa NON limita: quello che si legge (il tabellone degli altri depositi
 * resta visibile), e la scrittura dei dati del personale, che è un'altra area.
 *
 * Il deposito di un conducente è la sua residenza di servizio, abbinata al
 * catalogo come fa il resto dell'anagrafica (nome, codice o alias). Un
 * conducente senza deposito, o con un deposito che il catalogo non riconosce,
 * lo scrive solo chi non ha limiti.
 *
 * Qui non si lancia e non si risponde: le funzioni dicono se e perché, e ogni
 * rotta rifiuta a modo suo (403 con `solaLettura: true`, così la web mostra
 * l'avviso unico).
 */
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { limiteDepositi, scriveSulDeposito } from "./permessi";
import { trovaDeposito, type Deposito } from "./anagrafica-campi";
import { leggiDepositi, righe, type Ex } from "./anagrafica-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* una richiesta senza utente non dovrebbe arrivare fin qui (requireAuth): se arriva, non scrive su nessun deposito */
const NESSUN_DEPOSITO: readonly string[] = Object.freeze([""]);

/** I depositi su cui chi fa la richiesta scrive il roster; `null` = tutti. */
export function limiteDi(req: Request): readonly string[] | null {
  const u = req.user;
  if (!u) return NESSUN_DEPOSITO;
  return limiteDepositi({ admin: u.role === "admin", depositi: u.depositi });
}

const nomi = (codici: readonly string[], catalogo: readonly Deposito[]): string =>
  codici.filter(Boolean).map(c => catalogo.find(d => d.codice === c)?.nome ?? c).join(", ") || "nessun deposito";

/** Perché non si scrive: nomina i depositi, mai il conducente. */
export function motivoFuoriDeposito(deposito: Deposito | null, limite: readonly string[], catalogo: readonly Deposito[], piuDiUno = false): string {
  const chi = piuDiUno ? "uno dei conducenti" : "il conducente";
  const dove = deposito ? `è del deposito «${deposito.nome}»` : "non ha un deposito";
  return `Sola lettura: ${chi} ${dove}, e tu scrivi solo sui conducenti di ${nomi(limite, catalogo)}`;
}

/** Il deposito del catalogo di una residenza di servizio, con il limite di chi scrive. */
export interface Controllo {
  limite: readonly string[];
  catalogo: Deposito[];
  /** si scrive su un conducente con questa residenza di servizio? */
  scrive: (residenzaServizio: string | null | undefined) => boolean;
  /** il rifiuto per quella residenza di servizio */
  motivo: (residenzaServizio: string | null | undefined, piuDiUno?: boolean) => string;
}

/** Il controllo pronto per chi fa la richiesta, o `null` se non ha limiti (niente da leggere). */
export async function controlloDepositi(req: Request, ex: Ex): Promise<Controllo | null> {
  const limite = limiteDi(req);
  if (limite === null) return null;
  const catalogo = await leggiDepositi(ex);
  return {
    limite, catalogo,
    scrive: (r) => scriveSulDeposito(limite, trovaDeposito(r, catalogo)?.codice),
    motivo: (r, piuDiUno) => motivoFuoriDeposito(trovaDeposito(r, catalogo), limite, catalogo, piuDiUno),
  };
}

/**
 * Se uno dei conducenti è fuori dai depositi di chi scrive, il motivo del
 * rifiuto; altrimenti `null`. Chi non ha limiti non fa nessuna lettura. Un id
 * che non corrisponde a nessun conducente non conta: lo dirà la rotta.
 */
export async function fuoriDaiDepositi(req: Request, ex: Ex, conducenti: readonly unknown[]): Promise<string | null> {
  const c = await controlloDepositi(req, ex);
  if (!c) return null;
  const ids = [...new Set(conducenti.map(v => String(v ?? "").toLowerCase()).filter(v => UUID.test(v)))];
  if (!ids.length) return null;
  const r = righe(await ex.execute(sql`
    SELECT residenza_servizio FROM roster_drivers WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`));
  const fuori = r.find((x: any) => !c.scrive(x.residenza_servizio));
  return fuori ? c.motivo(fuori.residenza_servizio, ids.length > 1) : null;
}
