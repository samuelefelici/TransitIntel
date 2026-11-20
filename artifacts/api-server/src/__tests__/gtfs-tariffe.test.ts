/**
 * Le tariffe nel GTFS consegnabile (tappa 6.37): i file di GTFS Fares v2 dai
 * dati dell'azienda e dalle polimetriche. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import {
  areaDelNodo, confiniDalleFasce, fileDelleTariffe, polimetricaDelPercorso, reteDellaLinea, tariffeDellaLinea, tratteAutomatiche,
  type DatiDelleTariffe,
} from "../lib/gtfs-tariffe";
import { fasciaDeiKm, type FasciaKm } from "../lib/fasce-km";
import { verificaGtfs, type Gtfs } from "../lib/gtfs-verifica";
import { firmaDi } from "../lib/dati-aperti";
import type { Linea, Percorso } from "../lib/polimetrica-programma";
import type { RetiAzienda } from "../lib/reti-linee";
import type { TitoloCatalogo } from "../lib/titoli-catalogo";

/* fasce da 6 km fino a 18, poi una fino a 30 */
const FASCE: FasciaKm[] = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 }, { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 18, price: 2.35 }, { fascia: 4, kmFrom: 18, kmTo: 30, price: 2.95 },
];

const fermata = (stopId: string, stopName: string, km: number) => ({ stopId, stopName, lat: 1, lon: 2, km, distPrev: 0 });
/* la linea D: andata (5 corse) e ritorno (3 corse) sulle stesse fermate */
const ANDATA: Percorso = {
  variantId: "va", routeId: "D", routeIds: ["D"], directionId: 0, tripCount: 5, firstStopName: "Borgo", lastStopName: "Fornace",
  stopCount: 5, totalKm: 14, distanceMethod: "shape", shape: null,
  stops: [fermata("s1", "Borgo", 0), fermata("s2", "Ponte", 4), fermata("s3", "Molino", 7), fermata("s4", "Lago", 10), fermata("s5", "Fornace", 14)],
};
const RITORNO: Percorso = {
  ...ANDATA, variantId: "vb", directionId: 1, tripCount: 3, firstStopName: "Fornace", lastStopName: "Borgo",
  stops: [fermata("s5", "Fornace", 0), fermata("s4", "Lago", 4), fermata("s3", "Molino", 7), fermata("s2", "Ponte", 10), fermata("s1", "Borgo", 14)],
};
const LINEA_D: Linea = { lineCode: "D", lineName: "Borgo - Fornace", routeIds: ["D"], percorsi: [RITORNO, ANDATA] };

describe("la fascia di una distanza, come nelle polimetriche", () => {
  it("al metro, il limite nella fascia di sotto, zero nella prima, oltre l'ultima l'ultima", () => {
    expect([0, 0.0004, 6, 6.0004, 6.001, 30, 45].map((k) => fasciaDeiKm(k, FASCE))).toEqual([1, 1, 1, 1, 2, 4, 4]);
    expect(fasciaDeiKm(5, [])).toBeNull();
  });
});

describe("le tratte di un percorso", () => {
  it("fatte dalle fasce: una per fascia dal capolinea, il punto alla prima fermata", () => {
    expect(confiniDalleFasce(ANDATA.stops, FASCE)).toEqual([2, 4]);
    expect(tratteAutomatiche(ANDATA.stops, FASCE)).toEqual([
      { da: 0, a: 2, punto: 0, nome: "" }, { da: 2, a: 4, punto: 2, nome: "" }, { da: 4, a: 4, punto: 4, nome: "" },
    ]);
  });

  it("una fermata già nodo della linea diventa il punto della sua tratta", () => {
    expect(tratteAutomatiche(RITORNO.stops, FASCE, new Set(["s4", "s1"])).map((t) => t.punto)).toEqual([1, 2, 4]);
  });

  it("con una polimetrica salvata: le sue tratte e i suoi punti, sui km del programma", () => {
    const salvata = {
      direction: "AB", name: "D", boundaries: [3],
      tratte: [{ index: 0, nodeName: "Borgo centro" }, { index: 1, nodeName: "" }],
      stops: ANDATA.stops.map((s, i) => ({ stopId: s.stopId, ...(i === 1 ? { punto: true } : {}) })),
    };
    const p = polimetricaDelPercorso(LINEA_D, ANDATA, salvata, FASCE);
    expect(p.fonte).toBe("salvata");
    expect(p.tratte).toEqual([{ da: 0, a: 3, punto: 1, nome: "Borgo centro" }, { da: 3, a: 4, punto: 3, nome: "" }]);
    /* una salvata che non torna più con le fermate: le tratte dalle fasce */
    expect(polimetricaDelPercorso(LINEA_D, ANDATA, { ...salvata, stops: [{ stopId: "altro" }, { stopId: "s2" }] }, FASCE).fonte).toBe("automatica");
  });
});

