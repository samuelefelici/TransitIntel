/**
 * L'esecutore dei lavori: prende dalla coda (lib/lavori/coda.ts), esegue con
 * il gestore del tipo, batte, chiude. Gira nel lavoratore (src/lavoratore.ts)
 * e, con CERBERO_LAVORATORE_INTERNO=1, dentro l'API.
 *
 * - Slot separati per corsia: un calcolo lungo non ferma i brevi.
 * - Ogni 2 s guarda la coda; ogni 30 s rimette in coda i lavori abbandonati da
 *   un processo morto; ogni ora fa la pulizia (conservazione).
 * - Il battito (ogni 5 s, o prima se c'è un avanzamento nuovo, al massimo una
 *   volta al secondo) rinnova il lease e legge lo stop.
 * - Arresto ordinato (deploy): non prende più lavori, aspetta un poco quelli
 *   in corso, poi li ferma e li rimette in coda senza consumare il tentativo.
 */
import type { Corsia, Esito, Lavoro } from "./coda";
import * as codaReale from "./coda";
import type { Progresso } from "./python";

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface ContestoLavoro {
  /** abort: stop chiesto, arresto o lease perso (il motivo è in segnale.reason) */
  segnale: AbortSignal;
  progresso: (p: Progresso) => void;
  log: Log;
}

export interface Gestore {
  tipo: Lavoro["tipo"];
  versione: number;
  esegui: (lavoro: Lavoro, ctx: ContestoLavoro) => Promise<Exclude<Esito, { stato: "fermato" }> | { stato: "fermato" }>;
}

export type Coda = Pick<typeof codaReale, "prendi" | "battito" | "chiudi" | "rimettiInCoda" | "recuperaScaduti" | "pulisci">;

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
  let giroInCorso = false;
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
      esito = await g.esegui(l, { segnale: controller.signal, progresso: (p) => { progressoNuovo = p; }, log });
    } catch (err: any) {
      log.error({ err, lavoro: l.id }, "lavoro finito con un errore del sistema");
      esito = { stato: "fallito", errore: `Errore interno: ${err?.message ?? err}`, erroreTipo: "sistema" };
    } finally {
      clearInterval(orologio);
    }
    const motivo = controller.signal.aborted ? (controller.signal.reason as MotivoStop) : null;
    try {
      if (motivo === "lease") {
        log.warn({ lavoro: l.id }, "lavoro non più di questo processo (lease scaduto): risultato scartato");
      } else if (motivo === "arresto") {
        await coda.rimettiInCoda(l.id, o.chi);
        log.info({ lavoro: l.id }, "arresto: lavoro rimesso in coda");
      } else if (motivo === "annulla") {
        await coda.chiudi(l.id, o.chi, { stato: "fermato" });
      } else {
        await coda.chiudi(l.id, o.chi, esito.stato === "fermato" ? { stato: "fermato" } : esito);
      }
    } catch (err) {
      // la riga resta «in corso»: il lease scade e il recupero la sistema
      log.error({ err, lavoro: l.id }, "chiusura del lavoro non riuscita");
    }
  }

  function parti(l: Lavoro): void {
    const voce = { lavoro: l, controller: new AbortController() } as InCorso;
    occupati[l.corsia]++;
    voce.fine = esegui(l, voce.controller).finally(() => {
      inCorso.delete(l.id);
      occupati[l.corsia]--;
      if (!fermando) void giro();
    });
    inCorso.set(l.id, voce);
  }

  async function giro(): Promise<void> {
    if (fermando || giroInCorso) return;
    giroInCorso = true;
    try {
      const adesso = Date.now();
      if (adesso - ultimoRecupero >= recuperoMs) {
        ultimoRecupero = adesso;
        const r = await coda.recuperaScaduti();
        if (r.length) o.log.warn({ lavori: r }, "lavori abbandonati da un processo fermo: rimessi in coda o chiusi");
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
          o.log.info({ lavoro: l.id, tipo: l.tipo, corsia, tentativo: l.tentativi }, "lavoro preso");
          parti(l);
        }
      }
    } catch (err) {
      o.log.warn({ err }, "giro della coda dei lavori non riuscito: riprovo");
    } finally {
      giroInCorso = false;
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
