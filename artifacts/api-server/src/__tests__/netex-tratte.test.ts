/**
 * Le tratte fra due fermate col loro tracciato, per i ServiceLink del NeTEx
 * (tappa 6.42): la proiezione delle fermate sul tracciato, in ordine, il pezzo
 * di tracciato fra due fermate, le tratte uguali che diventano una, e il file
 * che ne esce passato allo schema EPIP con xmllint (se c'è: in CI sì). E gli
 * avvisi del controllo del GTFS sulle fermate fuori dal tracciato (tappa
 * 6.43). Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { netexDaGtfs } from "../lib/netex";
import {
  distanzaDalTracciato, distanzaKm, posizioniSulTracciato, posList, puntoA, stessaStrada, tracciatoDa, trattePercorso, trattoFra, ENTRO_KM,
  type Tratta,
} from "../lib/netex-tratte";
import { validaNetex } from "../lib/netex-validazione";
import { rigaDelProblema, verificaGtfs, type Gtfs } from "../lib/gtfs-verifica";
import { fermateFuoriTracciato } from "../lib/planning-studio-export";

const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });
const LAT = 45, LON = 9;
/** Un punto a tanti km a est e a nord del punto di partenza. */
const KM_LAT = 6371.0088 * Math.PI / 180;
const qui = (est: number, nord = 0): [number, number] => [LAT + nord / KM_LAT, LON + est / (KM_LAT * Math.cos(LAT * Math.PI / 180))];
/** Le righe di shapes.txt di un tracciato, dai suoi punti. */
const forma = (id: string, punti: Array<[number, number]>) =>
  punti.map(([lat, lon], i) => ({ shape_id: id, shape_pt_lat: lat, shape_pt_lon: lon, shape_pt_sequence: i + 1 }));
const vicino = (a: number | null | undefined, b: number, entro = 0.002) => a != null && Math.abs(a - b) <= entro;

describe("Tratte: il tracciato", () => {
  it("il tracciato mette i punti in ordine di sequenza e conta i km", () => {
    const righe = forma("F", [qui(0), qui(1), qui(1, 1)]);
    const t = tracciatoDa([righe[2]!, righe[0]!, righe[1]!])!;
    expect(t.punti).toEqual([qui(0), qui(1), qui(1, 1)]);
    expect(t.km[0]).toBe(0);
    expect(vicino(t.km[1], 1)).toBe(true);
    expect(vicino(t.km[2], 2)).toBe(true);
    /* un punto senza coordinate si scarta; con meno di due punti il tracciato non c'è */
    expect(tracciatoDa([...forma("G", [qui(0)]), { shape_id: "G", shape_pt_lat: "", shape_pt_lon: "x", shape_pt_sequence: 2 }])).toBeNull();
  });

  it("il punto a una distanza, e il pezzo fra due distanze coi vertici in mezzo", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(1), qui(1, 1)]))!;
    const p = puntoA(t, 0.5);
    expect(distanzaKm(p, qui(0.5))).toBeLessThan(0.001);
    expect(puntoA(t, -3)).toEqual(qui(0));
    expect(distanzaKm(puntoA(t, 99), qui(1, 1))).toBeLessThan(0.001);
    const pezzo = trattoFra(t, 0.5, 1.5)!;
    expect(pezzo.punti.length).toBe(3);
    expect(pezzo.punti[1]).toEqual(qui(1));
    expect(Math.abs(pezzo.metri - 1000)).toBeLessThanOrEqual(2);
    /* le distanze che non vanno avanti non danno un pezzo */
    expect(trattoFra(t, 1, 1)).toBeNull();
    expect(trattoFra(t, 1.2, 0.4)).toBeNull();
  });

  it("la polilinea come la vuole gml:posList: longitudine e latitudine, sei decimali", () => {
    expect(posList([[45, 9], [45.0000004, 9.1234567]])).toBe("9.000000 45.000000 9.123457 45.000000");
  });
});

