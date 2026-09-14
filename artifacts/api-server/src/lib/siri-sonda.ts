/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Sonda SIRI — che cosa espone il server dell'AVM oltre a ciò che usiamo
 * ───────────────────────────────────────────────────────────────────────────
 * Oggi interroghiamo un solo servizio, GetVehicleMonitoring con dettaglio
 * "calls". Lo standard SIRI ne prevede altri — StopMonitoring (arrivi per
 * fermata), EstimatedTimetable (orari stimati corsa per corsa),
 * ProductionTimetable (il programma del giorno), SituationExchange (avvisi) —
 * e un livello di dettaglio più alto, "full". Se anche uno solo risponde con
 * dati, abbiamo una fonte di tempi di passaggio che oggi ricostruiamo dalle
 * posizioni.
 *
 * La sonda manda le domande allo STESSO endpoint, con la STESSA busta SOAP 1.1
 * e lo stesso RequestorRef della richiesta che già funziona: così un rifiuto
 * dice "il servizio non c'è" e non "hai sbagliato la richiesta". Ogni
 * risposta viene classificata in quattro esiti — valida, SOAP Fault,
 * ErrorCondition, Status=false — e contata sugli elementi che contano.
 *
 * Il trasporto è iniettabile: la classificazione si collauda senza rete.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { buildGetCapabilitiesRequest, parseCapabilities, type SiriEndpointConfig } from "./siri-vm";

const SIRI_NS = "http://www.siri.org.uk/siri";
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

