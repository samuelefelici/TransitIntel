/**
 * L'esecutore dei lavori: prende dalla coda (lib/lavori/coda.ts), esegue con
 * il gestore del tipo, batte, chiude. Gira nel lavoratore (src/lavoratore.ts)
 * e, con CERBERO_LAVORATORE_INTERNO=1, dentro l'API.
 *
 * - Slot separati per corsia: un calcolo lungo non ferma i brevi.
 * - Ogni 2 s guarda la coda; ogni 30 s rimette in coda i lavori abbandonati da
 *   un processo morto e ferma i calcoli sincroni che nessuno aspetta più
 *   (coda.fermaAbbandonati); ogni ora fa la pulizia (conservazione).
 * - Il battito (ogni 5 s, o prima se c'è un avanzamento nuovo, al massimo una
 *   volta al secondo) rinnova il lease e legge lo stop.
 * - Arresto ordinato (deploy): non prende più lavori (aspetta il giro della
 *   coda già partito: un lavoro preso in quell'istante torna subito in coda),
 *   aspetta un poco quelli in corso, poi li ferma e li rimette in coda senza
 *   consumare il tentativo. Un lavoro che finisce lo stesso (il gestore non era
 *   più in Python, per esempio un giro che stava salvando) si chiude col suo
 *   esito invece di tornare in coda.
 * - La chiusura è la scrittura che conta (un calcolo può durare un'ora): se il
 *   database non risponde si ritenta, e un risultato che il database rifiuta
 *   (per esempio un carattere NUL nel JSON, anche nella risposta che un
 *   fallito porta con sé) chiude il lavoro «fallito, sistema» invece di farlo
 *   ricalcolare da capo.
 */
import type { Corsia, Esito, Lavoro } from "./coda";
import * as codaReale from "./coda";
import { risultatoDi } from "./coda";
import type { Progresso } from "./python";
import { contestoDb, inSistema } from "@workspace/db/contesto";

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface ContestoLavoro {
  /** chi esegue (il lease): chi scrive a nome del lavoro controlla che la riga sia ancora sua */
  chi: string;
  /** abort: stop chiesto, arresto o lease perso (il motivo è in segnale.reason) */
  segnale: AbortSignal;
  progresso: (p: Progresso) => void;
  log: Log;
}

export interface Gestore {
  tipo: Lavoro["tipo"];
  versione: number;
  /**
   * Un esito «completato» vale anche se nel frattempo è arrivato uno stop: il
   * lavoro ha già effetti che lo stop non annulla (la sincronizzazione ha già
   * agganciato il feed nuovo al progetto). Senza, uno stop chiude «fermato» e
   * il risultato si scarta.
   */
  completatoVinceSulloStop?: boolean;
  esegui: (lavoro: Lavoro, ctx: ContestoLavoro) => Promise<Exclude<Esito, { stato: "fermato" }> | { stato: "fermato" }>;
}

export type Coda = Pick<typeof codaReale, "prendi" | "battito" | "chiudi" | "rimettiInCoda" | "recuperaScaduti" | "pulisci">
  & Partial<Pick<typeof codaReale, "fermaAbbandonati">>;

export interface OpzioniEsecutore {
  /** chi sono, per il lease (per esempio «lavoratore:host:pid») */
  chi: string;
  slot: Record<Corsia, number>;
  gestori: Gestore[];
  log: Log;
  /** si prendono lavori solo se è vero (la guardia dello schema) */
  puoPrendere?: () => boolean;
  coda?: Coda;
  pollingMs?: number;
  battitoMs?: number;
  recuperoMs?: number;
  puliziaMs?: number;
}

export type MotivoStop = "annulla" | "arresto" | "lease";

/** Attese fra i tentativi di chiusura: in tutto 13 s, dentro il lease di 60. */
const ATTESE_CHIUSURA_MS = [1_000, 3_000, 9_000];

/** Un errore del database che ripetere non cambia: il dato è rifiutato (classe 22) o troppo grande (54). */
export function datoRifiutato(err: unknown): boolean {
  const codice = String((err as any)?.code ?? "");
  return /^(22|54)/.test(codice);
}

interface InCorso { lavoro: Lavoro; controller: AbortController; fine: Promise<void> }

