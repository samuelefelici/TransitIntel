/**
 * Il connettore SIRI si scrive a fronte di un WSDL, ma si collauda contro una
 * risposta. Qui la risposta è sintetica, costruita sui tipi dichiarati dal
 * servizio (VehicleActivity → MonitoredVehicleJourney → PreviousCalls /
 * MonitoredCall / OnwardCalls), così parser e normalizzazione sono verificati
 * senza rete: quando arriverà il payload vero basterà confrontarlo con questo.
 */
import { describe, it, expect } from "vitest";
import {
  parseXml, findAll, findFirst, textOf, directText, parseIsoDuration,
  refCandidates, parseVehicleMonitoringResponse, parseCapabilities,
  buildVehicleMonitoringRequest, buildCheckStatusRequest,
  mapVehicles, describeCompleteness, mostInformative, extractSampleActivity,
  lineCodeCandidates, normalizeStopName, routeRefLineCandidates, matchRouteByLongName,
  buildTripStartIndex, matchTripBySchedule, localHHMM, scheduleKeys, detectTransit,
  splitInService, delayFromSchedule, scheduledSeconds,
  effectivePollSeconds, MAX_GAP_SEC, POLL_CONSIGLIATO_SEC,
  distanceMeters, stopsAtPosition, STOP_RADIUS_M, emptyFunnel, explainFunnel,
  type TripStop,
  type GtfsIndex,
} from "../lib/siri-vm";

/* Risposta d'esempio: due mezzi, uno agganciato al GTFS con transiti reali,
 * uno con riferimenti namespacizzati; più una corsa annullata.
 * Prefissi di namespace volutamente misti (s:, siri:, nessuno) perché è ciò
 * che i produttori mandano davvero. */
const VM_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
 <s:Body>
  <GetVehicleMonitoringResponse xmlns="http://www.siri.org.uk/siri">
   <ServiceDeliveryInfo>
     <ResponseTimestamp>2026-09-10T08:15:00+02:00</ResponseTimestamp>
     <ProducerRef>MIZ</ProducerRef>
   </ServiceDeliveryInfo>
   <Answer>
    <siri:VehicleMonitoringDelivery xmlns:siri="http://www.siri.org.uk/siri" version="1.4">
     <siri:ResponseTimestamp>2026-09-10T08:15:00+02:00</siri:ResponseTimestamp>
     <siri:Status>true</siri:Status>
     <siri:ShortestPossibleCycle>PT15S</siri:ShortestPossibleCycle>
     <siri:VehicleActivity>
      <siri:RecordedAtTime>2026-09-10T08:14:50+02:00</siri:RecordedAtTime>
      <siri:ItemIdentifier>VA-1</siri:ItemIdentifier>
      <siri:ProgressBetweenStops>
        <siri:LinkDistance>420</siri:LinkDistance>
        <siri:Percentage>62.5</siri:Percentage>
      </siri:ProgressBetweenStops>
      <siri:MonitoredVehicleJourney>
       <siri:LineRef>22</siri:LineRef>
       <siri:DirectionRef>0</siri:DirectionRef>
       <siri:FramedVehicleJourneyRef>
         <siri:DataFrameRef>2026-09-10</siri:DataFrameRef>
         <siri:DatedVehicleJourneyRef>TRIP-A</siri:DatedVehicleJourneyRef>
       </siri:FramedVehicleJourneyRef>
       <siri:JourneyPatternRef>JP-9</siri:JourneyPatternRef>
       <siri:PublishedLineName>22</siri:PublishedLineName>
       <siri:DestinationName>Torrette Ospedale</siri:DestinationName>
       <siri:OriginAimedDepartureTime>2026-09-10T08:00:00+02:00</siri:OriginAimedDepartureTime>
       <siri:Monitored>true</siri:Monitored>
       <siri:InCongestion>true</siri:InCongestion>
       <siri:VehicleLocation>
         <siri:Longitude>13.5186</siri:Longitude>
         <siri:Latitude>43.6168</siri:Latitude>
       </siri:VehicleLocation>
       <siri:Bearing>271.5</siri:Bearing>
       <siri:ProgressRate>slowProgress</siri:ProgressRate>
       <siri:Occupancy>standingAvailable</siri:Occupancy>
       <siri:Delay>PT3M30S</siri:Delay>
       <siri:BlockRef>TURNO-7</siri:BlockRef>
       <siri:VehicleRef>BUS-01</siri:VehicleRef>
       <siri:PreviousCalls>
        <siri:PreviousCall>
         <siri:StopPointRef>STOP-1</siri:StopPointRef>
         <siri:Order>1</siri:Order>
         <siri:StopPointName>Stazione FS</siri:StopPointName>
         <siri:AimedArrivalTime>2026-09-10T08:00:00+02:00</siri:AimedArrivalTime>
         <siri:ActualArrivalTime>2026-09-10T08:01:00+02:00</siri:ActualArrivalTime>
         <siri:AimedDepartureTime>2026-09-10T08:00:00+02:00</siri:AimedDepartureTime>
         <siri:ActualDepartureTime>2026-09-10T08:02:00+02:00</siri:ActualDepartureTime>
        </siri:PreviousCall>
        <siri:PreviousCall>
         <siri:StopPointRef>STOP-2</siri:StopPointRef>
         <siri:Order>2</siri:Order>
         <siri:AimedArrivalTime>2026-09-10T08:06:00+02:00</siri:AimedArrivalTime>
         <siri:ActualArrivalTime>2026-09-10T08:09:00+02:00</siri:ActualArrivalTime>
        </siri:PreviousCall>
       </siri:PreviousCalls>
       <siri:MonitoredCall>
        <siri:StopPointRef>STOP-3</siri:StopPointRef>
        <siri:Order>3</siri:Order>
        <siri:VehicleAtStop>false</siri:VehicleAtStop>
        <siri:AimedArrivalTime>2026-09-10T08:14:00+02:00</siri:AimedArrivalTime>
        <siri:ExpectedArrivalTime>2026-09-10T08:17:30+02:00</siri:ExpectedArrivalTime>
       </siri:MonitoredCall>
       <siri:OnwardCalls>
        <siri:OnwardCall>
         <siri:StopPointRef>STOP-4</siri:StopPointRef>
         <siri:Order>4</siri:Order>
         <siri:AimedArrivalTime>2026-09-10T08:20:00+02:00</siri:AimedArrivalTime>
         <siri:ExpectedArrivalTime>2026-09-10T08:23:00+02:00</siri:ExpectedArrivalTime>
        </siri:OnwardCall>
       </siri:OnwardCalls>
      </siri:MonitoredVehicleJourney>
     </siri:VehicleActivity>
     <siri:VehicleActivity>
      <siri:RecordedAtTime>2026-09-10T08:14:40+02:00</siri:RecordedAtTime>
      <siri:MonitoredVehicleJourney>
       <siri:LineRef>ITA:Line:44</siri:LineRef>
       <siri:FramedVehicleJourneyRef>
         <siri:DatedVehicleJourneyRef>ITA:Journey:TRIP-B</siri:DatedVehicleJourneyRef>
       </siri:FramedVehicleJourneyRef>
       <siri:VehicleLocation>
         <siri:Longitude>13.50</siri:Longitude><siri:Latitude>43.60</siri:Latitude>
       </siri:VehicleLocation>
       <siri:Delay>-PT2M</siri:Delay>
       <siri:VehicleRef>BUS-02</siri:VehicleRef>
       <siri:MonitoredCall>
         <siri:StopPointRef>SCONOSCIUTA-9</siri:StopPointRef>
       </siri:MonitoredCall>
      </siri:MonitoredVehicleJourney>
     </siri:VehicleActivity>
     <siri:VehicleActivityCancellation>
       <siri:VehicleMonitoringRef>BUS-03</siri:VehicleMonitoringRef>
       <siri:VehicleJourneyRef>
         <siri:DatedVehicleJourneyRef>TRIP-C</siri:DatedVehicleJourneyRef>
       </siri:VehicleJourneyRef>
       <siri:Reason>Guasto</siri:Reason>
     </siri:VehicleActivityCancellation>
    </siri:VehicleMonitoringDelivery>
   </Answer>
  </GetVehicleMonitoringResponse>
 </s:Body>
