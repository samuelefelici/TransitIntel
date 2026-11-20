/**
 * Le tariffe nel GTFS consegnabile (tappa 6.37): i file di GTFS Fares v2 dai
 * dati dell'azienda e dalle polimetriche; il pagamento con carta a bordo e i
 * trasbordi dentro la durata (tappa 6.38). Dati inventati.
 */
import { describe, it, expect } from "vitest";
import {
  areaDelNodo, confiniDalleFasce, fileDelleTariffe, idCarta, polimetricaDelPercorso, reteDellaLinea, tariffeDellaLinea, tratteAutomatiche,
  type DatiDelleTariffe,
} from "../lib/gtfs-tariffe";
import type { Contactless } from "../lib/contactless";
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
    expect(regole.filter((r) => r.network_id === "urbano_lago")).toEqual([{ leg_group_id: "lg_lago_90", network_id: "urbano_lago", from_area_id: "", to_area_id: "", fare_product_id: "lago_90", rule_priority: 0 }]);
    /* con la colonna rule_priority un'area vuota vuol dire «l'area non conta»: la regola urbana vale anche da una fermata in un nodo extraurbano */
    expect(file["fare_leg_rules.txt"]!.colonne).toContain("rule_priority");
    expect(regole.every((r) => r.rule_priority === 0)).toBe(true);
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

  it("un biglietto urbano a tempo: le corse che cominciano dentro la durata non si pagano; gli abbonamenti non hanno trasbordi", () => {
    const { file } = fileDelleTariffe(dati());
    expect(file["fare_transfer_rules.txt"]!.righe).toEqual([
      { from_leg_group_id: "lg_lago_90", to_leg_group_id: "lg_lago_90", transfer_count: -1, duration_limit: 5400, duration_limit_type: 1, fare_transfer_type: 0, fare_product_id: "" },
    ]);
    /* andata e ritorno: due corse, non tutte quelle dentro la durata */
    const ar = fileDelleTariffe(dati({ titoli: [titolo({ titolo: "lago_ar", rete: "urbano_lago", tipo: "return", durataMinuti: 90 })] }));
    expect(ar.file["fare_leg_rules.txt"]!.righe.map((r) => r.fare_product_id)).toContain("lago_ar");
    expect(ar.file["fare_transfer_rules.txt"]).toBeUndefined();
  });

  describe("il pagamento con carta a bordo", () => {
    const CARTA: Contactless = {
      massimaleUnico: 10, finestraOre: 24, supporto: "carta_banca",
      tariffe: [
        { tipo: "urbano", primo: 2, secondo: 2, terzo: 1, validitaMinuti: 60, massimale: 5 },
        { tipo: "extraurbano", primo: 4, secondo: 4, terzo: 2, validitaMinuti: 75, massimale: 10 },
      ],
      reti: ["extraurbano", "urbano_lago"],
    };
    const SUPPORTI = [{ supporto: "carta", nome: "Biglietto di carta", tipo: 1 }, { supporto: "carta_banca", nome: "Carta bancaria", tipo: 3 }];
    const conCarta = (c: Partial<Contactless> = {}) => fileDelleTariffe(dati({ supporti: SUPPORTI, contactless: { ...CARTA, ...c } }));

    it("un titolo per tipo di rete, col primo viaggio e il supporto, per ogni categoria; sulle reti dove vale, accanto ai biglietti", () => {
      const { file, avvisi } = conCarta();
      const prodotti = file["fare_products.txt"]!.righe.filter((r) => String(r.fare_product_id).startsWith("contactless:"));
      expect(prodotti).toEqual([
        { fare_product_id: "contactless:urbano", fare_product_name: "Carta contactless a bordo · urbano", rider_category_id: "", fare_media_id: "carta_banca", amount: "2.00", currency: "EUR" },
        { fare_product_id: "contactless:extraurbano", fare_product_name: "Carta contactless a bordo · extraurbano", rider_category_id: "", fare_media_id: "carta_banca", amount: "4.00", currency: "EUR" },
      ]);
      const regole = file["fare_leg_rules.txt"]!.righe;
      expect(regole.filter((r) => r.fare_product_id === idCarta("urbano")).map((r) => r.network_id)).toEqual(["urbano_lago"]);
      /* su tutte le linee extraurbane del file, anche quella senza polimetrica, senza aree: vale ovunque sulla linea */
      expect(regole.filter((r) => r.fare_product_id === idCarta("extraurbano")).map((r) => [r.network_id, r.from_area_id, r.to_area_id]))
        .toEqual([[reteDellaLinea("D"), "", ""], [reteDellaLinea("Z"), "", ""]]);
      /* il biglietto di fascia resta: sulla linea D le 9 regole fra nodi più quella della carta */
      expect(regole.filter((r) => r.network_id === reteDellaLinea("D"))).toHaveLength(10);
      expect(avvisi.map((a) => a.codice).filter((c) => c.startsWith("contactless"))).toEqual([]);
    });

    it("dentro la validità le corse dopo la prima non si pagano; i massimali e i prezzi dal secondo viaggio non entrano nel GTFS", () => {
      const { file } = conCarta();
      expect(file["fare_transfer_rules.txt"]!.righe.map((r) => [r.from_leg_group_id, r.to_leg_group_id, r.transfer_count, r.duration_limit, r.duration_limit_type, r.fare_transfer_type, r.fare_product_id])).toEqual([
        ["lg_lago_90", "lg_lago_90", -1, 5400, 1, 0, ""],
        ["contactless:urbano", "contactless:urbano", -1, 3600, 1, 0, ""],
        ["contactless:extraurbano", "contactless:extraurbano", -1, 4500, 1, 0, ""],
      ]);
      const testo = JSON.stringify(file);
      expect(testo).not.toContain("10.00");
      expect(testo).not.toContain("5.00");
    });

    it("il GTFS con la carta passa la verifica; un trasbordo rotto è un errore", () => {
      const { file } = conCarta();
      const gtfs: Gtfs = { ...GTFS_ORARI, ...file };
      expect(verificaGtfs(gtfs).errori.filter((e) => /fare|network|area|rider|route_networks/.test(e.file))).toEqual([]);
      const rotto: Gtfs = {
        ...gtfs,
        "fare_transfer_rules.txt": { ...gtfs["fare_transfer_rules.txt"]!, righe: [
          ...gtfs["fare_transfer_rules.txt"]!.righe,
          { from_leg_group_id: "nessuno", to_leg_group_id: "contactless:urbano", transfer_count: "", duration_limit: "", duration_limit_type: "", fare_transfer_type: 0, fare_product_id: "" },
          { from_leg_group_id: "contactless:urbano", to_leg_group_id: "contactless:urbano", transfer_count: "", duration_limit: 60, duration_limit_type: "", fare_transfer_type: 7, fare_product_id: "manca" },
        ] },
      };
      expect(verificaGtfs(rotto).errori.map((e) => e.codice)).toEqual(expect.arrayContaining([
        "trasbordo_gruppo_inesistente", "trasbordo_senza_conteggio", "trasbordo_durata_senza_tipo", "trasbordo_tipo_non_valido", "trasbordo_titolo_inesistente",
      ]));
    });

    it("solo dove vale: senza la rete extraurbana niente carta sulle linee extraurbane; senza reti niente carta", () => {
      const soloUrbano = conCarta({ reti: ["urbano_lago"] }).file;
      expect(soloUrbano["fare_products.txt"]!.righe.map((r) => r.fare_product_id)).not.toContain(idCarta("extraurbano"));
      expect(soloUrbano["fare_leg_rules.txt"]!.righe.filter((r) => r.fare_product_id === idCarta("urbano"))).toHaveLength(1);
      const spento = conCarta({ reti: [] }).file;
      expect(JSON.stringify(spento)).not.toContain("contactless");
      expect(spento["fare_transfer_rules.txt"]!.righe).toHaveLength(1);
      /* una rete urbana che non ha linee nel file: niente titolo */
      const senzaLinee = fileDelleTariffe(dati({ supporti: SUPPORTI, contactless: { ...CARTA, reti: ["urbano_lago"] }, linee: [{ route_id: "D", route_short_name: "D" }] }));
      expect(JSON.stringify(senzaLinee.file)).not.toContain("contactless");
    });

    it("senza il supporto o senza la tariffa del tipo: un avviso", () => {
      const senzaSupporto = conCarta({ supporto: null });
      expect(senzaSupporto.file["fare_products.txt"]!.righe.find((r) => r.fare_product_id === idCarta("urbano"))?.fare_media_id).toBe("");
      expect(senzaSupporto.avvisi.map((a) => a.codice)).toContain("contactless_senza_supporto");
      /* un supporto che non c'è più fra quelli dell'azienda vale come nessun supporto */
      expect(conCarta({ supporto: "tessera_vecchia" }).avvisi.map((a) => a.codice)).toContain("contactless_senza_supporto");
      const senzaUrbana = conCarta({ tariffe: [CARTA.tariffe[1]!] });
      expect(senzaUrbana.avvisi.find((a) => a.codice === "contactless_senza_tariffa")?.esempi).toEqual(["urbano_lago"]);
      expect(senzaUrbana.file["fare_products.txt"]!.righe.map((r) => r.fare_product_id)).not.toContain(idCarta("urbano"));
    });
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
