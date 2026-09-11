/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIRI Vehicle Monitoring — client e normalizzatore
 * ───────────────────────────────────────────────────────────────────────────
 * Parla con un servizio SIRI-VM (profilo "Kolumbus", SOAP 1.1) e traduce le
 * VehicleActivity nel vocabolario interno: posizione del mezzo, corsa in
 * servizio, transiti alle fermate già passate.
 *
 * Perché un parser XML fatto in casa invece di una libreria: la risposta SIRI
 * ci interessa per una manciata di campi in posizioni note, e il progetto non
 * ha (né vuole) una dipendenza SOAP. Il parser è volutamente minimale ma
 * tollerante: ignora i prefissi di namespace e cerca gli elementi OVUNQUE
 * nell'albero, così funziona sia con binding RPC sia document/literal — che
 * dal solo WSDL non si distinguono con certezza.
 *
 * Qui dentro NON si tocca il database: sono funzioni pure, testabili senza
 * rete né Postgres (vedi src/__tests__/siri-vm.test.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/* ── Mini-parser XML ──────────────────────────────────────────────────────── */

export interface XmlNode {
  /** nome dell'elemento SENZA prefisso di namespace */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** testo diretto dell'elemento (concatenato, già de-escapato) */
  text: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};
function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, m => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
/** "siri:VehicleRef" → "VehicleRef" */
function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i === -1 ? tag : tag.slice(i + 1);
}

/**
 * Analizza un documento XML in un albero di XmlNode.
 * Gestisce: dichiarazione, commenti, CDATA, tag auto-chiudenti, attributi.
 * Non gestisce (e non servono): DTD, entità personalizzate, namespace veri.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;

    // testo che precede il tag → appartiene all'elemento aperto
    if (lt > i) {
      const raw = xml.slice(i, lt);
      if (raw.trim()) stack[stack.length - 1].text += unescapeXml(raw);
    }

    // costrutti da saltare in blocco
    if (xml.startsWith("<!--", lt)) { i = (xml.indexOf("-->", lt) + 3) || n; continue; }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      const stop = end === -1 ? n : end;
      stack[stack.length - 1].text += xml.slice(lt + 9, stop);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      i = (xml.indexOf(">", lt) + 1) || n; continue;
    }

    const gt = xml.indexOf(">", lt);
    if (gt === -1) break;
    const inner = xml.slice(lt + 1, gt).trim();

    // tag di chiusura
    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      // chiude l'elemento corrispondente più vicino (tollerante a tag orfani)
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      i = gt + 1;
      continue;
    }

    // tag di apertura (eventualmente auto-chiudente)
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const sp = body.search(/\s/);
    const name = localName(sp === -1 ? body : body.slice(0, sp));
    const attrs: Record<string, string> = {};
    if (sp !== -1) {
      const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
      let m: RegExpExecArray | null;
      const attrStr = body.slice(sp);
      while ((m = re.exec(attrStr)) !== null) {
        attrs[localName(m[1] ?? m[3])] = unescapeXml(m[2] ?? m[4] ?? "");
      }
    }
    const node: XmlNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

/** Tutti i discendenti (a qualsiasi profondità) con quel nome. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode) => {
    for (const c of x.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
/** Il primo discendente con quel nome, in ordine di documento. */
export function findFirst(node: XmlNode, name: string): XmlNode | null {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = findFirst(c, name);
    if (deep) return deep;
  }
  return null;
}
/** Testo del primo discendente con quel nome (null se assente o vuoto). */
export function textOf(node: XmlNode | null, name: string): string | null {
  if (!node) return null;
  const found = findFirst(node, name);
  const t = found?.text.trim();
  return t ? t : null;
}
/** Testo di un figlio DIRETTO: serve quando lo stesso nome esiste più in basso. */
export function directText(node: XmlNode | null, name: string): string | null {
  if (!node) return null;
  const c = node.children.find(x => x.name === name);
  const t = c?.text.trim();
  return t ? t : null;
}

/* ── Tipi XSD ricorrenti ──────────────────────────────────────────────────── */

/**
 * xsd:duration → secondi. SIRI usa questo tipo per il ritardo (`Delay`):
 * "PT3M30S" = 210, "-PT2M" = −120 (anticipo). Le componenti anno/mese non
 * hanno senso qui e vengono ignorate.
 */
