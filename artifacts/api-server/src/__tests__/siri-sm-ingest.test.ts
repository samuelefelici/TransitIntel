/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Previsioni alle prossime fermate — collaudo della parte pura
 * ───────────────────────────────────────────────────────────────────────────
 * Quali fermate chiedere, e che cosa tenere della risposta. Il trasporto e
 * il database non entrano: la risposta è quella vera dello StopMonitoring
 * del 14 settembre 2026 (la CR3 seguita, con la previsione), ridotta.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import { prossimeFermate, previsioniDaVisite, type CorsaAttiva } from "../lib/siri-sm-ingest";
import { parseStopMonitoringResponse, fermataVuota } from "../lib/siri-fermata";
import { buildMultipleStopMonitoringRequest } from "../lib/siri-sonda";

const SEQ = [
  { stopId: "20001", seq: 1, scheduled: "10:00:00" },
  { stopId: "20010", seq: 2, scheduled: "10:05:00" },
  { stopId: "20020", seq: 3, scheduled: "10:12:00" },
  { stopId: "20045", seq: 4, scheduled: "10:46:08" },
  { stopId: "20099", seq: 5, scheduled: "10:50:00" },
];

describe("prossimeFermate", () => {
  it("parte dalla fermata corrente dichiarata dall'AVM", () => {
    expect(prossimeFermate(SEQ, "20010", 0).map(s => s.stopId)).toEqual(["20010", "20020", "20045"]);
  });
  it("senza fermata corrente parte dalla prima non ancora passata (con due minuti di tolleranza)", () => {
    const ore = (h: number, m: number) => h * 3600 + m * 60;
    expect(prossimeFermate(SEQ, null, ore(10, 6)).map(s => s.stopId)).toEqual(["20010", "20020", "20045"]);   // 10:05 è passato da 1 minuto: si tiene
    expect(prossimeFermate(SEQ, null, ore(10, 8)).map(s => s.stopId)).toEqual(["20020", "20045", "20099"]);
    expect(prossimeFermate(SEQ, null, ore(11, 0))).toEqual([]);   // corsa finita
  });
  it("una fermata corrente sconosciuta alla sequenza ricade sul criterio orario", () => {
    expect(prossimeFermate(SEQ, "999", 10 * 3600 + 8 * 60).map(s => s.stopId)).toEqual(["20020", "20045", "20099"]);
  });
  it("rispetta il numero chiesto e la fine della corsa", () => {
    expect(prossimeFermate(SEQ, "20045", 0, 3).map(s => s.stopId)).toEqual(["20045", "20099"]);
    expect(prossimeFermate([], "20045", 0)).toEqual([]);
  });
});

const XML = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<GetMultipleStopMonitoringResponse xmlns="http://www.siri.org.uk/siri"><Answer xmlns="">
<StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4"><Status>true</Status>
<MonitoredStopVisit><RecordedAtTime>2026-09-14T00:00:00</RecordedAtTime><MonitoringRef>1122</MonitoringRef>
 <MonitoredVehicleJourney><LineRef>C</LineRef><CourseOfJourneyRef>369660</CourseOfJourneyRef><Monitored>false</Monitored>
  <MonitoredCall><StopPointRef>1122</StopPointRef><AimedDepartureTime>2026-09-14T10:12:00+02:00</AimedDepartureTime></MonitoredCall>
 </MonitoredVehicleJourney></MonitoredStopVisit>
<MonitoredStopVisit><RecordedAtTime>2026-09-14T10:01:25.7975277</RecordedAtTime><MonitoringRef>1122</MonitoringRef>
 <MonitoredVehicleJourney><LineRef>CR3</LineRef><CourseOfJourneyRef>454460</CourseOfJourneyRef><Monitored>true</Monitored>
  <MonitoredCall><StopPointRef>1122</StopPointRef><AimedDepartureTime>2026-09-14T10:46:08+02:00</AimedDepartureTime>
   <ExpectedDepartureTime>2026-09-14T10:47:03</ExpectedDepartureTime><DepartureStatus>onTime</DepartureStatus></MonitoredCall>
 </MonitoredVehicleJourney></MonitoredStopVisit>
