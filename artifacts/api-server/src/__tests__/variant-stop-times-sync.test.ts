import { describe, it, expect } from "vitest";
import { realignStopTimes, type SeqStop, type StopTimeRow } from "../lib/variant-stop-times-sync";

const hm = (h: number, m: number) => h * 3600 + m * 60;
/** corsa A(8:00) B(8:10) C(8:20) D(8:30), soste nulle */
const OLD: StopTimeRow[] = [
  { stopId: "A", arrivalSec: hm(8, 0), departureSec: hm(8, 0) },
  { stopId: "B", arrivalSec: hm(8, 10), departureSec: hm(8, 10) },
  { stopId: "C", arrivalSec: hm(8, 20), departureSec: hm(8, 20) },
  { stopId: "D", arrivalSec: hm(8, 30), departureSec: hm(8, 30) },
];
const seq = (...ids: string[]): SeqStop[] => ids.map(stopId => ({ stopId }));

describe("realignStopTimes", () => {
  it("toglie le fermate iniziali: la corsa parte dalla nuova prima, orari intatti", () => {
    const r = realignStopTimes(seq("C", "D"), OLD);
    expect(r.dropped).toBe(2);
    expect(r.added).toBe(0);
    expect(r.changed).toBe(true);
    expect(r.rows!.map(x => x.stopId)).toEqual(["C", "D"]);
    expect(r.rows!.map(x => x.departureSec)).toEqual([hm(8, 20), hm(8, 30)]);
  });

  it("toglie le fermate finali: la corsa termina prima, orari intatti", () => {
    const r = realignStopTimes(seq("A", "B"), OLD);
    expect(r.rows!.map(x => x.arrivalSec)).toEqual([hm(8, 0), hm(8, 10)]);
    expect(r.dropped).toBe(2);
  });

  it("toglie una fermata intermedia senza spostare le altre", () => {
    const r = realignStopTimes(seq("A", "C", "D"), OLD);
    expect(r.rows!.map(x => x.arrivalSec)).toEqual([hm(8, 0), hm(8, 20), hm(8, 30)]);
  });

  it("fermata NUOVA in mezzo: orario interpolato tra i due transiti noti", () => {
    const r = realignStopTimes(seq("A", "B", "X", "C", "D"), OLD);
    expect(r.added).toBe(1);
    expect(r.kept).toBe(4);
    // X sta tra B(8:10) e C(8:20), a metà passo → 8:15
    expect(r.rows![2]).toMatchObject({ stopId: "X", arrivalSec: hm(8, 15), departureSec: hm(8, 15) });
    // le fermate esistenti non si muovono
    expect(r.rows!.map(x => x.arrivalSec)).toEqual([hm(8, 0), hm(8, 10), hm(8, 15), hm(8, 20), hm(8, 30)]);
  });

  it("interpola sulle PROGRESSIVE quando ci sono (non a passo uniforme)", () => {
    const s: SeqStop[] = [
      { stopId: "A", shapeDistTraveled: 0 },
      { stopId: "X", shapeDistTraveled: 7500 }, // 3/4 del tratto A→C
      { stopId: "C", shapeDistTraveled: 10000 },
    ];
    const old2: StopTimeRow[] = [
      { stopId: "A", arrivalSec: hm(8, 0), departureSec: hm(8, 0) },
      { stopId: "C", arrivalSec: hm(8, 20), departureSec: hm(8, 20) },
    ];
    const r = realignStopTimes(s, old2);
    expect(r.rows![1].arrivalSec).toBe(hm(8, 15)); // 75% di 20 minuti
  });

  it("fermata NUOVA in testa: estrapolata col passo medio, la corsa parte prima", () => {
    const r = realignStopTimes(seq("Z", "A", "B", "C", "D"), OLD);
    // passo medio della parte nota = 10 min → Z alle 7:50
    expect(r.rows![0]).toMatchObject({ stopId: "Z", arrivalSec: hm(7, 50) });
    expect(r.rows![1].arrivalSec).toBe(hm(8, 0)); // A non si muove
  });

  it("fermata NUOVA in coda: estrapolata dopo l'ultima nota", () => {
    const r = realignStopTimes(seq("A", "B", "C", "D", "E"), OLD);
    expect(r.rows![4]).toMatchObject({ stopId: "E", arrivalSec: hm(8, 40) });
  });

  it("preserva le soste esistenti (arrivo ≠ partenza)", () => {
    const withDwell: StopTimeRow[] = [
      { stopId: "A", arrivalSec: hm(8, 0), departureSec: hm(8, 2) },
      { stopId: "B", arrivalSec: hm(8, 10), departureSec: hm(8, 12) },
    ];
    const r = realignStopTimes(seq("A", "B"), withDwell);
    expect(r.rows!.map(x => x.departureSec - x.arrivalSec)).toEqual([120, 120]);
  });

  it("non tocca la corsa se resterebbero meno di 2 transiti noti", () => {
    const r = realignStopTimes(seq("D", "Q"), OLD);
    expect(r.rows).toBeNull();
    expect(r.changed).toBe(false);
  });

  it("sequenza invariata: nessuna scrittura da fare", () => {
    const r = realignStopTimes(seq("A", "B", "C", "D"), OLD);
    expect(r.changed).toBe(false);
    expect(r.dropped).toBe(0);
    expect(r.added).toBe(0);
  });

  it("riordino delle fermate: gli orari seguono il nuovo ordine restando monotoni", () => {
    const r = realignStopTimes(seq("A", "C", "B", "D"), OLD);
    const t = r.rows!.map(x => x.arrivalSec);
    expect(t).toEqual([...t].sort((a, b) => a - b)); // mai un arrivo all'indietro
  });

  it("percorso ad anello con fermata ripetuta: ogni passaggio tiene il suo orario", () => {
    const loop: StopTimeRow[] = [
      { stopId: "A", arrivalSec: hm(8, 0), departureSec: hm(8, 0) },
      { stopId: "B", arrivalSec: hm(8, 10), departureSec: hm(8, 10) },
      { stopId: "A", arrivalSec: hm(8, 20), departureSec: hm(8, 20) },
    ];
    const r = realignStopTimes(seq("A", "B", "A"), loop);
    expect(r.changed).toBe(false);
    const r2 = realignStopTimes(seq("B", "A"), loop);
    expect(r2.rows!.map(x => x.arrivalSec)).toEqual([hm(8, 10), hm(8, 20)]);
  });

  it("corsa senza orari (prototipo ZERO): niente da rimodulare", () => {
    const r = realignStopTimes(seq("A", "B"), []);
    expect(r.rows).toBeNull();
  });

  it("estrapolazione in testa oltre la mezzanotte: nessun orario negativo", () => {
    const early: StopTimeRow[] = [
      { stopId: "A", arrivalSec: hm(0, 5), departureSec: hm(0, 5) },
      { stopId: "B", arrivalSec: hm(0, 15), departureSec: hm(0, 15) },
    ];
    const r = realignStopTimes(seq("Z", "A", "B"), early);
    expect(r.rows!.every(x => x.arrivalSec >= 0)).toBe(true);
    const t = r.rows!.map(x => x.arrivalSec);
    expect(t).toEqual([...t].sort((a, b) => a - b));
  });
});