function esc(v: string): string {
  return v.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function nowIso(): string { return new Date().toISOString(); }
function msgId(): string { return `TI-sonda-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function envelope(bodyInner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:siri="${SIRI_NS}">`
    + `<soap:Body>${bodyInner}</soap:Body></soap:Envelope>`;
}
/* Le due intestazioni che GetVehicleMonitoring usa già oggi, identiche. */
function info(requestorRef: string, ts: string): string {
  return `<ServiceRequestInfo>`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:RequestorRef>${esc(requestorRef)}</siri:RequestorRef>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + `</ServiceRequestInfo>`;
}
function testa(ts: string): string {
  return `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp><siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`;
}
/** Una richiesta di servizio nella forma già accettata dal produttore. */
function servizio(op: string, requestorRef: string, dentroRequest: string): string {
  const ts = nowIso();
  return envelope(
    `<siri:${op}>${info(requestorRef, ts)}<Request version="1.4">${testa(ts)}${dentroRequest}</Request>`
    + `<RequestExtension/></siri:${op}>`,
  );
}

/* ── Le richieste ────────────────────────────────────────────────────────── */

export const SERVIZI_SIRI = [
  "VehicleMonitoring", "StopMonitoring", "EstimatedTimetable", "ProductionTimetable", "SituationExchange",
] as const;

/** GetCapabilities per TUTTI i servizi, non solo VehicleMonitoring. */
export function buildCapabilitiesTutteRequest(requestorRef: string): string {
  const ts = nowIso();
  /* `version` su ogni richiesta di servizio: senza, il server Mizar risponde
   * ErrorCondition "Required attribute 'version' is missing". */
  const richieste = SERVIZI_SIRI
    .map(s => `<siri:${s}CapabilitiesRequest version="1.4">${testa(ts)}</siri:${s}CapabilitiesRequest>`).join("");
  return envelope(
    `<siri:GetCapabilities><Request version="1.4">${testa(ts)}`
    + `<siri:RequestorRef>${esc(requestorRef)}</siri:RequestorRef>${richieste}</Request>`
    + `<RequestExtension/></siri:GetCapabilities>`,
  );
}
export function buildVehicleMonitoringLivello(requestorRef: string, livello: "calls" | "full"): string {
  return servizio("GetVehicleMonitoring", requestorRef,
    `<siri:VehicleMonitoringDetailLevel>${livello}</siri:VehicleMonitoringDetailLevel>`);
}
export function buildEstimatedTimetableRequest(requestorRef: string, anteprima = "PT2H"): string {
  return servizio("GetEstimatedTimetable", requestorRef, `<siri:PreviewInterval>${anteprima}</siri:PreviewInterval>`);
}
export function buildStopMonitoringRequest(requestorRef: string, stopRef: string, anteprima = "PT2H"): string {
  return servizio("GetStopMonitoring", requestorRef,
    `<siri:PreviewInterval>${anteprima}</siri:PreviewInterval>`
    + `<siri:MonitoringRef>${esc(stopRef)}</siri:MonitoringRef>`
    + `<siri:StopMonitoringDetailLevel>calls</siri:StopMonitoringDetailLevel>`
    + `<siri:MaximumStopVisits>20</siri:MaximumStopVisits>`);
}
export function buildProductionTimetableRequest(requestorRef: string): string {
  return servizio("GetProductionTimetable", requestorRef, "");
}
export function buildSituationExchangeRequest(requestorRef: string): string {
  return servizio("GetSituationExchange", requestorRef, "");
}

/* ── Lettura delle risposte ──────────────────────────────────────────────── */

/** Quante volte compare l'elemento, con o senza prefisso di namespace. */
export function contaElementi(xml: string, nome: string): number {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${nome}[\\s>/]`, "g");
  return (xml.match(re) ?? []).length;
}
/** I nomi distinti degli elementi, senza prefisso: la "forma" della risposta. */
export function nomiElementi(xml: string): string[] {
  const nomi = new Set<string>();
  const re = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)[\s>/]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) nomi.add(m[1]);
  return [...nomi].sort();
}
/**
 * Gli endpoint "gemelli" che un server SIRI a servizi separati potrebbe
 * esporre. Il server Mizar pubblica il VehicleMonitoring su
 * `/SIRIService/VMWS/VMService.svc`: un percorso che porta nel nome la sigla
 * del servizio. Se gli altri servizi esistono, con ogni probabilità stanno
 * allo stesso indirizzo con la sigla cambiata. Restituisce vuoto se l'URL
 * non segue lo schema: allora non c'è nulla da indovinare.
 */
export const SIGLE_SERVIZI: Array<{ sigla: string; servizio: string }> = [
  { sigla: "ET", servizio: "EstimatedTimetable" },
  { sigla: "SM", servizio: "StopMonitoring" },
  { sigla: "PT", servizio: "ProductionTimetable" },
  { sigla: "SX", servizio: "SituationExchange" },
  { sigla: "GM", servizio: "GeneralMessage" },
  { sigla: "CM", servizio: "ConnectionMonitoring" },
];
export function endpointGemelli(url: string): Array<{ servizio: string; url: string }> {
  const m = /^(.*\/)([A-Z]{2})(WS\/)\2(Service\.svc)(.*)$/.exec(url);
  if (!m) return [];
  const [, prima, sigla, ws, svc, dopo] = m;
  return SIGLE_SERVIZI
    .filter(s => s.sigla !== sigla)
    .map(s => ({ servizio: s.servizio, url: `${prima}${s.sigla}${ws}${s.sigla}${svc}${dopo}` }));
}

/** Le <operation name="..."> di un WSDL: ciò che il server dichiara di sapere fare. */
export function operazioniWsdl(xml: string): string[] {
  const out = new Set<string>();
  const re = /<(?:[A-Za-z0-9_.-]+:)?operation\s[^>]*?name="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.add(m[1]);
  return [...out].sort();
}
function primoTesto(xml: string, nomi: string[]): string | null {
  for (const nome of nomi) {
    const m = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${nome}[^>]*>([^<]*)<`).exec(xml);
    const t = m?.[1]?.trim();
    if (t) return t;
  }
  return null;
}

export type EsitoSonda = "valida" | "fault" | "errore" | "rifiutata" | "nessuna_risposta" | "http";