</StopMonitoringDelivery>
<StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4"><Status>true</Status>
<MonitoredStopVisit><RecordedAtTime>2026-09-14T10:01:25</RecordedAtTime><MonitoringRef>200</MonitoringRef>
 <MonitoredVehicleJourney><LineRef>CR3</LineRef><CourseOfJourneyRef>454460</CourseOfJourneyRef><Monitored>true</Monitored>
  <MonitoredCall><StopPointRef>200</StopPointRef><AimedArrivalTime>2026-09-14T10:50:00+02:00</AimedArrivalTime>
   <ExpectedArrivalTime>2026-09-14T10:52:30</ExpectedArrivalTime><ArrivalStatus>delayed</ArrivalStatus></MonitoredCall>
 </MonitoredVehicleJourney></MonitoredStopVisit>
<MonitoredStopVisit><RecordedAtTime>2026-09-14T10:01:00</RecordedAtTime><MonitoringRef>200</MonitoringRef>
 <MonitoredVehicleJourney><LineRef>N</LineRef><CourseOfJourneyRef>455471</CourseOfJourneyRef><Monitored>true</Monitored>
  <MonitoredCall><StopPointRef>200</StopPointRef><ExpectedDepartureTime>2026-09-14T11:00:00</ExpectedDepartureTime></MonitoredCall>
 </MonitoredVehicleJourney></MonitoredStopVisit>
