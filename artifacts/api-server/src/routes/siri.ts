/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIRI — configurazione, diagnostica e ingestione manuale
 * ───────────────────────────────────────────────────────────────────────────
 * Il collegamento a un AVM esterno si rompe quasi sempre sulle stesse tre
 * cose: rete che non passa, credenziali, e codifiche che non combaciano.
 * Questi endpoint servono a vederle SEPARATAMENTE, prima di scrivere un solo
 * record nel database:
 *
 *   GET  /api/siri/status   — la configurazione è completa? il servizio
 *                             risponde? che cosa permette (filtri, cicli)?
 *   GET  /api/siri/preview  — una richiesta vera, MA SENZA SCRIVERE NULLA:
 *                             quanti mezzi arrivano, quanti agganciano il
 *                             GTFS, e quali riferimenti restano orfani.
 *   POST /api/siri/sync     — un giro di ingestione su richiesta.
 *
 * L'anteprima è il pezzo che conta: dice subito se i riferimenti dell'AVM
 * corrispondono agli id del feed o se serve una tabella di corrispondenza,
 * senza sporcare le tabelle di esercizio con dati mal agganciati.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import {
  buildCheckStatusRequest, buildGetCapabilitiesRequest, postSoap,
  parseCapabilities, parseXml, textOf, findFirst, fetchVehicleMonitoring,
  mapVehicles, describeCompleteness, mostInformative, extractSampleActivity,
  type SiriEndpointConfig, type VehicleCompleteness, type MappingReport,
} from "../lib/siri-vm";
import { loadGtfsIndex, ingestVehicles, closeCancelled } from "../lib/siri-ingest";

const router: IRouter = Router();

/** Configurazione da ambiente. Assente = connettore spento, non un errore. */
export function siriConfig(): SiriEndpointConfig | null {
  const url = process.env.SIRI_VM_URL;
  if (!url) return null;
  return {
    url,
    requestorRef: process.env.SIRI_REQUESTOR_REF || "TransitIntel",
    soapAction: process.env.SIRI_SOAP_ACTION || undefined,
    username: process.env.SIRI_USERNAME || null,
    password: process.env.SIRI_PASSWORD || null,
    timeoutMs: Number(process.env.SIRI_TIMEOUT_MS) || 20_000,
  };
}
export function siriDetailLevel(): "minimum" | "basic" | "normal" | "calls" | "full" {
  const v = (process.env.SIRI_DETAIL_LEVEL || "calls").toLowerCase();
  return (["minimum", "basic", "normal", "calls", "full"] as const).includes(v as any)
    ? (v as any) : "calls";
}

const NOT_CONFIGURED = {
  configured: false,
  hint: "Imposta SIRI_VM_URL (e SIRI_REQUESTOR_REF, se il produttore assegna un codice consumatore) "
    + "per attivare il connettore. Facoltative: SIRI_USERNAME/SIRI_PASSWORD, SIRI_SOAP_ACTION, "
    + "SIRI_DETAIL_LEVEL (default 'calls': senza, l'AVM non manda i transiti alle fermate), "
    + "SIRI_POLL_SECONDS (default 30).",
};

/* ── Stato del collegamento ───────────────────────────────────────────────── */

router.get("/siri/status", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  const out: any = {
    configured: true,
    url: cfg.url,
    requestorRef: cfg.requestorRef,
    authentication: cfg.username ? "basic" : "nessuna",
    detailLevel: siriDetailLevel(),
    pollSeconds: Number(process.env.SIRI_POLL_SECONDS) || 30,
  };

  try {
    const chk = await postSoap(cfg, "CheckStatus", buildCheckStatusRequest(cfg.requestorRef));
    const doc = parseXml(chk.xml);
    const fault = findFirst(doc, "Fault");
    out.checkStatus = {
      httpStatus: chk.status,
      alive: !fault && (textOf(doc, "Status") ?? "").toLowerCase() !== "false",
      serviceStartedTime: textOf(doc, "ServiceStartedTime"),
      fault: fault ? (textOf(fault, "faultstring") ?? "SOAP Fault") : null,
    };
  } catch (e: any) {
    out.checkStatus = { alive: false, error: e?.message ?? "irraggiungibile" };
  }

  try {
    const cap = await postSoap(cfg, "GetCapabilities", buildGetCapabilitiesRequest(cfg.requestorRef));
    out.capabilities = parseCapabilities(cap.xml);
    /* Il dettaglio "calls" è ciò che porta i transiti alle fermate: senza,
     * si possono alimentare solo posizioni e corse attive. Attenzione a non
     * scambiare "non dichiarato" per "disponibile": se il produttore non
     * risponde a GetCapabilities restano tutti null, e l'unica prova di che
     * cosa manda davvero è il conteggio nell'anteprima. */
    const known = Object.values(out.capabilities).some(v => v !== null && v !== undefined);
    out.capabilities.notaTransiti = !known
      ? "Il produttore non ha risposto a GetCapabilities (o in una forma non riconosciuta): "
        + "non dichiara nulla. Guarda 'completezza' in /api/siri/preview per sapere che cosa manda davvero."
      : out.capabilities.hasPreviousCalls === false
        ? "Il produttore dichiara di NON fornire le fermate già transitate: puntualità e tempi di percorrenza resteranno senza dati."
        : "Fermate transitate dichiarate disponibili.";
    if (req.query.raw === "1") out.capabilities.xmlGrezzo = cap.xml.slice(0, 4000);
  } catch (e: any) {
    out.capabilities = { error: e?.message ?? "non disponibili" };
  }

  const index = await loadGtfsIndex();
  out.feedGtfs = index
    ? { feedId: index.feedId, corse: index.trips.size, linee: index.routes.size, fermate: index.stops.size }
    : { error: "nessun feed GTFS attivo: senza, i riferimenti dell'AVM non sono agganciabili" };

  res.json(out);
});

