/**
 * I limiti per deposito su quello che una persona vede e modifica dei
 * conducenti (PR 2.14c e 2.14d).
 *
 * Per ogni utente l'amministratore sceglie, deposito per deposito, se può
 * modificare i conducenti, solo vederli, o niente (Amministrazione › Utenti e
 * accessi): users.depositi (quelli che modifica, migrazione 0012) e
 * users.depositi_visibili (quelli che vede, migrazione 0016). È il caso del
 * Capo deposito. La regola dei due elenchi è in @workspace/permessi
 * (limitiSuiDepositi); l'amministratore di sistema non ha mai limiti.
 *
 * **Quello che modifica** (2.14c): le scritture che toccano un conducente sul
 * tabellone (turni, scambi, voci di assenza e presenza, rotazioni dei riposi,
 * riposi generati) e i conducenti fittizi creati da chi non scrive il
 * «Personale». La scrittura dei dati del personale è un'altra area: chi la ha
 * scrive le schede di tutti i conducenti che vede.
 *
 * **Quello che vede** (2.14d): chi ha un elenco di depositi visibili non
 * riceve i conducenti degli altri, da nessuna rotta: elenco, scheda, storico,
 * esportazione, tabellone, rotazioni dei riposi. Per lui un conducente di un
 * altro deposito è come se non ci fosse (404), e non lo può nemmeno scrivere.
 * Nel tabellone i turni presi da conducenti che non vede risultano occupati,
 * senza dire da chi: altrimenti gli sembrerebbero scoperti.
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
import { limitiSuiDepositi, scriveSulDeposito, vedeIlDeposito, type LimitiDepositi } from "./permessi";
import { trovaDeposito, type Deposito } from "./anagrafica-campi";
import { leggiDepositi, righe, type Ex } from "./anagrafica-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* una richiesta senza utente non dovrebbe arrivare fin qui (requireAuth): se arriva, non vede e non scrive su nessun deposito */
const NESSUN_DEPOSITO: readonly string[] = Object.freeze([""]);

/** Che cosa vede e che cosa modifica chi fa la richiesta, deposito per deposito; `null` = tutti. */
export function limitiDi(req: Request): LimitiDepositi {
  const u = req.user;
  if (!u) return { vede: NESSUN_DEPOSITO, scrive: NESSUN_DEPOSITO };
  return limitiSuiDepositi({ admin: u.role === "admin", depositi: u.depositi, depositiVisibili: u.depositiVisibili });
}

/** I depositi su cui chi fa la richiesta scrive il roster; `null` = tutti. */
export function limiteDi(req: Request): readonly string[] | null {
  return limitiDi(req).scrive;
}

/** Chi fa la richiesta vede solo alcuni depositi? */
export function haLimiteDiVisibilita(req: Request): boolean {
  return limitiDi(req).vede !== null;
}

const nomi = (codici: readonly string[], catalogo: readonly Deposito[]): string =>
  codici.filter(Boolean).map(c => catalogo.find(d => d.codice === c)?.nome ?? c).join(", ");

/** Perché non si scrive un conducente che si vede: nomina i depositi, mai il conducente. */
export function motivoFuoriDeposito(deposito: Deposito | null, limite: readonly string[], catalogo: readonly Deposito[], piuDiUno = false): string {
  const chi = piuDiUno ? "uno dei conducenti" : "il conducente";
  const dove = deposito ? `è del deposito «${deposito.nome}»` : "non ha un deposito";
  const tuoi = nomi(limite, catalogo);
  return `Sola lettura: ${chi} ${dove}, e tu ${tuoi ? `scrivi solo sui conducenti di ${tuoi}` : "non modifichi i conducenti di nessun deposito"}`;
}

/** Il rifiuto per un conducente che chi scrive non vede: non dice di che deposito è. */
export const MOTIVO_NON_VISIBILE = "Sola lettura: uno dei conducenti non è di un deposito che vedi";