describe("i nodi e le coppie di una linea", () => {
  it("dal percorso più servito i nodi e le fermate; il ritorno riusa i nodi; fra due nodi la fascia più bassa", () => {
    const t = tariffeDellaLinea(LINEA_D, () => null, FASCE);
    /* il più servito è l'andata (5 corse): tratte s1-s2 (punto s1), s3-s4 (s3), s5 (s5) */
    expect([...t.nodi]).toEqual([["s1", "Borgo"], ["s3", "Molino"], ["s5", "Fornace"]]);
    expect(Object.fromEntries(t.fermate)).toEqual({ s1: "s1", s2: "s1", s3: "s3", s4: "s3", s5: "s5" });
    /* il ritorno riusa s5, s3, s1 come punti: tratte s5-s4 (s5), s3-s2 (s3), s1 (s1); s4 e s2 erano già altrove */
    expect(t.fermateContese).toEqual(["s2", "s4"]);
    expect([t.percorsi, t.salvati]).toEqual([2, 0]);
    expect(Object.fromEntries([...t.coppie].map(([k, f]) => [k.replace("\u0000", "-"), f]))).toEqual({
      "s1-s1": 1, "s1-s3": 2, "s1-s5": 3, "s3-s3": 1, "s3-s5": 2, "s5-s5": 1,
    });
    expect(t.coppieDiscordi).toBe(0);
  });

  it("due percorsi che danno fasce diverse alla stessa coppia: la più bassa, e si conta", () => {
    const corto: Percorso = { ...ANDATA, variantId: "vc", tripCount: 1, stops: [fermata("s1", "Borgo", 0), fermata("s5", "Fornace", 11)] };
    const t = tariffeDellaLinea({ ...LINEA_D, percorsi: [ANDATA, corto] }, () => null, FASCE);
    expect(t.coppie.get("s1\u0000s5")).toBe(2);
    expect(t.coppieDiscordi).toBe(1);
  });
});