describe("Tratte: le fermate sul tracciato", () => {
  it("una fermata a lato della strada cade sul punto più vicino del tracciato", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(2)]))!;
    const s = posizioniSulTracciato(t, [qui(0), qui(0.7, 0.012), qui(2, -0.01)]);
    expect(vicino(s[0], 0)).toBe(true);
    expect(vicino(s[1], 0.7)).toBe(true);
    expect(vicino(s[2], 2)).toBe(true);
  });

  it("andata e ritorno sulla stessa strada: ogni fermata sul suo passaggio, in ordine", () => {
    /* 2 km verso est e poi indietro: il ritorno passa davanti alle stesse fermate */
    const t = tracciatoDa(forma("F", [qui(0), qui(1), qui(2), qui(1, 0.001), qui(0, 0.001)]))!;
    const s = posizioniSulTracciato(t, [qui(0), qui(1), qui(2), qui(1, 0.002), qui(0, 0.002)]);
    expect(s.every((x) => x != null)).toBe(true);
    expect(vicino(s[1], 1)).toBe(true);
    expect(vicino(s[3], 3)).toBe(true);
    expect(vicino(s[4], 4)).toBe(true);
    /* e vanno avanti */
    expect(s.every((x, i) => i === 0 || x! > s[i - 1]!)).toBe(true);
  });

  it("un anello che ripassa dalla stessa fermata: la prima volta all'inizio, la seconda alla fine", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(1), qui(1, 1), qui(0, 1), qui(0)]))!;
    const s = posizioniSulTracciato(t, [qui(0), qui(1, 0.5), qui(0)]);
    expect(vicino(s[0], 0)).toBe(true);
    expect(vicino(s[1], 1.5)).toBe(true);
    expect(vicino(s[2], 4)).toBe(true);
  });

  it("una fermata lontana dal tracciato, o senza posizione, resta senza; le altre no", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(3)]))!;
    const s = posizioniSulTracciato(t, [qui(0), qui(1, ENTRO_KM + 0.2), null, qui(3)]);
    expect(s[1]).toBeNull();
    expect(s[2]).toBeNull();
    expect(vicino(s[0], 0)).toBe(true);
    expect(vicino(s[3], 3)).toBe(true);
  });

  it("una fermata che sul tracciato viene prima della precedente si salta", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(3)]))!;
    const s = posizioniSulTracciato(t, [qui(0), qui(2), qui(1), qui(3)]);
    expect(s[2]).toBeNull();
    expect(vicino(s[1], 2)).toBe(true);
    expect(vicino(s[3], 3)).toBe(true);
  });

  it("le tratte di un percorso: una per coppia di fermate consecutive, null dove manca", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(1), qui(1, 1)]))!;
    const tratte = trattePercorso(t, [qui(0), qui(1, 0.5), qui(5, 5), qui(1, 1)]);
    expect(tratte.length).toBe(3);
    const prima = tratte[0] as Tratta;
    expect(Math.abs(prima.metri - 1500)).toBeLessThanOrEqual(3);
    expect(prima.punti[1]).toEqual(qui(1));
    expect(tratte[1]).toBeNull();
    expect(tratte[2]).toBeNull();
  });

  it("due paline vicine, la seconda appena prima della prima: tutte e due nello stesso punto, e fra le due nessuna tratta (tappa 6.43)", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(2)]))!;
    /* la terza fermata è 15 m prima della seconda, sull'altro lato della strada */
    const fermate = [qui(0), qui(1), qui(0.985, -0.012), qui(2)];
    const s = posizioniSulTracciato(t, fermate);
    expect(s.every((x) => x != null)).toBe(true);
    expect(s[2]).toBe(s[1]);
    const tratte = trattePercorso(t, fermate);
    expect(tratte[1]).toBe("stesso_punto");
    expect(Math.abs((tratte[0] as Tratta).metri - 1000)).toBeLessThanOrEqual(2);
    expect(Math.abs((tratte[2] as Tratta).metri - 1000)).toBeLessThanOrEqual(2);
    /* oltre i 50 m all'indietro no: è un altro passaggio, o un ordine che non torna */
    expect(posizioniSulTracciato(t, [qui(0), qui(1), qui(0.9), qui(2)])[2]).toBeNull();
  });

  it("la distanza di una fermata dal tracciato, dal punto più vicino", () => {
    const t = tracciatoDa(forma("F", [qui(0), qui(1), qui(1, 1)]))!;
    expect(distanzaDalTracciato(t, qui(0.5, 0.2))).toBeCloseTo(0.2, 3);
    expect(distanzaDalTracciato(t, qui(1.15, 0.5))).toBeCloseTo(0.15, 3);
  });

  it("la stessa strada disegnata due volte è una; un'altra strada no", () => {
    const a = trattoFra(tracciatoDa(forma("A", [qui(0), qui(1), qui(2)]))!, 0, 2)!;
    const b = trattoFra(tracciatoDa(forma("B", [qui(0, 0.005), qui(0.5, 0.004), qui(2, 0.005)]))!, 0, 2)!;
    const c = trattoFra(tracciatoDa(forma("C", [qui(0), qui(1, 0.6), qui(2)]))!, 0, 2.4)!;
    expect(stessaStrada(a, b)).toBe(true);
    expect(stessaStrada(b, a)).toBe(true);
    expect(stessaStrada(a, c)).toBe(false);
  });
});

