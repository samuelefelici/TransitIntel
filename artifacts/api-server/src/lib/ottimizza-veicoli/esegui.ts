/**
 * Il calcolo dei turni macchina e del VCSP: dalla richiesta all'ingresso di
 * Python, e dall'uscita di Python alla risposta. Senza Express e senza DDL:
 * lo usano le rotte (con LAVORI_VEICOLI_IN_CODA=0) e il lavoratore dei calcoli.
 */
import { db } from "@workspace/db";
import { gtfsStops, gtfsStopTimes, depots } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { timeToMinutes, haversineKm } from "../geo-utils";
import { eseguiPython, jsonDallUscita, descriviUscita, type ScriptConsentito } from "../lavori/python";
import type { Advisory, TripBlock, VehicleShift } from "./modello";

export function buildPyTrips(tripBlocks: TripBlock[]) {
  return tripBlocks.map(t => ({
    tripId: t.tripId,
    routeId: t.routeId,
    routeName: t.routeName,
    headsign: t.headsign,
    directionId: t.directionId,
    departureTime: t.departureTime,
    arrivalTime: t.arrivalTime,
    departureMin: t.departureMin,
    arrivalMin: t.arrivalMin,
    firstStopId: t.firstStopId,
    lastStopId: t.lastStopId,
    firstStopLat: t.firstStopLat,
    firstStopLon: t.firstStopLon,
    lastStopLat: t.lastStopLat,
    lastStopLon: t.lastStopLon,
    firstStopName: t.firstStopName,
    lastStopName: t.lastStopName,
    stopCount: t.stopCount,
    requiredVehicle: t.requiredVehicle,
    variantCode: t.variantCode ?? undefined,
    category: t.category,
    forced: t.forced,
    onDemand: t.onDemand,
    // finestra di flessibilità dichiarata in Planning: la sonda di spostamento
    // del VCSP (cervello P↔TM↔TG) la userà per proporre traslazioni ±flexMin
    flexMin: t.flexMin ?? 0,
  }));
}

/**
 * I PASSAGGI IN TRANSITO sui capolinea ALTRUI, per corsa.
 *
 * La coincidenza fra due linee non si fa solo al capolinea. Alla Madonnetta la
 * 2/6 arriva al suo capolinea e la 21/33 ci transita cinque minuti dopo, senza
 * fermarsi: per il passeggero e' una coincidenza, e nel quadro festivo di
 * Ancona e' costruita a mano sulle quattro corse della giornata. Guardando solo
 * la prima e l'ultima fermata di ogni corsa quella coincidenza e' invisibile, e
 * la sonda di spostamento del VCSP puo' romperla senza accorgersene.
 *
 * Si portano SOLO i passaggi su fermate che sono capolinea di qualche corsa: e'
 * li' che una linea di passaggio incontra chi si ferma. Gli altri transiti sono
 * il corridoio che due linee percorrono insieme — decine di incontri, nessuna
 * coincidenza da difendere.
 */
