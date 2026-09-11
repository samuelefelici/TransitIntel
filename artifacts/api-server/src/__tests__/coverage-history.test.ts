/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Copertura del monitoraggio — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questi numeri finiscono in due posti dove sbagliare costa: sotto ogni altro
 * numero del prodotto, a dire quanto ci si può fidare; e in una richiesta a un
 * fornitore, dove una stima gonfiata si ritorce contro chi l'ha portata.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  capacitaDiMisura, scalaIntervalli, quadroCopertura,
  RAGGIO_M, VELOCITA_MS,
  type GiornataOsservata,
} from "../lib/coverage-history";

/** Una giornata qualunque, poi modificata caso per caso. */
function giorno(day: string, over: Partial<GiornataOsservata> = {}): GiornataOsservata {
  return {
    day, vetture: 368, vettureConPosizione: 33,
    corseProgrammate: 1000, corseConTransito: 90,
    transiti: 340, fermateProgrammate: 1000,
    passoLettureSec: 30,
    ...over,
  };
}

describe("cosa si riesce a misurare a un dato intervallo", () => {
  /* Il conto che va in mano al fornitore: a 60 secondi il mezzo percorre mezzo
   * chilometro fra due letture, e ne bastano 120 per attraversare una fermata. */
  it("lega l'intervallo ai metri percorsi fra due letture", () => {
    expect(capacitaDiMisura(60).passoMetri).toBe(500);
    expect(capacitaDiMisura(30).passoMetri).toBe(250);
    expect(capacitaDiMisura(15).passoMetri).toBe(125);
  });

  it("a 60 secondi meno di un passaggio su quattro è riconoscibile senza sosta", () => {
    const c = capacitaDiMisura(60);
    expect(c.quotaMinima).toBeLessThan(0.3);
    expect(c.quotaMinima).toBeGreaterThan(0.2);
  });

  /* Sotto la finestra utile il riconoscimento è certo: il conto non deve
   * restituire probabilità sopra 1, che sarebbero una promessa assurda. */
  it("a intervalli fitti il riconoscimento è certo e non supera il 100%", () => {
    expect(capacitaDiMisura(10).quotaMinima).toBe(1);
    expect(capacitaDiMisura(1).quotaMinima).toBe(1);
  });

  it("dimezzare l'intervallo raddoppia i passaggi riconoscibili, finché non satura", () => {
    expect(capacitaDiMisura(60).quotaMinima * 2)
      .toBeCloseTo(capacitaDiMisura(30).quotaMinima, 2);
  });

  it("la finestra utile è il diametro diviso la velocità", () => {
    /* 120 m a 8,33 m/s = 14,4 s; su 30 s è il 48%. */
    const atteso = (2 * RAGGIO_M) / VELOCITA_MS / 30;
    expect(capacitaDiMisura(30).quotaMinima).toBeCloseTo(atteso, 2);
  });

  it("la scala degli intervalli è ordinata e monotona: serve a confrontare", () => {
    const s = scalaIntervalli();
    expect(s.map(x => x.intervalloSec)).toEqual([10, 15, 30, 60, 120, 300]);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].quotaMinima).toBeLessThanOrEqual(s[i - 1].quotaMinima);
    }
  });

  it("il testo cambia con l'ordine di grandezza, non è una frase sola", () => {
    expect(capacitaDiMisura(10).cosaComporta).toMatch(/ogni passaggio/i);
    expect(capacitaDiMisura(300).cosaComporta).toMatch(/campione casuale/i);
  });
});

