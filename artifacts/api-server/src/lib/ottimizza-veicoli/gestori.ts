/**
 * I gestori dei calcoli dei turni macchina in coda, per il lavoratore (e per
 * l'esecutore interno dell'API).
 *
 * ottimizza_veicoli v1: richiesta { mode, feedId, corpo } → la risposta di
 * POST /service-program/cpsat o /vcsp. Un 200 è «completato» con la risposta
 * come risultato; un altro codice è «fallito» e porta con sé codice e corpo,
 * che la facciata sincrona ripete com'è (400, 422, 500). Lo stop è «fermato»,
 * il tempo massimo «fallito, scaduto».
 *
 * giro_agente v1: richiesta { mode, feedId, corpo, params, salvataggio } → il
 * calcolo e il salvataggio dello scenario (salvaGiro, in una transazione); il
 * risultato in coda è piccolo: { scenarioId, dssId, scenarioName }. L'esito
 * per Argos sta in agent_optimize_jobs, che il gestore aggiorna anche quando
 * il giro finisce male.
 *
 * Il feed arriva già risolto e controllato dalla rotta: qui non si guarda chi
 * è l'utente, e non si fa DDL.
 */
import type { Gestore } from "../lavori/esecutore";
import type { Progresso } from "../lavori/python";
import { eseguiOttimizzazione, type ModoVeicoli } from "./esegui";
import { eseguiGiro, scriviGiro, type RichiestaGiro } from "./giro";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modoValido = (m: unknown): m is ModoVeicoli => m === "cpsat" || m === "vcsp";
const tempoMassimo = (timeoutSec: number) => `Tempo massimo superato (${Math.round(timeoutSec / 60)} min)`;

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

/** Il log del lavoro: con pino un figlio che porta l'id, altrimenti il log com'è. */
function logDelLavoro(base: Log, id: string): Log {
  const figlio = (base as any).child?.({ lavoro: id });
  return figlio ?? base;
}

export const gestoreOttimizzaVeicoli: Gestore = {
  tipo: "ottimizza_veicoli",
  versione: 1,
  async esegui(l, ctx) {
    const { mode, feedId, corpo } = (l.richiesta ?? {}) as { mode?: unknown; feedId?: unknown; corpo?: unknown };
    if (!modoValido(mode) || typeof feedId !== "string" || !UUID.test(feedId)) {
      return { stato: "fallito", errore: "Richiesta del calcolo non valida", erroreTipo: "sistema" };
    }
    const r = await eseguiOttimizzazione(corpo, {
      mode, feedId, log: logDelLavoro(ctx.log, l.id),
      segnale: ctx.segnale, progresso: ctx.progresso, scadenza: Date.now() + l.timeout_sec * 1000,
    });
    if (r.motivo === "fermato") return { stato: "fermato" };
    if (r.motivo === "scaduto") {
      const errore = tempoMassimo(l.timeout_sec);
      return { stato: "fallito", errore, erroreTipo: "scaduto", httpCodice: 500, risultato: { error: errore } };
    }
    if (r.codice === 200) return { stato: "completato", risultato: r.corpo, httpCodice: 200 };
    return {
      stato: "fallito", errore: String(r.corpo?.error ?? `Errore HTTP ${r.codice}`).slice(0, 2000),
      erroreTipo: "calcolo", httpCodice: r.codice, risultato: r.corpo,
    };
  },
};

function richiestaGiroValida(r: any): r is RichiestaGiro {
  const s = r?.salvataggio;
  return !!r && modoValido(r.mode) && typeof r.feedId === "string" && UUID.test(r.feedId)
    && !!r.corpo && typeof r.corpo === "object" && !!r.params && typeof r.params === "object"
    && !!s && typeof s.utenteId === "string" && UUID.test(s.utenteId)
    && typeof s.psProjectId === "string" && UUID.test(s.psProjectId)
    && typeof s.rawDate === "string" && typeof s.psName === "string" && Number.isFinite(s.creatoIl);
}

export const gestoreGiro: Gestore = {
  tipo: "giro_agente",
  versione: 1,
  async esegui(l, ctx) {
    const r = l.richiesta;
    if (!richiestaGiroValida(r)) return { stato: "fallito", errore: "Richiesta del giro non valida", erroreTipo: "sistema" };
    const log = logDelLavoro(ctx.log, l.id);
    const fase = r.mode === "vcsp" ? "VCSP" : "VSP";
    let ultimo: Progresso | null = null;
    /* l'esito per Argos (agent_optimize_jobs) quando il giro non arriva al salvataggio */
    const segna = async (errore: string) => {
      try {
        await scriviGiro({
          id: l.id, userId: r.salvataggio.utenteId, psProjectId: r.salvataggio.psProjectId, mode: r.mode,
          status: "error", createdAt: r.salvataggio.creatoIl, finishedAt: Date.now(),
          progress: ultimo
            ? { phase: ultimo.phase, pct: Math.round(ultimo.percentage), msg: ultimo.detail.trim() }
            : { phase: fase, pct: 0, msg: "Avvio…" },
          params: r.params, error: errore,
        });
      } catch (err) {
        log.warn({ err }, "giro: esito non scritto in agent_optimize_jobs (resta quello della coda)");
      }
    };

    const esito = await eseguiGiro(r, {
      lavoroId: l.id, chi: ctx.chi, log, segnale: ctx.segnale, scadenza: Date.now() + l.timeout_sec * 1000,
      progresso: (p) => { ultimo = p; ctx.progresso(p); },
    });
    switch (esito.stato) {
      case "fatto":
        return {
          stato: "completato",
          risultato: { scenarioId: esito.scenarioId, dssId: esito.dssId, scenarioName: esito.scenarioName },
          avanzamento: { phase: fase, percentage: 100, detail: "Completato", timestamp: Date.now() },
        };
      case "fermato":
        await segna("Giro fermato");
        return { stato: "fermato" };
      case "non-nostro":
        // lease perso: il lavoro è di un altro processo, che scriverà lui l'esito
        if (esito.perche === "annullato") await segna("Giro fermato");
        return { stato: "fermato" };
      case "errore": {
        const errore = esito.scaduto ? tempoMassimo(l.timeout_sec) : esito.errore;
        await segna(errore);
        return {
          stato: "fallito", errore, erroreTipo: esito.scaduto ? "scaduto" : "calcolo",
          ...(esito.codice ? { httpCodice: esito.codice } : {}),
        };
      }
    }
  },
};
