/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Fermata vista da Mizar — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * La risposta è quella vera dello StopMonitoring di Mizar del 14 settembre
 * 2026 sulla fermata 1122 (ridotta a tre passaggi: due statici e uno da un
 * mezzo seguito). Il feed è costruito a mano intorno a quelle corse, con un
 * caso per ogni cosa che il confronto deve saper dire: orario identico,
 * orario diverso, fermata assente dalla corsa, corsa assente dal feed,
 * linea diversa, circolare che passa due volte.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  parseStopMonitoringResponse, confrontaFermata, secondiLocali, secondiGtfs, scartoCircolare, leggiConfronto,
  leggiDiagnosi, type RigaOrario,
} from "../lib/siri-fermata";
import type { GtfsIndex } from "../lib/siri-vm";

const visita = (o: {
  line: string; corsa: string; partenza: string; arrivoCapolinea: string; aimed: string;
  monitored?: boolean; recorded?: string; expected?: string; stato?: string; display?: string;
}) => `
<MonitoredStopVisit>
  <RecordedAtTime>${o.recorded ?? "2026-09-14T00:00:00"}</RecordedAtTime>
  <MonitoringRef>1122</MonitoringRef>
  <MonitoredVehicleJourney>
    <LineRef>${o.line}</LineRef><DirectionRef>back</DirectionRef><VehicleMode>bus</VehicleMode>
    <RouteRef>${o.corsa}</RouteRef><PublishedLineName>LINEA ${o.line}</PublishedLineName>
    <OriginRef>242</OriginRef><OriginName>CHIARAVALLE Capolinea</OriginName>
    <DestinationRef>200</DestinationRef><DestinationName>Piazza Cavour (Conerobus Linee Nord)</DestinationName>
    <OriginAimedDepartureTime>${o.partenza}</OriginAimedDepartureTime>
    <DestinationAimedArrivalTime>${o.arrivoCapolinea}</DestinationAimedArrivalTime>
    <Monitored>${o.monitored ? "true" : "false"}</Monitored>
    <CourseOfJourneyRef>${o.corsa}</CourseOfJourneyRef>
    <MonitoredCall>
      <StopPointRef>1122</StopPointRef><VisitNumber>1</VisitNumber>
      <StopPointName>ANCONA (Via Marconi Gas)</StopPointName>
      <VehicleLocationAtStop><Longitude>13.50299</Longitude><Latitude>43.60976</Latitude></VehicleLocationAtStop>
      <DestinationDisplay>${o.display ?? "C1A"}</DestinationDisplay>
      <AimedArrivalTime>${o.aimed}</AimedArrivalTime><AimedDepartureTime>${o.aimed}</AimedDepartureTime>
      ${o.expected ? `<ExpectedDepartureTime>${o.expected}</ExpectedDepartureTime><DepartureStatus>${o.stato ?? "onTime"}</DepartureStatus>` : ""}
    </MonitoredCall>
  </MonitoredVehicleJourney>
</MonitoredStopVisit>`;

