/**
 * Ricalcare un tratto sul tracciato di un'altra linea — collaudo.
 * Il caso vero: la 22/24, fra il Cimitero di Pinocchio e Via Togliatti 108,
 * passa su un senso vietato consentito ai bus. Lo snap stradale gira intorno
 * all'isolato, la retta taglia le case; la 24 quel tratto lo fa già.
 */
import { describe, it, expect } from "vitest";
import { ricalcaTratto, ritaglia, semplifica, coordinateValide, type TracciatoCandidato } from "../lib/ricalca-tratto";
import { metri, type PuntoLonLat } from "../lib/shape-segments";

const CIMITERO: PuntoLonLat = [13.49275, 43.58701];
const TOGLIATTI_108: PuntoLonLat = [13.49366, 43.58573];

/* La 24: scende dal Cimitero a Via Togliatti con una curva, poi prosegue. */
const VIA_24: PuntoLonLat[] = [
  [13.4925, 43.5885], [13.49276, 43.58705], [13.4930, 43.5866], [13.4934, 43.5861],
  [13.49368, 43.58576], [13.4950, 43.5846],
];
/* Una linea creata con lo snap stradale: dal Cimitero fa il giro dell'isolato. */
const GIRO: PuntoLonLat[] = [
  [13.49276, 43.58705], [13.4915, 43.5870], [13.4910, 43.5850], [13.4925, 43.5845],
  [13.49368, 43.58576],
];
const cand = (variantId: string, linea: string, coordinate: PuntoLonLat[]): TracciatoCandidato =>
  ({ variantId, linea, percorso: `${linea} andata`, coordinate });
const lung = (p: PuntoLonLat[]) => p.slice(1).reduce((m, q, i) => m + metri(p[i][1], p[i][0], q[1], q[0]), 0);

describe("ricalcaTratto", () => {
  it("prende il tratto della 24, non il giro dell'isolato", () => {
    const r = ricalcaTratto([cand("v-giro", "22/24", GIRO), cand("v-24", "24", VIA_24)], CIMITERO, TOGLIATTI_108);
    expect(r?.linea).toBe("24");
    expect(r?.variantId).toBe("v-24");
    expect(r!.metri).toBeGreaterThan(metri(CIMITERO[1], CIMITERO[0], TOGLIATTI_108[1], TOGLIATTI_108[0]));
    expect(r!.metri).toBeLessThan(250);
  });

  it("parte e arriva sulle fermate e segue la strada coi punti intermedi", () => {
    const r = ricalcaTratto([cand("v-24", "24", VIA_24)], CIMITERO, TOGLIATTI_108)!;
    expect(r.punti[0]).toEqual(CIMITERO);
    expect(r.punti[r.punti.length - 1]).toEqual(TOGLIATTI_108);
    expect(r.intermedi.length).toBeGreaterThanOrEqual(2);
    expect(r.intermedi).toEqual(r.punti.slice(1, -1));
    expect(r.intermedi).toContainEqual([13.4930, 43.5866]);
  });

  it("nel verso contrario la linea non vale", () => {
    expect(ricalcaTratto([cand("v-24r", "24", [...VIA_24].reverse())], CIMITERO, TOGLIATTI_108)).toBeNull();
  });

  it("un tracciato che non passa dalle fermate non vale", () => {
    const lontano: PuntoLonLat[] = VIA_24.map(([x, y]) => [x + 0.002, y]); // ~160 m più a est
    expect(ricalcaTratto([cand("v-x", "30", lontano)], CIMITERO, TOGLIATTI_108)).toBeNull();
  });

  it("nessun candidato: null, mai una retta inventata", () => {
    expect(ricalcaTratto([], CIMITERO, TOGLIATTI_108)).toBeNull();
  });

  it("un giro troppo lungo rispetto alla retta si scarta", () => {
    const lunghissimo: PuntoLonLat[] = [
      [13.49276, 43.58705], [13.4800, 43.5870], [13.4800, 43.5750], [13.4950, 43.5750], [13.49368, 43.58576],
    ];
    expect(ritaglia(lunghissimo, CIMITERO, TOGLIATTI_108)).toBeNull();
  });

  it("su una linea che ripassa dal Cimitero prende il passaggio che porta a Via Togliatti", () => {
    const anello: PuntoLonLat[] = [
      [13.49276, 43.58705], [13.4900, 43.5890], [13.4880, 43.5880], [13.4910, 43.5872], // primo passaggio, va via
      [13.49276, 43.58705], [13.4930, 43.5866], [13.49368, 43.58576],                   // secondo, quello buono
    ];
    const r = ritaglia(anello, CIMITERO, TOGLIATTI_108)!;
    expect(r).not.toBeNull();
    expect(r.metri).toBeLessThan(250);
  });
});

describe("semplifica", () => {
  it("toglie i punti allineati e tiene le curve", () => {
    const dritta: PuntoLonLat[] = [[13.50, 43.60], [13.501, 43.60], [13.502, 43.60], [13.503, 43.60]];
    expect(semplifica(dritta, 3)).toEqual([[13.50, 43.60], [13.503, 43.60]]);
    const curva: PuntoLonLat[] = [[13.50, 43.60], [13.501, 43.601], [13.502, 43.60]];
    expect(semplifica(curva, 3)).toHaveLength(3);
  });

  it("la lunghezza resta quella della strada", () => {
    const r = ricalcaTratto([cand("v-24", "24", VIA_24)], CIMITERO, TOGLIATTI_108)!;
    expect(Math.abs(lung(r.punti) - r.metri)).toBeLessThan(5);
  });
});

describe("coordinateValide", () => {
  it("solo LineString con coordinate numeriche", () => {
    expect(coordinateValide({ type: "LineString", coordinates: [[13.5, 43.6], ["x", 1], [13.6, 95], [13.7, 43.7]] }))
      .toEqual([[13.5, 43.6], [13.7, 43.7]]);
    expect(coordinateValide({ type: "Point", coordinates: [13.5, 43.6] })).toEqual([]);
    expect(coordinateValide(null)).toEqual([]);
  });
});
