/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Spezzare il tracciato fermata per fermata — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Gli errori di geometria non si vedono: producono una linea disegnata, che
 * sembra una risposta. Qui si costruiscono i casi in cui una linea sbagliata
 * sarebbe indistinguibile da una giusta a occhio — l'anello che ripassa, la
 * fermata fuori tracciato, le due fermate sullo stesso segmento.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  metri, ancoraFermate, spezzaPerFermate, LONTANO_DAL_TRACCIATO_M,
  type PuntoLonLat,
} from "../lib/shape-segments";

/* Una retta est-ovest ad Ancona, un punto ogni ~80 m. */
const BASE_LAT = 43.6158, BASE_LON = 13.5189;
const retta: PuntoLonLat[] = Array.from({ length: 11 },
  (_, i) => [BASE_LON + i * 0.001, BASE_LAT]);

describe("la distanza", () => {
  it("misura in metri, non in gradi", () => {
    const d = metri(BASE_LAT, BASE_LON, BASE_LAT, BASE_LON + 0.001);
    expect(d).toBeGreaterThan(70);
    expect(d).toBeLessThan(85);
  });

  /* Un grado di longitudine ad Ancona vale il 72% di uno di latitudine: chi
   * calcola in gradi ottiene una perpendicolare storta e proietta la fermata
   * sul punto sbagliato. */
  it("tiene conto che un grado di longitudine non è un grado di latitudine", () => {
    const lon = metri(BASE_LAT, BASE_LON, BASE_LAT, BASE_LON + 0.01);
    const lat = metri(BASE_LAT, BASE_LON, BASE_LAT + 0.01, BASE_LON);
    expect(lon / lat).toBeCloseTo(Math.cos(BASE_LAT * Math.PI / 180), 2);
  });
});

describe("l'ancoraggio delle fermate", () => {
  /* Si controlla il PUNTO, non l'indice: una fermata esattamente su un vertice
   * può essere descritta come «fine del segmento 4» o «inizio del 5», che sono
   * lo stesso posto, e un collaudo sull'indice fallirebbe su una differenza
   * che non esiste. */
  it("mette ogni fermata dove cade sul tracciato, in ordine", () => {
    const a = ancoraFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON + 0.0005 },
      { lat: BASE_LAT, lon: BASE_LON + 0.005 },
      { lat: BASE_LAT, lon: BASE_LON + 0.0095 },
    ]);
    expect(a.map(x => x!.lon)).toEqual([
      expect.closeTo(BASE_LON + 0.0005, 6),
      expect.closeTo(BASE_LON + 0.005, 6),
      expect.closeTo(BASE_LON + 0.0095, 6),
    ]);
    expect(a.every(x => x!.distanzaM < 1)).toBe(true);
    // e procedono: l'avanzamento lungo il tracciato non torna mai indietro
    expect(a[0]!.i + a[0]!.t).toBeLessThan(a[1]!.i + a[1]!.t);
    expect(a[1]!.i + a[1]!.t).toBeLessThan(a[2]!.i + a[2]!.t);
  });

  it("proietta perpendicolarmente una fermata a bordo strada", () => {
    const [a] = ancoraFermate(retta, [{ lat: BASE_LAT + 0.0002, lon: BASE_LON + 0.0025 }]);
    expect(a!.lat).toBeCloseTo(BASE_LAT, 5);
    expect(a!.lon).toBeCloseTo(BASE_LON + 0.0025, 5);
    expect(a!.distanzaM).toBeGreaterThan(15);
    expect(a!.distanzaM).toBeLessThan(30);
  });

  /* IL caso: un anello che ripassa sulla stessa strada. Il punto più vicino
   * in assoluto alla seconda fermata sta sul primo passaggio, cioè PRIMA
   * della prima fermata: senza il vincolo di procedere, il tratto tornerebbe
   * indietro attraversando tutta la linea. */
  it("non aggancia una fermata al passaggio precedente su una linea ad anello", () => {
    const andata: PuntoLonLat[] = Array.from({ length: 11 },
      (_, i) => [BASE_LON + i * 0.001, BASE_LAT]);
    const ritorno: PuntoLonLat[] = Array.from({ length: 11 },
      (_, i) => [BASE_LON + 0.01 - i * 0.001, BASE_LAT + 0.00002]);
    const anello = [...andata, ...ritorno];

    const a = ancoraFermate(anello, [
      { lat: BASE_LAT, lon: BASE_LON + 0.008 },        // andata, verso la fine
      { lat: BASE_LAT, lon: BASE_LON + 0.002 },        // ritorno, tornando indietro
    ]);
    // la prima sta sull'andata (indici 0..10), vicino al punto giusto
    expect(a[0]!.i).toBeLessThanOrEqual(10);
    expect(a[0]!.lon).toBeCloseTo(BASE_LON + 0.008, 6);
    // la seconda DEVE stare sul ramo di ritorno, cioè oltre l'indice 10:
    // il punto più vicino in assoluto starebbe sull'andata, PRIMA della prima
    expect(a[1]!.i).toBeGreaterThan(10);
    expect(a[1]!.lon).toBeCloseTo(BASE_LON + 0.002, 6);
  });

  it("salta le fermate senza coordinate invece di inventarle", () => {
    const a = ancoraFermate(retta, [{ lat: null, lon: null }, { lat: BASE_LAT, lon: BASE_LON + 0.003 }]);
    expect(a[0]).toBeNull();
    expect(a[1]).not.toBeNull();
  });

  it("senza tracciato non ancora nulla", () => {
    expect(ancoraFermate([], [{ lat: BASE_LAT, lon: BASE_LON }])).toEqual([null]);
    expect(ancoraFermate([[13, 43]], [{ lat: BASE_LAT, lon: BASE_LON }])).toEqual([null]);
  });
});