describe("quadro della copertura", () => {
  const settimana = ["01", "02", "03", "04", "05", "06", "07"]
    .map(d => giorno(`2026-09-${d}`));

  it("calcola la quota di corse viste e di fermate rilevate", () => {
    const q = quadroCopertura(settimana, 30);
    expect(q.quotaCorseMediana).toBe(0.09);
    expect(q.quotaFermateMediana).toBe(0.34);
    expect(q.giorni).toHaveLength(7);
  });

  it("ordina le giornate, comunque arrivino", () => {
    const q = quadroCopertura([...settimana].reverse(), 30);
    expect(q.giorni[0].day).toBe("2026-09-01");
    expect(q.giorni[6].day).toBe("2026-09-07");
  });

  /* L'intervallo che conta è quello che il fornitore usa davvero, non quello
   * che abbiamo scritto nella configurazione. */
  it("usa il passo misurato sulle letture, non quello configurato", () => {
    const q = quadroCopertura(settimana.map(g => ({ ...g, passoLettureSec: 120 })), 30);
    expect(q.capacitaAttuale?.intervalloSec).toBe(120);
    expect(q.passoLettureMedianoSec).toBe(120);
  });

  it("senza letture misurate ripiega su quello configurato", () => {
    const q = quadroCopertura(settimana.map(g => ({ ...g, passoLettureSec: null })), 45);
    expect(q.capacitaAttuale?.intervalloSec).toBe(45);
  });

  /* Il margine sopra la stima geometrica è l'unica traccia quantitativa che
   * abbiamo delle fermate davvero servite: se sparisse, sparirebbe la sola
   * risposta che possiamo dare a «quante fermate fa». */
  it("riconosce nelle soste il di più rispetto alla sola geometria", () => {
    /* 70% di fermate rilevate contro il 48% che la geometria da sola
     * consentirebbe: la differenza sono i mezzi che si fermano davvero. */
    const conSoste = settimana.map(g => ({ ...g, transiti: 700 }));
    const q = quadroCopertura(conSoste, 30);
    expect(q.margineDaSoste).toBeGreaterThan(0.2);
    expect(q.nota).toMatch(/soste/i);
  });

  /* Il caso VERO di oggi, e la conclusione che ne discende: con 34 fermate
   * rilevate su 100 e letture ogni 30 s, siamo SOTTO quello che l'intervallo
   * consentirebbe. Non è il refresh a limitarci — sono le vetture seguite.
   * Confondere le due cose farebbe chiedere al fornitore la cosa sbagliata. */
  it("sotto la soglia geometrica dice che il limite non è l'intervallo", () => {
    const q = quadroCopertura(settimana, 30);   // 34% rilevate, 48% possibile
    expect(q.margineDaSoste).toBeLessThan(0);
    expect(q.nota).toMatch(/quante vetture vengono seguite/i);
    expect(q.nota).not.toMatch(/soste/i);
  });
});

describe("andamento nel tempo", () => {
  const serie = (quote: number[]) =>
    quote.map((c, i) => giorno(`2026-09-${String(i + 1).padStart(2, "0")}`,
      { corseConTransito: Math.round(c * 1000) }));

  it("riconosce un miglioramento netto", () => {
    const q = quadroCopertura(serie([0.05, 0.05, 0.06, 0.05, 0.12, 0.13, 0.12, 0.14]), 30);
    expect(q.andamento).toBe("in_miglioramento");
  });

  it("riconosce un peggioramento netto", () => {
    const q = quadroCopertura(serie([0.20, 0.21, 0.19, 0.20, 0.08, 0.07, 0.08, 0.09]), 30);
    expect(q.andamento).toBe("in_peggioramento");
  });

  it("una fluttuazione modesta resta stabile: non è una tendenza", () => {
    const q = quadroCopertura(serie([0.10, 0.11, 0.09, 0.10, 0.11, 0.10, 0.09, 0.11]), 30);
    expect(q.andamento).toBe("stabile");
  });

  /* Due giorni buoni dopo due cattivi non sono una tendenza, e annunciarli
   * come tale fa festeggiare miglioramenti che non esistono. */
  it("con poche giornate non si pronuncia", () => {
    const q = quadroCopertura(serie([0.05, 0.05, 0.15, 0.16]), 30);
    expect(q.andamento).toBe("indeterminato");
  });
});

describe("casi in cui non si può rispondere", () => {
  it("su periodo vuoto non inventa una copertura", () => {
    const q = quadroCopertura([], 30);
    expect(q.giorni).toHaveLength(0);
    expect(q.quotaCorseMediana).toBeNull();
    expect(q.nota).toMatch(/nessuna giornata/i);
  });

  it("senza corse programmate lo dice invece di dividere per zero", () => {
    const q = quadroCopertura(
      [giorno("2026-09-01", { corseProgrammate: null })], 30);
    expect(q.giorni[0].quotaCorse).toBeNull();
    expect(q.quotaCorseMediana).toBeNull();
    expect(q.nota).toMatch(/non si sa quante corse/i);
  });

  it("una giornata senza fermate programmate non produce una quota finta", () => {
    const q = quadroCopertura(
      [giorno("2026-09-01", { fermateProgrammate: 0, transiti: 0 })], 30);
    expect(q.giorni[0].quotaFermate).toBeNull();
  });
});
