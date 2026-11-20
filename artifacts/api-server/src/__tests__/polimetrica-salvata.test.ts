/**
 * Il salvataggio di una polimetrica (tappa 6.35): dal browser si prendono
 * solo le decisioni, il resto viene dall'import. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { componiPolimetrica, fermateNelVerso, leggiCorpo, èUuid, type CorpoPolimetrica, type PercorsoImport } from "../lib/polimetrica-salvata";

const IMPORT = "e6350000-0000-4000-8000-0000000000a1";

/* un percorso di 6 fermate, 13,5 km */
const PERCORSO: PercorsoImport = {
  routeId: "R7", variantId: "v1", lineCode: "D", lineName: "Borgo Alto ↔ Fornace", totalKm: 13.5,
  stops: [
    { stopId: "3001", stopName: "Borgo Alto", lat: 1, lon: 2, km: 0, distPrev: 0 },
    { stopId: "3002", stopName: "Ponte Nuovo", lat: 1, lon: 2, km: 2.4, distPrev: 2.4 },
    { stopId: "3003", stopName: "Molino", lat: 1, lon: 2, km: 5.1, distPrev: 2.7 },
    { stopId: "4000", stopName: "Lago", lat: 1, lon: 2, km: 7.25, distPrev: 2.15 },
    { stopId: "4001", stopName: "Castello", lat: 1, lon: 2, km: 10, distPrev: 2.75 },
    { stopId: "4002", stopName: "Fornace", lat: 1, lon: 2, km: 13.5, distPrev: 3.5 },
  ],
};
const IDS = PERCORSO.stops.map((s) => s.stopId);

/** Il corpo che manda la pagina: fermate con tutti i loro campi, tratte con i campi calcolati. */
function corpo(extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    importId: IMPORT, routeId: "R7", variantId: "v1", direction: "AB",
    lineCode: "D", lineName: "Borgo Alto ↔ Fornace", name: " D · andata ", totalKm: 13.5,
    boundaries: [3],
    tratte: [
      { index: 0, number: 1, label: "Tratta 1", color: "#22c55e", nodeName: " Borgo ", fromStopIdx: 0, toStopIdx: 3, km: 7.25 },
      { index: 1, number: 2, label: "Tratta 2", color: "#38bdf8", nodeName: "Lago", fromStopIdx: 3, toStopIdx: 5, km: 6.25 },
    ],
    stops: PERCORSO.stops.map((s, i) => ({ ...s, tratta: i < 3 ? 0 : 1, ...(i === 4 ? { punto: true } : {}) })),
    ...extra,
  };
}

const letto = (b: unknown): CorpoPolimetrica => {
  const r = leggiCorpo(b);
  if (!r.ok) throw new Error(r.errore);
  return r.corpo;
};
const errore = (b: unknown): string => {
  const r = leggiCorpo(b);
  return r.ok ? "" : r.errore;
};

