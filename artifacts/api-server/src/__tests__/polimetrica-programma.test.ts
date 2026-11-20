/**
 * La fotografia di un programma di Planning Studio per le polimetriche
 * (tappa 6.36): le linee extraurbane, le varianti con corse, le fermate coi
 * km sulla geometria. Dati inventati: coordinate calcolate su un parallelo.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  coordinateDellaForma, fotografia, kmInLineaDAria, kmSullaGeometria, percorsiPerChiave, type DatiDelProgramma,
} from "../lib/polimetrica-programma";
import { percorsoDellaDecisione } from "../lib/polimetrica-ufficiale";
import { haversineKm } from "../lib/geo-utils";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

/* un parallelo: le fermate a est di un punto fisso, di centesimi di grado */
const LAT = 45, LON = 9;
const punto = (centesimi: number) => ({ lat: LAT, lon: LON + centesimi / 100 });
const km = (a: number, b: number) => haversineKm(LAT, LON + a / 100, LAT, LON + b / 100);

function dati(extra: Partial<DatiDelProgramma> = {}): DatiDelProgramma {
  const fermate = new Map([
    ["s1", { codice: "3001", nome: "Borgo Alto", ...punto(0) }],
    ["s2", { codice: "3002", nome: "Ponte Nuovo", ...punto(3) }],
    ["s3", { codice: "3003", nome: "Fornace", ...punto(7) }],
    ["s9", { codice: "9001", nome: "Piazza", ...punto(1) }],
  ]);
  return {
    agencyName: "Azienda di prova",
    linee: [
      { id: "r1", codice: "A", nomeCorto: "A", nomeLungo: "Borgo Alto - Fornace" },
      { id: "r2", codice: "A-bis", nomeCorto: "A", nomeLungo: null },
      { id: "r3", codice: "30", nomeCorto: "30", nomeLungo: "Urbana" },
      { id: "r4", codice: "Z", nomeCorto: "Z", nomeLungo: null },
    ],
    varianti: [
      { id: "v1", lineaId: "r1", direzione: 0 },
      { id: "v2", lineaId: "r2", direzione: 1 },
      { id: "v3", lineaId: "r1", direzione: 0 },  // senza corse
      { id: "v4", lineaId: "r1", direzione: 0 },  // una fermata sola
      { id: "v5", lineaId: "r3", direzione: 0 },  // linea urbana
      { id: "v6", lineaId: "r4", direzione: null }, // fermata che non c'è
    ],
    fermateDelleVarianti: new Map([
      ["v1", ["s1", "s2", "s3"]], ["v2", ["s3", "s2", "s1"]], ["v3", ["s1", "s3"]], ["v4", ["s1"]],
      ["v5", ["s9", "s1"]], ["v6", ["s1", "sx"]],
    ]),
    fermate,
    /* la geometria di v1 passa sulle fermate, più fitta */
    forme: new Map([["v1", [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [punto(c).lon, punto(c).lat] as [number, number])]]),
    corse: new Map([["v1", 5], ["v2", 7], ["v4", 3], ["v5", 9], ["v6", 1]]),
    ...extra,
  };
}

