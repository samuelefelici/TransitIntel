/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Analisi delle percorrenze — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Da questi numeri qualcuno sposta un orario vero. Un verdetto sbagliato non
 * si presenta come un guasto: si presenta come una corsa da allargare che non
 * andava allargata, e il ritardo si sposta altrove.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  analizzaPercorrenze, percentile, coperturaFermate,
  type CorsaOsservata,
} from "../lib/runtime-analysis";

/** Classificatore finto: la classe è scritta nella data stessa. */
const feriale = () => ({ key: "scuole_aperte/-/Feriale", label: "Scuole Aperte · Feriale" });

/** Genera N giornate della stessa corsa con la durata data. */
function giornate(
  tripId: string, durate: number[], programmata: number | null, fermate = 10,
): CorsaOsservata[] {
  return durate.map((d, i) => ({
    tripId,
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    durataOsservataSec: d,
    durataProgrammataSec: programmata,
    fermateOsservate: fermate,
  }));
}

describe("percentile", () => {
  it("interpola fra i due valori adiacenti", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20], 0.85)).toBe(18.5);
  });
  it("regge un valore solo e l'elenco vuoto", () => {
    expect(percentile([42], 0.85)).toBe(42);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe("verdetto sul tempo programmato", () => {
  /* Il caso "STRETTO": l'orario concede 20 minuti, il mezzo ne impiega
   * sistematicamente 24-26. L'85% delle corse sfora, quindi l'orario non
   * tiene e va allargato. */
  it("riconosce un orario troppo stretto", () => {
    const r = analizzaPercorrenze(
      giornate("T1", [1440, 1500, 1560, 1470, 1530], 1200), feriale);
    expect(r[0].verdetto).toBe("stretto");
    expect(r[0].scartoP85Sec).toBeGreaterThan(0);
    expect(r[0].correzioneSuggeritaMin).toBeGreaterThan(0);
    expect(r[0].motivo).toMatch(/non concede abbastanza tempo/i);
  });

  /* Il caso "LARGO": l'orario concede 30 minuti, ne bastano 22. */
  it("riconosce un orario troppo largo", () => {
    const r = analizzaPercorrenze(
      giornate("T2", [1320, 1290, 1350, 1310, 1330], 1800), feriale);
    expect(r[0].verdetto).toBe("largo");
    expect(r[0].scartoMedianaSec).toBeLessThan(0);
    expect(r[0].correzioneSuggeritaMin).toBeLessThan(0);
    expect(r[0].motivo).toMatch(/tempo che avanza/i);
  });

  it("non segnala una corsa il cui tempo corrisponde", () => {
    const r = analizzaPercorrenze(
      giornate("T3", [1200, 1210, 1190, 1205, 1195], 1200), feriale);
    expect(r[0].verdetto).toBe("adeguato");
  });

  /* LA SCELTA CHE CONTA: "stretto" si giudica sul percentile alto, non sulla
   * mediana. Qui la mediana sta dentro il programmato — sembrerebbe tutto a
   * posto — ma un terzo delle corse sfora pesantemente: l'orario NON tiene, e
   * tararlo sulla mediana condannerebbe quelle corse al ritardo. */
  it("segnala stretto anche quando la mediana starebbe dentro", () => {
    const r = analizzaPercorrenze(
      giornate("T4", [1180, 1190, 1200, 1560, 1620, 1600], 1200), feriale);
    expect(r[0].medianaSec).toBeLessThanOrEqual(1400);   // mediana quasi in regola
    expect(r[0].verdetto).toBe("stretto");               // ma l'85% no
  });

  /* Simmetricamente: "largo" NON si giudica sul percentile alto, altrimenti
   * una corsa che di norma avanza tempo non verrebbe mai segnalata per via di
   * due giornate con traffico. */
  it("segnala largo anche se qualche giornata sfora", () => {
    const r = analizzaPercorrenze(
      giornate("T5", [1300, 1280, 1320, 1290, 1850], 1800), feriale);
    expect(r[0].verdetto).toBe("largo");
  });

  /* Le soglie sono assolute E relative: senza la prima si segnalerebbe ogni
   * corsa per una manciata di secondi. */
  it("non segnala uno scostamento di pochi secondi", () => {
    const r = analizzaPercorrenze(
      giornate("T6", [1230, 1240, 1220, 1235, 1225], 1200), feriale);
    expect(r[0].verdetto).toBe("adeguato");
  });

  /* ...e senza la seconda, due minuti su un'ora sembrerebbero un problema. */
  it("scala la soglia sulla durata della corsa", () => {
    // 2 minuti su 60 sono il 3%: sotto soglia relativa
    const lunga = analizzaPercorrenze(
      giornate("T7", [3720, 3730, 3710, 3725, 3715], 3600), feriale);
    expect(lunga[0].verdetto).toBe("adeguato");
    // gli stessi 2 minuti su 10 sono il 20%: sopra soglia
    const breve = analizzaPercorrenze(
      giornate("T8", [720, 730, 710, 725, 715], 600), feriale);
    expect(breve[0].verdetto).toBe("stretto");
  });

  it("non emette verdetti su poche giornate", () => {
    const r = analizzaPercorrenze(giornate("T9", [1800, 1850], 1200), feriale);
    expect(r[0].verdetto).toBe("insufficiente");
    expect(r[0].motivo).toMatch(/troppo poco/i);
    expect(r[0].correzioneSuggeritaMin).toBeNull();
  });

  it("non emette verdetti senza durata programmata", () => {
    const r = analizzaPercorrenze(giornate("TA", [1200, 1210, 1190, 1205], null), feriale);
    expect(r[0].verdetto).toBe("insufficiente");
    expect(r[0].motivo).toMatch(/non dice quanto dovrebbe durare/i);
  });
});

/* ── Il punto che rende sensati tutti gli altri ─────────────────────────── */
describe("separazione per classe di giornata", () => {
  /* La stessa corsa impiega 25 minuti nei feriali scolastici e 16 la domenica,
   * contro 20 previsti. Mediarle darebbe ~21 minuti: un numero che non
   * descrive nessuno dei due giorni, e che porterebbe a lasciare il feriale
   * com'è — condannandolo al ritardo — e la domenica pure, sprecando quattro
   * minuti su ogni corsa. */
  it("non mescola giornate di tipo diverso", () => {
    const misto: CorsaOsservata[] = [
      ...giornate("T1", [1500, 1520, 1490], 1200),          // feriali: 25′
      ...giornate("T1", [960, 950, 970], 1200).map((o, i) => ({
        ...o, day: `2026-10-${String(i + 1).padStart(2, "0")}`,   // domeniche: 16′
      })),
    ];
    const classifica = (day: string) => day.startsWith("2026-09")
      ? { key: "scuole_aperte/-/Feriale", label: "Scuole Aperte · Feriale" }
      : { key: "festivo/domenica_aperte/-", label: "Festivo · Domenica" };

    const r = analizzaPercorrenze(misto, classifica);
    expect(r).toHaveLength(2);

    const fer = r.find(x => x.classe.startsWith("scuole_aperte"))!;
    const dom = r.find(x => x.classe.startsWith("festivo"))!;
    expect(fer.verdetto).toBe("stretto");     // 25 minuti su 20 previsti
    expect(dom.verdetto).toBe("largo");       // 16 su 20 previsti
    // e nessuna delle due somiglia alla media che si otterrebbe mescolando
    expect(fer.medianaSec).toBeGreaterThan(1400);
    expect(dom.medianaSec).toBeLessThan(1000);
  });

  it("conta le giornate distinte, non le osservazioni", () => {
    const doppie: CorsaOsservata[] = [
      ...giornate("T1", [1200, 1210], 1200),
      { tripId: "T1", day: "2026-09-01", durataOsservataSec: 1220,
        durataProgrammataSec: 1200, fermateOsservate: 10 },   // stesso giorno
    ];
    const r = analizzaPercorrenze(doppie, feriale);
    expect(r[0].giornate).toBe(2);
  });

  /* In testa deve stare ciò che va corretto di più: è l'ordine in cui si
   * lavora quando le corse da rivedere sono centinaia. */
  it("mette per prime le corse con lo scostamento maggiore", () => {
    const r = analizzaPercorrenze([
      ...giornate("PICCOLO", [1260, 1270, 1250, 1265], 1200),
      ...giornate("GRANDE", [2400, 2450, 2350, 2420], 1200),
    ], feriale);
    expect(r[0].tripId).toBe("GRANDE");
  });

  it("su elenco vuoto non produce gruppi", () => {
    expect(analizzaPercorrenze([], feriale)).toEqual([]);
  });
});

describe("copertura delle fermate rilevate", () => {
  it("chiama il rilevamento parziale col suo nome", () => {
    const c = coperturaFermate(20, 6, 30);
    expect(c.quota).toBe(0.3);
    expect(c.nota).toMatch(/limite della misura, non un servizio saltato/i);
    expect(c.nota).toMatch(/30s/);
  });

  it("dichiara affidabili i tempi di tratta con copertura alta", () => {
    expect(coperturaFermate(20, 18, 30).nota).toMatch(/affidabili/i);
  });

  it("regge una corsa senza fermate", () => {
    expect(coperturaFermate(0, 0, 30).quota).toBe(0);
  });
});
