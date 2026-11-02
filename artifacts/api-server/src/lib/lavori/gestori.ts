/**
 * I gestori dei tipi di lavoro che sanno eseguire sia il lavoratore sia
 * l'esecutore interno dell'API. Niente rotte, niente auth: solo il lanciatore.
 *
 * python v1: richiesta { script, argv, ingresso } → risultato = lo stdout JSON
 * dello script. Lo script deve essere nell'elenco (lib/lavori/python.ts):
 * una riga manomessa non lancia codice arbitrario.
 */
import type { Gestore } from "./esecutore";
import { eseguiPython, jsonDallUscita, scriptConsentito } from "./python";

export const gestorePython: Gestore = {
  tipo: "python",
  versione: 1,
  async esegui(l, ctx) {
    const { script, argv, ingresso } = (l.richiesta ?? {}) as { script?: unknown; argv?: unknown; ingresso?: unknown };
    if (!scriptConsentito(script)) return { stato: "fallito", errore: "Script non consentito", erroreTipo: "sistema" };
    const argomenti = Array.isArray(argv) ? argv.map(String) : [];
    const esito = await eseguiPython({
      script, argv: argomenti, ingresso,
      timeoutMs: l.timeout_sec * 1000,
      segnale: ctx.segnale,
      suProgresso: ctx.progresso,
      suRigaStderr: (r) => ctx.log.info(`[lavoro ${l.id.slice(0, 8)}] ${r}`),
    });
    switch (esito.motivo) {
      case "avvio": return { stato: "fallito", errore: `Errore avvio Python: ${esito.erroreAvvio}`, erroreTipo: "sistema" };
      case "fermato": return { stato: "fermato" };
      case "timeout": return { stato: "fallito", errore: `Tempo massimo superato (${Math.round(l.timeout_sec / 60)} min)`, erroreTipo: "scaduto" };
      case "tetto": return { stato: "fallito", errore: "Uscita del calcolo troppo grande", erroreTipo: "sistema" };
    }
    if (esito.codice !== 0) return { stato: "fallito", errore: `Python exit code ${esito.codice ?? esito.segnaleUscita}`, erroreTipo: "calcolo" };
    const j = jsonDallUscita(esito);
    if (!j.ok) return { stato: "fallito", errore: "Errore parsing output JSON", erroreTipo: "calcolo" };
    return { stato: "completato", risultato: j.valore };
  },
};

export const GESTORI = [gestorePython];