/* ── Lettura in chiaro di che cosa è alimentabile ─────────────────────────
 * Tre livelli distinti, perché falliscono per ragioni diverse: la mappa live
 * vuole solo la posizione; le corse attive vogliono il riferimento di corsa;
 * puntualità e tempi di percorrenza vogliono gli orari EFFETTIVI alle
 * fermate. Un flusso può bastare al primo e non al terzo. */
function diagnose(c: VehicleCompleteness, m?: MappingReport): string[] {
  const out: string[] = [];

  if (c.conPosizione === 0) {
    out.push("Nessun mezzo con posizione: non è alimentabile nemmeno la mappa live.");
  } else {
    out.push(`Mappa live alimentabile: ${c.conPosizione} mezzi su ${c.totale} con posizione.`);
  }

  if (c.conCorsa === 0) {
    out.push("L'AVM NON manda il riferimento di corsa (DatedVehicleJourneyRef) per nessun mezzo: "
      + "le corse in servizio non sono ricostruibili e i transiti non sono attribuibili a una corsa. "
      + "È il blocco principale.");
  } else if (m && m.tripMatched === 0) {
    out.push(`Riferimenti di corsa presenti su ${c.conCorsa} mezzi ma NESSUNO aggancia il feed, `
      + "né per identificativo né per linea+ora di partenza: senza corsa i transiti non "
      + "sono attribuibili.");
  } else if (m) {
    const modi: string[] = [];
    if (m.tripMatchedById) modi.push(`${m.tripMatchedById} per identificativo`);
    if (m.tripMatchedBySchedule) modi.push(`${m.tripMatchedBySchedule} per linea+ora di partenza`);
    out.push(`Corse agganciate: ${m.tripMatched} su ${c.conCorsa}`
      + (modi.length ? ` (${modi.join(", ")})` : "")
      + (m.tripAmbiguous ? ` — ${m.tripAmbiguous} ambigue: più corse partono a quell'ora sulla stessa linea.` : "."));
  }

  if (c.conOrarioEffettivo === 0) {
    out.push("Nessun orario EFFETTIVO alle fermate (né PreviousCalls né ActualArrival/Departure): "
      + "puntualità e tempi di percorrenza restano senza dati. "
      + (c.conFermataCorrente > 0
        ? "La fermata corrente però arriva: il produttore manda la posizione nel percorso, non la storia dei transiti."
        : "Non arriva nemmeno la fermata corrente."));
  } else {
    out.push(`Transiti reali disponibili su ${c.conOrarioEffettivo} mezzi: `
      + "puntualità e tempi di percorrenza alimentabili.");
  }

  if (c.conLinea > 0 && m && m.routeMatched < c.conLinea) {
    out.push(`Linee: ${m.routeMatched} agganciate su ${c.conLinea} dichiarate `
      + "— il resto usa una numerazione diversa da quella del feed.");
  }
  if (c.conRitardo > 0) out.push(`Ritardo dichiarato dall'AVM su ${c.conRitardo} mezzi.`);
  if (c.conTurnoVettura > 0) out.push(`Turno vettura (BlockRef) su ${c.conTurnoVettura} mezzi.`);

  return out;
}

/* ── Anteprima: legge, non scrive ─────────────────────────────────────────── */