export function creaEsecutore(o: OpzioniEsecutore) {
  const coda = o.coda ?? codaReale;
  const pollingMs = o.pollingMs ?? 2_000;
  const battitoMs = o.battitoMs ?? 5_000;
  const recuperoMs = o.recuperoMs ?? 30_000;
  const puliziaMs = o.puliziaMs ?? 60 * 60_000;
  const gestori = new Map(o.gestori.map(g => [`${g.tipo}:${g.versione}`, g]));
  const noti = o.gestori.map(g => ({ tipo: g.tipo, versione: g.versione }));
  const inCorso = new Map<string, InCorso>();
  const occupati: Record<Corsia, number> = { veloce: 0, lunga: 0 };
  let timer: NodeJS.Timeout | null = null;
  let fermando = false;
  /* il giro della coda in corso: ferma() lo aspetta, perché può avere un prendi in volo */
  let giroCorrente: Promise<void> | null = null;
  let ultimoRecupero = 0;
  let ultimaPulizia = 0;

  async function esegui(l: Lavoro, controller: AbortController): Promise<void> {
    let progressoNuovo: Progresso | undefined;
    let ultimoBattito = Date.now();
    let battendo = false;
    const log = o.log;
    const battiOra = async () => {
      if (battendo) return;
      battendo = true;
      const p = progressoNuovo;
      progressoNuovo = undefined;
      try {
        const r = await coda.battito(l.id, o.chi, p);
        ultimoBattito = Date.now();
        if (!r) { if (!controller.signal.aborted) controller.abort("lease" satisfies MotivoStop); }
        else if (r.annulla && !controller.signal.aborted) controller.abort("annulla" satisfies MotivoStop);
      } catch (err) {
        // il database non risponde: si riprova al prossimo giro (il lease dura 60 s)
        if (p && !progressoNuovo) progressoNuovo = p;
        log.warn({ err, lavoro: l.id }, "battito del lavoro non riuscito");
      } finally {
        battendo = false;
      }
    };
    const orologio = setInterval(() => {
      if (progressoNuovo || Date.now() - ultimoBattito >= battitoMs) void battiOra();
    }, 1_000);
    orologio.unref?.();

    let esito: Awaited<ReturnType<Gestore["esegui"]>>;
    const g = gestori.get(`${l.tipo}:${l.versione}`);
    try {
      if (!g) throw new Error(`tipo di lavoro sconosciuto: ${l.tipo} v${l.versione}`);
      esito = await g.esegui(l, { chi: o.chi, segnale: controller.signal, progresso: (p) => { progressoNuovo = p; }, log });
    } catch (err: any) {
      log.error({ err, lavoro: l.id }, "lavoro finito con un errore del sistema");
      esito = { stato: "fallito", errore: `Errore interno: ${err?.message ?? err}`, erroreTipo: "sistema" };
    } finally {
      clearInterval(orologio);
    }
    const motivo = controller.signal.aborted ? (controller.signal.reason as MotivoStop) : null;
    if (motivo === "lease") {
      log.warn({ lavoro: l.id }, "lavoro non più di questo processo (lease scaduto): risultato scartato");
    } else if (motivo === "arresto" && esito.stato === "fermato") {
      await rimetti(l.id);
    } else if (motivo === "arresto") {
      // finito (e magari già salvato, come un giro di Argos) mentre arrivava l'arresto: si chiude, non si rifà
      await chiudi(l.id, esito);
    } else {
      const vince = motivo === "annulla" && esito.stato === "completato" && g?.completatoVinceSulloStop === true;
      await chiudi(l.id, (motivo === "annulla" && !vince) || esito.stato === "fermato" ? { stato: "fermato" } : esito);
    }
  }

  /** Chiude il lavoro, ritentando se il database non risponde. */
  async function chiudi(id: string, esito: Esito): Promise<void> {
    for (let tentativo = 0; ; tentativo++) {
      try {
        const scritto = await coda.chiudi(id, o.chi, esito);
        if (!scritto) o.log.warn({ lavoro: id }, "chiusura non scritta: il lavoro non è più di questo processo (lease scaduto o già chiuso)");
        return;
      } catch (err: any) {
        if (datoRifiutato(err) && risultatoDi(esito) !== undefined) {
          // ripetere non serve: il risultato non entra nel database
          o.log.error({ err, lavoro: id }, "il database rifiuta il risultato del lavoro: lo chiudo come fallito");
          esito = { stato: "fallito", errore: `Il risultato del calcolo non si può salvare (${err.code}): ${err.message}`, erroreTipo: "sistema" };
          continue;
        }
        if (tentativo >= ATTESE_CHIUSURA_MS.length) {
          // la riga resta «in corso»: il lease scade e il recupero la sistema
          o.log.error({ err, lavoro: id }, "chiusura del lavoro non riuscita");
          return;
        }
        o.log.warn({ err, lavoro: id, tentativo: tentativo + 1 }, "chiusura del lavoro non riuscita: riprovo");
        await new Promise(r => setTimeout(r, ATTESE_CHIUSURA_MS[tentativo]));
      }
    }
  }

  /** Arresto: il lavoro torna in coda senza consumare il tentativo. */
  async function rimetti(id: string): Promise<void> {
    try {
      if (await coda.rimettiInCoda(id, o.chi)) o.log.info({ lavoro: id }, "arresto: lavoro rimesso in coda");
      else o.log.warn({ lavoro: id }, "arresto: lavoro non rimesso in coda, non è più di questo processo");
    } catch (err) {
      // il lease scade e il recupero lo rimette in coda (consumando il tentativo)
      o.log.error({ err, lavoro: id }, "arresto: lavoro non rimesso in coda");
    }
  }

  function parti(l: Lavoro): void {
    const voce = { lavoro: l, controller: new AbortController() } as InCorso;
    occupati[l.corsia]++;
    // il gestore scrive come chi ha lanciato il lavoro (cerbero.attore, PR 2.9);
    // un lavoro accodato da Argos resta di Argos anche nella coda
    const via = l.via?.startsWith("argos") ? `${l.via}:coda:${l.tipo}` : `coda:${l.tipo}`;
    voce.fine = contestoDb.run(
      { attore: l.utente_id ?? "", via, richiesta: `lavoro:${l.id}` },
      () => esegui(l, voce.controller),
    ).finally(() => {
      inCorso.delete(l.id);
      occupati[l.corsia]--;
      if (!fermando) void giro();
    });
    inCorso.set(l.id, voce);
  }

  /** Un giro della coda alla volta; ferma() aspetta quello in corso. */
  function giro(): Promise<void> {
    if (fermando) return Promise.resolve();
    // il giro è del sistema: può partire dalla fine di un lavoro e non deve ereditarne l'utente
    if (!giroCorrente) giroCorrente = inSistema("coda", unGiro).finally(() => { giroCorrente = null; });
    return giroCorrente;
  }

  async function unGiro(): Promise<void> {
    try {
      const adesso = Date.now();
      if (adesso - ultimoRecupero >= recuperoMs) {
        ultimoRecupero = adesso;
        const r = await coda.recuperaScaduti();
        if (r.length) o.log.warn({ lavori: r }, "lavori abbandonati da un processo fermo: rimessi in coda o chiusi");
        const senzaAttesa = coda.fermaAbbandonati ? await coda.fermaAbbandonati() : [];
        if (senzaAttesa.length) o.log.warn({ lavori: senzaAttesa }, "calcoli sincroni che nessuno aspetta più: fermati");
      }
      if (adesso - ultimaPulizia >= puliziaMs) {
        ultimaPulizia = adesso;
        const p = await coda.pulisci();
        if (p.svuotati || p.cancellati) o.log.info(p, "coda dei lavori: pulizia");
      }
      if (o.puoPrendere && !o.puoPrendere()) return;
      for (const corsia of ["veloce", "lunga"] as const) {
        while (!fermando && occupati[corsia] < o.slot[corsia]) {
          const l = await coda.prendi(corsia, o.chi, noti);
          if (!l) break;
          if (fermando) {
            // l'arresto è arrivato mentre lo prendevamo: torna subito in coda
            await rimetti(l.id);
            break;
          }
          o.log.info({ lavoro: l.id, tipo: l.tipo, corsia, tentativo: l.tentativi }, "lavoro preso");
          parti(l);
        }
      }
    } catch (err) {
      o.log.warn({ err }, "giro della coda dei lavori non riuscito: riprovo");
    }
  }

  return {
    avvia(): void {
      if (timer) return;
      fermando = false;
      timer = setInterval(() => void giro(), pollingMs);
      timer.unref?.();
      void giro();
    },
    /** Arresto ordinato: aspetta al massimo `attesaMs`, poi ferma e rimette in coda. */
    async ferma(attesaMs: number): Promise<void> {
      fermando = true;
      if (timer) { clearInterval(timer); timer = null; }
      const fine = Date.now() + attesaMs;
      if (giroCorrente) await giroCorrente;
      while (inCorso.size && Date.now() < fine) await new Promise(r => setTimeout(r, 200));
      // i lavori ancora in corso: stop con il motivo «arresto» (si rimettono in coda)
      for (const v of inCorso.values()) if (!v.controller.signal.aborted) v.controller.abort("arresto" satisfies MotivoStop);
      await Promise.all([...inCorso.values()].map(v => v.fine));
    },
    inCorso: () => inCorso.size,
    /** solo per i test */
    _giro: giro,
  };
}