describe("il corpo del salvataggio", () => {
  it("prende i campi che servono e scarta il resto", () => {
    const c = letto(corpo({ admin: true }));
    expect(Object.keys(c).sort()).toEqual(["boundaries", "direction", "importId", "name", "routeId", "stops", "tratte", "variantId"]);
    expect(Object.keys(c.stops[0]!)).toEqual(["stopId"]);
    expect(c.stops[4]).toEqual({ stopId: "4001", punto: true });
    expect(Object.keys(c.tratte[0]!).sort()).toEqual(["color", "index", "label", "nodeName", "number"]);
  });

  it("senza verso vale l'andata", () => {
    const b = corpo(); delete b.direction;
    expect(letto(b).direction).toBe("AB");
  });

  it("rifiuta in italiano, dicendo dove", () => {
    expect(errore(corpo({ importId: "abc" }))).toBe("Dati non validi (import): import non valido");
    expect(errore({ ...corpo(), routeId: undefined })).toBe("Dati non validi (percorso): manca");
    expect(errore(corpo({ routeId: 7 }))).toBe("Dati non validi (percorso): tipo sbagliato");
    expect(errore(corpo({ direction: "XY" }))).toBe("Dati non validi (verso): valore non ammesso");
    expect(errore(corpo({ name: "n".repeat(201) }))).toBe("Dati non validi (nome): al più 200 caratteri");
    expect(errore(corpo({ boundaries: [1.5] }))).toBe("Dati non validi (confini › n. 1): tipo sbagliato");
    expect(errore(corpo({ stops: [{ stopId: "3001" }] }))).toBe("Dati non validi (fermate): almeno 2 elementi");
    expect(errore(corpo({ stops: Array.from({ length: 1001 }, (_, i) => ({ stopId: `s${i}` })) }))).toBe("Dati non validi (fermate): al più 1000 elementi");
    expect(errore(corpo({ stops: [{ stopId: "" }, { stopId: "x" }] }))).toBe("Dati non validi (fermate › n. 1 › codice della fermata): non può essere vuoto");
    const t = corpo().tratte as Record<string, unknown>[];
    expect(errore(corpo({ tratte: [{ ...t[0], nodeName: "x".repeat(121) }, t[1]] }))).toBe("Dati non validi (tratte › n. 1 › nome del nodo): al più 120 caratteri");
    expect(errore(corpo({ tratte: [t[0], { ...t[1], color: "red;}" }] }))).toBe("Dati non validi (tratte › n. 2 › colore): colore non valido");
    expect(errore(corpo({ tratte: [{ ...t[0], number: 0 }, t[1]] }))).toBe("Dati non validi (tratte › n. 1 › numero): almeno 1");
    expect(errore(null)).toBe("Dati non validi (import): manca");
  });

  it("un identificativo è un UUID", () => {
    expect([èUuid(IMPORT), èUuid("abc"), èUuid(`${IMPORT}x`), èUuid(7), èUuid(undefined)]).toEqual([true, false, false, false, false]);
  });
});