export function parseIsoDuration(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(-)?P(?:\d+Y)?(?:\d+M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const secs = (Number(w ?? 0) * 604800) + (Number(d ?? 0) * 86400)
    + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
  if (!Number.isFinite(secs)) return null;
  return sign === "-" ? -Math.round(secs) : Math.round(secs);
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function parseNum(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * I riferimenti SIRI sono spesso namespacizzati ("ITA:Line:22", "conerobus:22").
 * Per agganciarli al GTFS si prova prima il valore esatto, poi l'ultimo segmento.
 */
export function refCandidates(ref: string | null): string[] {
  if (!ref) return [];
  const trimmed = ref.trim();
  if (!trimmed) return [];
  const out = [trimmed];
  const last = trimmed.slice(trimmed.lastIndexOf(":") + 1);
  if (last && last !== trimmed) out.push(last);
  return out;
}

/* ── Modello normalizzato ─────────────────────────────────────────────────── */

/** Un transito a una fermata: programmato contro effettivo. */
export interface SiriCall {
  stopPointRef: string | null;
  stopPointName: string | null;
  /** `Order` SIRI: la posizione nella sequenza della corsa */
  order: number | null;
  aimedArrival: Date | null;
  aimedDeparture: Date | null;
  /** orario EFFETTIVO (solo su PreviousCalls/MonitoredCall già transitate) */
  actualArrival: Date | null;
  actualDeparture: Date | null;
  /** orario PREVISTO (fermate future, o correnti non ancora servite) */
  expectedArrival: Date | null;
  expectedDeparture: Date | null;
  vehicleAtStop: boolean;
  /** effettivo − programmato, in secondi (>0 ritardo). null se non calcolabile */
  delaySeconds: number | null;
}

/** Una VehicleActivity normalizzata. */
export interface SiriVehicle {
  recordedAt: Date | null;
  itemIdentifier: string | null;
  vehicleRef: string | null;
  lineRef: string | null;
  directionRef: string | null;
  /** identificativo della corsa del giorno + data di servizio */
  datedVehicleJourneyRef: string | null;
  /** Identificativo di corsa alternativo: alcuni produttori (MIZ/Flashnet)
   *  usano SOLO questo, senza FramedVehicleJourneyRef. */
  courseOfJourneyRef: string | null;
  /** L'identificativo di corsa da usare: il framed se c'è, altrimenti il course. */
  journeyRef: string | null;
  /** Codice del PERCORSO (variante), distinto dalla linea */
  routeRef: string | null;
  /** Il mezzo si sta spostando SENZA servizio (trasferimento, rientro).
   *  Flashnet lo dichiara mettendo "FUORI LINEA" al posto del percorso: una
   *  corsa così non va cercata nell'orario, perché nell'orario non c'è. */
  outOfService: boolean;
  originRef: string | null;
  originName: string | null;
  destinationRef: string | null;
  /** Arrivo programmato al capolinea: con la partenza, identifica la corsa */
  destinationAimedArrival: Date | null;
  dataFrameRef: string | null;
  journeyPatternRef: string | null;
  publishedLineName: string | null;
  destinationName: string | null;
  originAimedDeparture: Date | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  /** ritardo dichiarato dall'AVM sull'intera corsa */
  delaySeconds: number | null;
  /** turno vettura / blocco di servizio */
  blockRef: string | null;
  monitored: boolean;
  inCongestion: boolean;
  inPanic: boolean;
  progressRate: string | null;
  /** percentuale percorsa tra la fermata precedente e la prossima */
  progressPercent: number | null;
  occupancy: string | null;
  /** fermate già transitate, con orari effettivi */
  previousCalls: SiriCall[];
  /** fermata corrente / prossima */
  monitoredCall: SiriCall | null;
  /** fermate successive, con previsioni */
  onwardCalls: SiriCall[];

  /* ── Campi che questo produttore riempie DAVVERO, e che finora ignoravamo.
   * Ricavati dall'inventario del flusso reale (GET /api/siri/campi), non dal
   * WSDL: erano il segnale più affidabile che avevamo e non lo leggevamo. */

  /** Stato dichiarato dall'AVM, valori composti separati da "/":
   *  "InDepot/ExpiredLocalization/WithoutService/WithoutTarget". Presente su
   *  357 mezzi su 368 — è il campo più valorizzato dopo la matricola. */
  progressStatus: string | null;
  /** in rimessa */
  inDepot: boolean;
  /** la localizzazione è SCADUTA: la posizione c'è ma è vecchia */
  expiredLocalization: boolean;
  /** nessun servizio in corso */
  withoutService: boolean;
  /** nessun turno/destinazione impostati a bordo */
  withoutTarget: boolean;
  /** perché il mezzo non è affidabile: "GPRS" (niente rete), "GPS" (niente fix) */
  monitoringError: string | null;
  /** metri percorsi sull'arco fra la fermata precedente e quella corrente */
  linkDistance: number | null;
}

export interface SiriVmResult {
  /** true se la delivery riporta Status=false o un ErrorCondition */
  failed: boolean;
  errorText: string | null;
  responseTimestamp: Date | null;
  /** intervallo minimo di polling dichiarato dal produttore, in secondi */
  shortestPossibleCycleSec: number | null;
  vehicles: SiriVehicle[];
  /** corse annullate (DatedVehicleJourneyRef) */
  cancellations: Array<{ vehicleRef: string | null; journeyRef: string | null; reason: string | null }>;
}

function parseCall(node: XmlNode): SiriCall {
  const aimedArrival = parseDate(directText(node, "AimedArrivalTime"));
  const aimedDeparture = parseDate(directText(node, "AimedDepartureTime"));
  const actualArrival = parseDate(directText(node, "ActualArrivalTime"));
  const actualDeparture = parseDate(directText(node, "ActualDepartureTime"));
  const expectedArrival = parseDate(directText(node, "ExpectedArrivalTime"));
  const expectedDeparture = parseDate(directText(node, "ExpectedDepartureTime"));

  /* Il ritardo di una fermata si misura sulla PARTENZA quando c'è (è quella che
   * il passeggero subisce), altrimenti sull'arrivo. Se manca l'effettivo si
   * usa il previsto: su una fermata futura resta una previsione, ma è il dato
   * che l'AVM sta dando. */
  const actual = actualDeparture ?? actualArrival ?? expectedDeparture ?? expectedArrival;
  const aimed = actualDeparture || expectedDeparture
    ? (aimedDeparture ?? aimedArrival)
    : (aimedArrival ?? aimedDeparture);
  const delaySeconds = actual && aimed
    ? Math.round((actual.getTime() - aimed.getTime()) / 1000)
    : null;

  return {
    stopPointRef: directText(node, "StopPointRef"),
    stopPointName: directText(node, "StopPointName"),
    order: parseNum(directText(node, "Order") ?? directText(node, "VisitNumber")),
    aimedArrival, aimedDeparture, actualArrival, actualDeparture,
    expectedArrival, expectedDeparture,
    vehicleAtStop: (directText(node, "VehicleAtStop") ?? "").toLowerCase() === "true",
    delaySeconds,
  };
}

function parseVehicleActivity(va: XmlNode): SiriVehicle {
  const mvj = findFirst(va, "MonitoredVehicleJourney");
  const loc = mvj ? findFirst(mvj, "VehicleLocation") : null;
  const framed = mvj ? findFirst(mvj, "FramedVehicleJourneyRef") : null;
  const progress = findFirst(va, "ProgressBetweenStops");
  const monitoredCallNode = mvj ? findFirst(mvj, "MonitoredCall") : null;
  const prevWrap = mvj ? findFirst(mvj, "PreviousCalls") : null;
  const onwardWrap = mvj ? findFirst(mvj, "OnwardCalls") : null;
  /* Due modi di dire la stessa cosa: lo standard prevede entrambi, e un
   * produttore che non manda FramedVehicleJourneyRef non è un produttore
   * senza corse — usa l'altro. */
  const framedJourney = directText(framed, "DatedVehicleJourneyRef");
  const course = directText(mvj, "CourseOfJourneyRef");
  const routeRefRaw = directText(mvj, "RouteRef");

  /* ProgressStatus arriva come elenco separato da "/", non come valore
   * singolo: "InDepot/ExpiredLocalization/WithoutService/WithoutTarget".
   * Confrontarlo per uguaglianza non troverebbe quasi mai niente. */
  const statusRaw = directText(mvj, "ProgressStatus");
  const stati = (statusRaw ?? "").split("/").map(s => s.trim().toLowerCase());
  const ha = (s: string) => stati.includes(s);

  return {
    recordedAt: parseDate(directText(va, "RecordedAtTime")),
    itemIdentifier: directText(va, "ItemIdentifier"),
    vehicleRef: directText(mvj, "VehicleRef"),
    lineRef: directText(mvj, "LineRef"),
    directionRef: directText(mvj, "DirectionRef"),
    datedVehicleJourneyRef: framedJourney,
    courseOfJourneyRef: course,
    journeyRef: framedJourney ?? course,
    routeRef: routeRefRaw,
    outOfService: /fuori\s*(linea|servizio)|out\s*of\s*service|deadhead/i
      .test(`${routeRefRaw ?? ""} ${directText(mvj, "PublishedLineName") ?? ""}`),
    originRef: directText(mvj, "OriginRef"),
    originName: directText(mvj, "OriginName"),
    destinationRef: directText(mvj, "DestinationRef"),
    destinationAimedArrival: parseDate(directText(mvj, "DestinationAimedArrivalTime")),
    dataFrameRef: directText(framed, "DataFrameRef"),
    journeyPatternRef: directText(mvj, "JourneyPatternRef"),
    publishedLineName: directText(mvj, "PublishedLineName"),
    destinationName: directText(mvj, "DestinationName"),
    originAimedDeparture: parseDate(directText(mvj, "OriginAimedDepartureTime")),
    lat: parseNum(directText(loc, "Latitude")),
    lon: parseNum(directText(loc, "Longitude")),
    bearing: parseNum(directText(mvj, "Bearing")),
    delaySeconds: parseIsoDuration(directText(mvj, "Delay")),
    blockRef: directText(mvj, "BlockRef"),
    monitored: (directText(mvj, "Monitored") ?? "true").toLowerCase() !== "false",
    inCongestion: (directText(mvj, "InCongestion") ?? "").toLowerCase() === "true",
    inPanic: (directText(mvj, "InPanic") ?? "").toLowerCase() === "true",
    progressRate: directText(mvj, "ProgressRate"),
    progressPercent: parseNum(directText(progress, "Percentage")),
    occupancy: directText(mvj, "Occupancy"),
    previousCalls: prevWrap ? findAll(prevWrap, "PreviousCall").map(parseCall) : [],
    monitoredCall: monitoredCallNode ? parseCall(monitoredCallNode) : null,
    onwardCalls: onwardWrap ? findAll(onwardWrap, "OnwardCall").map(parseCall) : [],

    progressStatus: statusRaw,
    inDepot: ha("indepot"),
    expiredLocalization: ha("expiredlocalization"),
    withoutService: ha("withoutservice"),
    withoutTarget: ha("withouttarget"),
    monitoringError: directText(mvj, "MonitoringError"),
    linkDistance: parseNum(directText(progress, "LinkDistance")),
  };
}

/** Estrae le VehicleActivity da una risposta GetVehicleMonitoring. */
export function parseVehicleMonitoringResponse(xml: string): SiriVmResult {
  const doc = parseXml(xml);

  // Un Fault SOAP non è una delivery: va riportato come errore, non come zero mezzi.
  const fault = findFirst(doc, "Fault");
  if (fault) {
    return {
      failed: true,
      errorText: textOf(fault, "faultstring") ?? textOf(fault, "Reason") ?? "SOAP Fault",
      responseTimestamp: null, shortestPossibleCycleSec: null, vehicles: [], cancellations: [],
    };
  }

  const delivery = findFirst(doc, "VehicleMonitoringDelivery");
  const errNode = delivery ? findFirst(delivery, "ErrorCondition") : null;
  const status = delivery ? directText(delivery, "Status") : null;

  const vehicles = findAll(doc, "VehicleActivity")
    // VehicleActivityNote è un fratello omonimo per prefisso: si filtra sui figli
    .filter(va => va.children.some(c => c.name === "MonitoredVehicleJourney"))
    .map(parseVehicleActivity);

  const cancellations = findAll(doc, "VehicleActivityCancellation").map(c => ({
    vehicleRef: directText(c, "VehicleMonitoringRef"),
    journeyRef: textOf(c, "DatedVehicleJourneyRef"),
    reason: directText(c, "Reason"),
  }));

  return {
    failed: status?.toLowerCase() === "false" || (!!errNode && vehicles.length === 0),
    errorText: errNode ? (textOf(errNode, "ErrorText") ?? textOf(errNode, "Description")) : null,
    responseTimestamp: parseDate(delivery ? directText(delivery, "ResponseTimestamp") : null),
    shortestPossibleCycleSec: parseIsoDuration(delivery ? directText(delivery, "ShortestPossibleCycle") : null),
    vehicles,
    cancellations,
  };
}

/* ── Costruzione delle richieste SOAP 1.1 ─────────────────────────────────── */

const SIRI_NS = "http://www.siri.org.uk/siri";
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

function esc(v: string): string {
  return v.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function nowIso(): string { return new Date().toISOString(); }
function msgId(): string { return `TI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function envelope(bodyInner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:siri="${SIRI_NS}">`
    + `<soap:Body>${bodyInner}</soap:Body></soap:Envelope>`;
}

export interface SiriRequestOptions {
  /** identificativo del consumatore assegnato dal produttore */
  requestorRef: string;
  /** versione SIRI dichiarata nella Request (default 1.4) */
  version?: string;
  /** quanto dettaglio: "calls" per avere PreviousCalls/OnwardCalls */
  detailLevel?: "minimum" | "basic" | "normal" | "calls" | "full";
  /** filtro opzionale su una linea */
  lineRef?: string | null;
  /** tetto ai mezzi restituiti */
  maximumVehicles?: number | null;
}

/** GetVehicleMonitoring: la richiesta che porta i mezzi in servizio. */
export function buildVehicleMonitoringRequest(o: SiriRequestOptions): string {
  const ts = nowIso();
  const version = o.version ?? "1.4";
  const filter = o.lineRef ? `<siri:LineRef>${esc(o.lineRef)}</siri:LineRef>` : "";
  const maxV = o.maximumVehicles ? `<siri:MaximumVehicles>${o.maximumVehicles}</siri:MaximumVehicles>` : "";
  return envelope(
    `<siri:GetVehicleMonitoring>`
    + `<ServiceRequestInfo>`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:RequestorRef>${esc(o.requestorRef)}</siri:RequestorRef>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + `</ServiceRequestInfo>`
    + `<Request version="${esc(version)}">`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + filter + maxV
    + `<siri:VehicleMonitoringDetailLevel>${o.detailLevel ?? "calls"}</siri:VehicleMonitoringDetailLevel>`
    + `</Request>`
    + `<RequestExtension/>`
    + `</siri:GetVehicleMonitoring>`,
  );
}

/** CheckStatus: il servizio è vivo? (nessun dato di esercizio) */
export function buildCheckStatusRequest(requestorRef: string): string {
  const ts = nowIso();
  return envelope(
    `<siri:CheckStatus>`
    + `<Request>`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:RequestorRef>${esc(requestorRef)}</siri:RequestorRef>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + `</Request>`
    + `<RequestExtension/>`
    + `</siri:CheckStatus>`,
  );
}

/** GetCapabilities: che cosa il produttore permette (filtri, cicli, namespace). */
export function buildGetCapabilitiesRequest(requestorRef: string, version = "1.4"): string {
  const ts = nowIso();
  return envelope(
    `<siri:GetCapabilities>`
    + `<Request version="${esc(version)}">`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:RequestorRef>${esc(requestorRef)}</siri:RequestorRef>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + `<siri:VehicleMonitoringCapabilitiesRequest>`
    + `<siri:RequestTimestamp>${ts}</siri:RequestTimestamp>`
    + `<siri:MessageIdentifier>${msgId()}</siri:MessageIdentifier>`
    + `</siri:VehicleMonitoringCapabilitiesRequest>`
    + `</Request>`
    + `<RequestExtension/>`
    + `</siri:GetCapabilities>`,
  );
}

/** Lettura sintetica di una CapabilitiesResponse: serve a tarare il poller. */
export function parseCapabilities(xml: string): {
  publishSubscribe: boolean | null;
  requestResponse: boolean | null;
  hasDetailLevel: boolean | null;
  defaultDetailLevel: string | null;
  hasPreviousCalls: boolean | null;
  hasOnwardCalls: boolean | null;
  filterByLineRef: boolean | null;
  defaultPreviewIntervalSec: number | null;
  stopPointNameSpace: string | null;
  lineNameSpace: string | null;
} {
  const doc = parseXml(xml);
  const bool = (name: string): boolean | null => {
    const t = textOf(doc, name);
    return t == null ? null : t.toLowerCase() === "true";
  };
  return {
    publishSubscribe: bool("PublishSubscribe"),
    requestResponse: bool("RequestResponse"),
    hasDetailLevel: bool("HasDetailLevel"),
    defaultDetailLevel: textOf(doc, "DefaultDetailLevel"),
    hasPreviousCalls: bool("HasNumberOfPreviousCalls"),
    hasOnwardCalls: bool("HasNumberOfOnwardsCalls"),
    filterByLineRef: bool("FilterByLineRef"),
    defaultPreviewIntervalSec: parseIsoDuration(textOf(doc, "DefaultPreviewInterval")),
    stopPointNameSpace: textOf(doc, "StopPointNameSpace"),
    lineNameSpace: textOf(doc, "LineNameSpace"),
  };
}

/* ── Che cosa l'AVM sta effettivamente mandando ───────────────────────────
 * Un conteggio per campo, non un campione: con centinaia di mezzi il campione
 * cade quasi sempre sulle vetture ferme in deposito — che non hanno corsa né
 * fermate — e fa sembrare vuoto un flusso che invece porta dati sui mezzi in
 * servizio. Questi numeri dicono quale PARTE del contratto SIRI il produttore
 * sta davvero riempiendo. */
export interface VehicleCompleteness {
  totale: number;
  conPosizione: number;
  conLinea: number;
  conCorsa: number;
  conFermataCorrente: number;
  conFermateTransitate: number;
  /** fermate transitate con orario EFFETTIVO: è ciò che alimenta i transiti */
  conOrarioEffettivo: number;
  conFermateFuture: number;
  conRitardo: number;
  conTurnoVettura: number;
  monitorati: number;
  /** mezzi in trasferimento, non in servizio: non sono corse dell'orario */
  fuoriLinea: number;
}

/* ── Stato del parco: quali apparati di bordo funzionano ──────────────────
 * L'AVM dichiara per ogni vettura se la sta seguendo, da quando non la sente e
 * perché. Su 368 mezzi, 298 riportano un errore di monitoraggio e alcuni un
 * ultimo contatto di mesi prima. Finora quel dato serviva solo a scartare le
 * posizioni vecchie, e finiva lì.
 *
 * Letto per vettura invece che come filtro, è un elenco di apparati da
 * verificare — l'unica informazione di questo flusso che riguarda il mezzo e
 * non il servizio, e l'unica che nessun altro sistema aziendale produce.
 *
 * Le due cause NON sono la stessa cosa e non si riparano allo stesso modo:
 * "GPRS" è la SIM o la copertura — l'apparato può funzionare benissimo e non
 * riuscire a parlare; "GPS" è l'antenna o la sua posizione — il mezzo
 * comunica, ma non sa dove si trova.
 */
export type StatoVettura =
  /** sta facendo una corsa */
  | "in_servizio"
  /** l'AVM la segue, posizione fresca, nessuna corsa avviata a bordo */
  | "pronta"
  /** dichiarata in rimessa */
  | "in_rimessa"
  /** l'apparato non riesce a comunicare: SIM o copertura */
  | "senza_rete"
  /** comunica ma non aggancia la posizione: antenna */
  | "senza_gps"
  /** nessun contatto utile da giorni: apparato spento o guasto */
  | "muta";

export interface VetturaDiagnostica {
  vehicleRef: string;
  stato: StatoVettura;
  /** da quanti secondi l'AVM non riceve un aggiornamento */
  etaContattoSec: number | null;
  ultimoContatto: string | null;
  errore: string | null;
  progressStatus: string | null;
  linea: string | null;
  haPosizione: boolean;
}

/** Oltre un giorno senza contatto non è un disservizio momentaneo. */
const MUTA_SEC = 24 * 3600;

export function diagnosiVettura(v: SiriVehicle, now = Date.now()): VetturaDiagnostica {
  const eta = fixAgeSeconds(v, now);
  const base = {
    vehicleRef: v.vehicleRef ?? "(senza matricola)",
    etaContattoSec: eta,
    ultimoContatto: v.recordedAt ? v.recordedAt.toISOString() : null,
    errore: v.monitoringError,
    progressStatus: v.progressStatus,
    linea: v.publishedLineName ?? v.lineRef,
    haPosizione: v.lat != null && v.lon != null,
  };

  /* L'ordine conta: un mezzo in corsa resta "in servizio" anche se l'ultimo
   * contatto è vecchio di un minuto, mentre uno muto da un giorno è un
   * problema di apparato qualunque cosa dichiari il resto. */
  if (eta != null && eta > MUTA_SEC) return { ...base, stato: "muta" };
  if (v.journeyRef && !v.inDepot && !v.withoutService) {
    return { ...base, stato: "in_servizio" };
  }
  if (v.monitoringError === "GPRS") return { ...base, stato: "senza_rete" };
  if (v.monitoringError === "GPS") return { ...base, stato: "senza_gps" };
  if (v.inDepot) return { ...base, stato: "in_rimessa" };
  return { ...base, stato: "pronta" };
}

export interface StatoParco {
  totale: number;
  perStato: Array<{ stato: StatoVettura; conteggio: number }>;
  /** vetture che meritano un intervento, dalla più ferma */
  daVerificare: VetturaDiagnostica[];
  /** quota del parco che l'AVM sta seguendo in modo utilizzabile */
  quotaUtilizzabile: number;
  nota: string;
}

/** Quanto è grave, per ordinare il lavoro di officina. */
const PESO: Record<StatoVettura, number> = {
  muta: 0, senza_gps: 1, senza_rete: 2, in_rimessa: 3, pronta: 4, in_servizio: 5,
};

export function statoParco(vehicles: SiriVehicle[], now = Date.now()): StatoParco {
  const diag = vehicles.map(v => diagnosiVettura(v, now));
  const conta = new Map<StatoVettura, number>();
  for (const d of diag) conta.set(d.stato, (conta.get(d.stato) ?? 0) + 1);

  /* In cima le mute da più tempo: è l'ordine in cui si apre un'officina. */
  const daVerificare = diag
    .filter(d => d.stato === "muta" || d.stato === "senza_gps" || d.stato === "senza_rete")
    .sort((a, b) => {
      const p = PESO[a.stato] - PESO[b.stato];
      return p !== 0 ? p : (b.etaContattoSec ?? 0) - (a.etaContattoSec ?? 0);
    });

  const utilizzabili = diag.filter(
    d => d.stato === "in_servizio" || d.stato === "pronta").length;
  const mute = conta.get("muta") ?? 0;

  return {
    totale: diag.length,
    perStato: [...conta.entries()]
      .map(([stato, conteggio]) => ({ stato, conteggio }))
      .sort((a, b) => PESO[a.stato] - PESO[b.stato]),
    daVerificare,
    quotaUtilizzabile: diag.length ? Math.round((utilizzabili / diag.length) * 1000) / 1000 : 0,
    nota: diag.length === 0
      ? "Nessuna vettura trasmessa."
      : mute > 0
        ? `${mute} vetture non danno segno da oltre un giorno: sono apparati da `
          + "verificare, non mezzi fermi."
        : `${utilizzabili} vetture su ${diag.length} sono seguite dall'AVM in modo `
          + "utilizzabile.",
  };
}

export function describeCompleteness(vehicles: SiriVehicle[]): VehicleCompleteness {
  const c: VehicleCompleteness = {
    totale: vehicles.length, conPosizione: 0, conLinea: 0, conCorsa: 0,
    conFermataCorrente: 0, conFermateTransitate: 0, conOrarioEffettivo: 0,
    conFermateFuture: 0, conRitardo: 0, conTurnoVettura: 0, monitorati: 0,
    fuoriLinea: 0,
  };
  for (const v of vehicles) {
    if (v.lat != null && v.lon != null) c.conPosizione++;
    if (v.lineRef) c.conLinea++;
    if (v.journeyRef) c.conCorsa++;
    if (v.monitoredCall?.stopPointRef) c.conFermataCorrente++;
    if (v.previousCalls.length > 0) c.conFermateTransitate++;
    if (v.onwardCalls.length > 0) c.conFermateFuture++;
    if (v.delaySeconds != null) c.conRitardo++;
    if (v.blockRef) c.conTurnoVettura++;
    if (v.monitored) c.monitorati++;
    if (v.outOfService) c.fuoriLinea++;
    const hasActual = v.previousCalls.some(x => x.actualArrival || x.actualDeparture)
      || !!(v.monitoredCall && (v.monitoredCall.actualArrival || v.monitoredCall.actualDeparture));
    if (hasActual) c.conOrarioEffettivo++;
  }
  return c;
}

/* ── Che cosa manda DAVVERO il produttore ─────────────────────────────────
 * Ogni normalizzazione in questo file parte da un'ipotesi su quali elementi
 * arrivino. Finché l'ipotesi non è verificata sul flusso vero si costruisce
 * sulla sabbia: si aggiunge un campo, non compare, si ipotizza il motivo, si
 * riprova. L'inventario toglie l'ipotesi di mezzo — elenca OGNI elemento
 * presente nella risposta, quante volte compare, quante volte è valorizzato
 * e con quali valori. Da lì in poi le tabelle si disegnano sul dato reale.
 */
export interface FieldStat {
  /** percorso completo, es. "MonitoredVehicleJourney/FramedVehicleJourneyRef/DataFrameRef" */
  path: string;
  /** quante volte l'elemento compare nel documento */
  occorrenze: number;
  /** ...di cui con testo non vuoto: la differenza sono gli elementi vuoti */
  valorizzati: number;
  /** valori distinti osservati, per capire il formato senza aprire il grezzo */
  esempi: string[];
}

/**
 * Inventario di tutti gli elementi del documento.
 *
 * `da` permette di partire da un sottoalbero (es. "VehicleActivity") invece
 * che dall'intera busta SOAP: i percorsi restano leggibili e il conteggio
 * diventa "per mezzo" invece che "per documento".
 */
export function inventoryFields(
  xml: string, da?: string, maxEsempi = 5,
): { radici: number; campi: FieldStat[] } {
  const doc = parseXml(xml);
  const radici = da ? findAll(doc, da) : [doc];
  const acc = new Map<string, { occorrenze: number; valorizzati: number; esempi: Set<string> }>();

  const visita = (nodo: XmlNode, prefisso: string): void => {
    for (const figlio of nodo.children) {
      const path = prefisso ? `${prefisso}/${figlio.name}` : figlio.name;
      let s = acc.get(path);
      if (!s) { s = { occorrenze: 0, valorizzati: 0, esempi: new Set() }; acc.set(path, s); }
      s.occorrenze++;
      /* Solo il testo DIRETTO: quello dei figli appartiene ai loro percorsi,
       * e sommarlo qui farebbe sembrare valorizzato ogni contenitore. */
      const t = figlio.text.trim();
      if (t) {
        s.valorizzati++;
        if (s.esempi.size < maxEsempi) s.esempi.add(t.slice(0, 120));
      }
      /* Gli attributi contano come campi: alcuni produttori ci mettono dentro
       * informazione vera (unità di misura, riferimenti, versioni). */
      for (const [k, v] of Object.entries(figlio.attrs)) {
        const ap = `${path}@${k}`;
        let a = acc.get(ap);
        if (!a) { a = { occorrenze: 0, valorizzati: 0, esempi: new Set() }; acc.set(ap, a); }
        a.occorrenze++;
        if (v.trim()) { a.valorizzati++; if (a.esempi.size < maxEsempi) a.esempi.add(v.slice(0, 120)); }
      }
      visita(figlio, path);
    }
  };
  for (const r of radici) visita(r, "");

  return {
    radici: radici.length,
    campi: [...acc.entries()]
      .map(([path, s]) => ({
        path, occorrenze: s.occorrenze, valorizzati: s.valorizzati, esempi: [...s.esempi],
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/* ── Mezzi in servizio e parco fermo ──────────────────────────────────────
 * L'AVM manda l'INTERO parco, deposito compreso: su 368 vetture ne dichiara
 * monitorate 72. Una vettura non monitorata, senza corsa e senza linea non è
 * esercizio: portarla in Sala Operativa riempie la mappa di autobus anonimi
 * fra cui i mezzi veri non si trovano più — ed è anche cinque volte il volume
 * di scrittura, tutto rumore.
 *
 * La distinzione da NON perdere è fra "fermo in deposito" e "in servizio ma
 * senza turno macchina". Il secondo è un mezzo che l'AVM segue davvero
 * (Monitored=true) e che quindi va mostrato anche se il conducente non ha
 * impostato il turno e la linea resta ignota: che quel turno manchi è un
 * dato di esercizio, non un difetto del collegamento.
 */
export interface ServiceSplit {
  /** in esercizio: monitorati dall'AVM, o con una corsa/linea dichiarata */
  inServizio: SiriVehicle[];
  /** parco fermo: nessuno dei tre segnali */
  ferme: SiriVehicle[];
  /** true quando il produttore non distingue nulla (nessun mezzo monitorato
   *  né con corsa): allora non si filtra — meglio troppi mezzi che nessuno. */
  nonDistinguibile: boolean;
}

/**
 * Un mezzo è in esercizio se sta facendo una corsa.
 *
 * NON si guarda `Monitored`, che sembrava il campo giusto e non lo è:
 * l'inventario del flusso vero mostra la vettura 434 con `Monitored=true` e
 * `ProgressStatus=InDepot` — ferma in rimessa e "monitorata". Monitored dice
 * se l'AVM sta seguendo il mezzo, non se il mezzo è in servizio.
 *
 * Il campo che lo dice davvero è ProgressStatus, valorizzato su 357 mezzi su
 * 368: `InDepot` e `WithoutService` escludono, e senza un riferimento di
 * corsa non c'è niente a cui attribuire un passaggio. Sui numeri reali questo
 * porta i mezzi in esercizio da 83 (stima sbagliata) a 15-17 (quelli veri).
 */
function inService(v: SiriVehicle): boolean {
  if (v.inDepot || v.withoutService) return false;
  if (v.outOfService) return false;             // RouteRef "FUORI LINEA"
  return !!v.journeyRef;
}

/**
 * La posizione è utilizzabile?
 *
 * `ExpiredLocalization` e `MonitoringError` (GPRS = niente rete, GPS = niente
 * fix) dicono che le coordinate ci sono ma sono VECCHIE — su 368 mezzi 298
 * hanno un errore di monitoraggio. Scriverle come se fossero attuali sposta i
 * puntini sulla mappa dove il mezzo non è più e, peggio, fa nascere transiti
 * inventati: il mezzo "passa" da una fermata perché il dato è di tre ore fa.
 */
export function positionUsable(v: SiriVehicle): boolean {
  if (v.lat == null || v.lon == null) return false;
  return !v.expiredLocalization && !v.monitoringError;
}

/**
 * Quanto è vecchio il rilevamento, in secondi. `RecordedAtTime` è l'ultima
 * volta che l'AVM ha SENTITO il mezzo, non l'istante della risposta: nel
 * flusso vero si trovano valori di mesi prima ("2024-09-19T16:50:05") sulle
 * vetture ferme. Usarlo come "adesso" avvelena tutto ciò che sta a valle.
 */
export function fixAgeSeconds(v: SiriVehicle, now = Date.now()): number | null {
  if (!v.recordedAt) return null;
  return Math.round((now - v.recordedAt.getTime()) / 1000);
}

export function splitInService(vehicles: SiriVehicle[]): ServiceSplit {
  const inServizio = vehicles.filter(inService);
  /* Nessun segnale su nessun mezzo: il produttore non compila quei campi.
   * Filtrare qui vorrebbe dire spegnere la mappa, quindi non si filtra. */
  if (inServizio.length === 0) {
    return { inServizio: vehicles, ferme: [], nonDistinguibile: true };
  }
  return {
    inServizio,
    ferme: vehicles.filter(v => !inService(v)),
    nonDistinguibile: false,
  };
}

/** Quanto è "informativo" un mezzo: serve a campionare quelli in servizio. */
function richness(v: SiriVehicle): number {
  return (v.journeyRef ? 8 : 0) + (v.previousCalls.length > 0 ? 8 : 0)
    + (v.onwardCalls.length > 0 ? 4 : 0) + (v.monitoredCall?.stopPointRef ? 3 : 0)
    + (v.lineRef ? 2 : 0) + (v.delaySeconds != null ? 2 : 0) + (v.blockRef ? 1 : 0);
}

/** I mezzi che portano più informazione, in testa. */
export function mostInformative(vehicles: SiriVehicle[], n: number): SiriVehicle[] {
  return [...vehicles].sort((a, b) => richness(b) - richness(a)).slice(0, n);
}

/**
 * Ritaglia dal grezzo UNA VehicleActivity, preferendo quella che contiene il
 * marcatore cercato (es. "LineRef"). Serve a leggere i nomi veri degli
 * elementi quando il parser non trova ciò che il WSDL prometteva.
 */
export function extractSampleActivity(xml: string, marker = "LineRef", maxChars = 4000): string | null {
  const re = /<([A-Za-z0-9_.-]+:)?VehicleActivity[\s>]/g;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = m.index;
    const prefix = m[1] ?? "";
    const closeTag = `</${prefix}VehicleActivity>`;
    const end = xml.indexOf(closeTag, start);
    const block = end === -1 ? xml.slice(start, start + maxChars) : xml.slice(start, end + closeTag.length);
    if (!best) best = block.slice(0, maxChars);
    if (block.includes(marker)) return block.slice(0, maxChars);
  }
  return best;
}

/* ── Corrispondenza SIRI ↔ GTFS ───────────────────────────────────────────
 * L'AVM identifica linee, corse e fermate con i SUOI riferimenti, che possono
 * non coincidere con gli id del feed GTFS attivo. Si prova la corrispondenza
 * esatta e, in subordine, l'ultimo segmento dopo i due punti ("ITA:Line:22" →
 * "22"). Ciò che non aggancia viene CONTATO e riportato, mai indovinato: è
 * l'anteprima a dire se serve una tabella di corrispondenza.
 * Logica pura (nessun accesso al database): vive qui per essere collaudabile. */

/** Gli identificativi del feed attivo, indicizzati per il confronto. */
export interface GtfsIndex {
  feedId: string;
  trips: Set<string>;
  routes: Set<string>;
  stops: Set<string>;
  /** trip_id → route_id, per completare le corse che l'AVM non associa */
  tripRoute: Map<string, string>;
  /** codice di linea normalizzato → route_id (da route_id e short_name) */
  routeByCode: Map<string, string>;
  /** nome esteso normalizzato → route_id: le linee extraurbane non hanno un
   *  numero nel nome, si chiamano "OSIMO - ASPIO - ANCONA" da entrambe le parti */
  routeLongNames: Array<{ norm: string; routeId: string }>;
  /** corse indicizzate per linea+partenza: l'aggancio quando gli id non parlano */
  tripStarts?: TripStartIndex;
  /** fuso dell'azienda: il server gira in UTC, l'orario del servizio no */
  timeZone?: string;
  /** stop_id → nome, per verificare che un id che combacia sia la STESSA fermata */
  stopNames: Map<string, string>;
  /** nome normalizzato → stop_id */
  stopByName: Map<string, string>;
  loadedAt: number;
}

/* ── Codice di linea: l'id interno dell'AVM non è il numero della linea ──
 * Osservato su Flashnet/MIZ: LineRef "16" è l'id interno della **Linea 3**,
 * "11" è la navetta del porto. Confrontare LineRef con gli id del feed non
 * produce assenza di corrispondenza — produce corrispondenze SBAGLIATE, che
 * mettono un mezzo sulla linea di un altro. Il numero pubblico sta invece in
 * PublishedLineName ("Linea 3 P.zza Cavour - …"), ed è quello che l'utenza
 * e il feed chiamano "linea". */
export function normalizeLineCode(v: string): string {
  return v.trim().toUpperCase().replace(/\s+/g, "");
}

/** Da "Linea 1-4  P.zza IV Novembre - …" ricava i codici plausibili: 1-4, 1/4. */
export function lineCodeCandidates(publishedLineName: string | null): string[] {
  if (!publishedLineName) return [];
  /* Il codice non è sempre numerico: il feed di Conerobus usa anche VI1,
   * UJ2A, BR3, JECN. Si accettano quindi codici alfanumerici, ma CORTI:
   * oltre i sei caratteri si starebbe catturando una parola del percorso
   * ("Linea Ancona - Jesi") invece di un codice. */
  const m = /^\s*(?:linea|line|linee|bus)\s+([0-9A-Z]+(?:\s*[-/]\s*[0-9A-Z]+)*)/i
    .exec(publishedLineName);
  if (!m || normalizeLineCode(m[1]).length > 6) return [];
  const raw = normalizeLineCode(m[1]);
  const out = [raw];
  // Le reti italiane scrivono le linee accoppiate ora con "-" ora con "/"
  const slashed = raw.replace(/-/g, "/");
  if (slashed !== raw) out.push(slashed);
  const dashed = raw.replace(/\//g, "-");
  if (dashed !== raw && !out.includes(dashed)) out.push(dashed);
  return out;
}

/**
 * Il codice di PERCORSO porta il numero di linea in testa: "03R1" = linea 3
 * andata/ritorno variante 1, "20P" = linea 20. Vale dove il nome pubblicato
 * non ha un numero — la navetta del porto è "Navetta Terminal Biglietterie"
 * ma il suo percorso è "20P", e la linea 20 nel feed c'è.
 */
export function routeRefLineCandidates(routeRef: string | null): string[] {
  if (!routeRef) return [];
  const m = /^\s*([0-9]+(?:\s*[-/]\s*[0-9]+)*)/.exec(routeRef);
  if (!m) return [];
  const raw = normalizeLineCode(m[1]);
  const out = new Set<string>([raw]);
  // "03" e "3" sono la stessa linea scritta con o senza zero iniziale
  const unpadded = raw.replace(/(^|[-/])0+(?=[0-9])/g, "$1");
  out.add(unpadded);
  for (const v of [...out]) {
    out.add(v.replace(/-/g, "/"));
    out.add(v.replace(/\//g, "-"));
  }
  return [...out].filter(Boolean);
}

/** Nome di fermata comparabile: senza accenti, punteggiatura e maiuscole. */
export function normalizeStopName(v: string): string {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export interface MappedVehicle {
  siri: SiriVehicle;
  tripId: string | null;
  routeId: string | null;
  /** fermata corrente (MonitoredCall) agganciata al GTFS */
  nearestStopId: string | null;
  /** transiti GIÀ AVVENUTI, con fermata agganciata */
  transits: Array<{
    stopId: string; stopSeq: number | null; scheduled: string | null;
    actualTs: Date; delaySeconds: number | null;
  }>;
}

export interface MappingReport {
  vehicles: number;
  withPosition: number;
  tripMatched: number;
  /** agganciate perché l'identificativo di corsa esiste nel feed */
  tripMatchedById: number;
  /** agganciate da linea + ora di partenza, quando gli id non parlano */
  tripMatchedBySchedule: number;
  /** più corse partono a quell'ora su quella linea: scelta arbitraria */
  tripAmbiguous: number;
  /** chi collide davvero: senza vederlo, "ambiguo" non è azionabile */
  tripAmbiguousExamples: Array<{
    linea: string; partenza: string | null; destinazioneAvm: string | null;
    candidati: Array<{ tripId: string; headsign: string | null }>;
  }>;
  routeMatched: number;
  stopMatched: number;
  transitsFound: number;
  transitsMatched: number;
  /** come si è agganciata la linea: dal numero pubblicato o dall'id interno */
  routeMatchedByPublishedName: number;
  /** agganciate dal codice di percorso ("03R1" → linea 3) */
  routeMatchedByRouteRef: number;
  /** agganciate confrontando il nome esteso (linee extraurbane) */
  routeMatchedByLongName: number;
  routeMatchedByRef: number;
  /** fermate agganciate per id, e per nome quando l'id non esiste nel feed */
  stopMatchedById: number;
  stopMatchedByName: number;
  /** id che combaciano ma con nomi diversi: sono corrispondenze FALSE */
  stopIdNameConflicts: string[];
  /** riferimenti orfani: servono a capire la codifica dell'AVM */
  unmatchedTripRefs: string[];
  unmatchedLineRefs: string[];
  /** linee orfane con il nome pubblicato e i codici tentati: senza questi,
   *  "19 linee non agganciate" non dice se il problema è la regola di
   *  estrazione o il fatto che quelle linee nel feed non ci sono proprio. */
  unmatchedLines: Array<{ lineRef: string | null; published: string | null; codiciProvati: string[] }>;
  unmatchedStopRefs: string[];
}

/** Un id combacia ma i nomi sono incompatibili → non è la stessa fermata. */
function namesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // senza nomi non si può smentire: si accetta l'id
  const na = normalizeStopName(a), nb = normalizeStopName(b);
  if (!na || !nb) return true;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Aggancia la fermata dell'AVM a quella del feed.
 * Prima per id, ma VERIFICANDO il nome: due numerazioni diverse che si
 * sovrappongono per caso producono corrispondenze false, ed è peggio di
 * nessuna corrispondenza. Poi, in subordine, per nome.
 */
function resolveStop(
  ref: string | null, name: string | null, index: GtfsIndex,
): { stopId: string | null; how: "id" | "name" | null; conflict: string | null } {
  for (const c of refCandidates(ref)) {
    if (!index.stops.has(c)) continue;
    const feedName = index.stopNames.get(c) ?? null;
    if (namesCompatible(name, feedName)) return { stopId: c, how: "id", conflict: null };
    // id uguale, fermata diversa: si annota e si prova col nome
    const conflict = `${c}: AVM "${name}" ≠ feed "${feedName}"`;
    const byName = name ? index.stopByName.get(normalizeStopName(name)) : undefined;
    return byName
      ? { stopId: byName, how: "name", conflict }
      : { stopId: null, how: null, conflict };
  }
  const byName = name ? index.stopByName.get(normalizeStopName(name)) : undefined;
  return byName ? { stopId: byName, how: "name", conflict: null } : { stopId: null, how: null, conflict: null };
}

/**
 * Le linee extraurbane non hanno un numero nel nome: si chiamano
 * "OSIMO - ASPIO - ANCONA" sia nell'AVM sia nel feed. Si confrontano quindi i
 * NOMI, tenendo conto che l'AVM tronca a 50 caratteri ("JESI - CHIARAVALLE -
 * ROCCA PRIORA - FALCONARA  ANC"): il nome dell'AVM è un PREFISSO di quello
 * del feed. Si accetta solo se il prefisso individua UNA sola linea — con due
 * candidati non si indovina, si lascia orfana.
 */
export function matchRouteByLongName(
  published: string | null, longNames: Array<{ norm: string; routeId: string }>,
): string | null {
  if (!published) return null;
  const q = normalizeStopName(published);
  if (q.length < 10) return null; // troppo corto per essere distintivo
  const hits = new Set<string>();
  for (const r of longNames) {
    if (!r.norm) continue;
    if (r.norm === q || r.norm.startsWith(q) || q.startsWith(r.norm)) hits.add(r.routeId);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Aggancia la linea. Il numero PUBBLICATO ha la precedenza sull'id interno:
 * su Flashnet LineRef "16" è la Linea 3 e "11" la navetta del porto, quindi
 * confrontare LineRef con gli id del feed metteva i mezzi su linee altrui.
 * L'id interno resta un ripiego per i produttori che non pubblicano il nome.
 */
function resolveRoute(
  v: SiriVehicle, index: GtfsIndex,
): { routeId: string | null; how: "published" | "routeRef" | "longName" | "ref" | null } {
  for (const code of lineCodeCandidates(v.publishedLineName)) {
    const byCode = index.routeByCode.get(code);
    if (byCode) return { routeId: byCode, how: "published" };
  }
  /* Il percorso porta il numero di linea anche quando il nome non lo dice. */
  if (!v.outOfService) {
    for (const code of routeRefLineCandidates(v.routeRef)) {
      const byRoute = index.routeByCode.get(code);
      if (byRoute) return { routeId: byRoute, how: "routeRef" };
    }
    // Extraurbane: nessun codice, ma il nome esteso è lo stesso da entrambe le parti
    const byLong = matchRouteByLongName(v.publishedLineName, index.routeLongNames);
    if (byLong) return { routeId: byLong, how: "longName" };
  }
  if (!v.publishedLineName) {
    for (const c of refCandidates(v.lineRef)) {
      const byRef = index.routeByCode.get(normalizeLineCode(c)) ?? (index.routes.has(c) ? c : undefined);
      if (byRef) return { routeId: byRef, how: "ref" };
    }
  }
  return { routeId: null, how: null };
}

/** Primo candidato presente nell'insieme (esatto, poi ultimo segmento). */
function resolveRef(ref: string | null, pool: Set<string>): string | null {
  for (const c of refCandidates(ref)) if (pool.has(c)) return c;
  return null;
}

/** Orario programmato come HH:MM:SS, la convenzione di stop_transits. */
function hhmmss(d: Date | null): string | null {
  if (!d) return null;
  return d.toTimeString().slice(0, 8);
}

export function mapVehicles(vehicles: SiriVehicle[], index: GtfsIndex): {
  mapped: MappedVehicle[]; report: MappingReport;
} {
  const unmatchedTrip = new Set<string>();
  const unmatchedLine = new Set<string>();
  const unmatchedStop = new Set<string>();
  let withPosition = 0, tripMatched = 0, routeMatched = 0, stopMatched = 0;
  let transitsFound = 0, transitsMatched = 0;

  let byPublished = 0, byRouteRef = 0, byLongName = 0, byRef = 0, stopById = 0, stopByName = 0;
  let byJourneyId = 0, bySchedule = 0, ambiguous = 0;
  const ambiguousExamples: MappingReport["tripAmbiguousExamples"] = [];
  const conflicts = new Set<string>();
  const unmatchedLineDetail = new Map<string, { lineRef: string | null; published: string | null; codiciProvati: string[] }>();

  const mapped: MappedVehicle[] = vehicles.map(v => {
    let tripId = resolveRef(v.journeyRef, index.trips);
    let byId = !!tripId;

    // La linea: numero pubblicato, poi id interno, poi quella della corsa agganciata
    const r = resolveRoute(v, index);
    let routeId = r.routeId;
    if (r.how === "published") byPublished++;
    else if (r.how === "routeRef") byRouteRef++;
    else if (r.how === "longName") byLongName++;
    else if (r.how === "ref") byRef++;
    if (!routeId && tripId) routeId = index.tripRoute.get(tripId) ?? null;
    if (routeId) routeMatched++;
    else if (v.lineRef || v.publishedLineName) {
      unmatchedLine.add(v.lineRef ?? v.publishedLineName!);
      const key = `${v.lineRef ?? ""}|${v.publishedLineName ?? ""}`;
      if (!unmatchedLineDetail.has(key)) {
        unmatchedLineDetail.set(key, {
          lineRef: v.lineRef, published: v.publishedLineName,
          codiciProvati: [...new Set([
            ...lineCodeCandidates(v.publishedLineName),
            ...routeRefLineCandidates(v.routeRef),
          ])],
        });
      }
    }

    /* Se l'id non aggancia — il caso normale con due sistemi diversi — si
     * riconosce la corsa da linea + ora di partenza. Serve la linea, quindi
     * va fatto DOPO averla risolta. */
    let scheduleMatch: TripMatch | null = null;
    if (!tripId && routeId && v.originAimedDeparture && !v.outOfService && index.tripStarts) {
      scheduleMatch = matchTripBySchedule(
        routeId, v.originAimedDeparture, index.tripStarts,
        index.timeZone ?? "Europe/Rome", v.destinationName,
      );
      if (scheduleMatch.tripId) {
        tripId = scheduleMatch.tripId;
        bySchedule++;
        if (scheduleMatch.ambiguous) {
          ambiguous++;
          if (ambiguousExamples.length < 5) {
            ambiguousExamples.push({
              linea: routeId,
              partenza: v.originAimedDeparture.toISOString(),
              destinazioneAvm: v.destinationName,
              candidati: scheduleMatch.candidates ?? [],
            });
          }
        }
      }
    }
    if (tripId) { tripMatched++; if (byId) byJourneyId++; }
    else if (v.journeyRef && !v.outOfService) unmatchedTrip.add(v.journeyRef);

    const mc = v.monitoredCall;
    const s = resolveStop(mc?.stopPointRef ?? null, mc?.stopPointName ?? null, index);
    const nearestStopId = s.stopId;
    if (s.conflict) conflicts.add(s.conflict);
    if (nearestStopId) { stopMatched++; if (s.how === "id") stopById++; else stopByName++; }
    else if (mc?.stopPointRef) unmatchedStop.add(mc.stopPointRef);

    if (v.lat != null && v.lon != null) withPosition++;

    /* I transiti utili sono quelli GIÀ AVVENUTI: PreviousCalls, più la
     * MonitoredCall se il mezzo l'ha effettivamente servita. Le OnwardCalls
     * sono previsioni e non vanno scritte tra i transiti reali. */
    const candidates = [...v.previousCalls];
    if (v.monitoredCall && (v.monitoredCall.actualArrival || v.monitoredCall.actualDeparture)) {
      candidates.push(v.monitoredCall);
    }
    const transits: MappedVehicle["transits"] = [];
    for (const c of candidates) {
      const actualTs = c.actualDeparture ?? c.actualArrival;
      if (!actualTs) continue;
      transitsFound++;
      const stopId = resolveStop(c.stopPointRef, c.stopPointName, index).stopId;
      if (!stopId) { if (c.stopPointRef) unmatchedStop.add(c.stopPointRef); continue; }
      transitsMatched++;
      transits.push({
        stopId,
        stopSeq: c.order,
        scheduled: hhmmss(c.aimedDeparture ?? c.aimedArrival),
        actualTs,
        delaySeconds: c.delaySeconds,
      });
    }
    return { siri: v, tripId, routeId, nearestStopId, transits };
  });

  return {
    mapped,
    report: {
      vehicles: vehicles.length, withPosition, tripMatched,
      tripMatchedById: byJourneyId, tripMatchedBySchedule: bySchedule, tripAmbiguous: ambiguous,
      tripAmbiguousExamples: ambiguousExamples,
      routeMatched, stopMatched,
      transitsFound, transitsMatched,
      routeMatchedByPublishedName: byPublished, routeMatchedByRouteRef: byRouteRef,
      routeMatchedByLongName: byLongName, routeMatchedByRef: byRef,
      stopMatchedById: stopById, stopMatchedByName: stopByName,
      stopIdNameConflicts: [...conflicts].slice(0, 10),
      unmatchedTripRefs: [...unmatchedTrip].slice(0, 10),
      unmatchedLineRefs: [...unmatchedLine].slice(0, 10),
      unmatchedLines: [...unmatchedLineDetail.values()].slice(0, 25),
      unmatchedStopRefs: [...unmatchedStop].slice(0, 10),
    },
  };
}

/** Corse annullate: aggancia il riferimento di viaggio al trip GTFS. */
export function resolveCancelledTrip(journeyRef: string | null, index: GtfsIndex): string | null {
  return resolveRef(journeyRef, index.trips);
}

/* ── Trasporto ────────────────────────────────────────────────────────────── */

export interface SiriEndpointConfig {
  url: string;
  requestorRef: string;
  /** valore dell'header SOAPAction (il WSDL dichiara azioni non qualificate) */
  soapAction?: string;
  /** Basic auth, se il produttore la richiede */
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
}

/** POST SOAP con timeout esplicito: un AVM che non risponde non deve bloccare il poller. */
export async function postSoap(
  cfg: SiriEndpointConfig, action: string, body: string,
): Promise<{ ok: boolean; status: number; xml: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": cfg.soapAction ?? action,
    };
    if (cfg.username) {
      const basic = Buffer.from(`${cfg.username}:${cfg.password ?? ""}`).toString("base64");
      headers["Authorization"] = `Basic ${basic}`;
    }
    const res = await fetch(cfg.url, { method: "POST", headers, body, signal: ctrl.signal });
    const xml = await res.text();
    return { ok: res.ok, status: res.status, xml };
  } finally {
    clearTimeout(timer);
  }
}

/** Un giro completo: richiesta, risposta, normalizzazione.
 *  `rawXml` è il grezzo INTERO: la diagnostica ne ritaglia ciò che serve. */
export async function fetchVehicleMonitoring(
  cfg: SiriEndpointConfig, opts: Omit<SiriRequestOptions, "requestorRef"> = {},
): Promise<SiriVmResult & { httpStatus: number; rawXml: string; requestXml: string }> {
  const body = buildVehicleMonitoringRequest({ ...opts, requestorRef: cfg.requestorRef });
  const { ok, status, xml } = await postSoap(cfg, "GetVehicleMonitoring", body);
  if (!ok && !xml.includes("Envelope")) {
    return {
      failed: true, errorText: `HTTP ${status}`, responseTimestamp: null,
      shortestPossibleCycleSec: null, vehicles: [], cancellations: [],
      httpStatus: status, rawXml: xml, requestXml: body,
    };
  }
  const parsed = parseVehicleMonitoringResponse(xml);
  /* La richiesta esce insieme alla risposta: per capire perché manca un campo
   * la prima domanda è sempre "che cosa abbiamo chiesto", e finora bisognava
   * andarla a leggere nel codice. */
  return { ...parsed, httpStatus: status, rawXml: xml, requestXml: body };
}

/* ── Aggancio della CORSA per orario ──────────────────────────────────────
 * Gli identificativi di corsa dei due sistemi non hanno nulla in comune
 * ("469179" contro "684_CodUdp:D1690_363283"): nessuna regola di stringa li
 * unirà mai. Ma l'AVM dichiara linea e ORA DI PARTENZA dal capolinea, e nel
 * feed la coppia (linea, partenza) individua una corsa. È l'aggancio che
 * sblocca tutto il resto, perché senza corsa un transito non è attribuibile.
 */

/** Una corsa del feed, ridotta a ciò che serve per riconoscerla. */
export interface TripStart {
  tripId: string;
  routeId: string;
  /** orario di partenza dalla prima fermata, HH:MM:SS (può superare le 24) */
  firstDeparture: string;
  headsign: string | null;
}

export interface TripStartIndex {
  /** "routeId|HH:MM" → corse che partono a quell'ora su quella linea */
  byRouteAndStart: Map<string, string[]>;
  headsign: Map<string, string | null>;
  trips: number;
  /** giorno di servizio su cui è costruito l'indice (YYYYMMDD) */
  serviceDay?: string;
  /** false = calendario non utilizzabile, indice su TUTTE le validità */
  calendarFiltered?: boolean;
}

export function buildTripStartIndex(rows: TripStart[]): TripStartIndex {
  const byRouteAndStart = new Map<string, string[]>();
  const headsign = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.firstDeparture) continue;
    const key = `${r.routeId}|${r.firstDeparture.slice(0, 5)}`;
    const arr = byRouteAndStart.get(key);
    if (arr) arr.push(r.tripId); else byRouteAndStart.set(key, [r.tripId]);
    headsign.set(r.tripId, r.headsign);
  }
  for (const arr of byRouteAndStart.values()) arr.sort();
  return { byRouteAndStart, headsign, trips: rows.length };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Ora locale dell'azienda: il server può girare in UTC, l'orario no. */
export function localHHMM(d: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("it-IT", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const h = p.find(x => x.type === "hour")?.value ?? "00";
  const m = p.find(x => x.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/**
 * Chiavi orarie da provare, in ordine di preferenza: l'esatta, poi ±1 e ±2
 * minuti (AVM e orario possono arrotondare diversamente). Per le ore piccole
 * si prova anche la forma GTFS oltre le 24 ("01:10" → "25:10"), con cui i
 * feed esprimono le corse a cavallo della mezzanotte.
 */
function scheduleCandidates(hhmm: string): Array<{ key: string; delta: number }> {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return [];
  const out: Array<{ key: string; delta: number }> = [];
  const seen = new Set<string>();
  const push = (key: string, delta: number) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, delta });
  };
  for (const delta of [0, -1, 1, -2, 2]) {
    const norm = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
    const hh = Math.floor(norm / 60), mm = norm % 60;
    push(`${pad2(hh)}:${pad2(mm)}`, delta);
    if (hh < 6) push(`${pad2(hh + 24)}:${pad2(mm)}`, delta);
  }
  return out;
}
export function scheduleKeys(hhmm: string): string[] {
  return scheduleCandidates(hhmm).map(c => c.key);
}

/* ── Il ritardo alla fermata, calcolato in casa ────────────────────────────
 * Finora il ritardo era SOLO quello dichiarato dall'AVM: se il produttore non
 * lo manda — e questo non lo manda quasi mai — la colonna Δ restava vuota
 * anche quando si conoscevano sia l'orario programmato sia il transito
 * osservato. Sono i due termini del confronto: il delta si calcola.
 *
 * Due trappole nel GTFS, entrambe reali:
 *  · l'orario programmato può superare le 24 ("25:10:00" = 01:10 del giorno
 *    dopo, stessa giornata di servizio);
 *  · il transito osservato cade dopo la mezzanotte civile mentre il
 *    programmato è ancora "prima".
 * In tutti e due i casi la sottrazione grezza sbaglia di 24 ore. Si riporta
 * quindi lo scarto nella finestra ±12 h, che è l'unica interpretazione
 * sensata: nessuna corsa è in ritardo di mezza giornata.
 */
const DAY_SEC = 86_400;

/** "HH:MM[:SS]" → secondi dalla mezzanotte, anche oltre le 24. */
export function scheduledSeconds(scheduled: string | null | undefined): number | null {
  if (!scheduled) return null;
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(scheduled.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Secondi dalla mezzanotte locale, nel fuso dell'azienda. */
function localSeconds(d: Date, timeZone: string): number {
  const p = new Intl.DateTimeFormat("it-IT", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => Number(p.find(x => x.type === t)?.value ?? "0");
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

/**
 * Scarto fra transito osservato e orario programmato, in secondi.
 * Positivo = ritardo, negativo = anticipo. null se manca un termine.
 */
export function delayFromSchedule(
  scheduled: string | null | undefined,
  observedAt: Date | string | null | undefined,
  timeZone = "Europe/Rome",
): number | null {
  const sched = scheduledSeconds(scheduled);
  if (sched == null || !observedAt) return null;
  const at = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(at.getTime())) return null;

  const raw = localSeconds(at, timeZone) - (sched % DAY_SEC);
  /* Nella finestra ±12 h. Il modulo di JS tiene il segno del dividendo,
   * quindi il +DAY_SEC prima del secondo modulo non è ridondante. */
  return (((raw + DAY_SEC / 2) % DAY_SEC) + DAY_SEC) % DAY_SEC - DAY_SEC / 2;
}

export interface TripMatch {
  tripId: string | null;
  /** più corse partono a quell'ora su quella linea: la scelta è arbitraria */
  ambiguous: boolean;
  /** scarto in minuti fra l'orario dell'AVM e quello del feed */
  toleranceUsed: number | null;
  /** quando è ambiguo: CHI stava collidendo, per poterlo guardare */
  candidates?: Array<{ tripId: string; headsign: string | null }>;
}

/**
 * Riconosce la corsa da linea + partenza programmata.
 * Con più candidati si preferisce quello con lo stesso capolinea; se restano
 * ambigui si sceglie in modo deterministico ma lo si DICHIARA: corse identiche
 * per linea e orario differiscono di norma solo per validità, e per leggere
 * gli orari programmati sono equivalenti — ma va detto, non nascosto.
 */
export function matchTripBySchedule(
  routeId: string, departure: Date, idx: TripStartIndex,
  timeZone: string, destinationName?: string | null,
): TripMatch {
  for (const cand of scheduleCandidates(localHHMM(departure, timeZone))) {
    const found = idx.byRouteAndStart.get(`${routeId}|${cand.key}`);
    if (!found || found.length === 0) continue;
    const tolerance = cand.delta;
    if (found.length === 1) {
      return { tripId: found[0], ambiguous: false, toleranceUsed: Math.abs(tolerance) };
    }
    if (destinationName) {
      const want = normalizeStopName(destinationName);
      const sameEnd = found.filter(t => {
        const h = idx.headsign.get(t);
        if (!h) return false;
        const n = normalizeStopName(h);
        return n === want || n.startsWith(want) || want.startsWith(n);
      });
      if (sameEnd.length === 1) {
        return { tripId: sameEnd[0], ambiguous: false, toleranceUsed: Math.abs(tolerance) };
      }
    }
    return {
      tripId: found[0], ambiguous: true, toleranceUsed: Math.abs(tolerance),
      candidates: found.slice(0, 6).map(t => ({ tripId: t, headsign: idx.headsign.get(t) ?? null })),
    };
  }
  return { tripId: null, ambiguous: false, toleranceUsed: null };
}

/* ── Dal passaggio alla fermata al TRANSITO ───────────────────────────────
 * MIZ manda le fermate transitate ma senza orari, quindi i transiti vanno
 * OSSERVATI: quando la fermata corrente di un mezzo cambia da A a B, quel
 * mezzo ha superato A nell'intervallo fra le due interrogazioni.
 *
 * Si registra l'osservazione, non una derivazione: `actual_ts` è il momento
 * stimato del passaggio (il punto medio dell'intervallo), `delay_seconds` è
 * il ritardo dichiarato dall'AVM, `scheduled` è l'orario del feed. Tre fatti
 * indipendenti. La tentazione era calcolare actual = programmato + ritardo,
 * che sembra più preciso: ma se l'AVM aggiorna il ritardo a livello di corsa
 * e non di fermata, i tempi di percorrenza "osservati" verrebbero identici a
 * quelli programmati per costruzione — un dato che si conferma da solo e non
 * dice niente. Meglio una misura rumorosa che una tautologia.
 */
export interface VehicleProgress {
  tripId: string;
  stopId: string;
  delaySeconds: number | null;
  at: Date;
}
export interface TransitEvent {
  tripId: string;
  stopId: string;
  delaySeconds: number | null;
  /** istante stimato del passaggio: metà dell'intervallo fra le due letture */
  observedAt: Date;
  /** ampiezza dell'intervallo, in secondi: è l'incertezza della misura */
  uncertaintySec: number;
}

/**
 * Oltre questo intervallo il punto medio non significa più nulla — ed è
 * anche il tetto oltre il quale non ha senso far girare il poller: se due
 * letture distano di più, nessun transito verrà mai registrato.
 */
export const MAX_GAP_SEC = 300;

/** Intervallo a cui si scende quando quello configurato è inutilizzabile. */
export const POLL_CONSIGLIATO_SEC = 60;

/**
 * L'intervallo di poll davvero applicabile, dato quello configurato.
 *
 * Il taglio NON si ferma a MAX_GAP_SEC, che è la soglia di rifiuto: un giro
 * da 300 s che ne impiega 300,4 verrebbe scartato lo stesso e il taglio non
 * servirebbe a nulla. Si scende a un intervallo più corto del tempo fra due
 * fermate, che è la condizione perché un transito si possa riconoscere.
 */
export function effectivePollSeconds(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 30;
  return requested > MAX_GAP_SEC ? POLL_CONSIGLIATO_SEC : Math.max(10, requested);
}

/* ── Il passaggio riconosciuto dalla POSIZIONE ────────────────────────────
 *
 * Il rilevamento qui sotto (detectTransit) dipende da un filo sottile: che
 * l'AVM mandi MonitoredCall, che quel riferimento di fermata si agganci al
 * feed, e che CAMBI fra due letture consecutive. Se uno solo dei tre anelli
 * salta — e su questo produttore saltano spesso — non viene acquisito nulla,
 * in silenzio, pur avendo la posizione del mezzo a ogni giro.
 *
 * La posizione però basta da sola: conoscendo le fermate della corsa e le
 * loro coordinate, un mezzo che passa entro pochi metri dalla fermata K della
 * PROPRIA corsa ha transitato da K. Non serve che l'AVM dichiari nulla, e si
 * riconoscono tutte le fermate toccate, non una per coppia di letture.
 */

/* L'acquisizione dei transiti è una catena di condizioni, e finora quando non
 * arrivava niente non si sapeva QUALE anello cedesse: si poteva solo tirare a
 * indovinare, una ipotesi per volta. Questi contatori misurano ogni passaggio
 * della catena su ogni giro, così la risposta si legge invece di dedurla. */
export interface TransitFunnel {
  inEsercizio: number;
  conMatricola: number;
  conCorsaAgganciata: number;
  /** con posizione UTILIZZABILE (non scaduta, senza errore di monitoraggio) */
  conPosizione: number;
  /** hanno coordinate, ma vecchie: l'AVM non sente il mezzo da un pezzo */
  posizioneScaduta: number;
  /** corse agganciate di cui conosciamo le fermate con coordinate */
  conGeometriaFermate: number;
  /** ── via posizione ── */
  vicinoAFermata: number;
  transitiDaPosizione: number;
  /** ── via cambio di fermata dichiarata dall'AVM ── */
  conFermataAvm: number;
  conLetturaPrecedente: number;
  fermataCambiata: number;
  transitiDaCambioFermata: number;
  /** ── dichiarati dall'AVM con orario effettivo ── */
  transitiDichiarati: number;
  /** ── esito ── */
  inseriti: number;
  giaPresenti: number;
}

export function emptyFunnel(): TransitFunnel {
  return {
    inEsercizio: 0, conMatricola: 0, conCorsaAgganciata: 0, conPosizione: 0,
    posizioneScaduta: 0,
    conGeometriaFermate: 0, vicinoAFermata: 0, transitiDaPosizione: 0,
    conFermataAvm: 0, conLetturaPrecedente: 0, fermataCambiata: 0,
    transitiDaCambioFermata: 0, transitiDichiarati: 0, inseriti: 0, giaPresenti: 0,
  };
}

/** Dove si è interrotta la catena, in una frase. */
export function explainFunnel(f: TransitFunnel): string {
  if (f.inEsercizio === 0) return "Nessun mezzo in esercizio: l'AVM non sta mandando vetture in servizio.";
  if (f.conCorsaAgganciata === 0) return "Nessun mezzo è agganciato a una corsa dell'orario: senza corsa il transito non è attribuibile a nulla.";
  if (f.conPosizione === 0) {
    return f.posizioneScaduta > 0
      ? `Nessuna posizione UTILIZZABILE: ${f.posizioneScaduta} mezzi hanno coordinate `
        + "ma la localizzazione è scaduta o il monitoraggio è in errore (GPRS/GPS). "
        + "Sono dati vecchi: usarli farebbe nascere passaggi mai avvenuti."
      : "Nessuna posizione: senza coordinate il passaggio non è riconoscibile.";
  }
  if (f.conGeometriaFermate === 0) return "Delle corse agganciate non si conoscono le fermate con coordinate: controlla che gtfs_stops abbia stop_lat/stop_lon per questo feed.";
  if (f.inseriti === 0 && f.giaPresenti > 0) return "I passaggi vengono riconosciuti ma risultano già registrati: nessuna novità, non è un guasto.";
  if (f.vicinoAFermata === 0) return "Nessun mezzo si trova entro il raggio di una fermata della propria corsa: o le coordinate del feed non combaciano con quelle dell'AVM, o le corse agganciate sono quelle sbagliate.";
  if (f.inseriti === 0) return "Mezzi riconosciuti alle fermate ma nessuna scrittura riuscita: guarda primoErrore.";
  return `${f.inseriti} passaggi registrati in questo giro.`;
}

/** Distanza in metri fra due punti (formula dell'emisenoverso). */
export function distanceMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6_371_000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Una fermata della corsa, con dove sta e a che ora è prevista. */
export interface TripStop {
  stopId: string;
  seq: number;
  lat: number;
  lon: number;
  /** orario programmato "HH:MM:SS", se il feed ce l'ha */
  scheduled: string | null;
}

/**
 * Raggio di prossimità. Sotto i ~30 m si perdono i passaggi per l'imprecisione
 * del GPS urbano; sopra i ~80 m si agganciano fermate della carreggiata
 * opposta o dell'incrocio accanto. 60 m è il compromesso abituale per il TPL.
 */
export const STOP_RADIUS_M = 60;

/**
 * Le fermate della corsa da cui il mezzo sta passando adesso, la più vicina
 * per prima. Elenco vuoto se è in mezzo a una tratta.
 */
export function stopsAtPosition(
  lat: number, lon: number, stops: TripStop[], radiusM = STOP_RADIUS_M,
): Array<TripStop & { distanceM: number }> {
  const near: Array<TripStop & { distanceM: number }> = [];
  for (const s of stops) {
    const d = distanceMeters(lat, lon, s.lat, s.lon);
    if (d <= radiusM) near.push({ ...s, distanceM: Math.round(d) });
  }
  return near.sort((a, b) => a.distanceM - b.distanceM);
}

export function detectTransit(
  prev: VehicleProgress | null | undefined, cur: VehicleProgress,
): TransitEvent | null {
  if (!prev) return null;                       // prima lettura: non si sa da dove venga
  if (prev.tripId !== cur.tripId) return null;  // cambio corsa: il passaggio non è attribuibile
  if (prev.stopId === cur.stopId) return null;  // ancora sulla stessa tratta
  const gapMs = cur.at.getTime() - prev.at.getTime();
  if (gapMs <= 0 || gapMs > MAX_GAP_SEC * 1000) return null;
  return {
    tripId: prev.tripId,
    stopId: prev.stopId,
    delaySeconds: prev.delaySeconds ?? cur.delaySeconds,
    observedAt: new Date(prev.at.getTime() + gapMs / 2),
    uncertaintySec: Math.round(gapMs / 1000),
  };
}
