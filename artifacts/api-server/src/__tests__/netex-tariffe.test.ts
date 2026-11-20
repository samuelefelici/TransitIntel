/**
 * NeTEx con il profilo italiano, livello 3: le tariffe (tappa 6.40). Dalle
 * tariffe del GTFS (fatte da fileDelleTariffe, come nell'export) al FareFrame,
 * e il file che ne esce passato allo schema del livello 3 con xmllint (se
 * c'è: in CI sì). Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { netexDaGtfs } from "../lib/netex";
import { codiceZona, durataIso, periodoDelTitolo, profiloDellaCategoria, type TariffePerNetex } from "../lib/netex-tariffe";
import { fileDelleTariffe, tariffeDellaLinea, type DatiDelleTariffe } from "../lib/gtfs-tariffe";
import { validaNetex, schemaPer, SCHEMA_EPIP, SCHEMA_LIVELLO_3 } from "../lib/netex-validazione";
import type { Gtfs } from "../lib/gtfs-verifica";
import type { FasciaKm } from "../lib/fasce-km";
import type { Contactless } from "../lib/contactless";
import type { Linea, Percorso } from "../lib/polimetrica-programma";
import type { RetiAzienda } from "../lib/reti-linee";
import type { TitoloCatalogo } from "../lib/titoli-catalogo";

const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });
const LAT = 45, LON = 9;

/* una linea urbana U1 su tre fermate, una extraurbana X1 su quattro, a 0, 4, 7 e 11 km */
const URBANE = ["P1", "P2", "P3"], EXTRA = ["E1", "E2", "E3", "E4"], KM = [0, 4, 7, 11];
const ORARI: Gtfs = {
  "agency.txt": file(["agency_id"], [{ agency_id: "azienda" }]),
  "stops.txt": file(["stop_id", "stop_name", "stop_lat", "stop_lon"], [
    ...URBANE.map((s, i) => ({ stop_id: s, stop_name: `Piazza ${i + 1}`, stop_lat: LAT + i / 100, stop_lon: LON })),
    ...EXTRA.map((s, i) => ({ stop_id: s, stop_name: `Borgo ${i + 1}`, stop_lat: LAT, stop_lon: LON + (i + 1) / 10 })),
  ]),
  "routes.txt": file(["route_id", "route_short_name", "route_long_name", "route_type"], [
    { route_id: "U1", route_short_name: "U1", route_long_name: "Anello del lago", route_type: 3 },
    { route_id: "X1", route_short_name: "X1", route_long_name: "Borgo - Valle", route_type: 3 },
  ]),
  "trips.txt": file(["route_id", "service_id", "trip_id", "direction_id"], [
    { route_id: "U1", service_id: "FER", trip_id: "T1", direction_id: 0 },
    { route_id: "X1", service_id: "FER", trip_id: "T2", direction_id: 0 },
  ]),
  "stop_times.txt": file(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], [
    ...URBANE.map((s, i) => ({ trip_id: "T1", arrival_time: `07:0${i}:00`, departure_time: `07:0${i}:00`, stop_id: s, stop_sequence: i + 1 })),
    ...EXTRA.map((s, i) => ({ trip_id: "T2", arrival_time: `08:${10 + i * 5}:00`, departure_time: `08:${10 + i * 5}:00`, stop_id: s, stop_sequence: i + 1 })),
  ]),
  "calendar.txt": file(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], [
    { service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: "20261106" },
  ]),
};