/* ── Il NeTEx: ServiceLink e rimandi dalle fermate dei percorsi ──────────── */

/**
 * Tre fermate su una strada verso est (A, B, C a 0, 1 e 2 km) e una a nord (D).
 * R1 va da A a C; R2 fa A-B lungo un tracciato disegnato a parte sulla stessa
 * strada, poi B-D; R3 va da A a B per un'altra strada; R4 non ha tracciato.
 */
const FERMATE = { A: qui(0, 0.01), B: qui(1, 0.01), C: qui(2, 0.01), D: qui(1, 1) };
const RETE: Gtfs = {
  "agency.txt": file(["agency_id"], [{ agency_id: "azienda" }]),
  "stops.txt": file(["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"],
    Object.entries(FERMATE).map(([id, [lat, lon]]) => ({ stop_id: id, stop_code: `${id}1`, stop_name: `Fermata ${id}`, stop_lat: lat, stop_lon: lon }))),
  "routes.txt": file(["route_id", "route_short_name", "route_long_name", "route_type"],
    ["R1", "R2", "R3", "R4"].map((r) => ({ route_id: r, route_short_name: r, route_long_name: `Linea ${r}`, route_type: 3 }))),
  "trips.txt": file(["route_id", "service_id", "trip_id", "direction_id", "shape_id"], [
    { route_id: "R1", service_id: "FER", trip_id: "T1", direction_id: 0, shape_id: "F1" },
    { route_id: "R1", service_id: "FER", trip_id: "T1b", direction_id: 0, shape_id: "F1" },
    { route_id: "R2", service_id: "FER", trip_id: "T2", direction_id: 0, shape_id: "F2" },
    { route_id: "R3", service_id: "FER", trip_id: "T3", direction_id: 0, shape_id: "F3" },
    { route_id: "R4", service_id: "FER", trip_id: "T4", direction_id: 0, shape_id: "" },
  ]),
  "stop_times.txt": file(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
    ([["T1", "ABC"], ["T1b", "ABC"], ["T2", "ABD"], ["T3", "AB"], ["T4", "CA"]] as const).flatMap(([t, fermate]) =>
      [...fermate].map((s, i) => ({ trip_id: t, arrival_time: `07:0${i}:00`, departure_time: `07:0${i}:00`, stop_id: s, stop_sequence: i + 1 })))),
  "shapes.txt": file(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], [
    ...forma("F1", [qui(0), qui(0.5), qui(1), qui(1.5), qui(2)]),
    ...forma("F2", [qui(0, 0.004), qui(1, 0.004), qui(1, 1)]),
    ...forma("F3", [qui(0), qui(0, -0.8), qui(1, -0.8), qui(1)]),
  ]),
  "calendar.txt": file(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], [
    { service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: "20261106" },
  ]),
};
const OPZIONI = {
  codiceLocale: "ITI3", fornitore: null, partecipante: "azienda", prefisso: "epd", prefissoCodici: "AZ",
  azienda: { ragioneSociale: "Azienda di prova S.p.A.", nome: "Azienda di prova", sito: null, telefono: null, codice: "azienda" },
  adesso: new Date("2026-11-20T08:00:00Z"),
};