export async function loadTerminalTransits(
  feedId: string,
  blocks: Array<Pick<TripBlock, "tripId" | "firstStopId" | "lastStopId">>,
  logger?: { info: (...a: any[]) => void },
): Promise<Record<string, Array<{ stopName: string; arrivalMin: number; departureMin: number }>>> {
  const out: Record<string, Array<{ stopName: string; arrivalMin: number; departureMin: number }>> = {};
  if (blocks.length === 0) return out;

  const terminals = new Set<string>();
  const own = new Map<string, [string, string]>();
  for (const b of blocks) {
    if (b.firstStopId) terminals.add(b.firstStopId);
    if (b.lastStopId) terminals.add(b.lastStopId);
    own.set(b.tripId, [b.firstStopId, b.lastStopId]);
  }
  if (terminals.size === 0) return out;

  const stopRows = await db.select({ stopId: gtfsStops.stopId, stopName: gtfsStops.stopName })
    .from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
  const nameOf = new Map<string, string>();
  for (const s of stopRows) nameOf.set(s.stopId, s.stopName || s.stopId);

  const ids = blocks.map(b => b.tripId);
  const BATCH = 500;
  let n = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const rows = await db.select({
      tripId: gtfsStopTimes.tripId,
      stopId: gtfsStopTimes.stopId,
      arrivalTime: gtfsStopTimes.arrivalTime,
      departureTime: gtfsStopTimes.departureTime,
    }).from(gtfsStopTimes)
      .where(and(eq(gtfsStopTimes.feedId, feedId), inArray(gtfsStopTimes.tripId, ids.slice(i, i + BATCH))));

    for (const r of rows) {
      if (!terminals.has(r.stopId)) continue;
      const o = own.get(r.tripId);
      if (!o || r.stopId === o[0] || r.stopId === o[1]) continue;  // il proprio capolinea non è un transito
      const a = r.arrivalTime || r.departureTime;
      const d = r.departureTime || r.arrivalTime;
      if (!a || !d) continue;
      (out[r.tripId] ??= []).push({
        stopName: nameOf.get(r.stopId) || r.stopId,
        arrivalMin: timeToMinutes(a),
        departureMin: timeToMinutes(d),
      });
      n++;
    }
  }
  for (const v of Object.values(out)) v.sort((x, y) => x.arrivalMin - y.arrivalMin);
  logger?.info(`loadTerminalTransits: ${n} passaggi su ${terminals.size} capolinea, ${Object.keys(out).length}/${ids.length} corse`);
  return out;
}

/** Uno script Python (JSON stdin → JSON stdout), dal lanciatore unico (lib/lavori/python.ts).
 *  Le righe di stderr vanno nel log una per una: agentJobLogger ci legge il PROGRESS. */
export async function spawnPythonJson(
  scriptName: ScriptConsentito,
  argv: string[],
  input: unknown,
  logger: { info: (...a: any[]) => void; error?: (...a: any[]) => void },
  label: string,
): Promise<any> {
  const esito = await eseguiPython({
    script: scriptName, argv, ingresso: input,
    // nessun limite prima della coda dei lavori: si tiene largo (VCSP «normal» ~17 min, giri fino a 30)
    timeoutMs: 2 * 60 * 60 * 1000,
    suRigaStderr: (r) => logger.info(`${label} stderr: ${r}`),
  });
  if (esito.motivo === "avvio") throw new Error(`Errore avvio Python: ${esito.erroreAvvio}`);
  if (esito.motivo !== "uscito" || esito.codice !== 0) {
    throw new Error(`${descriviUscita(esito)}: ${esito.stderrCoda.slice(-1500)}`);
  }
  const j = jsonDallUscita(esito);
  if (!j.ok) throw new Error(`parse ${label}: ${j.errore}`);
  return j.valore;
}

export async function runCPSATVehicleScheduler(
  tripBlocks: TripBlock[],
  timeLimitSec: number,
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  extraConfig?: Record<string, any>,
  routeDetails?: { routeId: string; routeName: string }[],
  psClusters?: { id: string; name: string; kind: string; stopIds: string[] }[],
  depotsForPy?: { id: string; name: string; color: string; lat: number; lon: number; maxVehicles: number | null; fleet?: Record<string, number> }[],
  deadheadKm?: Record<string, number>,
  deadheadMin?: Record<string, number>,
  deadheadArchive?: Record<string, any>,
  lockedChains?: { vehicleId?: string; tripIds: string[] }[],
): Promise<any> {
  return spawnPythonJson("vehicle_scheduler_cpsat.py", [String(timeLimitSec)], {
    trips: buildPyTrips(tripBlocks),
    config: {
      timeLimit: timeLimitSec,
      ...extraConfig,
    },
    routeDetails: routeDetails || [],
    psClusters: psClusters || [],
    // Multi-deposito: domiciliazione + cap vetture per deposito (vincolo hard)
    ...(depotsForPy && depotsForPy.length > 0 ? { depots: depotsForPy } : {}),
    // Matrice fuorilinea (km stradali reali, OSRM/fallback) per archi e tratte deposito
    ...(deadheadKm && Object.keys(deadheadKm).length > 0 ? { deadheadKm } : {}),
    // Override tempi curati a mano (Archi Fuorilinea, custom_min)
    ...(deadheadMin && Object.keys(deadheadMin).length > 0 ? { deadheadMin } : {}),
    // Restrizione all'archivio «Archi fuorilinea» (traccia per log e relazione)
    ...(deadheadArchive ? { deadheadArchive } : {}),
    // Il lucchetto: turni bloccati dall'operatore, vincoli duri per il solver
    ...(lockedChains && lockedChains.length > 0 ? { lockedChains } : {}),
  }, logger, "VSP");
}