const FASCE: FasciaKm[] = [{ fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 }, { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 }];
const RETI: RetiAzienda = {
  reti: [
    { rete: "urbano_lago", tipo: "urbano", nome: "Urbano del Lago", luogo: "Lago", sigla: "LA", zona: "lago_urban", codice: 2, colore: "#3b82f6", ordine: 1, corrispettivoKm: null, corrispettivoSuVuoti: false },
    { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano", luogo: null, sigla: null, zona: null, codice: null, colore: "#f59e0b", ordine: 2, corrispettivoKm: null, corrispettivoSuVuoti: false },
  ],
  regole: [{ tipo: "inizia", valore: "U", rete: "urbano_lago" }],
};
const titolo = (t: Partial<TitoloCatalogo> & Pick<TitoloCatalogo, "titolo" | "rete" | "tipo">): TitoloCatalogo => ({
  nome: t.titolo, categoria: "ordinario", prezzo: 1.5, durataMinuti: null, fascia: null, diRiferimento: false, ordine: 1, ...t,
});
const TITOLI = [
  titolo({ titolo: "lago_60min", nome: "Biglietto 60 minuti", rete: "urbano_lago", tipo: "single", durataMinuti: 60, diRiferimento: true }),
  titolo({ titolo: "lago_mens", nome: "Mensile urbano", rete: "urbano_lago", tipo: "abbonamento_mensile", prezzo: 30, durataMinuti: 43200 }),
  titolo({ titolo: "lago_mens_scuola", nome: "Mensile scolari", rete: "urbano_lago", tipo: "abbonamento_mensile", prezzo: 18, durataMinuti: 43200, categoria: "scolari" }),
  titolo({ titolo: "extra_mens_2", nome: "Mensile extraurbano", rete: "extraurbano", tipo: "abbonamento_mensile", prezzo: 45, durataMinuti: 43200, fascia: 2 }),
];
const fermata = (i: number) => ({ stopId: EXTRA[i]!, stopName: `Borgo ${i + 1}`, lat: LAT, lon: LON + (i + 1) / 10, km: KM[i]!, distPrev: 0 });
const PERCORSO: Percorso = {
  variantId: "va", routeId: "X1", routeIds: ["X1"], directionId: 0, tripCount: 1, firstStopName: "Borgo 1", lastStopName: "Borgo 4",
  stopCount: 4, totalKm: 11, distanceMethod: "shape", shape: null, stops: EXTRA.map((_, i) => fermata(i)),
};
const LINEA: Linea = { lineCode: "X1", lineName: "Borgo - Valle", routeIds: ["X1"], percorsi: [PERCORSO] };
const CARTA: Contactless = {
  massimaleUnico: 10, finestraOre: 24, supporto: "carta_banca",
  tariffe: [
    { tipo: "urbano", primo: 2, secondo: 2, terzo: 1, validitaMinuti: 60, massimale: 5 },
    { tipo: "extraurbano", primo: 4, secondo: 4, terzo: 2, validitaMinuti: 60, massimale: 10 },
  ],
  reti: ["extraurbano", "urbano_lago"],
};
const DATI: DatiDelleTariffe = {
  linee: ORARI["routes.txt"]!.righe, fermate: new Set([...URBANE, ...EXTRA]), reti: RETI, titoli: TITOLI,
  categorie: [{ categoria: "ordinario", nome: "Ordinaria", predefinita: true, url: null }, { categoria: "scolari", nome: "Scolari under 14", predefinita: false, url: null }],
  supporti: [{ supporto: "carta", nome: "Biglietto di carta", tipo: 1 }, { supporto: "carta_banca", nome: "Carta bancaria", tipo: 3 }],
  fasce: FASCE, extraurbane: [tariffeDellaLinea(LINEA, () => null, FASCE)], contactless: CARTA,
};
const PER_NETEX: TariffePerNetex = {
  titoli: new Map(TITOLI.map((t) => [t.titolo, { tipo: t.tipo, durataMinuti: t.durataMinuti, fascia: t.fascia, rete: t.rete }])),
  fasce: FASCE, contactless: CARTA,
};
const OPZIONI = {
  codiceLocale: "ITI3", fornitore: null, partecipante: "azienda", prefisso: "epd", prefissoCodici: "AZ",
  azienda: { ragioneSociale: "Azienda di prova S.p.A.", nome: "Azienda di prova", sito: null, telefono: null, codice: "azienda" },
  adesso: new Date("2026-11-20T08:00:00Z"),
};
const GTFS: Gtfs = { ...ORARI, ...fileDelleTariffe(DATI).file };

describe("NeTEx livello 3: i pezzi", () => {
  it("le durate come le vuole lo schema", () => {
    expect([durataIso(60), durataIso(100), durataIso(1440), durataIso(43200), durataIso(525600)]).toEqual(["PT60M", "PT100M", "P1D", "P30D", "P365D"]);
  });

  it("il profilo di una categoria: il tipo e l'età dal nome; la predefinita vale per tutti", () => {
    expect(profiloDellaCategoria("ordinario", "Tariffa ordinaria", true)).toEqual({ tipo: "anyone", minima: null, massima: null });
    expect(profiloDellaCategoria("studente_under14", "Studente under 14", false)).toEqual({ tipo: "student", minima: null, massima: 13 });
    expect(profiloDellaCategoria("studente", "Studente (14+ anni)", false)).toEqual({ tipo: "student", minima: 14, massima: null });
    expect(profiloDellaCategoria("anziano", "Over 65", false)).toEqual({ tipo: "senior", minima: 65, massima: null });
    expect(profiloDellaCategoria("agevolato", "ISEE basso", false).tipo).toBe("other");
  });

  it("il periodo di validità di ogni tipo di titolo", () => {
    expect(periodoDelTitolo("single", null)).toEqual({ codice: "corsa-semplice", tipo: "singleRide", durata: null });
    expect(periodoDelTitolo("single", 60)).toEqual({ codice: "corsa-PT60M", tipo: "singleTrip", durata: "PT60M" });
    expect(periodoDelTitolo("return", 60).tipo).toBe("returnTrip");
    expect(periodoDelTitolo("abbonamento_settimanale", 10080)).toEqual({ codice: "settimanale-P7D", tipo: "weeklyPass", durata: "P7D" });
    expect(periodoDelTitolo("abbonamento_annuale", 388800).durata).toBe("P270D");
    expect(codiceZona("extraurbano:X1:E1")).toBe("extraurbano-X1-E1");
  });
});

describe("NeTEx livello 3: il file", () => {
  const { xml, conteggi } = netexDaGtfs(GTFS, { ...OPZIONI, tariffe: PER_NETEX });
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!).filter((i) => i !== "iti3");
  const refs = [...xml.matchAll(/ ref="([^"]+)"/g)].map((m) => m[1]!).filter((r) => !r.startsWith("epip:") && r !== "iti3");
  const pezzo = (tipo: string, codice: string) => {
    const m = new RegExp(`<${tipo} id="epd:IT:ITI3:${tipo}:AZ_${codice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>.*?</${tipo}>`, "s").exec(xml);
    return m?.[0] ?? "";
  };

  it("senza le tariffe il file resta di livello 1, come prima", () => {
    const l1 = netexDaGtfs(ORARI, OPZIONI);
    expect(l1.xml).not.toContain("<FareFrame");
    expect(l1.xml).not.toContain("<tariffZones>");
    expect(l1.xml).toContain("livello 1 (EPIP)");
    expect(l1.conteggi.tariffe).toBeNull();
    /* le tariffe nel GTFS ma senza quello che il livello 3 vuole: livello 1 */
    expect(netexDaGtfs(GTFS, OPZIONI).xml).toBe(netexDaGtfs(GTFS, { ...OPZIONI, tariffe: null }).xml);
    expect(netexDaGtfs(GTFS, OPZIONI).xml).not.toContain("<FareFrame");
    expect(schemaPer(l1.xml)).toBe(SCHEMA_EPIP);
  });

  it("le zone: la rete urbana e i nodi della linea extraurbana; ogni fermata dice le sue", () => {
    expect(xml).toContain("livello 3 (con le tariffe)");
    expect(conteggi.tariffe).toMatchObject({ zone: 3, profili: 2, supporti: 2, fasce: 2, fuori: 0 });
    expect(xml).toContain('<TariffZone id="epd:IT:ITI3:TariffZone:AZ_urbano_lago" version="1"><Name>Urbano del Lago</Name></TariffZone>');
    expect(xml).toMatch(/<TariffZone id="epd:IT:ITI3:TariffZone:AZ_extraurbano-X1-E1" version="1"><Name>[^<]*\(linea X1\)<\/Name>/);
    expect(xml).toMatch(/<ScheduledStopPoint id="epd:IT:ITI3:ScheduledStopPoint:AZ_P2" [^>]*>.*?<tariffZones><TariffZoneRef ref="epd:IT:ITI3:TariffZone:AZ_urbano_lago" version="1"\/><\/tariffZones><\/ScheduledStopPoint>/);
    expect(xml).toMatch(/<ScheduledStopPoint id="epd:IT:ITI3:ScheduledStopPoint:AZ_E2" [^>]*>.*?<TariffZoneRef ref="epd:IT:ITI3:TariffZone:AZ_extraurbano-X1-E1" version="1"\/>/);
    /* le zone nello ServiceFrame, prima delle assegnazioni delle fermate */
    expect(xml.indexOf("<tariffZones>\n")).toBeLessThan(xml.indexOf("<stopAssignments>"));
  });

  it("i titoli del catalogo: periodo, profilo, zona, durata o fascia, e il prezzo", () => {
    const urbano = pezzo("FareStructureElement", "lago_60min");
    expect(urbano).toContain('<TimeIntervalRef ref="epd:IT:ITI3:TimeInterval:AZ_60min" version="1"/>');
    expect(urbano).toContain('<UsageValidityPeriodRef ref="epd:IT:ITI3:UsageValidityPeriod:AZ_corsa-PT60M" version="1"/>');
    expect(urbano).toContain('<UserProfileRef ref="epd:IT:ITI3:UserProfile:AZ_ordinario" version="1"/>');
    expect(urbano).toContain('<TariffZoneRef ref="epd:IT:ITI3:TariffZone:AZ_urbano_lago" version="1"/>');
    expect(pezzo("FareStructureElement", "lago_mens_scuola")).toContain('<UserProfileRef ref="epd:IT:ITI3:UserProfile:AZ_scolari" version="1"/>');
    expect(pezzo("UserProfile", "scolari")).toBe('<UserProfile id="epd:IT:ITI3:UserProfile:AZ_scolari" version="1"><UserType>student</UserType><MaximumAge>13</MaximumAge></UserProfile>');
    expect(pezzo("FareStructureElement", "extra_mens_2")).toContain('<GeographicalIntervalRef ref="epd:IT:ITI3:GeographicalInterval:AZ_fascia-2" version="1"/>');
    expect(pezzo("FareTable", "lago_mens")).toContain("<Amount>30.00</Amount><Currency>EUR</Currency>");
    expect(pezzo("PreassignedFareProduct", "lago_60min")).toContain("<Name>Biglietto 60 minuti</Name><ChargingMomentType>beforeTravel</ChargingMomentType>");
    expect(pezzo("UsageValidityPeriod", "mensile-P30D")).toContain("<ValidityPeriodType>monthlyPass</ValidityPeriodType><StandardDuration>P30D</StandardDuration>");
  });

  it("l'extraurbano di corsa semplice: un titolo, il prezzo di ogni coppia di nodi dalla sua fascia", () => {
    const regole = GTFS["fare_leg_rules.txt"]!.righe.filter((r) => r.from_area_id && r.to_area_id);
    expect(conteggi.tariffe?.coppie).toBe(regole.length);
    expect(xml.match(/<DistanceMatrixElement /g)?.length).toBe(regole.length);
    /* da E1 a E3: 7 km, la fascia 2 */
    const r = regole.find((x) => x.from_area_id === "extraurbano:X1:E1" && x.to_area_id === "extraurbano:X1:E3")!;
    expect(r.fare_product_id).toBe("extra_fascia_2");
    expect(pezzo("DistanceMatrixElementPrice", "extraurbano-X1-E1--E3")).toContain("<Name>Fascia 2</Name><Amount>1.85</Amount>");
    expect(pezzo("DistanceMatrixElement", "extraurbano-X1-E1--E3")).toBe(
      '<DistanceMatrixElement id="epd:IT:ITI3:DistanceMatrixElement:AZ_extraurbano-X1-E1--E3" version="1"><StartTariffZoneRef ref="epd:IT:ITI3:TariffZone:AZ_extraurbano-X1-E1" version="1"/>'
      + '<EndTariffZoneRef ref="epd:IT:ITI3:TariffZone:AZ_extraurbano-X1-E3" version="1"/></DistanceMatrixElement>');
    expect(pezzo("GeographicalIntervalPrice", "fascia-1")).toContain("<Amount>1.35</Amount>");
    expect(pezzo("PreassignedFareProduct", "extraurbano-corsa-semplice")).toContain("<Name>Extraurbano, corsa semplice</Name>");
    /* nel GTFS sono un biglietto per fascia; qui no */
    expect(xml).not.toContain("PreassignedFareProduct:AZ_extra_fascia_");
  });

  it("la carta: tre viaggi a prezzo, il massimale, il massimale unico, a bordo col supporto della carta", () => {
    const tabella = pezzo("FareTable", "contactless-urbano");
    expect(tabella).toContain("<CappingRulePrice id=\"epd:IT:ITI3:CappingRulePrice:AZ_contactless-urbano\" version=\"1\"><Name>Massimale</Name><Amount>5.00</Amount>");
    expect([...tabella.matchAll(/<Name>(\d)° viaggio<\/Name><Amount>([\d.]+)<\/Amount>/g)].map((m) => [m[1], m[2]])).toEqual([["1", "2.00"], ["2", "2.00"], ["3", "1.00"]]);
    const titoloCarta = pezzo("PreassignedFareProduct", "contactless-urbano");
    expect(titoloCarta).toContain("<ChargingMomentType>atEndOfFareDay</ChargingMomentType>");
    expect(titoloCarta).toContain("al massimo 5,00 € in 24 ore dal primo tap; usando urbano ed extraurbano al massimo 10,00 €");
    expect(pezzo("UsageValidityPeriod", "carta-24h")).toContain("<ValidityPeriodType>cap</ValidityPeriodType><StandardDuration>P1D</StandardDuration>");
    expect(pezzo("FareTable", "contactless-massimale-unico")).toContain("<Amount>10.00</Amount>");
    const pacchetto = pezzo("SalesOfferPackage", "contactless-extraurbano");
    expect(pacchetto).toContain('<DistributionChannelRef ref="epd:IT:ITI3:DistributionChannel:AZ_a-bordo-carta" version="1"/>');
    expect(pacchetto).toContain('<FareTableRef ref="epd:IT:ITI3:FareTable:AZ_contactless-massimale-unico" version="1"/>');
    expect(pacchetto).toContain('<TypeOfTravelDocumentRef ref="epd:IT:ITI3:TypeOfTravelDocument:AZ_carta_banca" version="1"/>');
    /* l'extraurbano vale sulle linee extraurbane del file; l'urbano sulla sua zona */
    expect(pezzo("FareStructureElement", "contactless-extraurbano-1")).toContain('<LineRef ref="epd:IT:ITI3:Line:AZ_X1" version="1"/>');
    expect(pezzo("FareStructureElement", "contactless-urbano-3")).toContain('order="3"');
    expect(pezzo("TypeOfTravelDocument", "carta_banca")).toContain("<MediaType>card</MediaType><MachineReadable>chip nfc</MachineReadable>");
    expect(conteggi.tariffe?.prodotti).toBe(4 + 1 + 2);
  });

  it("senza la carta, o con la carta solo sull'urbano, niente massimale unico", () => {
    const senza = netexDaGtfs({ ...ORARI, ...fileDelleTariffe({ ...DATI, contactless: null }).file }, { ...OPZIONI, tariffe: { ...PER_NETEX, contactless: null } });
    expect(senza.xml).not.toContain("contactless");
    expect(senza.xml).not.toContain("<distributionChannels>");
    const soloUrbano = { ...CARTA, reti: ["urbano_lago"] };
    const urbano = netexDaGtfs({ ...ORARI, ...fileDelleTariffe({ ...DATI, contactless: soloUrbano }).file }, { ...OPZIONI, tariffe: { ...PER_NETEX, contactless: soloUrbano } });
    expect(urbano.xml).toContain("PreassignedFareProduct:AZ_contactless-urbano");
    expect(urbano.xml).not.toContain("contactless-extraurbano");
    expect(urbano.xml).not.toContain("massimale-unico");
  });

  it("un titolo del GTFS che il catalogo non conosce resta fuori, e si conta", () => {
    const meno = new Map(PER_NETEX.titoli); meno.delete("lago_mens");
    const r = netexDaGtfs(GTFS, { ...OPZIONI, tariffe: { ...PER_NETEX, titoli: meno } });
    expect(r.conteggi.tariffe?.fuori).toBe(1);
    expect(r.xml).not.toContain("PreassignedFareProduct:AZ_lago_mens\"");
  });

  it("ogni riferimento porta a un oggetto del file, e nessun identificativo si ripete", () => {
    const definiti = new Set(ids);
    expect(definiti.size).toBe(ids.length);
    expect(refs.filter((r) => !definiti.has(r))).toEqual([]);
  });

  it("passa lo schema del livello 3 del profilo italiano (in CI xmllint è obbligatorio)", async () => {
    expect(schemaPer(xml)).toBe(SCHEMA_LIVELLO_3);
    const esito = await validaNetex(xml);
    if (esito.stato === "senza_xmllint" && !process.env.NETEX_SCHEMA_OBBLIGATORIO) return;
    expect(esito).toEqual({ stato: "valido", errori: [] });
  });

  it("uno sbagliato non passa lo schema del livello 3", async () => {
    const esito = await validaNetex(xml.replace("<ChargingMomentType>beforeTravel</ChargingMomentType>", "<ChargingMomentType>prima</ChargingMomentType>"));
    if (esito.stato === "senza_xmllint") return;
    expect(esito.stato).toBe("non_valido");
    expect(esito.errori.join(" ")).toContain("ChargingMomentType");
  });
});