const risposta = (corpo: string, testa = `<Status>true</Status>`) => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<GetStopMonitoringResponse xmlns="http://www.siri.org.uk/siri">
<ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-14T10:01:49.4624945+02:00</ResponseTimestamp><ProducerRef xmlns="http://www.siri.org.uk/siri">SwarcoMizar</ProducerRef></ServiceDeliveryInfo>
<Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4">
<ResponseTimestamp>2026-09-14T10:01:49.7252452+02:00</ResponseTimestamp>
<ValidUntil>2026-09-14T11:01:49.7252452+02:00</ValidUntil>
<ShortestPossibleCycle>PT1M</ShortestPossibleCycle>
${testa}
${corpo}
<Note><MonitoringRef/></Note>
</StopMonitoringDelivery></Answer><AnswerExtension xmlns=""/>
</GetStopMonitoringResponse></s:Body></s:Envelope>`;

const XML = risposta([
  /* orario puro, identico nel feed */
  visita({ line: "C", corsa: "369660", partenza: "2026-09-14T09:30:00+02:00", arrivoCapolinea: "2026-09-14T10:20:00+02:00", aimed: "2026-09-14T10:12:00+02:00" }),
  /* orario puro, il feed lo ha due minuti prima */
  visita({ line: "N", corsa: "455469", partenza: "2026-09-14T09:30:00+02:00", arrivoCapolinea: "2026-09-14T10:20:00+02:00", aimed: "2026-09-14T10:14:00+02:00", display: "N1A1" }),
  /* mezzo seguito, con previsione; orario con i secondi */
  visita({ line: "CR3", corsa: "454460", partenza: "2026-09-14T10:00:00+02:00", arrivoCapolinea: "2026-09-14T10:50:00+02:00", aimed: "2026-09-14T10:46:08+02:00",
    monitored: true, recorded: "2026-09-14T10:01:25.7975277", expected: "2026-09-14T10:47:03", stato: "onTime", display: "CR319A" }),
].join(""), "");

describe("parseStopMonitoringResponse", () => {
  it("legge i passaggi con linea pubblica, numero di corsa, orari e previsione", () => {
    const r = parseStopMonitoringResponse(XML);
    expect(r.failed).toBe(false);
    expect(r.shortestPossibleCycleSec).toBe(60);
    expect(r.validUntil?.toISOString()).toBe("2026-09-14T09:01:49.725Z");
    expect(r.visite).toHaveLength(3);

    const [c, , cr3] = r.visite;
    expect(c).toMatchObject({
      lineRef: "C", courseOfJourneyRef: "369660", routeRef: "369660", stopPointRef: "1122",
      stopPointName: "ANCONA (Via Marconi Gas)", monitored: false, statico: true, destinationDisplay: "C1A",
      originName: "CHIARAVALLE Capolinea", destinationName: "Piazza Cavour (Conerobus Linee Nord)",
    });
    expect(c.aimedArrival?.toISOString()).toBe("2026-09-14T08:12:00.000Z");
    expect(c.expectedDeparture).toBeNull();

    expect(cr3).toMatchObject({ lineRef: "CR3", monitored: true, statico: false, departureStatus: "onTime" });
    expect(cr3.aimedArrival?.toISOString()).toBe("2026-09-14T08:46:08.000Z");
    /* ExpectedDepartureTime arriva SENZA offset: è ora di parete dell'azienda */
    expect(cr3.expectedDeparture?.toISOString()).toBe("2026-09-14T08:47:03.000Z");
    expect(cr3.recordedAt?.toISOString()).toBe("2026-09-14T08:01:25.797Z");
  });

  it("riconosce un Fault e un ErrorCondition", () => {
    const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>ContractFilter mismatch</faultstring></s:Fault></s:Body></s:Envelope>`;
    expect(parseStopMonitoringResponse(fault)).toMatchObject({ failed: true, errorText: "ContractFilter mismatch", visite: [] });
    const errc = risposta(`<ErrorCondition><OtherError/><Description>fermata sconosciuta</Description></ErrorCondition>`, `<Status>false</Status>`);
    expect(parseStopMonitoringResponse(errc)).toMatchObject({ failed: true, errorText: "fermata sconosciuta", visite: [] });
  });
});

describe("orari", () => {
  it("secondi locali, secondi GTFS oltre le 24 e scarto sul giro delle 24 ore", () => {
    expect(secondiLocali(new Date("2026-09-14T08:12:00Z"), "Europe/Rome")).toBe(10 * 3600 + 12 * 60);
    expect(secondiGtfs("25:10:00")).toBe(25 * 3600 + 10 * 60);
    expect(secondiGtfs("9:05")).toBe(9 * 3600 + 5 * 60);
    expect(secondiGtfs("boh")).toBeNull();
    expect(scartoCircolare(10 * 3600, 25 * 3600)).toBe(9 * 3600);      // 10:00 contro 25:00 = 01:00 → +9h
    expect(scartoCircolare(0, 86340)).toBe(60);                        // mezzanotte contro 23:59 → +1 min
    expect(scartoCircolare(36720, 36840)).toBe(-120);
  });
});

/* Un feed intorno alle tre corse della risposta, più i casi limite. */
function indice(): GtfsIndex {
  const trips = new Set([
    "689_CodUdp:D1690_369660",   // C, orario identico
    "689_CodUdp:D1690_455469",   // N, due minuti prima
    "689_CodUdp:D1690_454460",   // CR3, con i secondi, identico
  ]);
  const tripRoute = new Map([
    ["689_CodUdp:D1690_369660", "C"],
    ["689_CodUdp:D1690_455469", "N"],
    ["689_CodUdp:D1690_454460", "SA2"],   // nel feed la corsa sta su un'altra linea
  ]);
  const tripByCode = new Map([...trips].map(t => [t.split("_").pop()!, t]));
  return {
    feedId: "f", trips, routes: new Set(["C", "N", "SA2", "CR3"]), stops: new Set(["1122", "242", "200"]),
    tripRoute, tripByCode,
    routeByCode: new Map([["C", "C"], ["N", "N"], ["SA2", "SA2"], ["CR3", "CR3"]]),
    routeLongNames: [],
    stopNames: new Map([["1122", "ANCONA Via Marconi Gas"], ["242", "CHIARAVALLE Capolinea"], ["200", "Piazza Cavour"]]),
    stopByName: new Map(),
    timeZone: "Europe/Rome",
    loadedAt: 0,
  };
}
const orari = (): Map<string, RigaOrario[]> => new Map([
  ["689_CodUdp:D1690_369660", [
    { stopId: "242", seq: 1, scheduled: "09:30:00" },
    { stopId: "1122", seq: 12, scheduled: "10:12:00" },
    { stopId: "200", seq: 20, scheduled: "10:20:00" },
  ]],
  ["689_CodUdp:D1690_455469", [
    { stopId: "242", seq: 1, scheduled: "09:31:00" },     // parte un minuto dopo secondo il feed
    { stopId: "1122", seq: 12, scheduled: "10:16:00" },   // Mizar 10:14 → scarto −120
    { stopId: "200", seq: 20, scheduled: "10:20:00" },
  ]],
  ["689_CodUdp:D1690_454460", [
    { stopId: "242", seq: 1, scheduled: "10:00:00" },
    { stopId: "1122", seq: 3, scheduled: "10:46:08" },    // circolare: passa due volte
    { stopId: "1122", seq: 18, scheduled: "11:30:00" },
    { stopId: "200", seq: 20, scheduled: "10:50:00" },
  ]],
]);