describe("la polimetrica composta col percorso dell'import", () => {
  it("andata: fermate, km e tratte vengono dall'import; dal browser le decisioni", () => {
    const r = componiPolimetrica(letto(corpo()), PERCORSO);
    if (!r.ok) throw new Error(r.errore);
    const p = r.polimetrica;
    expect(p).toMatchObject({
      importId: IMPORT, routeId: "R7", variantId: "v1", direction: "AB",
      lineCode: "D", lineName: "Borgo Alto ↔ Fornace", name: "D · andata", totalKm: 13.5, boundaries: [3],
    });
    expect(p.stops.map((s) => [s.stopId, s.stopName, s.km, s.tratta, s.punto ?? null])).toEqual([
      ["3001", "Borgo Alto", 0, 0, null], ["3002", "Ponte Nuovo", 2.4, 0, null], ["3003", "Molino", 5.1, 0, null],
      ["4000", "Lago", 7.25, 1, null], ["4001", "Castello", 10, 1, true], ["4002", "Fornace", 13.5, 1, null],
    ]);
    expect(p.tratte).toEqual([
      { index: 0, number: 1, label: "Tratta 1", color: "#22c55e", nodeName: "Borgo",
        fromStopIdx: 0, toStopIdx: 3, fromStopName: "Borgo Alto", toStopName: "Lago", fromKm: 0, toKm: 7.25, km: 7.25, stopCount: 4,
        puntoStopIdx: 0, puntoStopName: "Borgo Alto", puntoKm: 0 },
      { index: 1, number: 2, label: "Tratta 2", color: "#38bdf8", nodeName: "Lago",
        fromStopIdx: 3, toStopIdx: 5, fromStopName: "Lago", toStopName: "Fornace", fromKm: 7.25, toKm: 13.5, km: 6.25, stopCount: 3,
        puntoStopIdx: 4, puntoStopName: "Castello", puntoKm: 10 },
    ]);
  });

  it("i km e i nomi mandati dal browser non contano", () => {
    const b = corpo({ totalKm: 99, lineCode: "ZZ" });
    (b.stops as Record<string, unknown>[])[2] = { ...(b.stops as Record<string, unknown>[])[2], km: 50, stopName: "<b>altro</b>" };
    const r = componiPolimetrica(letto(b), PERCORSO);
    if (!r.ok) throw new Error(r.errore);
    expect([r.polimetrica.totalKm, r.polimetrica.lineCode, r.polimetrica.stops[2]!.km, r.polimetrica.stops[2]!.stopName]).toEqual([13.5, "D", 5.1, "Molino"]);
  });

  it("ritorno: le fermate al contrario, coi km dall'altro capo", () => {
    expect(fermateNelVerso(PERCORSO, "BA").map((s) => [s.stopId, s.km, s.distPrev])).toEqual([
      ["4002", 0, 0], ["4001", 3.5, 3.5], ["4000", 6.25, 2.75], ["3003", 8.4, 2.15], ["3002", 11.1, 2.7], ["3001", 13.5, 2.4],
    ]);
    const b = corpo({
      direction: "BA", boundaries: [2],
      stops: [...IDS].reverse().map((stopId) => ({ stopId })),
    });
    const r = componiPolimetrica(letto(b), PERCORSO);
    if (!r.ok) throw new Error(r.errore);
    expect(r.polimetrica.tratte.map((t) => [t.fromStopName, t.toStopName, t.km])).toEqual([["Fornace", "Lago", 6.25], ["Lago", "Borgo Alto", 7.25]]);
    expect(r.polimetrica.totalKm).toBe(13.5);
  });

  it("senza punto scelto il punto tariffario è la prima fermata della tratta; confini doppi o in disordine si mettono a posto", () => {
    const b = corpo({ boundaries: [4, 2, 4], stops: IDS.map((stopId) => ({ stopId })), tratte: [{ index: 2 }, { index: 0 }, { index: 1 }] });
    const r = componiPolimetrica(letto(b), PERCORSO);
    if (!r.ok) throw new Error(r.errore);
    expect(r.polimetrica.boundaries).toEqual([2, 4]);
    expect(r.polimetrica.tratte.map((t) => [t.index, t.number, t.label, t.nodeName, t.puntoStopIdx, t.stopCount, "color" in t])).toEqual([
      [0, 1, "Tratta 1", "", 0, 3, false], [1, 2, "Tratta 2", "", 2, 3, false], [2, 3, "Tratta 3", "", 4, 2, false],
    ]);
    expect(r.polimetrica.stops.map((s) => s.tratta)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("il nome vuoto non si salva", () => {
    const r = componiPolimetrica(letto(corpo({ name: "   " })), PERCORSO);
    expect(r.ok && r.polimetrica.name).toBeNull();
  });

  it("rifiuta quello che non torna col percorso", () => {
    const rifiuto = (b: Record<string, unknown>) => { const r = componiPolimetrica(letto(b), PERCORSO); return r.ok ? "" : r.errore; };
    expect(rifiuto(corpo({ stops: IDS.slice(0, 5).map((stopId) => ({ stopId })) }))).toBe("Le fermate non sono quelle del percorso: 5 invece di 6");
    expect(rifiuto(corpo({ stops: IDS.map((stopId, i) => ({ stopId: i === 3 ? "9999" : stopId })) }))).toBe("La fermata 4 non è quella del percorso");
    /* il ritorno con le fermate nell'ordine dell'andata */
    expect(rifiuto(corpo({ direction: "BA", stops: IDS.map((stopId) => ({ stopId })) }))).toBe("La fermata 1 non è quella del percorso letto al contrario");
    expect(rifiuto(corpo({ boundaries: [6] }))).toBe("Il confine 6 è fuori dal percorso (fermate da 1 a 5)");
    expect(rifiuto(corpo({ boundaries: [0] }))).toBe("Il confine 0 è fuori dal percorso (fermate da 1 a 5)");
    expect(rifiuto(corpo({ boundaries: [2, 4] }))).toBe("Le tratte non tornano coi confini: 2 invece di 3");
    expect(rifiuto(corpo({ tratte: [{ index: 0 }, { index: 2 }] }))).toBe("Le tratte vanno numerate da 0, una per indice");
    expect(rifiuto(corpo({ stops: IDS.map((stopId, i) => ({ stopId, ...(i === 3 || i === 5 ? { punto: true } : {}) })) }))).toBe("Due punti tariffari nella stessa tratta (la 2)");
  });

  it("un percorso dell'import senza fermate non si salva", () => {
    const r = componiPolimetrica(letto(corpo()), { ...PERCORSO, stops: [] });
    expect(r).toEqual({ ok: false, errore: "Il percorso dell'import non ha fermate" });
  });
});