export interface Classificazione {
  esito: EsitoSonda;
  /** una riga leggibile: il testo del Fault, la descrizione dell'ErrorCondition… */
  dettaglio: string;
}

/**
 * Che cosa ha risposto il server, in una parola. L'ordine conta: un Fault è
 * un rifiuto dell'operazione (il servizio non esiste o non è permesso), un
 * ErrorCondition è il servizio che esiste ma non consegna, Status=false lo
 * stesso senza spiegazione. "valida" non vuol dire "piena": i conteggi lo dicono.
 */
export function classificaRisposta(httpStatus: number, xml: string): Classificazione {
  if (httpStatus === 0 && !xml) return { esito: "nessuna_risposta", dettaglio: "il server non ha risposto entro il timeout" };
  if (/<(?:[A-Za-z0-9_.-]+:)?Fault[\s>]/.test(xml)) {
    return { esito: "fault", dettaglio: `SOAP Fault: ${primoTesto(xml, ["faultstring", "Reason", "Text"]) ?? "(senza testo)"}` };
  }
  if (contaElementi(xml, "ErrorCondition") > 0) {
    const testo = primoTesto(xml, ["ErrorText", "Description"]);
    const tipo = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z]+Error)[\s/>]/.exec(xml)?.[1];
    return { esito: "errore", dettaglio: `ErrorCondition${tipo ? ` (${tipo})` : ""}: ${testo ?? "(senza descrizione)"}` };
  }
  if (/<(?:[A-Za-z0-9_.-]+:)?Status>\s*false\s*</.test(xml)) {
    return { esito: "rifiutata", dettaglio: "Status=false: il servizio risponde ma non consegna" };
  }
  if (!xml.includes("Envelope")) {
    return { esito: "http", dettaglio: `HTTP ${httpStatus}, la risposta non è una busta SOAP` };
  }
  return { esito: "valida", dettaglio: "risposta valida" };
}

/* ── Esecuzione ──────────────────────────────────────────────────────────── */

export interface RispostaGrezza { status: number; xml: string }
/** POST SOAP: (operazione, corpo) → risposta. Iniettato per il collaudo. */
export type Trasporto = (operazione: string, corpo: string) => Promise<RispostaGrezza>;
/** GET semplice (per il WSDL). */
export type TrasportoGet = (url: string) => Promise<RispostaGrezza>;

export interface ProvaSonda {
  operazione: string;
  /** perché la facciamo, in una riga */
  scopo: string;
  httpStatus: number;
  byte: number;
  esito: EsitoSonda;
  dettaglio: string;
  /** gli elementi che contano per QUESTA prova, con quante volte compaiono */
  conteggi: Record<string, number>;
  /** quanti nomi di elemento distinti: la ricchezza della risposta */
  elementiDistinti: number;
  richiestaXml: string;
}

export interface RisultatoSonda {
  quando: string;
  endpoint: string;
  requestorRef: string;
  wsdl: { raggiunto: boolean; operazioni: string[]; dettaglio: string };
  /** gli indirizzi gemelli provati con una GET ?wsdl: esistono altri servizi sullo stesso server? */
  gemelli: Array<{ servizio: string; url: string; httpStatus: number; operazioni: string[]; esito: string }>;
  capacita: {
    dichiarate: Record<string, boolean>;
    letto: ReturnType<typeof parseCapabilities> | null;
    shortestPossibleCycle: string | null;
  };
  /** ciò che "full" aggiunge a "calls": la risposta secca alla domanda "chiedendo di più arriva di più?" */
  fullAggiunge: string[];
  fermataProvata: string | null;
  prove: ProvaSonda[];
  /** la conclusione, in due righe, per chi non legge i conteggi */
  lettura: string[];
  /** i grezzi interi, per operazione: si scaricano con ?grezzo=<operazione> */
  grezzi: Record<string, string>;
}