describe("confrontaFermata", () => {
  const visite = parseStopMonitoringResponse(XML).visite;

  it("aggancia fermata e corse, sceglie l'occorrenza giusta e misura gli scarti", () => {
    const c = confrontaFermata("1122", visite, indice(), orari());
    expect(c.fermata).toMatchObject({ ref: "1122", stopId: "1122", nomeMizar: "ANCONA (Via Marconi Gas)", nomeFeed: "ANCONA Via Marconi Gas", agganciataCome: "id", conflitto: null });

    const [vC, vN, vCR3] = c.visite;
    expect(vC).toMatchObject({
      corsaNelFeed: true, fermataNellaCorsa: true, lineaCombacia: true, scartoAllaFermataSec: 0, scartoAllaPartenzaSec: 0,
      gtfs: { tripId: "689_CodUdp:D1690_369660", routeId: "C", orarioAllaFermata: "10:12:00", progressivo: 12, partenza: "09:30:00" },
      mizar: { linea: "C", corsa: "369660", arrivoProgrammato: "10:12:00", partenza: "09:30:00", seguito: false, partenzaPrevista: null },
    });
    expect(vN).toMatchObject({ scartoAllaFermataSec: -120, scartoAllaPartenzaSec: -60, lineaCombacia: true });
    /* La circolare: si prende l'occorrenza vicina all'orario di Mizar, non l'ultima. */
    expect(vCR3).toMatchObject({
      scartoAllaFermataSec: 0, lineaCombacia: false,
      gtfs: { orarioAllaFermata: "10:46:08", progressivo: 3 },
      mizar: { seguito: true, partenzaPrevista: "10:47:03", statoPartenza: "onTime", arrivoProgrammato: "10:46:08" },
    });

    expect(c.riepilogo).toMatchObject({
      visite: 3, seguite: 1, conPrevisione: 1, corseNelFeed: 3, fermataNellaCorsa: 3,
      lineeCombaciano: 2, lineeDiverse: 1, orariIdentici: 2, scartoMedianoSec: 0, scartoMassimoSec: 120,
      scartoPartenzaMedianoSec: 0, corseNonTrovate: [],
    });
    expect(c.lettura.join("\n")).toMatch(/Tutte le 3 corse hanno il loro trip_id/);
    expect(c.lettura.join("\n")).toMatch(/identici in 2 corse su 3; scarto mediano 0 s, massimo 120 s/);
    expect(c.lettura.join("\n")).toMatch(/1 corse hanno nel feed una linea diversa/);
    expect(c.lettura.join("\n")).toMatch(/1 passaggi su 3 vengono da mezzi seguiti/);
  });

  it("corsa assente dal feed e fermata assente dalla corsa restano distinguibili", () => {
    const idx = indice();
    idx.trips.delete("689_CodUdp:D1690_455469"); idx.tripByCode!.delete("455469");
    const o = orari();
    o.set("689_CodUdp:D1690_369660", o.get("689_CodUdp:D1690_369660")!.filter(r => r.stopId !== "1122"));
    const c = confrontaFermata("1122", visite, idx, o);
    const [vC, vN] = c.visite;
    expect(vC).toMatchObject({ corsaNelFeed: true, fermataNellaCorsa: false, scartoAllaFermataSec: null, scartoAllaPartenzaSec: 0 });
    expect(vN).toMatchObject({ corsaNelFeed: false, fermataNellaCorsa: false, gtfs: { tripId: null } });
    expect(c.riepilogo).toMatchObject({ corseNelFeed: 2, fermataNellaCorsa: 1, corseNonTrovate: ["455469"] });
    expect(c.lettura.join("\n")).toMatch(/2 corse su 3 hanno il trip_id nel feed; mancano 1 numeri \(455469\)/);
    expect(c.lettura.join("\n")).toMatch(/In 1 corse agganciate il feed NON passa da questa fermata/);
  });

  it("fermata sconosciuta al feed: lo dice, e nessun confronto alla fermata", () => {
    const idx = indice();
    idx.stops.delete("1122"); idx.stopNames.delete("1122");
    const c = confrontaFermata("1122", visite, idx, orari());
    expect(c.fermata.stopId).toBeNull();
    expect(c.visite.every(v => !v.fermataNellaCorsa && v.scartoAllaFermataSec == null)).toBe(true);
    expect(c.visite[0].scartoAllaPartenzaSec).toBe(0);   // la partenza si confronta comunque
    expect(c.lettura[0]).toMatch(/non esiste nel feed né per codice né per nome/);
  });

  /* Il caso vero: Mizar dice 1122, il feed ha stop_id 20045 e porta 1122 in
   * stop_code. Prima dell'indice sullo stop_code l'aggancio riusciva solo
   * per nome. */
  it("aggancia la fermata per stop_code quando lo stop_id del feed è un altro", () => {
    const idx = indice();
    idx.stops.delete("1122"); idx.stopNames.delete("1122");
    idx.stops.add("20045"); idx.stopNames.set("20045", "ANCONA (VIA MARCONI GAS)");
    idx.stopByCode = new Map([["1122", "20045"]]);
    const o = orari();
    for (const righe of o.values()) for (const r of righe) if (r.stopId === "1122") r.stopId = "20045";
    const c = confrontaFermata("1122", visite, idx, o);
    expect(c.fermata).toMatchObject({ stopId: "20045", agganciataCome: "code", conflitto: null });
    expect(c.riepilogo.fermataNellaCorsa).toBe(3);
    expect(c.lettura[0]).toMatch(/stop_id 20045, agganciata per stop_code 1122/);
  });

  it("uno stop_code che combacia ma con un nome incompatibile non viene accettato", () => {
    const idx = indice();
    idx.stops.delete("1122"); idx.stopNames.delete("1122");
    idx.stops.add("20045"); idx.stopNames.set("20045", "OSIMO Stazione");
    idx.stopByCode = new Map([["1122", "20045"]]);
    const c = confrontaFermata("1122", visite, idx, orari());
    expect(c.fermata.stopId).toBeNull();
    expect(c.fermata.conflitto).toMatch(/stop_code 1122/);
  });

  it("senza passaggi la lettura lo dice e basta", () => {
    expect(leggiConfronto(
      { visite: 0, seguite: 0, conPrevisione: 0, corseNelFeed: 0, fermataNellaCorsa: 0, lineeCombaciano: 0, lineeDiverse: 0,
        orariIdentici: 0, scartoMedianoSec: null, scartoMassimoSec: null, scartoPartenzaMedianoSec: null, corseNonTrovate: [] },
      { ref: "9999", stopId: null, nomeMizar: null, nomeFeed: null },
    )).toEqual(["Mizar non dà passaggi per la fermata 9999 nell'intervallo chiesto."]);
  });
});