</s:Envelope>`;

describe("parser XML minimale", () => {
  it("ignora i prefissi di namespace e annida correttamente", () => {
    const doc = parseXml(`<a:root xmlns:a="x"><b:child><c>testo</c></b:child></a:root>`);
    expect(findFirst(doc, "root")).not.toBeNull();
    expect(textOf(doc, "c")).toBe("testo");
  });

  it("gestisce tag auto-chiudenti, attributi, commenti e CDATA", () => {
    const doc = parseXml(
      `<r><!-- nota --><empty attr="1"/><t><![CDATA[a<b]]></t></r>`,
    );
    expect(findFirst(doc, "empty")?.attrs.attr).toBe("1");
    expect(textOf(doc, "t")).toBe("a<b");
  });

  it("de-escapa le entità", () => {
    expect(textOf(parseXml("<x>Poggio &amp; Torrette</x>"), "x")).toBe("Poggio & Torrette");
  });

  it("directText legge solo i figli diretti, textOf scende in profondità", () => {
    const doc = parseXml(`<outer><name>fuori</name><inner><name>dentro</name></inner></outer>`);
    const outer = findFirst(doc, "outer")!;
    expect(directText(outer, "name")).toBe("fuori");
    expect(textOf(findFirst(doc, "inner"), "name")).toBe("dentro");
  });
});

describe("xsd:duration", () => {
  it("converte i ritardi in secondi, anche negativi (anticipo)", () => {
    expect(parseIsoDuration("PT3M30S")).toBe(210);
    expect(parseIsoDuration("-PT2M")).toBe(-120);
    expect(parseIsoDuration("PT1H5M")).toBe(3900);
    expect(parseIsoDuration("PT15S")).toBe(15);
    expect(parseIsoDuration("P1DT2H")).toBe(93600);
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration("non-una-durata")).toBeNull();
  });
});

describe("riferimenti namespacizzati", () => {
  it("propone il valore esatto e poi l'ultimo segmento", () => {
    expect(refCandidates("ITA:Line:44")).toEqual(["ITA:Line:44", "44"]);
    expect(refCandidates("22")).toEqual(["22"]);
    expect(refCandidates(null)).toEqual([]);
  });
});

describe("normalizzazione della risposta VM", () => {
  const r = parseVehicleMonitoringResponse(VM_RESPONSE);

  it("legge la delivery e il ciclo minimo di polling", () => {
    expect(r.failed).toBe(false);
    expect(r.shortestPossibleCycleSec).toBe(15);
    expect(r.responseTimestamp?.toISOString()).toBe("2026-09-10T06:15:00.000Z");
  });

  it("estrae i mezzi senza confondersi coi nodi omonimi", () => {
    expect(r.vehicles).toHaveLength(2);
    expect(r.vehicles.map(v => v.vehicleRef)).toEqual(["BUS-01", "BUS-02"]);
  });

  it("porta i campi che oggi non hanno un posto nel software", () => {
    const v = r.vehicles[0];
    expect(v.blockRef).toBe("TURNO-7");        // turno vettura
    expect(v.inCongestion).toBe(true);          // mezzo in coda
    expect(v.occupancy).toBe("standingAvailable"); // carico
    expect(v.progressRate).toBe("slowProgress");
    expect(v.progressPercent).toBe(62.5);
  });

  it("legge posizione, rotta e ritardo dichiarato", () => {
    const v = r.vehicles[0];
    expect(v.lat).toBeCloseTo(43.6168);
    expect(v.lon).toBeCloseTo(13.5186);
    expect(v.bearing).toBeCloseTo(271.5);
    expect(v.delaySeconds).toBe(210);
    expect(r.vehicles[1].delaySeconds).toBe(-120); // anticipo
  });

  it("separa fermate transitate, corrente e future", () => {
    const v = r.vehicles[0];
    expect(v.previousCalls).toHaveLength(2);
    expect(v.monitoredCall?.stopPointRef).toBe("STOP-3");
    expect(v.onwardCalls).toHaveLength(1);
  });

  it("calcola il ritardo di ogni fermata: partenza se c'è, altrimenti arrivo", () => {
    const [c1, c2] = r.vehicles[0].previousCalls;
    expect(c1.delaySeconds).toBe(120);  // partenza effettiva 08:02 vs programmata 08:00
    expect(c2.delaySeconds).toBe(180);  // solo arrivo: 08:09 vs 08:06
  });

  it("sulla fermata corrente non ancora servita usa la previsione", () => {
    const mc = r.vehicles[0].monitoredCall!;
    expect(mc.actualArrival).toBeNull();
    expect(mc.delaySeconds).toBe(210);  // atteso 08:17:30 vs programmato 08:14
  });

  it("riporta le corse annullate", () => {
    expect(r.cancellations).toHaveLength(1);
    expect(r.cancellations[0].journeyRef).toBe("TRIP-C");
    expect(r.cancellations[0].reason).toBe("Guasto");
  });

  it("tratta un SOAP Fault come errore, non come zero mezzi", () => {
    const f = parseVehicleMonitoringResponse(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>`
      + `<faultcode>s:Client</faultcode><faultstring>RequestorRef sconosciuto</faultstring>`
      + `</s:Fault></s:Body></s:Envelope>`,
    );
    expect(f.failed).toBe(true);
    expect(f.errorText).toBe("RequestorRef sconosciuto");
    expect(f.vehicles).toHaveLength(0);
  });
});