describe("i tratti fra fermate", () => {
  it("dà un tratto per ogni coppia di fermate consecutive", () => {
    const t = spezzaPerFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON },
      { lat: BASE_LAT, lon: BASE_LON + 0.004 },
      { lat: BASE_LAT, lon: BASE_LON + 0.009 },
    ]);
    expect(t).toHaveLength(2);
    expect(t.every(x => x.attendibile)).toBe(true);
  });

  /* Il tratto deve contenere i vertici INTERMEDI del tracciato: sono le curve.
   * Un tratto fatto di due soli punti è la congiungente, cioè la scorciatoia. */
  it("porta con sé le curve del tracciato, non solo gli estremi", () => {
    const curva: PuntoLonLat[] = [
      [BASE_LON, BASE_LAT], [BASE_LON + 0.002, BASE_LAT + 0.003],
      [BASE_LON + 0.004, BASE_LAT + 0.003], [BASE_LON + 0.006, BASE_LAT],
    ];
    const [t] = spezzaPerFermate(curva, [
      { lat: BASE_LAT, lon: BASE_LON }, { lat: BASE_LAT, lon: BASE_LON + 0.006 },
    ]);
    expect(t.punti.length).toBeGreaterThan(2);
    expect(t.attendibile).toBe(true);
    // e la lunghezza è quella della strada, non quella della corda
    const corda = metri(BASE_LAT, BASE_LON, BASE_LAT, BASE_LON + 0.006);
    expect(t.metri).toBeGreaterThan(corda * 1.5);
  });

  /* Una fermata con coordinate sbagliate nel feed, o un tracciato che quel
   * pezzo non lo copre: disegnare comunque la strada mostrerebbe un percorso
   * che il mezzo non ha fatto. */
  it("ripiega sulla congiungente, dichiarandolo, se una fermata è lontana", () => {
    const [t] = spezzaPerFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON },
      { lat: BASE_LAT + 0.05, lon: BASE_LON + 0.005 }, // ~5 km fuori
    ]);
    expect(t.attendibile).toBe(false);
    expect(t.punti).toHaveLength(2);
  });

  it("la soglia di lontananza è quella dichiarata", () => {
    const poco = spezzaPerFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON },
      { lat: BASE_LAT + 0.001, lon: BASE_LON + 0.005 }, // ~111 m
    ]);
    expect(LONTANO_DAL_TRACCIATO_M).toBe(200);
    expect(poco[0].attendibile).toBe(true);
  });

  /* Due fermate quasi sovrapposte darebbero un tratto di un punto solo, e la
   * mappa non disegnerebbe niente: nessun errore, nessuna linea, nessuna
   * spiegazione. */
  it("non produce un tratto degenere quando due fermate coincidono", () => {
    const [t] = spezzaPerFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON + 0.003 },
      { lat: BASE_LAT, lon: BASE_LON + 0.003 },
    ]);
    expect(t.punti.length).toBeGreaterThanOrEqual(2);
  });

  it("senza tracciato unisce le fermate e lo dichiara", () => {
    const [t] = spezzaPerFermate([], [
      { lat: BASE_LAT, lon: BASE_LON }, { lat: BASE_LAT, lon: BASE_LON + 0.004 },
    ]);
    expect(t.attendibile).toBe(false);
    expect(t.punti).toHaveLength(2);
    expect(t.metri).toBeGreaterThan(250);
  });

  it("con una fermata sola non c'è nessun tratto", () => {
    expect(spezzaPerFermate(retta, [{ lat: BASE_LAT, lon: BASE_LON }])).toEqual([]);
  });

  it("una fermata senza coordinate non fa sparire il tratto", () => {
    const t = spezzaPerFermate(retta, [
      { lat: BASE_LAT, lon: BASE_LON },
      { lat: null, lon: null },
      { lat: BASE_LAT, lon: BASE_LON + 0.008 },
    ]);
    expect(t).toHaveLength(2);
    expect(t.every(x => !x.attendibile)).toBe(true);
  });
});
