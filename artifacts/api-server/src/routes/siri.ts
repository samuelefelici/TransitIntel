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
  mapVehicles, type SiriEndpointConfig,
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

router.get("/siri/status", async (_req, res): Promise<void> => {
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
     * si possono alimentare solo posizioni e corse attive. */
    out.capabilities.notaTransiti = out.capabilities.hasPreviousCalls === false
      ? "Il produttore dichiara di NON fornire le fermate già transitate: puntualità e tempi di percorrenza resteranno senza dati."
      : "Fermate transitate disponibili: puntualità e tempi di percorrenza alimentabili.";
  } catch (e: any) {
    out.capabilities = { error: e?.message ?? "non disponibili" };
  }

  const index = await loadGtfsIndex();
  out.feedGtfs = index
    ? { feedId: index.feedId, corse: index.trips.size, linee: index.routes.size, fermate: index.stops.size }
    : { error: "nessun feed GTFS attivo: senza, i riferimenti dell'AVM non sono agganciabili" };

  res.json(out);
});

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

    res.json({
      configured: true,
      httpStatus: result.httpStatus,
      failed: result.failed,
      errorText: result.errorText,
      responseTimestamp: result.responseTimestamp,
      shortestPossibleCycleSec: result.shortestPossibleCycleSec,
      mezzi: result.vehicles.length,
      corseAnnullate: result.cancellations.length,
      corrispondenze: mapping?.report ?? { nota: "nessun feed GTFS attivo" },
      /* Un campione leggibile: serve a riconoscere la codifica a occhio. */
      campione: result.vehicles.slice(0, 5).map(v => ({
        mezzo: v.vehicleRef,
        linea: v.lineRef,
        lineaPubblicata: v.publishedLineName,
        corsa: v.datedVehicleJourneyRef,
        dataServizio: v.dataFrameRef,
        posizione: v.lat != null ? [v.lat, v.lon] : null,
        ritardoSec: v.delaySeconds,
        turnoVettura: v.blockRef,
        inCoda: v.inCongestion,
        occupazione: v.occupancy,
        fermataCorrente: v.monitoredCall?.stopPointRef ?? null,
        fermateTransitate: v.previousCalls.length,
        fermateFuture: v.onwardCalls.length,
      })),
      xmlTroncato: (req.query.raw === "1") ? result.rawSample : undefined,
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
