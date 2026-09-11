/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Il parco nel tempo — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questo elenco manda qualcuno a cercare un guasto. Dire "persa" di una
 * vettura che era semplicemente a riposo fa perdere un giro all'officina;
 * non dire niente di una che ha smesso ieri la lascia in fondo alla lista,
 * dietro a quelle mute da mesi, che è dove è rimasta finora.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  andamentoParco, giornateDelPeriodo,
  type PresenzaVettura,
} from "../lib/fleet-trend";

/** Dieci giornate consecutive: cinque nella prima metà, cinque nella seconda. */
const PERIODO = giornateDelPeriodo("2026-09-01", "2026-09-10");
const PRIMA = PERIODO.slice(0, 5);
const DOPO = PERIODO.slice(5);

const v = (vehicleRef: string, giorni: string[]): PresenzaVettura => ({ vehicleRef, giorni });

describe("elenco delle giornate", () => {
  it("copre gli estremi compresi", () => {
    expect(PERIODO).toHaveLength(10);
    expect(PERIODO[0]).toBe("2026-09-01");
    expect(PERIODO[9]).toBe("2026-09-10");
  });

  it("attraversa il cambio di mese senza saltare giorni", () => {
    const g = giornateDelPeriodo("2026-08-30", "2026-09-02");
    expect(g).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });

  /* Un periodo rovesciato o malformato non deve produrre un ciclo infinito. */
  it("su un periodo rovesciato non si inventa giornate", () => {
    expect(giornateDelPeriodo("2026-09-10", "2026-09-01")).toEqual([]);
    expect(giornateDelPeriodo("boh", "2026-09-01")).toEqual([]);
  });
});

describe("che cosa è cambiato nel parco", () => {
  it("riconosce una vettura che trasmetteva e ha smesso", () => {
    const a = andamentoParco([v("433", PRIMA)], PERIODO);
    expect(a.perse.map(x => x.vehicleRef)).toEqual(["433"]);
    expect(a.perse[0].secondaMeta).toBe(0);
    expect(a.nota).toMatch(/ha smesso/);
  });

  it("riconosce una vettura che ha ripreso: è la prova che l'intervento è servito", () => {
    const a = andamentoParco([v("402", DOPO)], PERIODO);
    expect(a.riprese.map(x => x.vehicleRef)).toEqual(["402"]);
    expect(a.riprese[0].primaMeta).toBe(0);
    expect(a.nota).toMatch(/ripreso/);
  });

  it("una vettura presente tutti i giorni è stabile, non una novità", () => {
    const a = andamentoParco([v("268", PERIODO)], PERIODO);
    expect(a.stabili).toBe(1);
    expect(a.perse).toHaveLength(0);
    expect(a.riprese).toHaveLength(0);
  });

  /* Un mezzo di scorta trasmette a sprazzi: non è guasto, e mandare qualcuno
   * a cercarne il guasto è un giro a vuoto. */
  it("una presenza a sprazzi non viene dichiarata persa", () => {
    const saltuaria = [PERIODO[0], PERIODO[3], PERIODO[7]];
    const a = andamentoParco([v("310", saltuaria)], PERIODO);
    expect(a.saltuarie).toBe(1);
    expect(a.perse).toHaveLength(0);
  });

  /* Il caso che la prima versione di questo modulo lasciava sfuggire: una
   * vettura che smette poco DOPO la metà del periodo ha una presenza nella
   * seconda metà, e con la regola "assente in tutta la seconda metà" finiva
   * fra le saltuarie — cioè nascosta, proprio mentre è il guasto più fresco. */
  it("riconosce chi ha smesso subito DOPO la metà del periodo", () => {
    const a = andamentoParco([v("450", [...PRIMA, PERIODO[5]])], PERIODO);
    expect(a.perse.map(x => x.vehicleRef)).toEqual(["450"]);
    expect(a.perse[0].secondaMeta).toBe(1);
    expect(a.perse[0].giorniDiSilenzio).toBe(4);
  });

  it("un'assenza di pochi giorni in fondo non basta a dirla persa", () => {
    /* Assente solo negli ultimi due giorni: può essere in sosta. */
    const a = andamentoParco([v("278", PERIODO.slice(0, 8))], PERIODO);
    expect(a.perse).toHaveLength(0);
    expect(a.stabili).toBe(1);
  });
});

describe("ordine dell'elenco", () => {
  /* Una muta da mesi è in elenco da mesi; quella che ha smesso ieri è la
   * novità, e finora finiva in fondo perché ordinata per tempo di fermo. */
  it("mette per prima la vettura persa più di recente", () => {
    const a = andamentoParco([
      v("433", PRIMA.slice(0, 2)),          // sparita presto
      v("450", [...PRIMA, PERIODO[5]]),     // sparita quasi subito dopo la metà
    ], PERIODO);
    expect(a.perse.map(x => x.vehicleRef)).toEqual(["450", "433"]);
    expect(a.perse[0].giorniDiSilenzio).toBeLessThan(a.perse[1].giorniDiSilenzio);
  });

  it("misura il silenzio dalla fine del periodo, non da oggi", () => {
    const a = andamentoParco([v("433", [PERIODO[0]])], PERIODO);
    expect(a.perse[0].giorniDiSilenzio).toBe(9);
    expect(a.perse[0].ultimoGiorno).toBe("2026-09-01");
  });
});

describe("il saldo", () => {
  /* Il numero che conta: riparare sei mezzi mentre se ne rompono otto non è
   * un miglioramento, e guardando solo le riprese sembrerebbe di sì. */
  it("dice se il parco seguito cresce o cala, non solo quante riparazioni", () => {
    const a = andamentoParco([
      v("1", PRIMA), v("2", PRIMA), v("3", PRIMA),   // tre perse
      v("4", DOPO),                                   // una ripresa
      v("5", PERIODO),
    ], PERIODO);
    expect(a.perse).toHaveLength(3);
    expect(a.riprese).toHaveLength(1);
    expect(a.variazioneNette).toBe(-2);
    expect(a.nota).toMatch(/si perde terreno/i);
  });

  it("quando si guadagna lo dice, e dice perché conta", () => {
    const a = andamentoParco([
      v("1", DOPO), v("2", DOPO), v("3", PRIMA), v("4", PERIODO),
    ], PERIODO);
    expect(a.variazioneNette).toBe(1);
    expect(a.nota).toMatch(/cresciuto/);
  });

  it("in pari lo dice invece di tacere", () => {
    const a = andamentoParco([v("1", PRIMA), v("2", DOPO)], PERIODO);
    expect(a.variazioneNette).toBe(0);
    expect(a.nota).toMatch(/in pari/i);
  });

  it("senza cambiamenti non inventa una notizia", () => {
    const a = andamentoParco([v("1", PERIODO), v("2", PERIODO)], PERIODO);
    expect(a.nota).toMatch(/lo stesso di prima/);
  });
});

describe("casi in cui non si può rispondere", () => {
  it("su un periodo troppo corto non confronta", () => {
    const a = andamentoParco([v("1", ["2026-09-01"])], giornateDelPeriodo("2026-09-01", "2026-09-02"));
    expect(a.perse).toHaveLength(0);
    expect(a.nota).toMatch(/troppo corto/i);
  });

  it("senza vetture lo dice invece di restituire zeri", () => {
    const a = andamentoParco([], PERIODO);
    expect(a.vetture).toBe(0);
    expect(a.nota).toMatch(/nessuna vettura/i);
  });
});
