/* Il gestore dei lavori Python (lib/lavori/gestori.ts): l'esito del lavoro
 * dall'uscita del processo. Il caso nuovo è il tempo massimo: uno script che
 * al SIGINT chiude in ordine (codice 0, JSON valido) e dichiara
 * `interrupted: true` (crew_scheduler_v4.py) consegna la soluzione migliore
 * trovata fin lì, e il lavoro è «completato» con un avviso. Senza quella
 * dichiarazione il timeout resta «fallito, scaduto», come prima. */
import { describe, it, expect } from "vitest";
import { esitoDaUscita } from "../lib/lavori/gestori";
import type { EsitoProcesso } from "../lib/lavori/python";

const uscita = (o: Partial<EsitoProcesso>): EsitoProcesso =>
  ({ codice: 0, segnaleUscita: null, motivo: "uscito", stdout: "", stderrTesta: "", stderrCoda: "", ...o });
const L = { timeout_sec: 3600 };
const SCADUTO = { stato: "fallito", errore: "Tempo massimo superato (60 min)", erroreTipo: "scaduto" };

describe("il tempo massimo", () => {
  it("JSON valido con interrupted: true → completato, con l'avviso nel risultato e nell'avanzamento", () => {
    const dati = { driverShifts: [{ id: 1 }], summary: { totalDriverShifts: 1 }, interrupted: true };
    const r = esitoDaUscita(uscita({ motivo: "timeout", stdout: JSON.stringify(dati) }), L, 42);
    const avviso = "Tempo massimo superato (60 min): risultato parziale, la soluzione migliore trovata fino allo stop";
    expect(r.avviso).toBe(avviso);
    expect(r.esito).toEqual({
      stato: "completato",
      risultato: { ...dati, avvisoLavoro: avviso },
      avanzamento: { phase: "done", percentage: 100, detail: avviso, timestamp: 42 },
    });
  });

  it("senza la dichiarazione dello script, o con un'uscita non ordinata: fallito, scaduto, come prima", () => {
    const casi: Array<[string, Partial<EsitoProcesso>]> = [
      ["interrupted assente", { stdout: JSON.stringify({ driverShifts: [] }) }],
      ["interrupted falso", { stdout: JSON.stringify({ driverShifts: [], interrupted: false }) }],
      ["interrupted non booleano", { stdout: JSON.stringify({ interrupted: "true" }) }],
      ["JSON spezzato dal SIGKILL", { stdout: '{"driverShifts": [' }],
      ["stdout vuoto", { stdout: "" }],
      ["un JSON che non è un oggetto", { stdout: "true" }],
      ["ucciso dal SIGKILL", { codice: null, segnaleUscita: "SIGKILL", stdout: JSON.stringify({ interrupted: true }) }],
      ["uscito con errore", { codice: 1, stdout: JSON.stringify({ interrupted: true }) }],
    ];
    for (const [nome, o] of casi) {
      const r = esitoDaUscita(uscita({ motivo: "timeout", ...o }), L);
      expect(r.esito, nome).toEqual(SCADUTO);
      expect(r.avviso, nome).toBeUndefined();
    }
  });
});

describe("gli altri esiti non cambiano", () => {
  it("avvio, stop, tetto, codice d'uscita, JSON non valido, uscita normale", () => {
    expect(esitoDaUscita(uscita({ motivo: "avvio", codice: null, erroreAvvio: "ENOENT" }), L).esito)
      .toEqual({ stato: "fallito", errore: "Errore avvio Python: ENOENT", erroreTipo: "sistema" });
    // lo stop dell'utente resta «fermato» anche se lo script chiude in ordine con un JSON valido
    expect(esitoDaUscita(uscita({ motivo: "fermato", stdout: JSON.stringify({ interrupted: true }) }), L).esito)
      .toEqual({ stato: "fermato" });
    expect(esitoDaUscita(uscita({ motivo: "tetto", codice: null, segnaleUscita: "SIGKILL" }), L).esito)
      .toEqual({ stato: "fallito", errore: "Uscita del calcolo troppo grande", erroreTipo: "sistema" });
    expect(esitoDaUscita(uscita({ codice: 2 }), L).esito)
      .toEqual({ stato: "fallito", errore: "Python exit code 2", erroreTipo: "calcolo" });
    expect(esitoDaUscita(uscita({ stdout: "non json" }), L).esito)
      .toEqual({ stato: "fallito", errore: "Errore parsing output JSON", erroreTipo: "calcolo" });
    const r = esitoDaUscita(uscita({ stdout: '{"driverShifts":[],"interrupted":false}' }), L);
    expect(r.esito).toEqual({ stato: "completato", risultato: { driverShifts: [], interrupted: false } });
    expect(r.avviso).toBeUndefined();
  });
});
