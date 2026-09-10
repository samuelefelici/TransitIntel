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

  return {
    recordedAt: parseDate(directText(va, "RecordedAtTime")),
    itemIdentifier: directText(va, "ItemIdentifier"),
    vehicleRef: directText(mvj, "VehicleRef"),
    lineRef: directText(mvj, "LineRef"),
    directionRef: directText(mvj, "DirectionRef"),
    datedVehicleJourneyRef: directText(framed, "DatedVehicleJourneyRef"),
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
  loadedAt: number;
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
  routeMatched: number;
  stopMatched: number;
  transitsFound: number;
  transitsMatched: number;
  /** riferimenti orfani: servono a capire la codifica dell'AVM */
  unmatchedTripRefs: string[];
  unmatchedLineRefs: string[];
  unmatchedStopRefs: string[];
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

  const mapped: MappedVehicle[] = vehicles.map(v => {
    const tripId = resolveRef(v.datedVehicleJourneyRef, index.trips);
    if (tripId) tripMatched++;
    else if (v.datedVehicleJourneyRef) unmatchedTrip.add(v.datedVehicleJourneyRef);

    // La linea: quella dichiarata dall'AVM, altrimenti quella della corsa agganciata
    let routeId = resolveRef(v.lineRef, index.routes);
    if (!routeId && tripId) routeId = index.tripRoute.get(tripId) ?? null;
    if (routeId) routeMatched++;
    else if (v.lineRef) unmatchedLine.add(v.lineRef);

    const nearestStopId = resolveRef(v.monitoredCall?.stopPointRef ?? null, index.stops);
    if (nearestStopId) stopMatched++;
    else if (v.monitoredCall?.stopPointRef) unmatchedStop.add(v.monitoredCall.stopPointRef);

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
      const stopId = resolveRef(c.stopPointRef, index.stops);
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
      vehicles: vehicles.length, withPosition, tripMatched, routeMatched, stopMatched,
      transitsFound, transitsMatched,
      unmatchedTripRefs: [...unmatchedTrip].slice(0, 10),
      unmatchedLineRefs: [...unmatchedLine].slice(0, 10),
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

/** Un giro completo: richiesta, risposta, normalizzazione. */
export async function fetchVehicleMonitoring(
  cfg: SiriEndpointConfig, opts: Omit<SiriRequestOptions, "requestorRef"> = {},
): Promise<SiriVmResult & { httpStatus: number; rawSample: string }> {
  const body = buildVehicleMonitoringRequest({ ...opts, requestorRef: cfg.requestorRef });
  const { ok, status, xml } = await postSoap(cfg, "GetVehicleMonitoring", body);
  if (!ok && !xml.includes("Envelope")) {
    return {
      failed: true, errorText: `HTTP ${status}`, responseTimestamp: null,
      shortestPossibleCycleSec: null, vehicles: [], cancellations: [],
      httpStatus: status, rawSample: xml.slice(0, 2000),
    };
  }
  const parsed = parseVehicleMonitoringResponse(xml);
  return { ...parsed, httpStatus: status, rawSample: xml.slice(0, 2000) };
}