const CONTEGGI: Record<string, string[]> = {
  "GetVehicleMonitoring-calls": ["VehicleActivity", "PreviousCall", "OnwardCall", "ActualArrivalTime", "ExpectedArrivalTime"],
  "GetVehicleMonitoring-full": ["VehicleActivity", "PreviousCall", "OnwardCall", "ActualArrivalTime", "ExpectedArrivalTime"],
  GetEstimatedTimetable: ["EstimatedVehicleJourney", "EstimatedCall", "ExpectedArrivalTime", "ExpectedDepartureTime"],
  GetStopMonitoring: ["MonitoredStopVisit", "ExpectedArrivalTime", "ExpectedDepartureTime"],
  GetProductionTimetable: ["DatedVehicleJourney", "DatedCall"],
  GetSituationExchange: ["PtSituationElement"],
  GetCapabilities: SERVIZI_SIRI.map(s => `${s}ServiceCapabilities`),
};

async function prova(
  post: Trasporto, operazione: string, azioneSoap: string, scopo: string, corpo: string, grezzi: Record<string, string>,
): Promise<ProvaSonda> {
  let r: RispostaGrezza;
  try { r = await post(azioneSoap, corpo); }
  catch (e: any) { r = { status: 0, xml: "" }; grezzi[operazione] = `(nessuna risposta: ${e?.message ?? e})`; }
  if (!(operazione in grezzi)) grezzi[operazione] = r.xml;
  const c = classificaRisposta(r.status, r.xml);
  const conteggi: Record<string, number> = {};
  for (const nome of CONTEGGI[operazione] ?? []) conteggi[nome] = contaElementi(r.xml, nome);
  return {
    operazione, scopo, httpStatus: r.status, byte: Buffer.byteLength(r.xml),
    esito: c.esito, dettaglio: c.dettaglio, conteggi,
    elementiDistinti: nomiElementi(r.xml).length, richiestaXml: corpo,
  };
}

/**
 * Tutte le prove, in ordine di costo. `stopRef` forza la fermata per
 * StopMonitoring; altrimenti si prende la prima trovata nella risposta
 * VehicleMonitoring, che è la sola che il produttore sicuramente conosce.
 */
