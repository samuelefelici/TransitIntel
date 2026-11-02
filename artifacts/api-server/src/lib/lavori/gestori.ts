/**
 * I gestori dei tipi di lavoro che sanno eseguire sia il lavoratore sia
 * l'esecutore interno dell'API. Niente rotte, niente auth: solo il lanciatore.
 *
 * python v1: richiesta { script, argv, ingresso } → risultato = lo stdout JSON
 * dello script. Lo script deve essere nell'elenco (lib/lavori/python.ts):
 * una riga manomessa non lancia codice arbitrario.
 *
 * Il tempo massimo: il lanciatore manda SIGINT, poi SIGKILL dopo 5 s. Uno
 * script che a quel SIGINT chiude in ordine (codice 0, JSON valido) e lo
 * dichiara con `interrupted: true` (oggi crew_scheduler_v4.py) consegna la
 * soluzione migliore trovata fin lì: il lavoro è «completato» con un avviso
 * (`avvisoLavoro` nel risultato, l'avanzamento, il log), non «fallito,
 * scaduto». Senza quella dichiarazione il timeout resta un fallimento.
 */
import type { Esito, Lavoro } from "./coda";
import type { Gestore } from "./esecutore";
import { eseguiPython, jsonDallUscita, scriptConsentito, type EsitoProcesso } from "./python";

/** L'esito del lavoro dall'uscita del processo; `avviso` va anche nel log. */
export function esitoDaUscita(esito: EsitoProcesso, l: Pick<Lavoro, "timeout_sec">, adesso: number = Date.now()): { esito: Esito; avviso?: string } {
  const minuti = Math.round(l.timeout_sec / 60);
  switch (esito.motivo) {
    case "avvio": return { esito: { stato: "fallito", errore: `Errore avvio Python: ${esito.erroreAvvio}`, erroreTipo: "sistema" } };
    case "fermato": return { esito: { stato: "fermato" } };
    case "timeout": {
      const scaduto: Esito = { stato: "fallito", errore: `Tempo massimo superato (${minuti} min)`, erroreTipo: "scaduto" };
      if (esito.codice !== 0) return { esito: scaduto };
      const j = jsonDallUscita(esito);
      if (!j.ok || !j.valore || typeof j.valore !== "object" || j.valore.interrupted !== true) return { esito: scaduto };
      const avviso = `Tempo massimo superato (${minuti} min): risultato parziale, la soluzione migliore trovata fino allo stop`;
      return {
        esito: {
          stato: "completato",
          risultato: { ...j.valore, avvisoLavoro: avviso },
          avanzamento: { phase: "done", percentage: 100, detail: avviso, timestamp: adesso },
        },
        avviso,
      };
    }
    case "tetto": return { esito: { stato: "fallito", errore: "Uscita del calcolo troppo grande", erroreTipo: "sistema" } };
  }
  if (esito.codice !== 0) return { esito: { stato: "fallito", errore: `Python exit code ${esito.codice ?? esito.segnaleUscita}`, erroreTipo: "calcolo" } };
  const j = jsonDallUscita(esito);
  if (!j.ok) return { esito: { stato: "fallito", errore: "Errore parsing output JSON", erroreTipo: "calcolo" } };
  return { esito: { stato: "completato", risultato: j.valore } };
}

export const gestorePython: Gestore = {
  tipo: "python",
  versione: 1,
  async esegui(l, ctx) {
    const { script, argv, ingresso } = (l.richiesta ?? {}) as { script?: unknown; argv?: unknown; ingresso?: unknown };
    if (!scriptConsentito(script)) return { stato: "fallito", errore: "Script non consentito", erroreTipo: "sistema" };
    const argomenti = Array.isArray(argv) ? argv.map(String) : [];
    const uscita = await eseguiPython({
      script, argv: argomenti, ingresso,
      timeoutMs: l.timeout_sec * 1000,
      segnale: ctx.segnale,
      suProgresso: ctx.progresso,
      suRigaStderr: (r) => ctx.log.info(`[lavoro ${l.id.slice(0, 8)}] ${r}`),
    });
    const { esito, avviso } = esitoDaUscita(uscita, l);
    if (avviso) ctx.log.warn({ lavoro: l.id, script }, avviso);
    return esito;
  },
};

export const GESTORI = [gestorePython];