/** Il deposito del catalogo di una residenza di servizio, con i limiti di chi fa la richiesta. */
export interface Controllo {
  /** i depositi su cui scrive (vuoto: nessuno) */
  limite: readonly string[];
  catalogo: Deposito[];
  /** ha anche un limite su quello che vede? */
  limitaLaVista: boolean;
  /** vede un conducente con questa residenza di servizio? */
  vede: (residenzaServizio: string | null | undefined) => boolean;
  /** si scrive su un conducente con questa residenza di servizio? (mai su uno che non si vede) */
  scrive: (residenzaServizio: string | null | undefined) => boolean;
  /** il rifiuto per quella residenza di servizio */
  motivo: (residenzaServizio: string | null | undefined, piuDiUno?: boolean) => string;
}

/**
 * Il controllo pronto per chi fa la richiesta, o `null` se non ha limiti
 * (niente da leggere). Chi non ha un limite su quello che scrive non ne ha
 * nemmeno su quello che vede: lo dice la regola (limitiSuiDepositi).
 */
export async function controlloDepositi(req: Request, ex: Ex): Promise<Controllo | null> {
  const { vede, scrive } = limitiDi(req);
  if (scrive === null) return null;
  const catalogo = await leggiDepositi(ex);
  const codice = (r: string | null | undefined) => trovaDeposito(r, catalogo)?.codice;
  const visibile = (r: string | null | undefined) => vedeIlDeposito(vede, codice(r));
  return {
    limite: scrive, catalogo, limitaLaVista: vede !== null,
    vede: visibile,
    scrive: (r) => visibile(r) && scriveSulDeposito(scrive, codice(r)),
    motivo: (r, piuDiUno) => (visibile(r) ? motivoFuoriDeposito(trovaDeposito(r, catalogo), scrive, catalogo, piuDiUno) : MOTIVO_NON_VISIBILE),
  };
}

/**
 * I conducenti di un elenco che chi fa la richiesta vede. Chi non ha limiti
 * sulla vista riceve l'elenco com'è, senza leggere niente.
 */
export async function soloVisibili<T extends { residenzaServizio?: string | null }>(req: Request, ex: Ex, conducenti: T[]): Promise<T[]> {
  if (!haLimiteDiVisibilita(req)) return conducenti;
  const c = await controlloDepositi(req, ex);
  return c ? conducenti.filter(x => c.vede(x.residenzaServizio)) : conducenti;
}

/**
 * Gli id, fra quelli dati, dei conducenti che chi fa la richiesta NON vede;
 * `null` se non ha limiti sulla vista (niente da leggere). Un id che non
 * corrisponde a nessun conducente non c'è nell'insieme: lo dirà la rotta.
 */
export async function nonVisibili(req: Request, ex: Ex, conducenti: readonly unknown[]): Promise<Set<string> | null> {
  if (!haLimiteDiVisibilita(req)) return null;
  const c = await controlloDepositi(req, ex);
  if (!c) return null;
  const ids = [...new Set(conducenti.map(v => String(v ?? "").toLowerCase()).filter(v => UUID.test(v)))];
  if (!ids.length) return new Set();
  const r = righe(await ex.execute(sql`
    SELECT id::text AS id, residenza_servizio FROM roster_drivers WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`));
  return new Set(r.filter((x: any) => !c.vede(x.residenza_servizio)).map((x: any) => String(x.id).toLowerCase()));
}

/** Vero se chi fa la richiesta vede quel conducente (o se il conducente non esiste: lo dirà la rotta). */
export async function vedeConducente(req: Request, ex: Ex, id: string): Promise<boolean> {
  const fuori = await nonVisibili(req, ex, [id]);
  return !fuori || !fuori.has(String(id).toLowerCase());
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
  /* prima chi non si vede: il suo rifiuto non dice di che deposito è */
  const fuori = r.find((x: any) => !c.vede(x.residenza_servizio)) ?? r.find((x: any) => !c.scrive(x.residenza_servizio));
  return fuori ? c.motivo(fuori.residenza_servizio, ids.length > 1) : null;
}
