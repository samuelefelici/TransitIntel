/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Fermata vista da Mizar — StopMonitoring a confronto con il GTFS
 * ───────────────────────────────────────────────────────────────────────────
 * Il servizio StopMonitoring di Mizar (endpoint SMWS, scoperto dalla sonda il
 * 14 settembre 2026) risponde, per UNA fermata, con i passaggi programmati
 * delle ore successive: linea con il codice pubblico, numero di corsa MTRAM
 * (lo stesso in coda al nostro trip_id), orario programmato alla fermata con
 * i secondi, capolinea, e — per i mezzi che l'AVM segue — l'orario di
 * partenza previsto con lo stato.
 *
 * È l'orario di Mizar, fermata per fermata, agganciabile al feed senza
 * euristiche. Confrontarlo con le stop_times delle stesse corse dice tre cose
 * in un colpo solo, e nessuna è tautologica:
 *   - se i codici fermata di Mizar e del feed sono la stessa fermata;
 *   - se il numero di corsa individua la corsa anche nel feed;
 *   - di quanti secondi divergono i due orari alla fermata (e alla partenza).
 *
 * Logica pura: parsing e confronto vivono qui e si collaudano senza rete né
 * database; la rotta fa solo le due letture e le mette insieme.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  parseXml, findAll, findFirst, directText, parseDate, parseIsoDuration,
  resolveRef, resolveStop, normalizeLineCode, codiceCorsaDi,
  type GtfsIndex,
} from "./siri-vm";

/* ── Modello ─────────────────────────────────────────────────────────────── */

export interface VisitaFermata {
  /** quando l'AVM ha registrato il dato; mezzanotte = orario statico */
  recordedAt: Date | null;
  /** true se il passaggio viene dall'orario e non da un mezzo seguito */
  statico: boolean;
  monitoringRef: string | null;
  lineRef: string | null;
  publishedLineName: string | null;
  directionRef: string | null;
  routeRef: string | null;
  /** numero di corsa MTRAM: la chiave verso il trip_id */
  courseOfJourneyRef: string | null;
  vehicleRef: string | null;
  originRef: string | null;
  originName: string | null;
  destinationRef: string | null;
  destinationName: string | null;
  originAimedDeparture: Date | null;
  destinationAimedArrival: Date | null;
  monitored: boolean;
  stopPointRef: string | null;
  stopPointName: string | null;
  visitNumber: number | null;
  destinationDisplay: string | null;
  aimedArrival: Date | null;
  aimedDeparture: Date | null;
  expectedArrival: Date | null;
  expectedDeparture: Date | null;
  arrivalStatus: string | null;
  departureStatus: string | null;
}

export interface StopMonitoringResult {
  failed: boolean;
  errorText: string | null;
  responseTimestamp: Date | null;
  validUntil: Date | null;
  shortestPossibleCycleSec: number | null;
  visite: VisitaFermata[];
}

/* ── Lettura della risposta ──────────────────────────────────────────────── */