/** Orchestratore VCSP (loop VSP→CSP→costi-ombra→re-VSP in un unico processo). */
export async function runVcspOrchestrator(
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  input: unknown,
): Promise<any> {
  return spawnPythonJson("vcsp_orchestrator.py", [], input, logger, "VCSP");
}

export type DepotPoint = { id: string; name: string; color: string; lat: number; lon: number };

/** Depositi candidati per il solving. Scope PS14: i depositi legati a un
 * progetto Planner Studio valgono SOLO per i giri di quel progetto — senza
 * filtro, un run senza selezione esplicita pescherebbe i depositi
 * sperimentali di altri progetti come residenze candidate. */
export async function loadDepotPoints(schedProjectId?: string | null): Promise<DepotPoint[]> {
  try {
    const rows = await db.select().from(depots);
    const scope = new Map<string, string | null>();
    try {
      const r = await db.execute<any>(sql`SELECT id, ps_project_id FROM depots`);
      for (const x of (r as any).rows ?? []) scope.set(x.id, x.ps_project_id ?? null);
    } catch { /* colonna assente su DB legacy: tutti globali */ }
    let psProj: string | null = null;
    if (schedProjectId && /^[0-9a-f-]{36}$/i.test(schedProjectId)) {
      try {
        const pr = await db.execute<any>(sql`SELECT planning_studio_project_id FROM scheduling_projects WHERE id = ${schedProjectId}::uuid`);
        psProj = (pr.rows?.[0]?.planning_studio_project_id as string | undefined) ?? null;
      } catch { /* tabella assente */ }
    }
    return rows
      .filter((d: any) => d.lat != null && d.lon != null)
      .filter((d: any) => { const sc = scope.get(d.id) ?? null; return sc == null || sc === psProj; })
      .map((d: any) => ({ id: d.id, name: d.name, color: d.color || "#3b82f6", lat: Number(d.lat), lon: Number(d.lon) }));
  } catch { return []; }
}

export function nearestDepot(lat: number | null | undefined, lon: number | null | undefined, dps: DepotPoint[]): DepotPoint | null {
  if (lat == null || lon == null || dps.length === 0) return null;
  let best: DepotPoint | null = null;
  let bestD = Infinity;
  for (const d of dps) {
    const km = haversineKm(lat, lon, d.lat, d.lon);
    if (km < bestD) { bestD = km; best = d; }
  }
  return best;
}

/**
 * Assegna a ogni turno macchina la RESIDENZA DI SERVIZIO (deposito), in base alla
 * geografia: deposito di uscita = il più vicino alla prima fermata del turno,
 * deposito di rientro = il più vicino all'ultima. In servizio mono-deposito tutti
 * i turni ricadono sullo stesso; in multi-deposito (extraurbano) ognuno prende il
 * proprio. È il legame deposito→turno che il roster usa per la colorazione.
 */