describe("la fotografia di un programma", () => {
  it("le linee extraurbane con le varianti che hanno corse e almeno due fermate, dalla più servita", () => {
    const f = fotografia(dati());
    expect(f.agencyName).toBe("Azienda di prova");
    expect(f.lines.map((l) => [l.lineCode, l.lineName, l.routeIds])).toEqual([["A", "Borgo Alto - Fornace", ["A", "A-bis"]]]);
    const [p2, p1] = f.lines[0]!.percorsi;
    expect([p2!.variantId, p2!.routeId, p2!.routeIds, p2!.directionId, p2!.tripCount]).toEqual(["v2", "A-bis", ["A-bis"], 1, 7]);
    expect([p1!.variantId, p1!.routeId, p1!.directionId, p1!.tripCount, p1!.firstStopName, p1!.lastStopName, p1!.stopCount]).toEqual(["v1", "A", 0, 5, "Borgo Alto", "Fornace", 3]);
    expect(p1!.stops.map((s) => s.stopId)).toEqual(["3001", "3002", "3003"]);
  });

  it("i km: sulla geometria dove c'è, altrimenti in linea d'aria", () => {
    const [p2, p1] = fotografia(dati()).lines[0]!.percorsi;
    expect(p1!.distanceMethod).toBe("shape");
    expect(p1!.stops.map((s) => s.km)).toEqual([0, km(0, 3), km(0, 7)].map((x) => Math.round(x * 1000) / 1000));
    expect(p1!.stops[2]!.distPrev).toBeCloseTo(km(3, 7), 3);
    expect(p1!.totalKm).toBeCloseTo(km(0, 7), 2);
    expect(p1!.shape?.length).toBe(8);
    expect(p2!.distanceMethod).toBe("haversine");
    expect(p2!.shape).toBeNull();
    expect(p2!.stops.map((s) => s.km)).toEqual([0, km(7, 3), km(7, 0)].map((x) => Math.round(x * 1000) / 1000));
  });

  it("una geometria lontana dalle fermate non vale: in linea d'aria", () => {
    const lontana = [0, 7].map((c) => [punto(c).lon, LAT + 0.05] as [number, number]); // circa 5,5 km più a nord
    const p1 = fotografia(dati({ forme: new Map([["v1", lontana]]) })).lines[0]!.percorsi.find((p) => p.variantId === "v1")!;
    expect([p1.distanceMethod, p1.shape]).toEqual(["haversine", null]);
    expect(kmSullaGeometria([punto(0)], [punto(0)])).toBeNull();
    expect(kmInLineaDAria([punto(0), punto(3), punto(3)])).toEqual([0, km(0, 3), km(0, 3)]);
  });

  it("una linea senza varianti buone resta fuori; senza nome lungo, i capolinea", () => {
    expect(fotografia(dati({ corse: new Map() })).lines).toEqual([]);
    const senzaNome = dati();
    senzaNome.linee = senzaNome.linee.map((l) => ({ ...l, nomeLungo: null }));
    expect(fotografia(senzaNome).lines[0]!.lineName).toBe("Fornace ↔ Borgo Alto");
  });

  it("le coordinate di una geometria di Planning Studio", () => {
    expect(coordinateDellaForma({ type: "LineString", coordinates: [[9, 45], [9.5, 45], ["x", 1], [1]] })).toEqual([[9, 45], [9.5, 45]]);
    expect(coordinateDellaForma({ type: "Point", coordinates: [9, 45] })).toEqual([]);
    expect(coordinateDellaForma(null)).toEqual([]);
  });

  it("i percorsi per chiave: linea e fermate in ordine", () => {
    const per = percorsiPerChiave(fotografia(dati()));
    expect([...per.values()].map((x) => x.percorso.variantId).sort()).toEqual(["v1", "v2"]);
    expect(per.get("A\u00003001|3002|3003")?.percorso.variantId).toBe("v1");
  });
});

describe("la decisione del confronto, su un'altra fotografia", () => {
  const percorso = (routeId: string, variantId: string, corse: number, fermate: string[]) => ({ routeId, variantId, corse, fermate: fermate.map((stopId) => ({ stopId })) });
  const PERCORSI = [percorso("A", "v1", 5, ["3001", "3002", "3003"]), percorso("A", "v9", 9, ["3001", "3002", "3003"]), percorso("A", "v2", 7, ["3003", "3002", "3001"])];

  it("con gli stessi identificativi vale lì", () => {
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "v1", fermate: null }, PERCORSI)?.variantId).toBe("v1");
  });

  it("con identificativi che non ci sono vale sul percorso con le stesse fermate, il più servito", () => {
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "vecchia", fermate: ["3001", "3002", "3003"] }, PERCORSI)?.variantId).toBe("v9");
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "vecchia", fermate: ["3003", "3002", "3001"] }, PERCORSI)?.variantId).toBe("v2");
  });

  it("altrimenti non vale: torna la proposta", () => {
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "vecchia", fermate: null }, PERCORSI)).toBeNull();
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "vecchia", fermate: ["3001", "3003"] }, PERCORSI)).toBeNull();
    expect(percorsoDellaDecisione({ routeId: "A", variantId: "vecchia", fermate: [] }, PERCORSI)).toBeNull();
  });
});