describe("Tratte nel NeTEx", () => {
  const { xml, conteggi } = netexDaGtfs(RETE, OPZIONI);
  const link = (codice: string) => new RegExp(`<ServiceLink id="epd:IT:ITI3:ServiceLink:${codice}" version="1">.*?</ServiceLink>`).exec(xml)?.[0] ?? "";
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!).filter((i) => i !== "iti3");
  const refs = [...xml.matchAll(/ ref="([^"]+)"/g)].map((m) => m[1]!).filter((r) => !r.startsWith("epip:") && r !== "iti3");
  const avanti = (linea: string) => [...xml.matchAll(new RegExp(`<StopPointInJourneyPattern id="epd:IT:ITI3:StopPointInJourneyPattern:AZ_${linea}-[^"]*" [^>]*>(.*?)</StopPointInJourneyPattern>`, "g"))]
    .map((m) => /<OnwardServiceLinkRef ref="epd:IT:ITI3:ServiceLink:([^"]+)"/.exec(m[1]!)?.[1] ?? null);

  it("una tratta per coppia di fermate e strada, come le chiama la Regione", () => {
    expect([...xml.matchAll(/<ServiceLink id="epd:IT:ITI3:ServiceLink:([^"]+)"/g)].map((m) => m[1])).toEqual(["AZ_A-AZ_B", "AZ_B-AZ_C", "AZ_B-AZ_D", "AZ_A-AZ_B_2"]);
    expect(conteggi.tratte).toBe(4);
    /* R4 non ha tracciato: la sua coppia resta senza tratta, e si conta */
    expect(conteggi.tratteSenzaTracciato).toBe(1);
  });

  it("la tratta ha il nome coi codici delle fermate, i metri, la polilinea e le due fermate", () => {
    const ab = link("AZ_A-AZ_B");
    expect(ab).toContain("<Name>A1-B1</Name>");
    const metri = Number(/<Distance>(\d+)<\/Distance>/.exec(ab)?.[1]);
    expect(Math.abs(metri - 1000)).toBeLessThanOrEqual(3);
    const punti = /<gml:posList>([^<]+)<\/gml:posList>/.exec(ab)![1]!.split(" ").map(Number);
    /* longitudine e latitudine: dalla proiezione di A, dal vertice a 0,5 km, alla proiezione di B */
    expect(punti.length).toBe(6);
    expect(punti[1]).toBeCloseTo(LAT, 5);
    expect(punti[0]).toBeCloseTo(qui(0)[1], 5);
    expect(punti[4]).toBeCloseTo(qui(1)[1], 5);
    expect(ab).toMatch(/<FromPointRef ref="epd:IT:ITI3:ScheduledStopPoint:AZ_A" version="1"\/><ToPointRef ref="epd:IT:ITI3:ScheduledStopPoint:AZ_B" version="1"\/><\/ServiceLink>$/);
    /* l'ordine degli elementi che lo schema vuole */
    expect(ab.indexOf("<Name>")).toBeLessThan(ab.indexOf("<Distance>"));
    expect(ab.indexOf("<Distance>")).toBeLessThan(ab.indexOf("<gml:LineString"));
    /* la seconda strada fra A e B è più lunga */
    expect(Number(/<Distance>(\d+)<\/Distance>/.exec(link("AZ_A-AZ_B_2"))?.[1])).toBeGreaterThan(2500);
  });

  it("le tratte stanno fra i punti di fermata e le assegnazioni; gli identificativi GML non si ripetono", () => {
    expect(xml.indexOf("</scheduledStopPoints>")).toBeLessThan(xml.indexOf("<serviceLinks>"));
    expect(xml.indexOf("</serviceLinks>")).toBeLessThan(xml.indexOf("<stopAssignments>"));
    const gml = [...xml.matchAll(/gml:id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(gml).size).toBe(gml.length);
    expect(gml.length).toBe(4);
  });

  it("ogni fermata del percorso rimanda alla tratta che ne parte; l'ultima no, e dove manca il tracciato nemmeno", () => {
    expect(avanti("R1")).toEqual(["AZ_A-AZ_B", "AZ_B-AZ_C", null]);
    /* R2 fra A e B fa la stessa strada di R1: la stessa tratta */
    expect(avanti("R2")).toEqual(["AZ_A-AZ_B", "AZ_B-AZ_D", null]);
    expect(avanti("R3")).toEqual(["AZ_A-AZ_B_2", null]);
    expect(avanti("R4")).toEqual([null, null]);
    /* il rimando sta subito dopo il punto di fermata, come vuole lo schema */
    expect(xml).toMatch(/<ScheduledStopPointRef ref="epd:IT:ITI3:ScheduledStopPoint:AZ_A" version="1"\/><OnwardServiceLinkRef ref="epd:IT:ITI3:ServiceLink:AZ_A-AZ_B" version="1"\/><ForAlighting>/);
  });

  it("ogni riferimento porta a un oggetto del file, e nessun identificativo si ripete", () => {
    const definiti = new Set(ids);
    expect(definiti.size).toBe(ids.length);
    expect(refs.filter((r) => !definiti.has(r))).toEqual([]);
  });

  it("senza tracciati il file non ha tratte né rimandi", () => {
    const { "shapes.txt": _, ...senza } = RETE;
    const r = netexDaGtfs(senza, OPZIONI);
    expect(r.xml).not.toContain("<serviceLinks>");
    expect(r.xml).not.toContain("OnwardServiceLinkRef");
    expect(r.conteggi.tratte).toBe(0);
    expect(r.conteggi.tratteSenzaTracciato).toBe(6);
  });

  it("lo stesso GTFS dà lo stesso file", () => {
    expect(netexDaGtfs(RETE, OPZIONI).xml).toBe(xml);
  });

  it("passa lo schema EPIP del profilo italiano (in CI xmllint è obbligatorio)", async () => {
    const esito = await validaNetex(xml);
    if (esito.stato === "senza_xmllint" && !process.env.NETEX_SCHEMA_OBBLIGATORIO) return;
    expect(esito).toEqual({ stato: "valido", errori: [] });
  });
});