export async function eseguiSonda(
  cfg: Pick<SiriEndpointConfig, "url" | "requestorRef">,
  post: Trasporto, get: TrasportoGet, stopRef: string | null = null,
): Promise<RisultatoSonda> {
  const grezzi: Record<string, string> = {};
  const prove: ProvaSonda[] = [];

  /* 0. WSDL: una GET, l'elenco delle operazioni dichiarate. */
  let wsdl: RisultatoSonda["wsdl"];
  try {
    const r = await get(`${cfg.url}${cfg.url.includes("?") ? "&" : "?"}wsdl`);
    grezzi.wsdl = r.xml;
    const operazioni = operazioniWsdl(r.xml);
    wsdl = {
      raggiunto: r.status > 0 && r.status < 400, operazioni,
      dettaglio: operazioni.length ? `${operazioni.length} operazioni dichiarate` : `HTTP ${r.status}, nessuna <operation> trovata`,
    };
  } catch (e: any) {
    wsdl = { raggiunto: false, operazioni: [], dettaglio: `?wsdl non raggiungibile: ${e?.message ?? e}` };
  }

  /* 0b. Gli indirizzi gemelli: una GET ?wsdl ciascuno. Un 404 dice "non
   * c'è"; un WSDL con operazioni dice "c'è, e queste sono le sue". */
  const gemelli: RisultatoSonda["gemelli"] = [];
  for (const g of endpointGemelli(cfg.url)) {
    try {
      const r = await get(`${g.url}?wsdl`);
      const operazioni = operazioniWsdl(r.xml);
      grezzi[`wsdl-${g.servizio}`] = r.xml;
      gemelli.push({
        ...g, httpStatus: r.status, operazioni,
        esito: operazioni.length ? `esiste: ${operazioni.length} operazioni` : r.status === 404 ? "non esiste (404)" : `HTTP ${r.status}, nessun WSDL`,
      });
    } catch (e: any) {
      gemelli.push({ ...g, httpStatus: 0, operazioni: [], esito: `nessuna risposta: ${e?.message ?? e}` });
    }
  }

  /* 1. Capacità di tutti i servizi. */
  const cap = await prova(post, "GetCapabilities", "GetCapabilities",
    "che cosa il server dichiara di sapere fare, servizio per servizio",
    buildCapabilitiesTutteRequest(cfg.requestorRef), grezzi);
  prove.push(cap);
  const capXml = grezzi.GetCapabilities ?? "";
  const dichiarate: Record<string, boolean> = {};
  for (const s of SERVIZI_SIRI) dichiarate[s] = contaElementi(capXml, `${s}ServiceCapabilities`) > 0;
  let letto: ReturnType<typeof parseCapabilities> | null = null;
  try { letto = cap.esito === "valida" ? parseCapabilities(capXml) : null; } catch { letto = null; }

  /* 2. VehicleMonitoring "calls" e "full", per differenza. */
  const vmCalls = await prova(post, "GetVehicleMonitoring-calls", "GetVehicleMonitoring",
    "la richiesta di oggi, come riferimento", buildVehicleMonitoringLivello(cfg.requestorRef, "calls"), grezzi);
  const vmFull = await prova(post, "GetVehicleMonitoring-full", "GetVehicleMonitoring",
    "la stessa richiesta col dettaglio massimo: arriva qualcosa in più?",
    buildVehicleMonitoringLivello(cfg.requestorRef, "full"), grezzi);
  prove.push(vmCalls, vmFull);
  const nomiCalls = new Set(nomiElementi(grezzi["GetVehicleMonitoring-calls"] ?? ""));
  const fullAggiunge = nomiElementi(grezzi["GetVehicleMonitoring-full"] ?? "").filter(n => !nomiCalls.has(n));

  /* 3. EstimatedTimetable. */
  prove.push(await prova(post, "GetEstimatedTimetable", "GetEstimatedTimetable",
    "orari stimati corsa per corsa nelle prossime due ore: la fonte dei tempi di passaggio",
    buildEstimatedTimetableRequest(cfg.requestorRef), grezzi));

  /* 4. StopMonitoring su una fermata che il produttore conosce. */
  const fermata = stopRef
    ?? /<(?:[A-Za-z0-9_.-]+:)?StopPointRef[^>]*>([^<]+)</.exec(grezzi["GetVehicleMonitoring-calls"] ?? "")?.[1]?.trim()
    ?? null;
  if (fermata) {
    prove.push(await prova(post, "GetStopMonitoring", "GetStopMonitoring",
      `arrivi previsti alla fermata ${fermata}`, buildStopMonitoringRequest(cfg.requestorRef, fermata), grezzi));
  }

  /* 5. ProductionTimetable, 6. SituationExchange. */
  prove.push(await prova(post, "GetProductionTimetable", "GetProductionTimetable",
    "il programma del giorno secondo l'AVM, da confrontare col GTFS",
    buildProductionTimetableRequest(cfg.requestorRef), grezzi));
  prove.push(await prova(post, "GetSituationExchange", "GetSituationExchange",
    "avvisi e deviazioni", buildSituationExchangeRequest(cfg.requestorRef), grezzi));

  return {
    quando: new Date().toISOString(),
    endpoint: cfg.url, requestorRef: cfg.requestorRef,
    wsdl, gemelli,
    capacita: {
      dichiarate, letto,
      shortestPossibleCycle: /<(?:[A-Za-z0-9_.-]+:)?ShortestPossibleCycle>([^<]+)</.exec(capXml)?.[1] ?? null,
    },
    fullAggiunge, fermataProvata: fermata, prove,
    lettura: leggiSonda({ wsdl, gemelli, dichiarate, fullAggiunge, prove }),
    grezzi,
  };
}