describe("leggiDiagnosi: dove sono finiti i numeri che non si trovano", () => {
  it("numero presente altrove nel trip_id: la regola «ultimo segmento» non basta", () => {
    const l = leggiDiagnosi({
      trovateAltrove: { "369660": ["689_CodUdp:D1690_369660_1"], "455469": [] },
      lineeNelFeed: { C: { routeId: "C", corse: 40 }, N: null },
    }, ["369660", "455469"]);
    expect(l[0]).toMatch(/1 dei 2 numeri mancanti stanno nel feed ma NON in coda al trip_id \(es\. 369660 in 689_CodUdp:D1690_369660_1\)/);
    expect(l.join("\n")).toMatch(/Le linee N nel feed non esistono/);
    expect(l.join("\n")).toMatch(/Le linee C \(40 corse\) nel feed ci sono, ma 1 numeri di corsa non compaiono/);
  });
  it("senza numeri mancanti non dice nulla", () => {
    expect(leggiDiagnosi({ trovateAltrove: {}, lineeNelFeed: {} }, [])).toEqual([]);
  });
  it("numeri assenti e nessuna linea da confrontare", () => {
    expect(leggiDiagnosi({ trovateAltrove: {}, lineeNelFeed: {} }, ["1", "2"])).toEqual(["2 numeri non compaiono in nessun trip_id del feed."]);
  });
});