/* ── Tappa 6.43: le fermate fuori dal tracciato, nel controllo del GTFS ──── */

describe("Le fermate fuori dal tracciato, nel controllo del GTFS", () => {
  const del = (g: Gtfs, codice: string) => verificaGtfs(g, "20261115").avvisi.find((a) => a.codice === codice);
  const conRighe = (g: Gtfs, f: string, righe: Array<Record<string, string | number>>): Gtfs => ({ ...g, [f]: { ...g[f]!, righe: [...g[f]!.righe, ...righe] } });

  it("fermate sul loro tracciato: nessun avviso; e senza tracciati nemmeno", () => {
    expect(del(RETE, "fermata_lontana_dal_tracciato")).toBeUndefined();
    expect(del(RETE, "fermata_fuori_ordine_sul_tracciato")).toBeUndefined();
    const { "shapes.txt": _, ...senza } = RETE;
    const v = verificaGtfs({ ...senza, "trips.txt": { ...RETE["trips.txt"]!, righe: RETE["trips.txt"]!.righe.map((t) => ({ ...t, shape_id: "" })) } }, "20261115");
    expect(v.avvisi.filter((a) => a.codice.includes("tracciato"))).toEqual([]);
  });

  it("una fermata a più di 100 m dal tracciato della sua corsa: avviso con la linea, la fermata e i metri", () => {
    /* D spostata 200 m a est della fine del tracciato di R2 */
    const g: Gtfs = { ...RETE, "stops.txt": { ...RETE["stops.txt"]!, righe: RETE["stops.txt"]!.righe.map((s) =>
      (s.stop_id === "D" ? { ...s, stop_lat: qui(1.2, 1)[0], stop_lon: qui(1.2, 1)[1] } : s)) } };
    const a = del(g, "fermata_lontana_dal_tracciato")!;
    expect(a.quante).toBe(1);
    expect(a.esempi).toEqual(["R2 · D «Fermata D»: 200 m"]);
    expect(a.messaggio).toContain("100 m");
    expect(rigaDelProblema(a)).toMatch(/^una fermata è a più di 100 m dal tracciato .*\(1\): R2 · D «Fermata D»: 200 m$/);
    /* entro i 300 m la tratta c'è ancora */
    expect(netexDaGtfs(g, OPZIONI).conteggi.tratteSenzaTracciato).toBe(1);
  });

  it("una fermata che il tracciato tocca solo prima della precedente: avviso, una volta per percorso", () => {
    /* R1 al ritorno sul tracciato dell'andata: da C a B il tracciato va nel verso opposto */
    let g = conRighe(RETE, "trips.txt", [
      { route_id: "R1", service_id: "FER", trip_id: "T5", direction_id: 1, shape_id: "F1" },
      { route_id: "R1", service_id: "FER", trip_id: "T5b", direction_id: 1, shape_id: "F1" },
    ]);
    g = conRighe(g, "stop_times.txt", ["T5", "T5b"].flatMap((t) => [
      { trip_id: t, arrival_time: "08:00:00", departure_time: "08:00:00", stop_id: "C", stop_sequence: 1 },
      { trip_id: t, arrival_time: "08:05:00", departure_time: "08:05:00", stop_id: "B", stop_sequence: 2 },
    ]));
    const a = del(g, "fermata_fuori_ordine_sul_tracciato")!;
    expect(a.quante).toBe(1);
    expect(a.esempi).toEqual(["R1 · B «Fermata B»"]);
    expect(del(g, "fermata_lontana_dal_tracciato")).toBeUndefined();
    /* l'export del NeTEx dice quali fermate guardare */
    expect(fermateFuoriTracciato(verificaGtfs(g, "20261115"))).toEqual(["R1 · B «Fermata B»"]);
  });

  it("due paline vicine nell'ordine sbagliato non sono un avviso, e nel NeTEx non mancano tratte", () => {
    /* E sta 15 m prima di B, sull'altro lato della strada: R5 fa A, B, E, C sul tracciato di R1 */
    let g = conRighe(RETE, "stops.txt", [{ stop_id: "E", stop_code: "E1", stop_name: "Fermata E", stop_lat: qui(0.985, -0.012)[0], stop_lon: qui(0.985, -0.012)[1] }]);
    g = conRighe(g, "routes.txt", [{ route_id: "R5", route_short_name: "R5", route_long_name: "Linea R5", route_type: 3 }]);
    g = conRighe(g, "trips.txt", [{ route_id: "R5", service_id: "FER", trip_id: "T6", direction_id: 0, shape_id: "F1" }]);
    g = conRighe(g, "stop_times.txt", [..."ABEC"].map((s, i) => ({ trip_id: "T6", arrival_time: `09:0${i}:00`, departure_time: `09:0${i}:00`, stop_id: s, stop_sequence: i + 1 })));
    expect(verificaGtfs(g, "20261115").avvisi.filter((a) => a.codice.includes("tracciato"))).toEqual([]);
    const { xml, conteggi } = netexDaGtfs(g, OPZIONI);
    expect(conteggi.tratteSenzaTracciato).toBe(1);
    expect(xml).toContain('<ServiceLink id="epd:IT:ITI3:ServiceLink:AZ_E-AZ_C" version="1">');
    expect(xml).not.toContain("AZ_B-AZ_E");
  });
});