describe("corrispondenza con gli id del feed GTFS", () => {
  const index: GtfsIndex = {
    feedId: "feed-1",
    trips: new Set(["TRIP-A", "TRIP-B"]),
    routes: new Set(["22", "44"]),
    stops: new Set(["STOP-1", "STOP-2", "STOP-3", "STOP-4"]),
    tripRoute: new Map([["TRIP-A", "22"], ["TRIP-B", "44"]]),
    routeByCode: new Map([["22", "22"], ["44", "44"]]),
    routeLongNames: [], stopNames: new Map(),
    stopByName: new Map(),
    loadedAt: Date.now(),
  };
  const { mapped, report } = mapVehicles(
    parseVehicleMonitoringResponse(VM_RESPONSE).vehicles, index,
  );

  it("aggancia i riferimenti diretti e quelli namespacizzati", () => {
    expect(mapped[0].tripId).toBe("TRIP-A");
    expect(mapped[0].routeId).toBe("22");
    expect(mapped[1].tripId).toBe("TRIP-B");  // da "ITA:Journey:TRIP-B"
    expect(mapped[1].routeId).toBe("44");     // da "ITA:Line:44"
    expect(report.tripMatched).toBe(2);
  });

  it("scrive come transiti SOLO le fermate già servite", () => {
    // due PreviousCall con orario effettivo; la MonitoredCall ha solo il previsto
    expect(mapped[0].transits).toHaveLength(2);
    expect(mapped[0].transits.map(t => t.stopId)).toEqual(["STOP-1", "STOP-2"]);
    expect(mapped[0].transits[0].delaySeconds).toBe(120);
    expect(mapped[0].transits[0].stopSeq).toBe(1);
  });

  it("segnala i riferimenti orfani invece di inventare un aggancio", () => {
    expect(mapped[1].nearestStopId).toBeNull();
    expect(report.unmatchedStopRefs).toContain("SCONOSCIUTA-9");
  });

  it("l'orario programmato esce come HH:MM:SS", () => {
    expect(mapped[0].transits[0].scheduled).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("completezza del flusso", () => {
  const vehicles = parseVehicleMonitoringResponse(VM_RESPONSE).vehicles;

  it("conta che cosa il produttore riempie davvero", () => {
    const c = describeCompleteness(vehicles);
    expect(c.totale).toBe(2);
    expect(c.conPosizione).toBe(2);
    expect(c.conCorsa).toBe(2);
    expect(c.conFermateTransitate).toBe(1);  // solo BUS-01
    expect(c.conOrarioEffettivo).toBe(1);
    expect(c.conTurnoVettura).toBe(1);
    expect(c.conRitardo).toBe(2);
  });

  /* Il caso osservato su Conerobus: centinaia di vetture in deposito, che
   * hanno solo la posizione. Prendere i primi mezzi dell'elenco faceva
   * concludere che l'AVM non mandasse nulla. */
  it("distingue una flotta in deposito da un flusso vuoto", () => {
    const parcheggiate = Array.from({ length: 20 }, (_, i) => ({
      ...vehicles[0],
      vehicleRef: `P-${i}`, lineRef: null, publishedLineName: null,
      datedVehicleJourneyRef: null, courseOfJourneyRef: null, journeyRef: null,
      delaySeconds: null, blockRef: null,
      previousCalls: [], onwardCalls: [], monitoredCall: null,
    }));
    const c = describeCompleteness([...parcheggiate, vehicles[0]]);
    expect(c.totale).toBe(21);
    expect(c.conPosizione).toBe(21);   // tutte hanno il GPS
    expect(c.conCorsa).toBe(1);        // una sola è in servizio
    expect(c.conOrarioEffettivo).toBe(1);
  });

  it("il campione pesca i mezzi in servizio, non i primi dell'elenco", () => {
    const parcheggiata = {
      ...vehicles[0], vehicleRef: "FERMO", lineRef: null, publishedLineName: null,
      datedVehicleJourneyRef: null, courseOfJourneyRef: null, journeyRef: null,
      previousCalls: [], onwardCalls: [], monitoredCall: null,
    };
    const scelti = mostInformative([parcheggiata, parcheggiata, vehicles[0]], 1);
    expect(scelti[0].vehicleRef).toBe("BUS-01");
  });
});

/* ── Esercizio contro parco fermo ─────────────────────────────────────────
 * Su Conerobus l'AVM trasmette 368 vetture e ne dichiara monitorate 72: il
 * resto è deposito. Registrarle tutte riempiva la mappa di autobus anonimi
 * ("??") e la tabella di righe che non sono esercizio. */
describe("ripartizione fra mezzi in esercizio e parco fermo", () => {
  const base = parseVehicleMonitoringResponse(VM_RESPONSE).vehicles[0];
  const ferma = {
    ...base, vehicleRef: "FERMO", monitored: false,
    lineRef: null, publishedLineName: null, routeRef: null,
    datedVehicleJourneyRef: null, courseOfJourneyRef: null, journeyRef: null,
    delaySeconds: null, blockRef: null,
    previousCalls: [], onwardCalls: [], monitoredCall: null,
  };

  it("scarta le vetture che l'AVM non segue e che non dichiarano nulla", () => {
    const s = splitInService([base, ferma, { ...ferma, vehicleRef: "FERMO-2" }]);
    expect(s.inServizio.map(v => v.vehicleRef)).toEqual(["BUS-01"]);
    expect(s.ferme).toHaveLength(2);
    expect(s.nonDistinguibile).toBe(false);
  });

  /* La distinzione che conta per l'operatore: il turno macchina non impostato
   * NON è un mezzo fermo. L'AVM lo segue, quindi è in giro, e va mostrato. */
  it("tiene i mezzi monitorati anche senza corsa né linea", () => {
    const senzaTurno = { ...ferma, vehicleRef: "SENZA-TURNO", monitored: true };
    const s = splitInService([ferma, senzaTurno]);
    expect(s.inServizio.map(v => v.vehicleRef)).toEqual(["SENZA-TURNO"]);
    expect(s.ferme.map(v => v.vehicleRef)).toEqual(["FERMO"]);
  });

  it("tiene chi dichiara una corsa anche se non risulta monitorato", () => {
    const conCorsa = { ...ferma, vehicleRef: "CON-CORSA", journeyRef: "TRIP-A" };
    expect(splitInService([conCorsa]).inServizio).toHaveLength(1);
  });

  /* Un mezzo in trasferimento dichiara la linea ma è FUORI LINEA: la linea da
   * sola non basta a chiamarlo esercizio. */
  it("non promuove a esercizio un fuori linea non monitorato", () => {
    const trasferimento = {
      ...ferma, vehicleRef: "TRASFER", lineRef: "16", outOfService: true,
    };
    const s = splitInService([base, trasferimento]);
    expect(s.ferme.map(v => v.vehicleRef)).toEqual(["TRASFER"]);
  });

  /* Se il produttore non compila nessuno dei tre campi, filtrare vorrebbe
   * dire spegnere la mappa: si preferisce mostrare tutto e dirlo. */
  it("non filtra nulla quando il produttore non distingue", () => {
    const s = splitInService([ferma, { ...ferma, vehicleRef: "FERMO-2" }]);
    expect(s.inServizio).toHaveLength(2);
    expect(s.ferme).toHaveLength(0);
    expect(s.nonDistinguibile).toBe(true);
  });

  it("su elenco vuoto non inventa mezzi", () => {
    const s = splitInService([]);
    expect(s.inServizio).toHaveLength(0);
    expect(s.nonDistinguibile).toBe(true);
  });
});

/* ── Il Δ alla fermata ────────────────────────────────────────────────────
 * Questo AVM non dichiara quasi mai il ritardo: finché lo si aspettava da
 * lui la colonna Δ restava vuota anche avendo in mano sia il programmato sia
 * il transito osservato. Sono i due termini del confronto. */
describe("ritardo calcolato da programmato e transito osservato", () => {
  const TZ = "Europe/Rome";
  // 2026-09-10 è ora legale a Roma: UTC+2.
  const at = (hhmmss: string) => new Date(`2026-09-10T${hhmmss}+02:00`);

  it("legge gli orari GTFS, anche oltre le 24", () => {
    expect(scheduledSeconds("08:30:00")).toBe(30_600);
    expect(scheduledSeconds("25:10:00")).toBe(90_600);
    expect(scheduledSeconds("8:30")).toBe(30_600);
    expect(scheduledSeconds("pippo")).toBeNull();
    expect(scheduledSeconds(null)).toBeNull();
  });

  it("un transito in ritardo dà un delta positivo", () => {
    expect(delayFromSchedule("08:30:00", at("08:33:20"), TZ)).toBe(200);
  });

  it("un transito in anticipo dà un delta negativo", () => {
    expect(delayFromSchedule("08:30:00", at("08:28:30"), TZ)).toBe(-90);
  });

  it("in perfetto orario dà zero", () => {
    expect(delayFromSchedule("08:30:00", at("08:30:00"), TZ)).toBe(0);
  });

  /* Prima trappola: il GTFS scrive "25:10" per l'01:10 del giorno dopo,
   * stessa giornata di servizio. La sottrazione grezza sbaglierebbe di 24h. */
  it("gestisce l'orario programmato oltre la mezzanotte", () => {
    const transito = new Date("2026-09-11T01:12:00+02:00");
    expect(delayFromSchedule("25:10:00", transito, TZ)).toBe(120);
  });

  /* Seconda trappola: programmato appena prima di mezzanotte, transito
   * appena dopo. È un ritardo di 2 minuti, non un anticipo di 23h58'. */
  it("gestisce il transito che scavalca la mezzanotte civile", () => {
    const transito = new Date("2026-09-11T00:01:00+02:00");
    expect(delayFromSchedule("23:59:00", transito, TZ)).toBe(120);
  });

  it("calcola nell'ora locale dell'azienda, non in UTC", () => {
    // 06:30 UTC = 08:30 a Roma: in orario, non due ore di anticipo.
    expect(delayFromSchedule("08:30:00", new Date("2026-09-10T06:30:00Z"), TZ)).toBe(0);
  });

  it("senza uno dei due termini non inventa un numero", () => {
    expect(delayFromSchedule(null, at("08:30:00"), TZ)).toBeNull();
    expect(delayFromSchedule("08:30:00", null, TZ)).toBeNull();
    expect(delayFromSchedule("08:30:00", "non-una-data", TZ)).toBeNull();
  });

  it("accetta il transito anche come stringa ISO, com'esce dal database", () => {
    expect(delayFromSchedule("08:30:00", "2026-09-10T06:35:00Z", TZ)).toBe(300);
  });
});

/* ── L'intervallo di poll ──────────────────────────────────────────────────
 * Il caso vero: SIRI_POLL_SECONDS=3600 in produzione. Il connettore girava,
 * i log erano puliti, e non veniva registrato un solo transito — perché con
 * un'ora fra due letture il cambio di fermata non è attribuibile. */
describe("intervallo di poll applicabile", () => {
  it("rispetta un intervallo già utilizzabile", () => {
    expect(effectivePollSeconds(30)).toBe(30);
    expect(effectivePollSeconds(60)).toBe(60);
    expect(effectivePollSeconds(120)).toBe(120);
  });

  it("riporta a un valore utile un intervallo che spegnerebbe i transiti", () => {
    expect(effectivePollSeconds(3600)).toBe(POLL_CONSIGLIATO_SEC);
    expect(effectivePollSeconds(900)).toBe(POLL_CONSIGLIATO_SEC);
  });

  /* Fermarsi a MAX_GAP_SEC sarebbe un taglio inutile: è la soglia di RIFIUTO,
   * quindi un giro appena più lungo del previsto verrebbe scartato lo stesso
   * e non si registrerebbe nulla comunque. */
  it("non si ferma sulla soglia di rifiuto, che non lascerebbe margine", () => {
    expect(effectivePollSeconds(3600)).toBeLessThan(MAX_GAP_SEC);
  });

  it("non scende sotto un minimo che martellerebbe il produttore", () => {
    expect(effectivePollSeconds(1)).toBe(10);
    expect(effectivePollSeconds(0)).toBe(30);   // non impostato
    expect(effectivePollSeconds(NaN)).toBe(30);
    expect(effectivePollSeconds(-5)).toBe(30);
  });
});

/* ── Il passaggio riconosciuto dalla posizione ────────────────────────────
 * È il canale che non dipende da nulla che l'AVM debba dichiarare: quando
 * MonitoredCall manca o non si aggancia, prima non veniva acquisito niente
 * in silenzio pur avendo le coordinate del mezzo a ogni giro. */
describe("riconoscimento del passaggio dalla posizione", () => {
  // Ancona, ~43.6°N: a questa latitudine 0,001° di longitudine ≈ 80 m.
  const fermata = (id: string, seq: number, lat: number, lon: number): TripStop =>
    ({ stopId: id, seq, lat, lon, scheduled: "08:00:00" });

  const corsa: TripStop[] = [
    fermata("S1", 1, 43.6000, 13.5000),
    fermata("S2", 2, 43.6100, 13.5000),
    fermata("S3", 3, 43.6200, 13.5000),
  ];

  it("misura la distanza in metri", () => {
    // un grado di latitudine ≈ 111 km
    expect(distanceMeters(43.6, 13.5, 43.6, 13.5)).toBe(0);
    expect(Math.round(distanceMeters(43.6, 13.5, 43.601, 13.5))).toBeGreaterThan(100);
    expect(Math.round(distanceMeters(43.6, 13.5, 43.601, 13.5))).toBeLessThan(120);
  });

  it("riconosce la fermata sotto cui si trova il mezzo", () => {
    const near = stopsAtPosition(43.6100, 13.5000, corsa);
    expect(near.map(s => s.stopId)).toEqual(["S2"]);
    expect(near[0].distanceM).toBe(0);
  });

  it("tollera l'imprecisione del GPS entro il raggio", () => {
    // ~33 m più a nord della fermata S2
    const near = stopsAtPosition(43.6103, 13.5000, corsa);
    expect(near.map(s => s.stopId)).toEqual(["S2"]);
    expect(near[0].distanceM).toBeLessThan(STOP_RADIUS_M);
  });

  /* In mezzo a una tratta non si deve inventare nessun passaggio. */
  it("non aggancia nulla a metà tratta", () => {
    expect(stopsAtPosition(43.6050, 13.5000, corsa)).toHaveLength(0);
  });

  /* All'incrocio due fermate della stessa corsa possono cadere entrambe nel
   * raggio: l'ordine per distanza è ciò che permette di scriverne una sola. */
  it("mette per prima la più vicina quando due cadono nel raggio", () => {
    const vicine: TripStop[] = [
      fermata("A", 1, 43.6000, 13.5000),
      fermata("B", 2, 43.6004, 13.5000),   // ~44 m più a nord
    ];
    const near = stopsAtPosition(43.6001, 13.5000, vicine, 100);
    expect(near.map(s => s.stopId)).toEqual(["A", "B"]);
    expect(near[0].distanceM).toBeLessThan(near[1].distanceM);
  });

  it("porta con sé orario programmato e progressivo della fermata", () => {
    const near = stopsAtPosition(43.6200, 13.5000, corsa);
    expect(near[0]).toMatchObject({ stopId: "S3", seq: 3, scheduled: "08:00:00" });
  });

  it("su una corsa senza fermate non esplode", () => {
    expect(stopsAtPosition(43.6, 13.5, [])).toEqual([]);
  });
});

describe("diagnosi dell'acquisizione", () => {
  it("indica l'anello che ha ceduto, non un generico fallimento", () => {
    const f = emptyFunnel();
    expect(explainFunnel(f)).toMatch(/nessun mezzo in esercizio/i);

    f.inEsercizio = 50;
    expect(explainFunnel(f)).toMatch(/agganciato a una corsa/i);

    f.conCorsaAgganciata = 20;
    expect(explainFunnel(f)).toMatch(/nessuna posizione/i);

    f.conPosizione = 20;
    expect(explainFunnel(f)).toMatch(/fermate con coordinate/i);

    f.conGeometriaFermate = 20;
    expect(explainFunnel(f)).toMatch(/raggio di una fermata/i);

    f.vicinoAFermata = 5;
    f.inseriti = 5;
    expect(explainFunnel(f)).toMatch(/5 passaggi registrati/i);
  });

  /* "Già registrati" NON è un guasto: senza distinguerlo si andrebbe a
   * cercare un problema che non c'è. */
  it("distingue il nulla di fatto dal già acquisito", () => {
    const f = emptyFunnel();
    Object.assign(f, {
      inEsercizio: 50, conCorsaAgganciata: 20, conPosizione: 20,
      conGeometriaFermate: 20, vicinoAFermata: 8, inseriti: 0, giaPresenti: 8,
    });
    expect(explainFunnel(f)).toMatch(/già registrati/i);
  });
});

describe("ritaglio del grezzo per la diagnosi", () => {
  it("estrae la VehicleActivity che contiene il marcatore cercato", () => {
    const block = extractSampleActivity(VM_RESPONSE, "BlockRef");
    expect(block).toContain("BUS-01");
    expect(block).toContain("TURNO-7");
    expect(block).not.toContain("BUS-02"); // un solo blocco, non l'intera risposta
  });

  it("ripiega sulla prima attività se il marcatore non c'è", () => {
    const block = extractSampleActivity(VM_RESPONSE, "NonEsiste");
    expect(block).toContain("VehicleActivity");
  });

  it("non esplode su un documento senza attività", () => {
    expect(extractSampleActivity("<Envelope/>", "LineRef")).toBeNull();
  });
});

/* ── Il caso Conerobus/MIZ, ricostruito dal grezzo osservato in produzione ──
 * Tre trappole vere, tutte presenti in una sola VehicleActivity:
 *  1. la corsa sta in CourseOfJourneyRef, non in FramedVehicleJourneyRef;
 *  2. LineRef è un id INTERNO ("16" = Linea 3): confrontarlo con gli id del
 *     feed non dà zero corrispondenze, ne dà di SBAGLIATE;
 *  3. le PreviousCalls arrivano senza alcun orario. */
const MIZ_RESPONSE = `<Envelope><Body><Answer><VehicleMonitoringDelivery>
 <ResponseTimestamp>2026-09-10T14:32:47+02:00</ResponseTimestamp>
 <ShortestPossibleCycle>PT60S</ShortestPossibleCycle>
 <VehicleActivity>
  <RecordedAtTime>2026-09-10T14:31:53+02:00</RecordedAtTime>
  <ProgressBetweenStops><LinkDistance>194</LinkDistance><Percentage>99.487</Percentage></ProgressBetweenStops>
  <MonitoredVehicleJourney>
   <LineRef>16</LineRef>
   <DirectionRef>back</DirectionRef>
   <RouteRef>03A1</RouteRef>
   <PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>
   <OriginRef>4796</OriginRef><OriginName>POSATORA CAPOLINEA</OriginName>
   <DestinationRef>189</DestinationRef><DestinationName>Piazza CAVOUR</DestinationName>
   <OriginAimedDepartureTime>2026-09-10T14:39:00+02:00</OriginAimedDepartureTime>
   <DestinationAimedArrivalTime>2026-09-10T14:59:00+02:00</DestinationAimedArrivalTime>
   <Monitored>true</Monitored>
   <VehicleLocation><Longitude>13.48981</Longitude><Latitude>43.5989</Latitude></VehicleLocation>
   <Delay>PT0S</Delay><ProgressStatus/>
   <CourseOfJourneyRef>469173</CourseOfJourneyRef>
   <VehicleRef>278</VehicleRef>
   <PreviousCalls><PreviousCall>
     <StopPointRef>4746</StopPointRef><VisitNumber>1</VisitNumber><Order>1</Order>
     <StopPointName>VIA M.VETTORE</StopPointName>
   </PreviousCall></PreviousCalls>
   <MonitoredCall><StopPointRef>4796</StopPointRef><VisitNumber>1</VisitNumber>
     <StopPointName>POSATORA CAPOLINEA</StopPointName></MonitoredCall>
  </MonitoredVehicleJourney>
 </VehicleActivity>
</VehicleMonitoringDelivery></Answer></Body></Envelope>`;

describe("numero di linea dal nome pubblicato", () => {
  it("estrae il codice e ne offre le varianti con trattino e barra", () => {
    expect(lineCodeCandidates("Linea 3  P.zza Cavour - Galleria")).toEqual(["3"]);
    expect(lineCodeCandidates("Linea 1-4  P.zza IV Novembre - Stazione FS"))
      .toEqual(["1-4", "1/4"]);
    expect(lineCodeCandidates("Linea 94  Ancona - Portonovo")).toEqual(["94"]);
  });

  it("non inventa un codice dove non c'è", () => {
    expect(lineCodeCandidates("Navetta Terminal Biglietterie - Imbarchi")).toEqual([]);
    expect(lineCodeCandidates(null)).toEqual([]);
  });

  it("i nomi di fermata si confrontano senza accenti né punteggiatura", () => {
    expect(normalizeStopName("P.zza Cavour")).toBe(normalizeStopName("PIAZZA CAVOUR".replace("PIAZZA", "P zza")));
    expect(normalizeStopName("Città Alta")).toBe("CITTA ALTA");
  });
});

describe("caso Conerobus/MIZ", () => {
  const r = parseVehicleMonitoringResponse(MIZ_RESPONSE);
  const v = r.vehicles[0];

  it("legge la corsa da CourseOfJourneyRef quando manca il framed", () => {
    expect(v.datedVehicleJourneyRef).toBeNull();
    expect(v.courseOfJourneyRef).toBe("469173");
    expect(v.journeyRef).toBe("469173");          // è questo che conta
    expect(describeCompleteness([v]).conCorsa).toBe(1);
  });

  it("porta gli orari programmati del viaggio, utili per riconoscere la corsa", () => {
    expect(v.originAimedDeparture?.toISOString()).toBe("2026-09-10T12:39:00.000Z");
    expect(v.destinationAimedArrival?.toISOString()).toBe("2026-09-10T12:59:00.000Z");
    expect(v.routeRef).toBe("03A1");
    expect(v.originName).toBe("POSATORA CAPOLINEA");
  });

  it("le PreviousCalls senza orari non diventano transiti", () => {
    expect(v.previousCalls).toHaveLength(1);
    expect(v.previousCalls[0].actualArrival).toBeNull();
    expect(describeCompleteness([v]).conOrarioEffettivo).toBe(0);
  });

  /* Il punto che rendeva sbagliata la mappa: la linea. */
  it("aggancia la linea dal numero pubblicato, non dall'id interno", () => {
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(["3", "16"]),
      stops: new Set(), tripRoute: new Map(),
      routeByCode: new Map([["3", "3"], ["16", "16"]]),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { mapped, report } = mapVehicles([v], index);
    expect(mapped[0].routeId).toBe("3");            // Linea 3, non la linea "16"
    expect(report.routeMatchedByPublishedName).toBe(1);
    expect(report.routeMatchedByRef).toBe(0);
  });

  it("un id di fermata che combacia ma con altro nome è una corrispondenza falsa", () => {
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(), stops: new Set(["4796"]),
      tripRoute: new Map(), routeByCode: new Map(),
      routeLongNames: [], stopNames: new Map([["4796", "Via Giordano Bruno"]]),   // NON è Posatora
      stopByName: new Map([["POSATORA CAPOLINEA", "981"]]),
      loadedAt: Date.now(),
    };
    const { mapped, report } = mapVehicles([v], index);
    expect(mapped[0].nearestStopId).toBe("981");     // ripiegato sul nome
    expect(report.stopIdNameConflicts[0]).toContain("4796");
  });

  it("con id e nome coerenti aggancia per id", () => {
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(), stops: new Set(["4796"]),
      tripRoute: new Map(), routeByCode: new Map(),
      routeLongNames: [], stopNames: new Map([["4796", "Posatora Capolinea"]]),
      stopByName: new Map([["POSATORA CAPOLINEA", "4796"]]),
      loadedAt: Date.now(),
    };
    const { mapped, report } = mapVehicles([v], index);
    expect(mapped[0].nearestStopId).toBe("4796");
    expect(report.stopMatchedById).toBe(1);
    expect(report.stopIdNameConflicts).toHaveLength(0);
  });
});

describe("numero di linea dal codice di percorso", () => {
  it("estrae la linea dal percorso, con e senza zero iniziale", () => {
    expect(routeRefLineCandidates("03R1")).toContain("3");
    expect(routeRefLineCandidates("03R1")).toContain("03");
    expect(routeRefLineCandidates("31R2")).toContain("31");
    expect(routeRefLineCandidates("94R1")).toContain("94");
    expect(routeRefLineCandidates("20P")).toContain("20");
  });

  it("non ricava un numero da un percorso che non ne ha", () => {
    expect(routeRefLineCandidates("FUORI LINEA")).toEqual([]);
    expect(routeRefLineCandidates(null)).toEqual([]);
  });

  /* Il caso che il nome pubblicato non copre: la navetta del porto non ha
   * un numero nel nome, ma il suo percorso "20P" dice che è la linea 20. */
  it("aggancia la navetta, che dal nome non sarebbe agganciabile", () => {
    const navetta = parseVehicleMonitoringResponse(
      MIZ_RESPONSE
        .replace("<PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>",
          "<PublishedLineName>Navetta Terminal Biglietterie - Terminal Imbarchi</PublishedLineName>")
        .replace("<RouteRef>03A1</RouteRef>", "<RouteRef>20P</RouteRef>"),
    ).vehicles[0];
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(["20"]), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map([["20", "20"]]),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { mapped, report } = mapVehicles([navetta], index);
    expect(mapped[0].routeId).toBe("20");
    expect(report.routeMatchedByRouteRef).toBe(1);
    expect(report.routeMatchedByPublishedName).toBe(0);
  });

  it("il nome pubblicato ha comunque la precedenza sul percorso", () => {
    const v = parseVehicleMonitoringResponse(MIZ_RESPONSE).vehicles[0]; // Linea 3, percorso 03A1
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(["3"]), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map([["3", "3"]]),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { report } = mapVehicles([v], index);
    expect(report.routeMatchedByPublishedName).toBe(1);
    expect(report.routeMatchedByRouteRef).toBe(0);
  });

  it("un mezzo in trasferimento non viene agganciato a una linea dal percorso", () => {
    const fuori = parseVehicleMonitoringResponse(
      MIZ_RESPONSE
        .replace("<PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>",
          "<PublishedLineName>Rientro deposito</PublishedLineName>")
        .replace("<RouteRef>03A1</RouteRef>", "<RouteRef>FUORI LINEA</RouteRef>"),
    ).vehicles[0];
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(["3"]), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map([["3", "3"]]),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    expect(mapVehicles([fuori], index).mapped[0].routeId).toBeNull();
  });
});

/* Le linee EXTRAURBANE osservate in produzione non hanno un numero nel nome:
 * si chiamano "OSIMO - ASPIO - ANCONA" da entrambe le parti. E l'AVM tronca a
 * 50 caratteri, quindi il suo nome è un PREFISSO di quello del feed. */
describe("linee extraurbane, agganciate per nome esteso", () => {
  const feedLongNames = [
    { norm: normalizeStopName("OSIMO - ASPIO - ANCONA"), routeId: "UJ2A" },
    { norm: normalizeStopName("OSIMO - OFFAGNA - ANCONA"), routeId: "UJ3" },
    { norm: normalizeStopName("JESI - CHIARAVALLE - ROCCA PRIORA - FALCONARA  ANCONA"), routeId: "JECN" },
    { norm: normalizeStopName("RECANATI - ANCONA"), routeId: "RE1" },
  ];

  it("aggancia un nome identico", () => {
    expect(matchRouteByLongName("OSIMO - ASPIO - ANCONA", feedLongNames)).toBe("UJ2A");
  });

  it("aggancia anche quando l'AVM ha troncato a 50 caratteri", () => {
    // esattamente ciò che arriva: "…FALCONARA  ANC"
    expect(matchRouteByLongName("JESI - CHIARAVALLE - ROCCA PRIORA - FALCONARA  ANC", feedLongNames))
      .toBe("JECN");
  });

  it("non sceglie a caso quando il prefisso è ambiguo", () => {
    // "OSIMO - " è prefisso sia di ASPIO sia di OFFAGNA: due candidati, nessuna scelta
    expect(matchRouteByLongName("OSIMO - ", feedLongNames)).toBeNull();
  });

  it("ignora nomi troppo corti per essere distintivi", () => {
    expect(matchRouteByLongName("ANCONA", feedLongNames)).toBeNull();
    expect(matchRouteByLongName(null, feedLongNames)).toBeNull();
  });
});

describe("codici di linea non numerici", () => {
  it("legge i codici alfanumerici che il feed usa davvero", () => {
    // osservato: "Linea VI1 PERGOLA - SASSOFERRATO - FABRIANO", e VI1 è nel feed
    expect(lineCodeCandidates("Linea VI1 PERGOLA - SASSOFERRATO - FABRIANO")).toContain("VI1");
    expect(lineCodeCandidates("Linea 3  P.zza Cavour")).toContain("3");
  });

  it("non scambia una parola del percorso per un codice", () => {
    expect(lineCodeCandidates("Linea Ancona - Jesi - Fabriano")).toEqual([]);
  });
});

describe("mezzi fuori servizio e linee orfane", () => {
  it("riconosce il fuori servizio dichiarato nel nome della linea", () => {
    // il mezzo con LineRef 100 pubblica "Fuori servizio" al posto della linea
    const v = parseVehicleMonitoringResponse(
      MIZ_RESPONSE.replace(
        "<PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>",
        "<PublishedLineName>Fuori servizio</PublishedLineName>"),
    ).vehicles[0];
    expect(v.outOfService).toBe(true);
  });

  /* Osservato in produzione: il mezzo 415 ha percorso "FUORI LINEA", cioè
   * si sta trasferendo. Cercarne la corsa nell'orario non ha senso. */
  const FUORI_LINEA = MIZ_RESPONSE
    .replace("<RouteRef>03A1</RouteRef>", "<RouteRef>FUORI LINEA</RouteRef>");

  it("riconosce il trasferimento dichiarato al posto del percorso", () => {
    const v = parseVehicleMonitoringResponse(FUORI_LINEA).vehicles[0];
    expect(v.outOfService).toBe(true);
    expect(describeCompleteness([v]).fuoriLinea).toBe(1);
  });

  it("un percorso normale non è un trasferimento", () => {
    const v = parseVehicleMonitoringResponse(MIZ_RESPONSE).vehicles[0];
    expect(v.outOfService).toBe(false);
  });

  it("le linee orfane riportano nome pubblicato e codici tentati", () => {
    const v = parseVehicleMonitoringResponse(MIZ_RESPONSE).vehicles[0];
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(["44"]), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map([["44", "44"]]),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { report } = mapVehicles([v], index);
    expect(report.routeMatched).toBe(0);
    // il perché dev'essere leggibile: "Linea 3" cercata come "3" (dal nome) e
    // come "03"/"3" (dal percorso 03A1), tutte assenti nel feed
    expect(report.unmatchedLines[0].lineRef).toBe("16");
    expect(report.unmatchedLines[0].published)
      .toBe("Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi");
    expect(report.unmatchedLines[0].codiciProvati).toContain("3");
  });

  it("quando né il nome né il percorso portano un numero, lo dichiara", () => {
    const navetta = parseVehicleMonitoringResponse(
      MIZ_RESPONSE
        .replace("<PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>",
          "<PublishedLineName>Navetta Terminal Biglietterie - Terminal Imbarchi</PublishedLineName>")
        .replace("<RouteRef>03A1</RouteRef>", "<RouteRef>NAV</RouteRef>"),
    ).vehicles[0];
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map(),
      routeLongNames: [], stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { report } = mapVehicles([navetta], index);
    expect(report.unmatchedLines[0].codiciProvati).toEqual([]);
  });
});

describe("richieste SOAP", () => {
  it("GetVehicleMonitoring chiede il dettaglio 'calls' (senza, niente transiti)", () => {
    const xml = buildVehicleMonitoringRequest({ requestorRef: "TI", detailLevel: "calls" });
    expect(xml).toContain("<siri:VehicleMonitoringDetailLevel>calls<");
    expect(xml).toContain("<siri:RequestorRef>TI<");
    expect(xml).toContain("GetVehicleMonitoring");
  });

  it("filtra per linea quando richiesto e protegge i caratteri speciali", () => {
    const xml = buildVehicleMonitoringRequest({ requestorRef: 'a&b', lineRef: "22" });
    expect(xml).toContain("<siri:LineRef>22<");
    expect(xml).toContain("a&amp;b");
  });

  it("CheckStatus non chiede dati di esercizio", () => {
    const xml = buildCheckStatusRequest("TI");
    expect(xml).toContain("CheckStatus");
    expect(xml).not.toContain("VehicleMonitoringDetailLevel");
  });
});

describe("capabilities", () => {
  it("legge ciò che serve a tarare il poller", () => {
    const cap = parseCapabilities(`<Envelope><Body><CapabilitiesResponse>
      <VehicleMonitoringServiceCapabilities>
        <GeneralInteraction><RequestResponse>true</RequestResponse>
          <PublishSubscribe>false</PublishSubscribe></GeneralInteraction>
        <TopicFiltering><FilterByLineRef>true</FilterByLineRef>
          <DefaultPreviewInterval>PT30M</DefaultPreviewInterval></TopicFiltering>
        <RequestPolicy><HasDetailLevel>true</HasDetailLevel>
          <DefaultDetailLevel>normal</DefaultDetailLevel>
          <HasNumberOfPreviousCalls>true</HasNumberOfPreviousCalls></RequestPolicy>
      </VehicleMonitoringServiceCapabilities>
    </CapabilitiesResponse></Body></Envelope>`);
    expect(cap.requestResponse).toBe(true);
    expect(cap.publishSubscribe).toBe(false);
    expect(cap.hasPreviousCalls).toBe(true);
    expect(cap.defaultDetailLevel).toBe("normal");
    expect(cap.defaultPreviewIntervalSec).toBe(1800);
  });
});

/* ── Aggancio della corsa per orario ─────────────────────────────────────
 * È l'ultimo anello: gli id dei due sistemi non si parlano ("469179" contro
 * "684_CodUdp:D1690_363283"), ma linea + ora di partenza individuano la corsa. */
describe("aggancio della corsa per linea e ora di partenza", () => {
  const idx = buildTripStartIndex([
    { tripId: "T-0715-A", routeId: "3", firstDeparture: "07:15:00", headsign: "Piazza Cavour" },
    { tripId: "T-0730-A", routeId: "3", firstDeparture: "07:30:00", headsign: "Piazza Cavour" },
    // stessa linea e ora, capolinea diversi: disambiguabili dalla destinazione
    { tripId: "T-0800-AND", routeId: "3", firstDeparture: "08:00:00", headsign: "Posatora Capolinea" },
    { tripId: "T-0800-RIT", routeId: "3", firstDeparture: "08:00:00", headsign: "Piazza Cavour" },
    // corsa a cavallo della mezzanotte, scritta come il GTFS impone
    { tripId: "T-NOTTE", routeId: "3", firstDeparture: "25:10:00", headsign: "Deposito" },
  ]);
  const rome = "Europe/Rome";
  const at = (iso: string) => new Date(iso);

  it("aggancia la corsa con la partenza esatta", () => {
    const m = matchTripBySchedule("3", at("2026-09-10T05:15:00Z"), idx, rome); // 07:15 a Roma
    expect(m.tripId).toBe("T-0715-A");
    expect(m.ambiguous).toBe(false);
    expect(m.toleranceUsed).toBe(0);
  });

  it("tollera un minuto di scarto fra AVM e orario", () => {
    const m = matchTripBySchedule("3", at("2026-09-10T05:31:00Z"), idx, rome); // 07:31
    expect(m.tripId).toBe("T-0730-A");
    expect(m.toleranceUsed).toBe(1);
  });

  it("non aggancia se lo scarto è troppo grande", () => {
    const m = matchTripBySchedule("3", at("2026-09-10T05:40:00Z"), idx, rome); // 07:40
    expect(m.tripId).toBeNull();
  });

  it("usa il capolinea per scegliere fra due corse alla stessa ora", () => {
    const m = matchTripBySchedule("3", at("2026-09-10T06:00:00Z"), idx, rome, "POSATORA CAPOLINEA");
    expect(m.tripId).toBe("T-0800-AND");
    expect(m.ambiguous).toBe(false);
  });

  it("senza capolinea sceglie in modo deterministico ma lo DICHIARA", () => {
    const m = matchTripBySchedule("3", at("2026-09-10T06:00:00Z"), idx, rome);
    expect(m.tripId).toBe("T-0800-AND"); // ordinamento stabile
    expect(m.ambiguous).toBe(true);      // e l'ambiguità non si nasconde
  });

  it("trova le corse notturne scritte oltre le 24 ore", () => {
    // 01:10 di notte: nel GTFS è la corsa "25:10" del giorno prima
    const m = matchTripBySchedule("3", at("2026-09-10T23:10:00Z"), idx, rome); // 01:10 dell'11
    expect(m.tripId).toBe("T-NOTTE");
  });

  it("non confonde le linee", () => {
    expect(matchTripBySchedule("94", at("2026-09-10T05:15:00Z"), idx, rome).tripId).toBeNull();
  });
});

describe("orario locale e chiavi di ricerca", () => {
  it("converte nell'ora dell'azienda, non in quella del server", () => {
    // ora legale italiana: UTC+2
    expect(localHHMM(new Date("2026-09-10T12:39:00Z"), "Europe/Rome")).toBe("14:39");
    // mezzanotte deve essere 00, non 24
    expect(localHHMM(new Date("2026-09-10T22:00:00Z"), "Europe/Rome")).toBe("00:00");
  });

  it("prova l'ora esatta per prima, poi gli scarti", () => {
    const k = scheduleKeys("07:15");
    expect(k[0]).toBe("07:15");
    expect(k).toContain("07:14");
    expect(k).toContain("07:16");
  });

  it("per le ore piccole propone anche la forma oltre le 24", () => {
    expect(scheduleKeys("01:10")).toContain("25:10");
    expect(scheduleKeys("14:39")).not.toContain("38:39");
  });
});

/* ── Transiti osservati ──────────────────────────────────────────────────
 * MIZ manda le fermate transitate senza orari: il passaggio si riconosce dal
 * cambio di fermata corrente fra due letture. */
describe("riconoscimento del transito dal cambio di fermata", () => {
  const p = (stopId: string, at: string, tripId = "T1", delaySeconds: number | null = 60) =>
    ({ tripId, stopId, delaySeconds, at: new Date(at) });

  it("riconosce il passaggio e lo colloca a metà intervallo", () => {
    const ev = detectTransit(
      p("A", "2026-09-10T10:00:00Z"),
      p("B", "2026-09-10T10:01:00Z"),
    );
    expect(ev).not.toBeNull();
    expect(ev!.stopId).toBe("A");                              // ha superato A, non B
    expect(ev!.observedAt.toISOString()).toBe("2026-09-10T10:00:30.000Z");
    expect(ev!.uncertaintySec).toBe(60);                       // l'incertezza è dichiarata
  });

  it("usa il ritardo del momento in cui era ancora ad A", () => {
    const ev = detectTransit(
      p("A", "2026-09-10T10:00:00Z", "T1", 45),
      p("B", "2026-09-10T10:01:00Z", "T1", 90),
    );
    expect(ev!.delaySeconds).toBe(45);
  });

  it("non inventa un transito alla prima lettura di un mezzo", () => {
    expect(detectTransit(null, p("A", "2026-09-10T10:00:00Z"))).toBeNull();
  });

  it("non emette nulla finché il mezzo è sulla stessa tratta", () => {
    expect(detectTransit(
      p("A", "2026-09-10T10:00:00Z"),
      p("A", "2026-09-10T10:01:00Z"),
    )).toBeNull();
  });

  it("al cambio di corsa non attribuisce il passaggio", () => {
    // il mezzo ha iniziato un'altra corsa: non si sa quando ha lasciato A
    expect(detectTransit(
      p("A", "2026-09-10T10:00:00Z", "T1"),
      p("B", "2026-09-10T10:01:00Z", "T2"),
    )).toBeNull();
  });

  it("scarta gli intervalli troppo lunghi, dove il punto medio non dice nulla", () => {
    expect(detectTransit(
      p("A", "2026-09-10T10:00:00Z"),
      p("B", "2026-09-10T10:10:00Z"),   // dieci minuti dopo
    )).toBeNull();
  });

  it("ignora letture arrivate fuori ordine", () => {
    expect(detectTransit(
      p("A", "2026-09-10T10:01:00Z"),
      p("B", "2026-09-10T10:00:00Z"),
    )).toBeNull();
  });
});