router.get("/siri/preview", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  try {
    const lineRef = (req.query.lineRef as string | undefined)?.trim() || null;
    const maximumVehicles = Number(req.query.max) || null;
    const result = await fetchVehicleMonitoring(cfg, {
      detailLevel: siriDetailLevel(), lineRef, maximumVehicles,
    });

    const index = await loadGtfsIndex();
    const mapping = index ? mapVehicles(result.vehicles, index) : null;
    const completezza = describeCompleteness(result.vehicles);

    /* Il campione va preso sui mezzi IN SERVIZIO: prendendo i primi si
     * finisce sulle vetture in deposito, che non hanno corsa né fermate, e
     * si conclude erroneamente che l'AVM non mandi nulla. */
    const campione = mostInformative(result.vehicles, 5).map(v => ({
      mezzo: v.vehicleRef,
      linea: v.lineRef,
      lineaPubblicata: v.publishedLineName,
      corsa: v.journeyRef,
      corsaDa: v.datedVehicleJourneyRef ? "FramedVehicleJourneyRef" : v.courseOfJourneyRef ? "CourseOfJourneyRef" : null,
      percorso: v.routeRef,
      dataServizio: v.dataFrameRef,
      partenzaProgrammata: v.originAimedDeparture,
      arrivoProgrammato: v.destinationAimedArrival,
      destinazione: v.destinationName,
      posizione: v.lat != null ? [v.lat, v.lon] : null,
      ritardoSec: v.delaySeconds,
      turnoVettura: v.blockRef,
      inCoda: v.inCongestion,
      occupazione: v.occupancy,
      fermataCorrente: v.monitoredCall?.stopPointRef ?? null,
      fermateTransitate: v.previousCalls.length,
      fermateFuture: v.onwardCalls.length,
    }));

    res.json({
      configured: true,
      httpStatus: result.httpStatus,
      failed: result.failed,
      errorText: result.errorText,
      responseTimestamp: result.responseTimestamp,
      shortestPossibleCycleSec: result.shortestPossibleCycleSec,
      mezzi: result.vehicles.length,
      corseAnnullate: result.cancellations.length,
      /* Che cosa il produttore riempie davvero, campo per campo. */
      completezza,
      diagnosi: diagnose(completezza, mapping?.report),
      corrispondenze: mapping?.report ?? { nota: "nessun feed GTFS attivo" },
      /* Se l'indice non è filtrato per il giorno, OGNI aggancio risulta
       * ambiguo: la stessa corsa esiste in ogni validità. */
      indiceCorse: index?.tripStarts ? {
        corseCircolantiOggi: index.tripStarts.trips,
        giornoDiServizio: index.tripStarts.serviceDay ?? null,
        filtratoPerCalendario: index.tripStarts.calendarFiltered ?? null,
        nota: index.tripStarts.calendarFiltered === false
          ? "Il calendario del feed non dice quali corse circolano oggi: l'indice contiene TUTTE "
            + "le validità, quindi linea+ora individuano più corse e ogni aggancio è ambiguo."
          : undefined,
      } : undefined,
      /* Gli id VERI del feed, accanto ai riferimenti orfani dell'AVM: senza
       * vedere le due codifiche affiancate non si può disegnare la
       * corrispondenza (numeri di linea? codici interni? uuid?). */
      esempiFeed: index ? {
        /* Tutte le linee del feed: con 19 linee orfane serve poter cercare
         * a occhio se quel numero nel feed esiste o no. */
        linee: [...index.routes].sort(),
        fermate: [...index.stops].slice(0, 10),
        corse: [...index.trips].slice(0, 5),
      } : undefined,
      campione,
      /* ?raw=1 ritaglia UNA VehicleActivity dal grezzo: è l'unico modo di
       * vedere i nomi veri degli elementi quando manca ciò che ci si aspetta. */
      xmlEsempio: (req.query.raw === "1")
        ? extractSampleActivity(result.rawXml, String(req.query.marker ?? "LineRef"))
        : undefined,
    });
  } catch (e: any) {
    res.status(502).json({ configured: true, error: e?.message ?? "richiesta fallita" });
  }
});

/* ── Ingestione su richiesta ──────────────────────────────────────────────── */

router.post("/siri/sync", async (_req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.status(400).json(NOT_CONFIGURED); return; }
  try {
    const result = await runSiriIngest();
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message ?? "sync fallita" });
  }
});

/** Un giro completo: interroga l'AVM e scrive nelle tabelle di esercizio. */
export async function runSiriIngest(): Promise<Record<string, unknown>> {
  const cfg = siriConfig();
  if (!cfg) return { skipped: "SIRI_VM_URL non impostata" };

  const result = await fetchVehicleMonitoring(cfg, { detailLevel: siriDetailLevel() });
  if (result.failed) {
    return {
      failed: true, errorText: result.errorText, httpStatus: result.httpStatus,
      mezzi: 0,
    };
  }
  const ingest = await ingestVehicles(result.vehicles);
  const cancelled = await closeCancelled(result.cancellations);
  return {
    mezzi: result.vehicles.length,
    posizioniInserite: ingest.positionsInserted,
    corseAperte: ingest.tripsOpened,
    corseChiuse: ingest.tripsClosed + cancelled,
    transitiInseriti: ingest.transitsInserted,
    corrispondenze: ingest.report,
  };
}

export default router;