</StopMonitoringDelivery>
</Answer></GetMultipleStopMonitoringResponse></s:Body></s:Envelope>`;

describe("parseStopMonitoringResponse su più delivery", () => {
  it("legge le visite di tutte le fermate chieste", () => {
    const r = parseStopMonitoringResponse(XML);
    expect(r.failed).toBe(false);
    expect(r.visite).toHaveLength(4);
    expect(r.visite.map(v => v.monitoringRef)).toEqual(["1122", "1122", "200", "200"]);
  });
});

describe("previsioniDaVisite", () => {
  const attive: CorsaAttiva[] = [
    { vehicleRef: "11096", tripId: "689_CodUdp:D1634_454460", fermataCorrenteRef: "1122", fermataCorrenteId: "20045" },
  ];
  const tripByCode = new Map([["454460", "689_CodUdp:D1634_454460"], ["369660", "689_CodUdp:D1638_369660"], ["455471", "689_CodUdp:D1638_455471"]]);
  const alias = new Map([["1122", "20045"], ["200", "20001"]]);

  it("tiene solo le previsioni delle corse attive, tradotte nel feed", () => {
    const p = previsioniDaVisite(parseStopMonitoringResponse(XML).visite, attive, tripByCode, alias);
    expect(p).toHaveLength(2);
    const [a, b] = p;
    expect(a).toMatchObject({ tripId: "689_CodUdp:D1634_454460", stopId: "20045", mizarRef: "1122", vehicleRef: "11096", lineRef: "CR3", stato: "onTime" });
    expect(a.expectedTs.toISOString()).toBe("2026-09-14T08:47:03.000Z");
    expect(a.aimedTs?.toISOString()).toBe("2026-09-14T08:46:08.000Z");
    expect(a.recordedAt?.toISOString()).toBe("2026-09-14T08:01:25.797Z");
    /* la seconda fermata: previsione di arrivo, senza partenza */
    expect(b).toMatchObject({ stopId: "20001", mizarRef: "200", stato: "delayed" });
    expect(b.expectedTs.toISOString()).toBe("2026-09-14T08:52:30.000Z");
  });
  it("una corsa seguita ma non attiva per noi, o senza previsione, non entra", () => {
    const p = previsioniDaVisite(parseStopMonitoringResponse(XML).visite, [], tripByCode, alias);
    expect(p).toEqual([]);
    const soloN: CorsaAttiva[] = [{ vehicleRef: "1", tripId: "689_CodUdp:D1638_455471", fermataCorrenteRef: null, fermataCorrenteId: null }];
    const q = previsioniDaVisite(parseStopMonitoringResponse(XML).visite, soloN, tripByCode, alias);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ stopId: "20001", lineRef: "N", aimedTs: null });
  });
  it("una fermata senza transcodifica non produce previsioni", () => {
    const p = previsioniDaVisite(parseStopMonitoringResponse(XML).visite, attive, tripByCode, new Map([["200", "20001"]]));
    expect(p.map(x => x.stopId)).toEqual(["20001"]);
  });
});

describe("buildMultipleStopMonitoringRequest", () => {
  it("un filtro per fermata, dentro la stessa busta delle altre richieste", () => {
    const x = buildMultipleStopMonitoringRequest("TransitIntel", ["1122", "200"], "PT1H", 30);
    expect(x).toContain("<siri:GetMultipleStopMonitoring><ServiceRequestInfo>");
    expect(x).toContain(`<Request version="1.4">`);
    expect((x.match(/<siri:StopMonitoringFilter>/g) ?? []).length).toBe(2);
    expect(x).toContain("<siri:MonitoringRef>1122</siri:MonitoringRef>");
    expect(x).toContain("<siri:MonitoringRef>200</siri:MonitoringRef>");
    expect(x).toContain("<siri:MaximumStopVisits>30</siri:MaximumStopVisits>");
    expect(x).toContain("<RequestExtension/></siri:GetMultipleStopMonitoring>");
  });
});

/* Il caso vero del primo giro in produzione (14/09, 12:41): su 18 fermate
 * chieste una era vuota, e Mizar risponde a una fermata vuota con un
 * ErrorCondition "No info found.". Non è un errore, e non deve buttare via
 * le altre diciassette né la modalità multipla. */
describe("fermate vuote: «No info found.» non è un errore", () => {
  const vuota = (ref: string) => `<StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4"><Status>false</Status>
    <ErrorCondition><NoInfoForTopicError/><Description>No info found.</Description></ErrorCondition><MonitoringRef>${ref}</MonitoringRef></StopMonitoringDelivery>`;
  const piena = (ref: string) => `<StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4"><Status>true</Status>
    <MonitoredStopVisit><RecordedAtTime>2026-09-14T00:00:00</RecordedAtTime><MonitoringRef>${ref}</MonitoringRef>
     <MonitoredVehicleJourney><LineRef>C</LineRef><CourseOfJourneyRef>369660</CourseOfJourneyRef><Monitored>false</Monitored>
      <MonitoredCall><StopPointRef>${ref}</StopPointRef><AimedDepartureTime>2026-09-14T10:12:00+02:00</AimedDepartureTime></MonitoredCall>
     </MonitoredVehicleJourney></MonitoredStopVisit></StopMonitoringDelivery>`;
  const busta = (corpo: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
    <GetMultipleStopMonitoringResponse xmlns="http://www.siri.org.uk/siri"><Answer xmlns="">${corpo}</Answer></GetMultipleStopMonitoringResponse></s:Body></s:Envelope>`;

  it("una fermata vuota fra due piene: risposta valida con le visite delle altre", () => {
    const r = parseStopMonitoringResponse(busta(piena("1122") + vuota("4759") + piena("200")));
    expect(r.failed).toBe(false);
    expect(r.visite.map(v => v.monitoringRef)).toEqual(["1122", "200"]);
    expect(fermataVuota(r.errorText)).toBe(true);   // il testo resta leggibile, ma non è un fallimento
  });
  it("tutte le fermate vuote: fallita per il parser, ma riconoscibile come vuota", () => {
    const r = parseStopMonitoringResponse(busta(vuota("4759")));
    expect(r.failed).toBe(true);
    expect(r.errorText).toBe("No info found.");
    expect(fermataVuota(r.errorText)).toBe(true);
    expect(fermataVuota("ContractFilter mismatch")).toBe(false);
    expect(fermataVuota(null)).toBe(false);
  });
});