describe("i file delle tariffe", () => {
  const RETI: RetiAzienda = {
    reti: [
      { rete: "urbano_lago", tipo: "urbano", nome: "Urbano del Lago", luogo: "Lago", sigla: "LA", zona: "lago_urban", codice: 2, colore: "#3b82f6", ordine: 1, corrispettivoKm: 2, corrispettivoSuVuoti: true },
      { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano", luogo: null, sigla: null, zona: null, codice: null, colore: "#f59e0b", ordine: 2, corrispettivoKm: 1.5, corrispettivoSuVuoti: true },
    ],
    regole: [{ tipo: "inizia", valore: "U", rete: "urbano_lago" }],
  };
  const titolo = (t: Partial<TitoloCatalogo> & Pick<TitoloCatalogo, "titolo" | "rete" | "tipo">): TitoloCatalogo => ({
    nome: t.titolo, categoria: "ordinario", prezzo: 1.5, durataMinuti: null, fascia: null, diRiferimento: false, ordine: 1, ...t,
  });
  const dati = (extra: Partial<DatiDelleTariffe> = {}): DatiDelleTariffe => ({
    linee: [{ route_id: "D", route_short_name: "D" }, { route_id: "U1", route_short_name: "U1" }, { route_id: "Z", route_short_name: "Z" }],
    fermate: new Set(["s1", "s2", "s3", "s4", "s5"]),
    reti: RETI,
    titoli: [
      titolo({ titolo: "lago_90", rete: "urbano_lago", tipo: "single", durataMinuti: 90, diRiferimento: true }),
      titolo({ titolo: "lago_mens", rete: "urbano_lago", tipo: "abbonamento_mensile", prezzo: 30, durataMinuti: 43200 }),
      titolo({ titolo: "extra_mens_3", rete: "extraurbano", tipo: "abbonamento_mensile", prezzo: 50, fascia: 3 }),
      titolo({ titolo: "extra_mens_9", rete: "extraurbano", tipo: "abbonamento_mensile", prezzo: 90, fascia: 9 }),
      titolo({ titolo: "lago_studenti", rete: "urbano_lago", tipo: "abbonamento_mensile", categoria: "studente" }),
    ],
    categorie: [{ categoria: "ordinario", nome: "Ordinaria", predefinita: true, url: null }],
    supporti: [{ supporto: "carta", nome: "Biglietto di carta", tipo: 1 }],
    fasce: FASCE,
    extraurbane: [tariffeDellaLinea(LINEA_D, () => null, FASCE)],
    ...extra,
  });
  const GTFS_ORARI: Gtfs = {
    "agency.txt": { colonne: ["agency_id", "agency_name", "agency_url", "agency_timezone"], righe: [{ agency_id: "a", agency_name: "Azienda", agency_url: "https://azienda.example", agency_timezone: "Europe/Rome" }] },
    "stops.txt": { colonne: ["stop_id", "stop_name", "stop_lat", "stop_lon"], righe: ["s1", "s2", "s3", "s4", "s5"].map((stop_id, i) => ({ stop_id, stop_name: stop_id, stop_lat: 1, stop_lon: 2 + i / 1000 })) },
    "routes.txt": { colonne: ["route_id", "agency_id", "route_short_name", "route_type"], righe: [{ route_id: "D", agency_id: "a", route_short_name: "D", route_type: 3 }, { route_id: "U1", agency_id: "a", route_short_name: "U1", route_type: 3 }, { route_id: "Z", agency_id: "a", route_short_name: "Z", route_type: 3 }] },
  };

  it("titoli dal catalogo e un biglietto per fascia; quelli che non tornano restano fuori, con un avviso", () => {
    const { file, avvisi } = fileDelleTariffe(dati());
    expect(file["fare_products.txt"]!.righe.map((r) => [r.fare_product_id, r.rider_category_id, r.amount])).toEqual([
      ["lago_90", "ordinario", "1.50"], ["lago_mens", "ordinario", "30.00"], ["extra_mens_3", "ordinario", "50.00"],
      ["extra_fascia_1", "ordinario", "1.35"], ["extra_fascia_2", "ordinario", "1.85"], ["extra_fascia_3", "ordinario", "2.35"], ["extra_fascia_4", "ordinario", "2.95"],
    ]);
    expect(file["fare_products.txt"]!.righe[2]!.fare_product_name).toBe("extra_mens_3 — Fascia 3 (12–18 km)");
    expect(avvisi.map((a) => [a.codice, a.esempi])).toEqual(expect.arrayContaining([
      ["titolo_senza_fascia", ["extra_mens_9"]], ["titolo_senza_categoria", ["lago_studenti (studente)"]],
    ]));
    expect(file["rider_categories.txt"]!.righe).toEqual([{ rider_category_id: "ordinario", rider_category_name: "Ordinaria", is_default_fare_category: 1, eligibility_url: "" }]);
    expect(file["fare_media.txt"]!.righe).toEqual([{ fare_media_id: "carta", fare_media_name: "Biglietto di carta", fare_media_type: 1 }]);
  });

  it("le reti: le urbane dell'azienda, una per ogni linea extraurbana; ogni linea nella sua", () => {
    const { file, avvisi } = fileDelleTariffe(dati());
    expect(file["networks.txt"]!.righe).toEqual([
      { network_id: "extraurbano:D", network_name: "Extraurbano · linea D" }, { network_id: "urbano_lago", network_name: "Urbano del Lago" },
      { network_id: "extraurbano:Z", network_name: "Extraurbano · linea Z" },
    ]);
    expect(file["route_networks.txt"]!.righe).toEqual([
      { network_id: "extraurbano:D", route_id: "D" }, { network_id: "urbano_lago", route_id: "U1" }, { network_id: "extraurbano:Z", route_id: "Z" },
    ]);
    expect(avvisi.find((a) => a.codice === "linea_senza_polimetrica")?.esempi).toEqual(["Z"]);
  });

  it("le regole: sulla rete urbana il suo biglietto ovunque; sulla linea extraurbana, fra due nodi, la fascia", () => {
    const { file } = fileDelleTariffe(dati());
    const regole = file["fare_leg_rules.txt"]!.righe;
    expect(regole.filter((r) => r.network_id === "urbano_lago")).toEqual([{ leg_group_id: "lg_lago_90", network_id: "urbano_lago", from_area_id: "", to_area_id: "", fare_product_id: "lago_90" }]);
    const extra = regole.filter((r) => r.network_id === reteDellaLinea("D"));
    expect(extra).toHaveLength(9); // 3 nodi: 3 a sé, 3 coppie nei due versi
    expect(extra.find((r) => r.from_area_id === areaDelNodo("D", "s1") && r.to_area_id === areaDelNodo("D", "s5"))?.fare_product_id).toBe("extra_fascia_3");
    expect(extra.find((r) => r.from_area_id === areaDelNodo("D", "s5") && r.to_area_id === areaDelNodo("D", "s1"))?.fare_product_id).toBe("extra_fascia_3");
    expect(file["areas.txt"]!.righe).toEqual([
      { area_id: "extraurbano:D:s1", area_name: "Borgo (linea D)" }, { area_id: "extraurbano:D:s3", area_name: "Molino (linea D)" }, { area_id: "extraurbano:D:s5", area_name: "Fornace (linea D)" },
    ]);
    expect(file["stop_areas.txt"]!.righe).toHaveLength(5);
  });

  it("il GTFS con le tariffe passa la verifica; un riferimento rotto è un errore", () => {
    const { file } = fileDelleTariffe(dati());
    const gtfs: Gtfs = { ...GTFS_ORARI, ...file };
    const errori = verificaGtfs(gtfs).errori.filter((e) => /fare|network|area|rider|route_networks/.test(e.file));
    expect(errori).toEqual([]);
    const rotto: Gtfs = {
      ...gtfs,
      "fare_leg_rules.txt": { ...gtfs["fare_leg_rules.txt"]!, righe: [...gtfs["fare_leg_rules.txt"]!.righe, { leg_group_id: "x", network_id: "nessuna", from_area_id: "", to_area_id: "", fare_product_id: "nessuno" }] },
      "stop_areas.txt": { ...gtfs["stop_areas.txt"]!, righe: [...gtfs["stop_areas.txt"]!.righe, { area_id: "extraurbano:D:s1", stop_id: "s99" }] },
    };
    expect(verificaGtfs(rotto).errori.map((e) => e.codice).sort()).toEqual(expect.arrayContaining(["fermata_inesistente", "regola_rete_inesistente", "regola_titolo_inesistente"]));
  });

  it("senza fasce, niente tariffe extraurbane (con un avviso); senza titoli, nessun file", () => {
    const senzaFasce = fileDelleTariffe(dati({ fasce: [], extraurbane: [tariffeDellaLinea(LINEA_D, () => null, [])] }));
    expect(senzaFasce.file["fare_leg_rules.txt"]!.righe.every((r) => r.network_id === "urbano_lago")).toBe(true);
    expect(senzaFasce.avvisi.map((a) => a.codice)).toContain("senza_fasce");
    expect(fileDelleTariffe(dati({ titoli: [], fasce: [] })).file).toEqual({});
  });

  it("una fermata delle polimetriche che non è nel file resta fuori, con un avviso", () => {
    const { file, avvisi } = fileDelleTariffe(dati({ fermate: new Set(["s1", "s2", "s3", "s4"]) }));
    expect(file["stop_areas.txt"]!.righe.map((r) => r.stop_id)).not.toContain("s5");
    expect(avvisi.find((a) => a.codice === "fermata_non_nel_file")?.esempi).toEqual(["s5"]);
  });
});

describe("la firma del GTFS dei dati aperti", () => {
  it("cambia con le tariffe; quella del NeTEx no", () => {
    const v = { versioneId: "v", feedId: "f" };
    const a: any = { compilata: true, gtfsAgencyId: "a", ragioneSociale: "Azienda", sito: null, telefono: null };
    expect(firmaDi("gtfs", v, a, [], "uno")).not.toBe(firmaDi("gtfs", v, a, [], "due"));
    expect(firmaDi("gtfs", v, a, [], null)).toBe(firmaDi("gtfs", v, a));
    expect(firmaDi("netex", v, a, [], "uno")).toBe(firmaDi("netex", v, a, [], "due"));
  });
});
