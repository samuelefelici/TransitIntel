/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Sonda SIRI — collaudo senza rete
 * ───────────────────────────────────────────────────────────────────────────
 * Il trasporto è un finto server che risponde in modo diverso a ogni
 * operazione: una risposta piena, un Fault, un ErrorCondition, uno Status
 * false, un silenzio. Si verifica che ogni esito venga letto per quello che
 * è, che le richieste abbiano la forma già accettata dal produttore, e che
 * la lettura finale dica la cosa giusta.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  buildCapabilitiesTutteRequest, buildEstimatedTimetableRequest, buildStopMonitoringRequest,
  buildVehicleMonitoringLivello, classificaRisposta, contaElementi, nomiElementi, operazioniWsdl,
  eseguiSonda, leggiSonda, endpointGemelli, type Trasporto, type TrasportoGet,
} from "../lib/siri-sonda";
import { buildGetCapabilitiesRequest } from "../lib/siri-vm";

const NS = 'xmlns:siri="http://www.siri.org.uk/siri"';
const busta = (corpo: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ${NS}><soap:Body>${corpo}</soap:Body></soap:Envelope>`;

const VM = busta(
  `<siri:GetVehicleMonitoringResponse><Answer><siri:VehicleMonitoringDelivery><siri:Status>true</siri:Status>`
  + `<siri:VehicleActivity><siri:MonitoredVehicleJourney><siri:VehicleRef>13161</siri:VehicleRef>`
  + `<siri:PreviousCalls><siri:PreviousCall><siri:StopPointRef>ANC001</siri:StopPointRef></siri:PreviousCall></siri:PreviousCalls>`
  + `</siri:MonitoredVehicleJourney></siri:VehicleActivity>`
  + `<siri:VehicleActivity><siri:MonitoredVehicleJourney><siri:VehicleRef>13162</siri:VehicleRef></siri:MonitoredVehicleJourney></siri:VehicleActivity>`
  + `</siri:VehicleMonitoringDelivery></Answer></siri:GetVehicleMonitoringResponse>`);
const VM_FULL = VM.replace("</siri:PreviousCalls>",
  `</siri:PreviousCalls><siri:OnwardCalls><siri:OnwardCall><siri:ExpectedArrivalTime>2026-09-14T10:00:00</siri:ExpectedArrivalTime></siri:OnwardCall></siri:OnwardCalls>`);
const CAP = busta(
  `<siri:GetCapabilitiesResponse><Answer><siri:VehicleMonitoringServiceCapabilities>`
  + `<siri:PublishSubscribe>false</siri:PublishSubscribe><siri:DefaultDetailLevel>calls</siri:DefaultDetailLevel>`
  + `<siri:HasNumberOfOnwardsCalls>false</siri:HasNumberOfOnwardsCalls><siri:ShortestPossibleCycle>PT60S</siri:ShortestPossibleCycle>`
  + `</siri:VehicleMonitoringServiceCapabilities></Answer></siri:GetCapabilitiesResponse>`);
const FAULT = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>`
  + `<faultcode>soap:Client</faultcode><faultstring>Operazione non supportata</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
const ERRC = busta(
  `<siri:GetEstimatedTimetableResponse><Answer><siri:EstimatedTimetableDelivery><siri:Status>false</siri:Status>`
  + `<siri:ErrorCondition><siri:ServiceNotAvailableError/><siri:Description>servizio non attivo per questo requestor</siri:Description></siri:ErrorCondition>`
  + `</siri:EstimatedTimetableDelivery></Answer></siri:GetEstimatedTimetableResponse>`);
const VUOTA_FALSE = busta(`<siri:GetProductionTimetableResponse><Answer><siri:ProductionTimetableDelivery><siri:Status>false</siri:Status></siri:ProductionTimetableDelivery></Answer></siri:GetProductionTimetableResponse>`);
const WSDL = `<wsdl:definitions xmlns:wsdl="x"><wsdl:portType><wsdl:operation name="GetVehicleMonitoring"/>`
  + `<wsdl:operation name="CheckStatus"/><wsdl:operation name="GetEstimatedTimetable"/></wsdl:portType>`
  + `<wsdl:binding><wsdl:operation name="GetVehicleMonitoring"/></wsdl:binding></wsdl:definitions>`;

describe("classificaRisposta", () => {
  it("distingue i quattro esiti e il silenzio", () => {
    expect(classificaRisposta(200, VM).esito).toBe("valida");
    expect(classificaRisposta(500, FAULT)).toEqual({ esito: "fault", dettaglio: "SOAP Fault: Operazione non supportata" });
    expect(classificaRisposta(200, ERRC)).toEqual({
      esito: "errore", dettaglio: "ErrorCondition (ServiceNotAvailableError): servizio non attivo per questo requestor",
    });
    expect(classificaRisposta(200, VUOTA_FALSE).esito).toBe("rifiutata");
    expect(classificaRisposta(0, "").esito).toBe("nessuna_risposta");
    expect(classificaRisposta(404, "<html>Not found</html>").esito).toBe("http");
  });
  /* Un Fault batte tutto: dentro può esserci la parola "ErrorCondition"
   * nel testo, e non per questo diventa un servizio che "esiste". */
  it("un Fault resta un Fault anche se nel testo compare ErrorCondition", () => {
    const f = FAULT.replace("Operazione non supportata", "ErrorCondition ignota");
    expect(classificaRisposta(500, f).esito).toBe("fault");
  });
});

describe("conteggi ed elementi", () => {
  it("conta gli elementi con o senza prefisso e non i nomi che iniziano allo stesso modo", () => {
    expect(contaElementi(VM, "VehicleActivity")).toBe(2);
    expect(contaElementi(VM, "PreviousCall")).toBe(1);      // non PreviousCalls
    expect(contaElementi(VM, "OnwardCall")).toBe(0);
    expect(contaElementi(VM.replace(/siri:/g, ""), "VehicleActivity")).toBe(2);
  });
  it("elenca i nomi distinti senza prefisso, ordinati", () => {
    const nomi = nomiElementi(VM);
    expect(nomi).toContain("VehicleActivity");
    expect(nomi).toContain("StopPointRef");
    expect(nomi.some(n => n.includes(":"))).toBe(false);
    expect([...nomi].sort()).toEqual(nomi);
  });
  it("legge le operazioni del WSDL una volta sola", () => {
    expect(operazioniWsdl(WSDL)).toEqual(["CheckStatus", "GetEstimatedTimetable", "GetVehicleMonitoring"]);
  });
});

describe("endpointGemelli", () => {
  /* L'indirizzo vero di Mizar porta la sigla del servizio nel percorso, due volte. */
  it("dall'indirizzo del VehicleMonitoring ricava quelli degli altri servizi", () => {
    const g = endpointGemelli("https://flashnetconerobus.miz.it/SIRIService/VMWS/VMService.svc");
    expect(g.map(x => x.servizio)).toEqual([
      "EstimatedTimetable", "StopMonitoring", "ProductionTimetable", "SituationExchange", "GeneralMessage", "ConnectionMonitoring",
    ]);
    expect(g[0].url).toBe("https://flashnetconerobus.miz.it/SIRIService/ETWS/ETService.svc");
    expect(g[1].url).toBe("https://flashnetconerobus.miz.it/SIRIService/SMWS/SMService.svc");
  });
  it("conserva ciò che segue il .svc e non propone il servizio di partenza", () => {
    const g = endpointGemelli("http://x/SIRIService/SMWS/SMService.svc/soap");
    expect(g.some(x => x.servizio === "StopMonitoring")).toBe(false);
    expect(g.find(x => x.servizio === "EstimatedTimetable")?.url).toBe("http://x/SIRIService/ETWS/ETService.svc/soap");
  });
  it("con un indirizzo che non segue lo schema non indovina nulla", () => {
    expect(endpointGemelli("https://avm.example.org/siri")).toEqual([]);
    expect(endpointGemelli("https://x/VMWS/OtherService.svc")).toEqual([]);
  });
});

describe("le richieste hanno la forma già accettata dal produttore", () => {
  it("GetEstimatedTimetable: ServiceRequestInfo con RequestorRef, Request 1.4, PreviewInterval", () => {
    const x = buildEstimatedTimetableRequest("Conerobus");
    expect(x).toContain(`<siri:GetEstimatedTimetable><ServiceRequestInfo>`);
    expect(x).toContain(`<siri:RequestorRef>Conerobus</siri:RequestorRef>`);
    expect(x).toContain(`<Request version="1.4">`);
    expect(x).toContain(`<siri:PreviewInterval>PT2H</siri:PreviewInterval>`);
    expect(x).toContain(`<RequestExtension/></siri:GetEstimatedTimetable>`);
  });
  it("GetStopMonitoring: la fermata è protetta dall'escape", () => {
    const x = buildStopMonitoringRequest("R", `A&B<`);
    expect(x).toContain(`<siri:MonitoringRef>A&amp;B&lt;</siri:MonitoringRef>`);
  });
  /* Il server Mizar rifiuta la richiesta di capacità senza `version` sul
   * singolo servizio: "Required attribute 'version' is missing". */
  it("GetCapabilities chiede tutti e cinque i servizi, ognuno con la versione", () => {
    const x = buildCapabilitiesTutteRequest("R");
    for (const s of ["VehicleMonitoring", "StopMonitoring", "EstimatedTimetable", "ProductionTimetable", "SituationExchange"]) {
      expect(x).toContain(`<siri:${s}CapabilitiesRequest version="1.4">`);
    }
    expect(buildGetCapabilitiesRequest("R")).toContain(`<siri:VehicleMonitoringCapabilitiesRequest version="1.4">`);
  });
  it("VehicleMonitoring 'full' differisce da 'calls' solo nel livello", () => {
    const a = buildVehicleMonitoringLivello("R", "calls").replace(/TI-sonda-[^<]+|20\d\d-[^<]+Z/g, "");
    const b = buildVehicleMonitoringLivello("R", "full").replace(/TI-sonda-[^<]+|20\d\d-[^<]+Z/g, "");
    expect(a.replace("calls", "full")).toBe(b);
  });
});

describe("eseguiSonda", () => {
  const post: Trasporto = async (op, corpo) => {
    if (op === "GetCapabilities") return { status: 200, xml: CAP };
    if (op === "GetVehicleMonitoring") return { status: 200, xml: corpo.includes(">full<") ? VM_FULL : VM };
    if (op === "GetEstimatedTimetable") return { status: 200, xml: ERRC };
    if (op === "GetStopMonitoring") return { status: 500, xml: FAULT };
    if (op === "GetProductionTimetable") return { status: 200, xml: VUOTA_FALSE };
    throw new Error("timeout");
  };
  const get: TrasportoGet = async () => ({ status: 200, xml: WSDL });

  it("mette insieme WSDL, capacità, differenza full/calls, fermata, esiti e grezzi", async () => {
    const r = await eseguiSonda({ url: "http://avm/siri", requestorRef: "Conerobus" }, post, get);
    expect(r.wsdl).toMatchObject({ raggiunto: true, operazioni: ["CheckStatus", "GetEstimatedTimetable", "GetVehicleMonitoring"] });
    expect(r.gemelli).toEqual([]);   // l'indirizzo non segue lo schema a sigle
    expect(r.capacita.dichiarate).toEqual({
      VehicleMonitoring: true, StopMonitoring: false, EstimatedTimetable: false, ProductionTimetable: false, SituationExchange: false,
    });
    expect(r.capacita.letto?.defaultDetailLevel).toBe("calls");
    expect(r.capacita.shortestPossibleCycle).toBe("PT60S");
    expect(r.fullAggiunge).toEqual(["ExpectedArrivalTime", "OnwardCall", "OnwardCalls"]);
    expect(r.fermataProvata).toBe("ANC001");

    const per = Object.fromEntries(r.prove.map(p => [p.operazione, p]));
    expect(per["GetVehicleMonitoring-calls"].conteggi).toMatchObject({ VehicleActivity: 2, PreviousCall: 1, OnwardCall: 0 });
    expect(per["GetVehicleMonitoring-full"].conteggi).toMatchObject({ OnwardCall: 1, ExpectedArrivalTime: 1 });
    expect(per.GetEstimatedTimetable.esito).toBe("errore");
    expect(per.GetStopMonitoring).toMatchObject({ esito: "fault", httpStatus: 500 });
    expect(per.GetProductionTimetable.esito).toBe("rifiutata");
    expect(per.GetSituationExchange).toMatchObject({ esito: "nessuna_risposta", httpStatus: 0 });

    expect(Object.keys(r.grezzi).sort()).toEqual([
      "GetCapabilities", "GetEstimatedTimetable", "GetProductionTimetable", "GetSituationExchange",
      "GetStopMonitoring", "GetVehicleMonitoring-calls", "GetVehicleMonitoring-full", "wsdl",
    ]);
    expect(r.grezzi.GetStopMonitoring).toBe(FAULT);
    expect(r.grezzi.GetSituationExchange).toContain("nessuna risposta: timeout");
  });

  it("la fermata passata a mano vince su quella trovata nel flusso", async () => {
    const r = await eseguiSonda({ url: "http://avm/siri", requestorRef: "R" }, post, get, "ANC999");
    expect(r.fermataProvata).toBe("ANC999");
    expect(r.prove.find(p => p.operazione === "GetStopMonitoring")?.richiestaXml).toContain("ANC999");
  });

  it("senza fermata nel flusso e senza fermata a mano, StopMonitoring viene saltata", async () => {
    const senzaFermate: Trasporto = async (op, corpo) =>
      op === "GetVehicleMonitoring" ? { status: 200, xml: VM.replace(/<siri:PreviousCalls>.*<\/siri:PreviousCalls>/, "") } : post(op, corpo);
    const r = await eseguiSonda({ url: "http://avm/siri", requestorRef: "R" }, senzaFermate, get);
    expect(r.fermataProvata).toBeNull();
    expect(r.prove.some(p => p.operazione === "GetStopMonitoring")).toBe(false);
  });

  it("prova gli indirizzi gemelli con una GET ?wsdl e riporta chi esiste", async () => {
    const VM_URL = "https://flashnetconerobus.miz.it/SIRIService/VMWS/VMService.svc";
    const getGemelli: TrasportoGet = async (url) => {
      if (url.startsWith(VM_URL)) return { status: 200, xml: WSDL };
      if (url.includes("/ETWS/")) return { status: 200, xml: WSDL.replace(/GetVehicleMonitoring/g, "GetEstimatedTimetable") };
      if (url.includes("/SXWS/")) throw new Error("timeout");
      return { status: 404, xml: "<html>Not Found</html>" };
    };
    const r = await eseguiSonda({ url: VM_URL, requestorRef: "R" }, post, getGemelli);
    const per = Object.fromEntries(r.gemelli.map(g => [g.servizio, g]));
    expect(per.EstimatedTimetable).toMatchObject({ httpStatus: 200, operazioni: ["CheckStatus", "GetEstimatedTimetable"], esito: "esiste: 2 operazioni" });
    expect(per.StopMonitoring).toMatchObject({ httpStatus: 404, operazioni: [], esito: "non esiste (404)" });
    expect(per.SituationExchange).toMatchObject({ httpStatus: 0, esito: "nessuna risposta: timeout" });
    expect(r.grezzi["wsdl-EstimatedTimetable"]).toContain("GetEstimatedTimetable");
    expect(r.lettura.join("\n")).toMatch(/esistono altri endpoint SIRI: EstimatedTimetable \(https:\/\/flashnetconerobus\.miz\.it\/SIRIService\/ETWS\/ETService\.svc\)/);
    expect(r.lettura.join("\n")).not.toMatch(/vanno chiesti a Mizar\.$/m);
  });

  it("la lettura dice che full aggiunge, che ET non è disponibile, e che il server dichiara solo VM", async () => {
    const r = await eseguiSonda({ url: "http://avm/siri", requestorRef: "R" }, post, get);
    expect(r.lettura.join("\n")).toMatch(/"full" aggiunge 3 elementi/);
    expect(r.lettura.join("\n")).toMatch(/EstimatedTimetable non disponibile/);
    expect(r.lettura.join("\n")).toMatch(/dichiara il solo VehicleMonitoring/);
  });
});

describe("leggiSonda su risultati costruiti", () => {
  const prova = (operazione: string, esito: any, conteggi: Record<string, number>) => ({
    operazione, scopo: "", httpStatus: 200, byte: 0, esito, dettaglio: "", conteggi, elementiDistinti: 0, richiestaXml: "",
  });
  it("quando EstimatedTimetable risponde con corse, lo dice come fonte da usare", () => {
    const l = leggiSonda({
      wsdl: { operazioni: [] }, dichiarate: { VehicleMonitoring: true, EstimatedTimetable: true }, fullAggiunge: [],
      prove: [prova("GetEstimatedTimetable", "valida", { EstimatedVehicleJourney: 40 })],
    });
    expect(l.join("\n")).toMatch(/full" non aggiunge nulla/);
    expect(l.join("\n")).toMatch(/EstimatedTimetable risponde con corse/);
    expect(l.join("\n")).not.toMatch(/solo VehicleMonitoring/);
  });
  /* Il caso vero del 14 settembre: WSDL con Subscribe, nessun gemello. */
  it("con Subscribe nel WSDL e nessun gemello, lo dice, e dice che il resto va chiesto a Mizar", () => {
    const l = leggiSonda({
      wsdl: { operazioni: ["CheckStatus", "DeleteSubscription", "GetCapabilities", "GetVehicleMonitoring", "Subscribe"] },
      gemelli: [{ servizio: "EstimatedTimetable", url: "u", operazioni: [] }],
      dichiarate: {}, fullAggiunge: [], prove: [],
    });
    expect(l.join("\n")).toMatch(/nessun indirizzo gemello risponde/);
    expect(l.join("\n")).toMatch(/accetta sottoscrizioni/);
  });
  it("quando EstimatedTimetable esiste ma è vuoto, lo distingue dal non disponibile", () => {
    const l = leggiSonda({
      wsdl: { operazioni: [] }, dichiarate: {}, fullAggiunge: [],
      prove: [prova("GetEstimatedTimetable", "valida", { EstimatedVehicleJourney: 0 })],
    });
    expect(l.join("\n")).toMatch(/esiste ma risponde vuoto/);
  });
});