/**
 * La conclusione in parole. Non ripete i numeri: dice che cosa cambia per noi.
 * Pura, così si collauda su risultati costruiti a mano.
 */
export function leggiSonda(r: {
  wsdl: { operazioni: string[] };
  gemelli?: Array<{ servizio: string; url: string; operazioni: string[] }>;
  dichiarate: Record<string, boolean>;
  fullAggiunge: string[];
  prove: ProvaSonda[];
}): string[] {
  const out: string[] = [];
  const p = (op: string) => r.prove.find(x => x.operazione === op);
  const piena = (op: string, ...nomi: string[]) => {
    const x = p(op);
    return !!x && x.esito === "valida" && nomi.some(n => (x.conteggi[n] ?? 0) > 0);
  };

  if (r.fullAggiunge.length) {
    out.push(`Il dettaglio "full" aggiunge ${r.fullAggiunge.length} elementi rispetto a "calls" (${r.fullAggiunge.slice(0, 6).join(", ")}${r.fullAggiunge.length > 6 ? "…" : ""}): vale la pena passare a "full".`);
  } else {
    out.push(`Il dettaglio "full" non aggiunge nulla rispetto a "calls": quello che riceviamo dal VehicleMonitoring è tutto quello che c'è.`);
  }

  if (piena("GetEstimatedTimetable", "EstimatedVehicleJourney")) {
    out.push("EstimatedTimetable risponde con corse: è la fonte degli orari di passaggio stimati, da usare al posto della ricostruzione dalle posizioni.");
  } else if (p("GetEstimatedTimetable")?.esito === "valida") {
    out.push("EstimatedTimetable esiste ma risponde vuoto: il servizio c'è, va chiesto a Mizar perché non lo alimenta.");
  } else if (p("GetEstimatedTimetable")) {
    out.push(`EstimatedTimetable non disponibile (${p("GetEstimatedTimetable")!.dettaglio}): va chiesto a Mizar se è attivabile.`);
  }

  if (piena("GetStopMonitoring", "MonitoredStopVisit")) {
    out.push("StopMonitoring risponde con arrivi previsti: le previsioni per fermata esistono lato server.");
  }
  if (piena("GetProductionTimetable", "DatedVehicleJourney")) {
    out.push("ProductionTimetable risponde con il programma del giorno: si può confrontare direttamente col GTFS, corsa per corsa.");
  }

  const trovati = (r.gemelli ?? []).filter(g => g.operazioni.length > 0);
  if (trovati.length) {
    out.push(`Sullo stesso server esistono altri endpoint SIRI: ${trovati.map(g => `${g.servizio} (${g.url})`).join(", ")}. Vanno interrogati lì, non sull'indirizzo del VehicleMonitoring.`);
  }

  const dichiarati = Object.entries(r.dichiarate).filter(([, v]) => v).map(([k]) => k);
  const soloVm = dichiarati.length === 1 && dichiarati[0] === "VehicleMonitoring";
  const wsdlSoloVm = r.wsdl.operazioni.length > 0
    && !r.wsdl.operazioni.some(o => /EstimatedTimetable|StopMonitoring|ProductionTimetable/.test(o));
  if ((soloVm || wsdlSoloVm) && !trovati.length) {
    out.push(r.gemelli?.length
      ? "Questo endpoint espone il solo VehicleMonitoring e nessun indirizzo gemello risponde: gli altri servizi vanno chiesti a Mizar."
      : "Il server dichiara il solo VehicleMonitoring: gli altri servizi non sono un'opzione da configurare da parte nostra, vanno chiesti a Mizar.");
  }
  if (r.wsdl.operazioni.includes("Subscribe")) {
    out.push("Il server accetta sottoscrizioni (Subscribe/DeleteSubscription): può spingerci gli aggiornamenti invece di rispondere a un poll ogni 30 secondi.");
  }
  return out;
}