export function parseStopMonitoringResponse(xml: string): StopMonitoringResult {
  const doc = parseXml(xml);
  const delivery = findFirst(doc, "StopMonitoringDelivery");
  const fault = findFirst(doc, "Fault");
  const errorCondition = findFirst(doc, "ErrorCondition");
  const status = delivery ? directText(delivery, "Status") : null;

  const errorText = fault
    ? (directText(fault, "faultstring") ?? findFirst(fault, "Text")?.text.trim() ?? "SOAP Fault")
    : errorCondition
      ? (findFirst(errorCondition, "Description")?.text.trim() ?? findFirst(errorCondition, "ErrorText")?.text.trim() ?? "ErrorCondition")
      : null;
  const failed = !!fault || !!errorCondition || status?.toLowerCase() === "false";

  const visite: VisitaFermata[] = [];
  if (delivery) {
    for (const v of findAll(delivery, "MonitoredStopVisit")) {
      const mvj = findFirst(v, "MonitoredVehicleJourney");
      const call = mvj ? findFirst(mvj, "MonitoredCall") : null;
      const recordedAt = parseDate(directText(v, "RecordedAtTime"));
      visite.push({
        recordedAt,
        statico: /T00:00:00(?:\.0+)?$/.test(directText(v, "RecordedAtTime") ?? ""),
        monitoringRef: directText(v, "MonitoringRef"),
        lineRef: directText(mvj, "LineRef"),
        publishedLineName: directText(mvj, "PublishedLineName"),
        directionRef: directText(mvj, "DirectionRef"),
        routeRef: directText(mvj, "RouteRef"),
        courseOfJourneyRef: directText(mvj, "CourseOfJourneyRef"),
        vehicleRef: directText(mvj, "VehicleRef"),
        originRef: directText(mvj, "OriginRef"),
        originName: directText(mvj, "OriginName"),
        destinationRef: directText(mvj, "DestinationRef"),
        destinationName: directText(mvj, "DestinationName"),
        originAimedDeparture: parseDate(directText(mvj, "OriginAimedDepartureTime")),
        destinationAimedArrival: parseDate(directText(mvj, "DestinationAimedArrivalTime")),
        monitored: (directText(mvj, "Monitored") ?? "false").toLowerCase() === "true",
        stopPointRef: directText(call, "StopPointRef"),
        stopPointName: directText(call, "StopPointName"),
        visitNumber: call && directText(call, "VisitNumber") != null ? Number(directText(call, "VisitNumber")) : null,
        destinationDisplay: directText(call, "DestinationDisplay"),
        aimedArrival: parseDate(directText(call, "AimedArrivalTime")),
        aimedDeparture: parseDate(directText(call, "AimedDepartureTime")),
        expectedArrival: parseDate(directText(call, "ExpectedArrivalTime")),
        expectedDeparture: parseDate(directText(call, "ExpectedDepartureTime")),
        arrivalStatus: directText(call, "ArrivalStatus"),
        departureStatus: directText(call, "DepartureStatus"),
      });
    }
  }

  return {
    failed, errorText,
    responseTimestamp: parseDate(delivery ? directText(delivery, "ResponseTimestamp") : null),
    validUntil: parseDate(delivery ? directText(delivery, "ValidUntil") : null),
    shortestPossibleCycleSec: parseIsoDuration(delivery ? directText(delivery, "ShortestPossibleCycle") : null),
    visite,
  };
}

/* ── Orari: due convenzioni, un solo asse ────────────────────────────────── */

/** Secondi dalla mezzanotte LOCALE di un istante. */
export function secondiLocali(d: Date, timeZone = process.env.SIRI_TIMEZONE || "Europe/Rome"): number {
  const p = new Intl.DateTimeFormat("it-IT", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? "0");
  return g("hour") * 3600 + g("minute") * 60 + g("second");
}