export function assignResidenzaToShifts(
  shifts: VehicleShift[],
  tripBlocks: TripBlock[],
  dps: DepotPoint[],
  caps?: Map<string, number>,
): Map<string, number> {
  // counts = veicoli assegnati per deposito (residenza). Ritornato per l'advisory capacità.
  const counts = new Map<string, number>();
  if (dps.length === 0) return counts;
  const coord = new Map<string, { fLat: number; fLon: number; lLat: number; lLon: number }>();
  for (const t of tripBlocks) {
    coord.set(t.tripId, { fLat: t.firstStopLat, fLon: t.firstStopLon, lLat: t.lastStopLat, lLon: t.lastStopLon });
  }
  // Cap morbido: preferisci il deposito più vicino tra quelli NON ancora pieni;
  // se sono tutti pieni, ricadi sul più vicino in assoluto (overflow consentito).
  const pickOut = (lat: number, lon: number): DepotPoint | null => {
    if (caps && caps.size > 0) {
      const avail = dps.filter(d => (counts.get(d.id) ?? 0) < (caps.get(d.id) ?? Infinity));
      return nearestDepot(lat, lon, avail.length > 0 ? avail : dps);
    }
    return nearestDepot(lat, lon, dps);
  };
  for (const s of shifts) {
    const tripEntries = s.trips.filter((t) => t.type === "trip" && coord.has(t.tripId));
    if (tripEntries.length === 0) { s.depotOut = null; s.depotIn = null; s.residenzaDepotId = null; continue; }
    const first = coord.get(tripEntries[0].tripId)!;
    const last = coord.get(tripEntries[tripEntries.length - 1].tripId)!;
    const dOut = pickOut(first.fLat, first.fLon);
    const dIn = nearestDepot(last.lLat, last.lLon, dps);
    s.depotOut = dOut ? { id: dOut.id, name: dOut.name, color: dOut.color } : null;
    s.depotIn = dIn ? { id: dIn.id, name: dIn.name, color: dIn.color } : null;
    const res = dOut || dIn;
    s.residenzaDepotId = res?.id ?? null;
    s.residenzaName = res?.name ?? null;
    s.residenzaColor = res?.color ?? null;
    if (res) counts.set(res.id, (counts.get(res.id) ?? 0) + 1);
  }
  return counts;
}

/** Selezione depositi dall'input ottimizzatore: ids consentiti + capacità (max
 *  veicoli totali e, opzionale, flotta per TIPOLOGIA di veicolo). */
export function parseDepotSelection(raw: any): { ids: Set<string>; caps: Map<string, number>; fleets: Map<string, Record<string, number>> } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = new Set<string>();
  const caps = new Map<string, number>();
  const fleets = new Map<string, Record<string, number>>();
  for (const d of raw) {
    if (d && typeof d.id === "string" && /^[0-9a-f-]{36}$/i.test(d.id)) {
      ids.add(d.id);
      const mv = Number(d.maxVehicles);
      if (Number.isFinite(mv) && mv > 0) caps.set(d.id, mv);
      // flotta per tipologia: { "12m": 10, "autosnodato": 3, ... }
      if (d.fleet && typeof d.fleet === "object" && !Array.isArray(d.fleet)) {
        const clean: Record<string, number> = {};
        for (const [vt, n] of Object.entries(d.fleet)) {
          const num = Number(n);
          if (typeof vt === "string" && vt.length <= 20 && Number.isFinite(num) && num >= 0) clean[vt] = Math.floor(num);
        }
        if (Object.keys(clean).length > 0) fleets.set(d.id, clean);
      }
    }
  }
  return ids.size > 0 ? { ids, caps, fleets } : null;
}

/** Advisory "cap morbido": segnala i depositi che superano la capacità indicata. */
export function depotCapacityAdvisory(counts: Map<string, number>, caps: Map<string, number>, points: DepotPoint[]): Advisory | null {
  const over: string[] = [];
  let maxOver = 0;
  for (const [id, cap] of caps) {
    const used = counts.get(id) ?? 0;
    if (used > cap) {
      const nm = points.find(p => p.id === id)?.name ?? "deposito";
      over.push(`${nm} ${used}/${cap}`);
      maxOver = Math.max(maxOver, used - cap);
    }
  }
  if (over.length === 0) return null;
  return {
    id: "depot-capacity",
    severity: "warning",
    category: "fleet",
    title: "Capacità deposito superata",
    description: `Alcuni depositi hanno più veicoli della capacità indicata: ${over.join(", ")}.`,
    impact: `${maxOver} veicol${maxOver === 1 ? "o" : "i"} oltre capacità`,
    action: "Aumenta la capacità del deposito, aggiungine un altro o riduci le linee in questo scenario.",
    metric: maxOver,
  };
}
