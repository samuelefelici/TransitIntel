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
  lineCodeCandidates, normalizeStopName,
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
    stopNames: new Map(),
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
      stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
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
      stopNames: new Map([["4796", "Via Giordano Bruno"]]),   // NON è Posatora
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
      stopNames: new Map([["4796", "Posatora Capolinea"]]),
      stopByName: new Map([["POSATORA CAPOLINEA", "4796"]]),
      loadedAt: Date.now(),
    };
    const { mapped, report } = mapVehicles([v], index);
    expect(mapped[0].nearestStopId).toBe("4796");
    expect(report.stopMatchedById).toBe(1);
    expect(report.stopIdNameConflicts).toHaveLength(0);
  });
});

describe("mezzi fuori servizio e linee orfane", () => {
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
      stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
    };
    const { report } = mapVehicles([v], index);
    expect(report.routeMatched).toBe(0);
    // il perché dev'essere leggibile: "Linea 3" cercata come "3", assente nel feed
    expect(report.unmatchedLines[0]).toEqual({
      lineRef: "16",
      published: "Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi",
      codiciProvati: ["3"],
    });
  });

  it("una linea senza numero nel nome lo dichiara apertamente", () => {
    const navetta = parseVehicleMonitoringResponse(
      MIZ_RESPONSE.replace(
        "<PublishedLineName>Linea 3  P.zza Cavour - Galleria - P.zza Ugo Bassi</PublishedLineName>",
        "<PublishedLineName>Navetta Terminal Biglietterie - Terminal Imbarchi</PublishedLineName>"),
    ).vehicles[0];
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(), stops: new Set(),
      tripRoute: new Map(), routeByCode: new Map(),
      stopNames: new Map(), stopByName: new Map(), loadedAt: Date.now(),
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