/** Secondi di un orario GTFS "HH:MM:SS", anche oltre le 24 ("25:10:00"). */
export function secondiGtfs(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** a − b sul giro delle 24 ore: la differenza più corta, in [-12h, +12h]. */
export function scartoCircolare(a: number, b: number): number {
  let d = (a - b) % 86400;
  if (d > 43200) d -= 86400;
  if (d < -43200) d += 86400;
  return d;
}

/* ── Confronto con il feed ───────────────────────────────────────────────── */

/** Una riga di stop_times, come serve qui. */
export interface RigaOrario { stopId: string; seq: number; scheduled: string }

export interface ConfrontoVisita {
  /** come Mizar chiama le cose */
  mizar: {
    linea: string | null; nomeLinea: string | null; corsa: string | null; percorso: string | null;
    partenza: string | null; capolineaPartenza: string | null; capolineaArrivo: string | null;
    arrivoProgrammato: string | null; partenzaProgrammata: string | null;
    partenzaPrevista: string | null; statoPartenza: string | null;
    seguito: boolean; matricola: string | null;
  };
  /** come le chiama il feed, quando l'aggancio riesce */
  gtfs: {
    tripId: string | null; routeId: string | null; stopId: string | null;
    fermataAgganciataCome: "alias" | "id" | "code" | "name" | null;
    /** l'orario alla fermata, nell'occorrenza più vicina a quella di Mizar */
    orarioAllaFermata: string | null; progressivo: number | null;
    partenza: string | null;
  };
  /** movimento fuori servizio (rientro in deposito, trasferimento): non è una
   *  corsa del feed e non deve contare come mancante */
  fuoriServizio: boolean;
  /** secondi di sosta al capolinea dichiarati da Mizar (arrivo prima della
   *  partenza): il feed ha solo la partenza, il confronto usa quella */
  sostaAlCapolineaSec: number | null;
  /** true se il trip_id esiste nel feed */
  corsaNelFeed: boolean;
  /** true se la corsa del feed passa da questa fermata */
  fermataNellaCorsa: boolean;
  /** true se la linea di Mizar e la route della corsa nel feed sono la stessa */
  lineaCombacia: boolean | null;
  /** Mizar − feed alla fermata, secondi (positivo: Mizar più tardi) */
  scartoAllaFermataSec: number | null;
  /** Mizar − feed alla partenza dal capolinea, secondi */
  scartoAllaPartenzaSec: number | null;
}

export interface ConfrontoFermata {
  fermata: {
    ref: string; nomeMizar: string | null;
    stopId: string | null; nomeFeed: string | null; agganciataCome: "alias" | "id" | "code" | "name" | null; conflitto: string | null;
  };
  visite: ConfrontoVisita[];
  riepilogo: {
    /** record ricevuti da Mizar, prima di unire arrivo e partenza al capolinea */
    visiteGrezze: number;
    visite: number;
    fuoriServizio: number;
    sosteAlCapolinea: number;
    seguite: number;
    conPrevisione: number;
    corseNelFeed: number;
    fermataNellaCorsa: number;
    lineeCombaciano: number;
    lineeDiverse: number;
    /** quante visite hanno lo stesso orario alla fermata, al secondo */
    orariIdentici: number;
    scartoMedianoSec: number | null;
    scartoMassimoSec: number | null;
    scartoPartenzaMedianoSec: number | null;
    corseNonTrovate: string[];
  };
  lettura: string[];
}

function fmt(d: Date | null, timeZone?: string): string | null {
  if (!d) return null;
  const s = secondiLocali(d, timeZone);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Un movimento fuori servizio: rientro in deposito, trasferimento, "fuori
 * linea". Mizar li elenca fra i passaggi come le corse (numero "FRSRV…",
 * linea "FSRV" o nessuna linea): nel feed non ci sono per definizione.
 */
export function fuoriServizio(v: Pick<VisitaFermata, "courseOfJourneyRef" | "lineRef" | "publishedLineName" | "destinationDisplay">): boolean {
  if (v.courseOfJourneyRef && /^FRSRV/i.test(v.courseOfJourneyRef.trim())) return true;
  if (v.lineRef && v.lineRef.trim().toUpperCase() === "FSRV") return true;
  if (v.destinationDisplay && /FUORI LINEA|RIENTRO DEPOSITO|DEPOSITO/i.test(v.destinationDisplay)) return true;
  return !v.lineRef && !v.publishedLineName;
}

/**
 * Ai capolinea Mizar manda DUE record per la stessa corsa: l'arrivo in
 * sosta (AimedArrival 11:08, AimedDeparture 11:15) e la partenza
 * (11:15/11:15), o uno dei due senza l'orario di arrivo. Sono lo stesso
 * passaggio: si uniscono per (corsa, partenza programmata), tenendo
 * l'arrivo più presto e la previsione di chi ce l'ha. Un passaggio vero
 * ripetuto (circolare che torna al capolinea) ha una partenza diversa e
 * resta distinto.
 */
export function unisciVisite(visite: VisitaFermata[]): VisitaFermata[] {
  const out: VisitaFermata[] = [];
  const posizione = new Map<string, number>();
  for (const v of visite) {
    const chiave = `${v.courseOfJourneyRef ?? ""}|${v.aimedDeparture?.getTime() ?? ""}`;
    const i = posizione.get(chiave);
    if (i == null || !v.courseOfJourneyRef) { posizione.set(chiave, out.length); out.push({ ...v }); continue; }
    const u = out[i];
    if (v.aimedArrival && (!u.aimedArrival || v.aimedArrival < u.aimedArrival)) u.aimedArrival = v.aimedArrival;
    u.aimedDeparture = u.aimedDeparture ?? v.aimedDeparture;
    u.expectedArrival = u.expectedArrival ?? v.expectedArrival;
    u.expectedDeparture = u.expectedDeparture ?? v.expectedDeparture;
    u.arrivalStatus = u.arrivalStatus ?? v.arrivalStatus;
    u.departureStatus = u.departureStatus ?? v.departureStatus;
    u.vehicleRef = u.vehicleRef ?? v.vehicleRef;
    u.lineRef = u.lineRef ?? v.lineRef;
    u.publishedLineName = u.publishedLineName ?? v.publishedLineName;
    if (v.monitored) { u.monitored = true; u.statico = false; u.recordedAt = v.recordedAt ?? u.recordedAt; }
  }
  return out;
}

/**
 * Confronta i passaggi che Mizar dà per una fermata con le stop_times del
 * feed. `orari` porta, per ogni trip_id agganciato, tutte le sue righe in
 * ordine di progressivo: serve la partenza (prima riga) e l'occorrenza
 * giusta della fermata (le circolari passano due volte dal capolinea).
 * Il confronto alla fermata usa la PARTENZA programmata: il feed ha un solo
 * orario per fermata, ed è quello; l'arrivo in sosta al capolinea è un dato
 * in più di Mizar, riportato a parte.
 */
export function confrontaFermata(
  ref: string, visiteGrezze: VisitaFermata[], index: GtfsIndex,
  orari: Map<string, RigaOrario[]>, timeZone = index.timeZone,
): ConfrontoFermata {
  const visite = unisciVisite(visiteGrezze);
  const nomeMizar = visite.find(v => v.stopPointName)?.stopPointName ?? null;
  const fermata = resolveStop(ref, nomeMizar, index);
  const stopId = fermata.stopId;

  const nonTrovate = new Set<string>();
  const confronti: ConfrontoVisita[] = visite.map(v => {
    const fuori = fuoriServizio(v);
    const tripId = fuori ? null : resolveRef(v.courseOfJourneyRef, index.trips, index.tripByCode);
    if (!fuori && !tripId && v.courseOfJourneyRef) nonTrovate.add(v.courseOfJourneyRef);
    const righe = tripId ? (orari.get(tripId) ?? []) : [];
    const routeId = tripId ? (index.tripRoute.get(tripId) ?? null) : null;
    const sosta = v.aimedArrival && v.aimedDeparture && v.aimedDeparture > v.aimedArrival
      ? Math.round((v.aimedDeparture.getTime() - v.aimedArrival.getTime()) / 1000) : null;

    /* La linea: il codice pubblico di Mizar contro la route della corsa. */
    let lineaCombacia: boolean | null = null;
    if (routeId && v.lineRef) {
      const attesa = index.routeByCode.get(normalizeLineCode(v.lineRef));
      lineaCombacia = attesa != null ? attesa === routeId : null;
    }

    /* L'orario alla fermata: la partenza, e l'occorrenza più vicina. */
    const mizarSec = v.aimedDeparture ? secondiLocali(v.aimedDeparture, timeZone)
      : v.aimedArrival ? secondiLocali(v.aimedArrival, timeZone) : null;
    const allaFermata = stopId ? righe.filter(r => r.stopId === stopId) : [];
    let scelta: RigaOrario | null = null;
    let scartoFermata: number | null = null;
    for (const r of allaFermata) {
      const s = secondiGtfs(r.scheduled);
      if (s == null) continue;
      const d = mizarSec != null ? scartoCircolare(mizarSec, s) : null;
      if (!scelta || (d != null && scartoFermata != null && Math.abs(d) < Math.abs(scartoFermata))) {
        scelta = r; scartoFermata = d;
      }
    }

    /* La partenza dal capolinea: prima riga della corsa nel feed. */
    const prima = righe.length ? righe.reduce((a, b) => (b.seq < a.seq ? b : a)) : null;
    const primaSec = prima ? secondiGtfs(prima.scheduled) : null;
    const scartoPartenza = v.originAimedDeparture && primaSec != null
      ? scartoCircolare(secondiLocali(v.originAimedDeparture, timeZone), primaSec) : null;

    return {
      mizar: {
        linea: v.lineRef, nomeLinea: v.publishedLineName, corsa: v.courseOfJourneyRef, percorso: v.destinationDisplay,
        partenza: fmt(v.originAimedDeparture, timeZone), capolineaPartenza: v.originName, capolineaArrivo: v.destinationName,
        arrivoProgrammato: fmt(v.aimedArrival, timeZone), partenzaProgrammata: fmt(v.aimedDeparture, timeZone),
        partenzaPrevista: fmt(v.expectedDeparture ?? v.expectedArrival, timeZone),
        statoPartenza: v.departureStatus ?? v.arrivalStatus,
        seguito: v.monitored, matricola: v.vehicleRef,
      },
      gtfs: {
        tripId, routeId, stopId,
        fermataAgganciataCome: fermata.how,
        orarioAllaFermata: scelta?.scheduled ?? null, progressivo: scelta?.seq ?? null,
        partenza: prima?.scheduled ?? null,
      },
      fuoriServizio: fuori,
      sostaAlCapolineaSec: sosta,
      corsaNelFeed: !!tripId,
      fermataNellaCorsa: !!scelta,
      lineaCombacia,
      scartoAllaFermataSec: scartoFermata,
      scartoAllaPartenzaSec: scartoPartenza,
    };
  });

  const scarti = confronti.map(c => c.scartoAllaFermataSec).filter((x): x is number => x != null);
  const scartiPartenza = confronti.map(c => c.scartoAllaPartenzaSec).filter((x): x is number => x != null);
  const riepilogo: ConfrontoFermata["riepilogo"] = {
    visiteGrezze: visiteGrezze.length,
    visite: confronti.length,
    fuoriServizio: confronti.filter(c => c.fuoriServizio).length,
    sosteAlCapolinea: confronti.filter(c => c.sostaAlCapolineaSec != null).length,
    seguite: confronti.filter(c => c.mizar.seguito).length,
    conPrevisione: confronti.filter(c => c.mizar.partenzaPrevista).length,
    corseNelFeed: confronti.filter(c => c.corsaNelFeed).length,
    fermataNellaCorsa: confronti.filter(c => c.fermataNellaCorsa).length,
    lineeCombaciano: confronti.filter(c => c.lineaCombacia === true).length,
    lineeDiverse: confronti.filter(c => c.lineaCombacia === false).length,
    orariIdentici: scarti.filter(s => s === 0).length,
    scartoMedianoSec: mediana(scarti.map(Math.abs)),
    scartoMassimoSec: scarti.length ? Math.max(...scarti.map(Math.abs)) : null,
    scartoPartenzaMedianoSec: mediana(scartiPartenza.map(Math.abs)),
    corseNonTrovate: [...nonTrovate].sort(),
  };

  return {
    fermata: {
      ref, nomeMizar, stopId, nomeFeed: stopId ? (index.stopNames.get(stopId) ?? null) : null,
      agganciataCome: fermata.how, conflitto: fermata.conflict,
    },
    visite: confronti,
    riepilogo,
    lettura: leggiConfronto(riepilogo, { ref, stopId, nomeMizar, nomeFeed: stopId ? (index.stopNames.get(stopId) ?? null) : null, come: fermata.how }),
  };
}

/* ── Quando i numeri di corsa non si trovano: dove sono finiti? ──────────
 * "0 corse su 22 nel feed" ha due spiegazioni opposte — il numero sta nel
 * trip_id ma in un'altra posizione, oppure quelle corse nel feed non ci
 * sono proprio — e si distinguono solo guardando il feed. La rotta fa le
 * due letture; qui si scrive la conclusione. */

export interface DiagnosiCorse {
  /** numero di Mizar → trip_id del feed che lo contengono in QUALUNQUE posizione */
  trovateAltrove: Record<string, string[]>;
  /** linea di Mizar → quante corse ha nel feed (null: linea non nel feed) */
  lineeNelFeed: Record<string, { routeId: string; corse: number } | null>;
  /** la fermata come sta nel feed, per vedere con che codice la chiama */
  fermataNelFeed?: { stopId: string; stopCode: string | null; stopName: string | null } | null;
}

/** Che cosa dice il feed della fermata agganciata: il suo stop_code è quello di Mizar? */
export function leggiFermataFeed(
  ref: string, f: DiagnosiCorse["fermataNelFeed"], come: "alias" | "id" | "code" | "name" | null,
): string[] {
  if (!f || come !== "name") return [];
  return [f.stopCode
    ? `Nel feed la fermata ${f.stopId} ha stop_code «${f.stopCode}», non ${ref}: i codici fermata di Mizar e del feed sono due numerazioni diverse, e l'aggancio per nome resta l'unico possibile.`
    : `Nel feed la fermata ${f.stopId} non ha stop_code: il feed non porta il codice con cui Mizar chiama le fermate, e l'aggancio per nome resta l'unico possibile.`];
}

export function leggiDiagnosi(d: DiagnosiCorse, nonTrovate: string[]): string[] {
  if (!nonTrovate.length) return [];
  const out: string[] = [];
  /* Tre casi diversi per i numeri che stanno nel feed: in coda al trip_id
   * ma ripetuti su più unità di programmazione (il numero non è univoco
   * sull'intero feed: serve il calendario del giorno); in coda e unici (non
   * dovrebbe succedere: allora è l'indice a non vederli); altrove. */
  const presenti = nonTrovate.filter(c => (d.trovateAltrove[c] ?? []).length > 0);
  const inCoda = presenti.filter(c => d.trovateAltrove[c].every(t => codiceCorsaDi(t) === c));
  const ripetuti = inCoda.filter(c => d.trovateAltrove[c].length > 1);
  const unici = inCoda.filter(c => d.trovateAltrove[c].length === 1);
  const altrove = presenti.filter(c => !inCoda.includes(c));
  if (ripetuti.length) {
    const es = ripetuti[0];
    const udp = d.trovateAltrove[es].map(t => /CodUdp:([^_]+)/.exec(t)?.[1] ?? t);
    out.push(`${ripetuti.length} dei ${nonTrovate.length} numeri mancanti stanno in coda al trip_id ma su più unità di programmazione (es. ${es} in ${udp.join(", ")}): sull'intero feed il numero non è univoco, serve il calendario del giorno per scegliere la corsa.`);
  }
  if (unici.length) {
    out.push(`${unici.length} numeri stanno in coda a un solo trip_id (es. ${unici[0]} in ${d.trovateAltrove[unici[0]][0]}) eppure l'indice non li ha agganciati: da verificare.`);
  }
  if (altrove.length) {
    const es = d.trovateAltrove[altrove[0]][0];
    out.push(`${altrove.length} numeri stanno nel feed ma NON in coda al trip_id (es. ${altrove[0]} in ${es}): la regola «ultimo segmento» non basta per queste corse.`);
  }
  const assenti = nonTrovate.filter(c => !(d.trovateAltrove[c] ?? []).length);
  if (assenti.length) {
    const linee = Object.entries(d.lineeNelFeed);
    const senzaLinea = linee.filter(([, v]) => v == null).map(([k]) => k);
    const conLinea = linee.filter(([, v]) => v != null).map(([k, v]) => `${k} (${v!.corse} corse)`);
    if (senzaLinea.length) out.push(`Le linee ${senzaLinea.join(", ")} nel feed non esistono: le loro corse non sono nell'esportazione.`);
    if (conLinea.length) out.push(`Le linee ${conLinea.join(", ")} nel feed ci sono, ma ${assenti.length} numeri di corsa non compaiono in nessun trip_id: l'orario di Mizar e il feed non sono la stessa versione per queste corse.`);
    if (!linee.length) out.push(`${assenti.length} numeri non compaiono in nessun trip_id del feed.`);
  }
  return out;
}

/** La conclusione in parole: che cosa combacia e che cosa no. */
export function leggiConfronto(
  r: ConfrontoFermata["riepilogo"],
  f: { ref: string; stopId: string | null; nomeMizar: string | null; nomeFeed: string | null; come?: "alias" | "id" | "code" | "name" | null },
): string[] {
  const out: string[] = [];
  if (!r.visite) { out.push(`Mizar non dà passaggi per la fermata ${f.ref} nell'intervallo chiesto.`); return out; }
  if (!f.stopId) {
    out.push(`La fermata ${f.ref} («${f.nomeMizar ?? "?"}») non esiste nel feed né per codice né per nome: i codici fermata di Mizar e del GTFS non sono gli stessi.`);
  } else {
    const come = f.come === "alias" ? "transcodifica delle paline"
      : f.come === "id" ? "stesso stop_id" : f.come === "code" ? `stop_code ${f.ref}`
      : "solo per nome: il codice di Mizar non è né stop_id né stop_code del feed, e manca nella transcodifica";
    out.push(`Fermata ${f.ref}: Mizar la chiama «${f.nomeMizar ?? "?"}», il feed «${f.nomeFeed ?? "?"}» (stop_id ${f.stopId}, agganciata per ${come}).`);
  }
  if (r.visiteGrezze !== r.visite || r.fuoriServizio) {
    const pezzi: string[] = [];
    if (r.visiteGrezze !== r.visite) pezzi.push(`${r.visiteGrezze} record uniti in ${r.visite} passaggi (arrivo e partenza al capolinea sono lo stesso passaggio)`);
    if (r.fuoriServizio) pezzi.push(`${r.fuoriServizio} movimenti fuori servizio, che nel feed non esistono per definizione`);
    out.push(pezzi.join("; ") + ".");
  }
  const diLinea = r.visite - r.fuoriServizio;
  if (diLinea > 0 && r.corseNelFeed === diLinea) {
    out.push(`Tutte le ${diLinea} corse di linea hanno il loro trip_id nel feed: il numero di corsa di Mizar è la chiave giusta.`);
  } else if (diLinea > 0) {
    out.push(`${r.corseNelFeed} corse di linea su ${diLinea} hanno il trip_id nel feed; mancano ${r.corseNonTrovate.length} numeri (${r.corseNonTrovate.slice(0, 5).join(", ")}${r.corseNonTrovate.length > 5 ? "…" : ""}): orario di Mizar e feed non sono la stessa versione, oppure sono corse fuori dall'esportazione.`);
  }
  if (r.sosteAlCapolinea) {
    out.push(`${r.sosteAlCapolinea} passaggi portano anche l'arrivo in sosta al capolinea prima della partenza: il feed non lo ha, il confronto usa la partenza.`);
  }
  if (r.corseNelFeed > 0) {
    if (r.fermataNellaCorsa === r.corseNelFeed) {
      out.push(`In tutte le corse agganciate il feed passa da questa fermata.`);
    } else {
      out.push(`In ${r.corseNelFeed - r.fermataNellaCorsa} corse agganciate il feed NON passa da questa fermata: percorso diverso o codice fermata diverso.`);
    }
  }
  if (r.fermataNellaCorsa > 0) {
    if (r.orariIdentici === r.fermataNellaCorsa) {
      out.push(`Gli orari alla fermata sono identici al secondo in tutte le ${r.fermataNellaCorsa} corse confrontabili.`);
    } else {
      out.push(`Orari alla fermata: identici in ${r.orariIdentici} corse su ${r.fermataNellaCorsa}; scarto mediano ${r.scartoMedianoSec} s, massimo ${r.scartoMassimoSec} s.`);
    }
  }
  if (r.lineeDiverse > 0) {
    out.push(`${r.lineeDiverse} corse hanno nel feed una linea diversa da quella che dice Mizar.`);
  }
  out.push(r.seguite
    ? `${r.seguite} passaggi su ${r.visite} vengono da mezzi seguiti dall'AVM, ${r.conPrevisione} con un orario previsto; gli altri sono orario puro.`
    : `Nessun passaggio viene da un mezzo seguito: sono tutti orario puro, senza previsione.`);
  return out;
}
