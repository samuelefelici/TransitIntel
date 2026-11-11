/**
 * Il calcolo dei turni macchina e del VCSP: dalla richiesta all'ingresso di
 * Python, e dall'uscita di Python alla risposta. Senza Express e senza DDL:
 * lo usano le rotte (con LAVORI_VEICOLI_IN_CODA=0) e il lavoratore dei calcoli.
 */
import { db } from "@workspace/db";
import { gtfsTrips, gtfsRoutes, gtfsStops, gtfsStopTimes, depots } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { timeToMinutes, haversineKm } from "../geo-utils";
import { buildDeadheadKmMatrix, dhKey, type DHNode } from "../deadhead-matrix";
import {
  enrichTripsWithClusterStops, loadClustersForPython, loadCompanyCars, loadRestPointsForScenario,
} from "../dati-solver";
import { eseguiPython, jsonDallUscita, descriviUscita, type Progresso, type ScriptConsentito } from "../lavori/python";
import {
  type Advisory, type TripBlock, type VehicleShift, type VehicleType,
  VEHICLE_SIZE, getServiceCategory, getActiveServiceIds, calculateCosts, calculateScore, generateAdvisories,
} from "./modello";

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

/** Stop, tempo massimo e avanzamento di un calcolo (dal lavoro in coda). */
export interface OpzioniPython {
  /** abort = stop richiesto: SIGINT, poi SIGKILL */
  segnale?: AbortSignal;
  /** istante (ms) oltre il quale il processo si ferma; senza, 2 ore */
  scadenza?: number;
  /** le righe PROGRESS| (allora non vanno più nel log) */
  suProgresso?: (p: Progresso) => void;
}

/** Il calcolo non è finito da solo: fermato da chi l'ha lanciato, o oltre il tempo massimo. */
export class CalcoloInterrotto extends Error {
  constructor(readonly motivo: "fermato" | "scaduto", messaggio: string) { super(messaggio); }
}

/** Uno script Python (JSON stdin → JSON stdout), dal lanciatore unico (lib/lavori/python.ts).
 *  Le altre righe di stderr vanno nel log una per una. */
export async function spawnPythonJson(
  scriptName: ScriptConsentito,
  argv: string[],
  input: unknown,
  logger: { info: (...a: any[]) => void; error?: (...a: any[]) => void },
  label: string,
  opz: OpzioniPython = {},
): Promise<any> {
  const esito = await eseguiPython({
    script: scriptName, argv, ingresso: input,
    // dentro l'API senza scadenza si tiene largo (VCSP «normal» ~17 min, giri fino a 30);
    // nel lavoratore vale il tempo massimo del lavoro
    timeoutMs: opz.scadenza != null ? Math.max(1_000, opz.scadenza - Date.now()) : 2 * 60 * 60 * 1000,
    segnale: opz.segnale,
    suProgresso: opz.suProgresso,
    suRigaStderr: (r) => logger.info(`${label} stderr: ${r}`),
  });
  if (esito.motivo === "avvio") throw new Error(`Errore avvio Python: ${esito.erroreAvvio}`);
  if (esito.motivo === "fermato") throw new CalcoloInterrotto("fermato", "Calcolo fermato");
  if (esito.motivo === "timeout" && opz.scadenza != null) throw new CalcoloInterrotto("scaduto", "Tempo massimo superato");
  if (esito.motivo === "uscito" && esito.segnaleUscita === "SIGKILL") {
    // nessuno di noi l'ha chiesto: di solito è il limite di memoria del container (OOM killer)
    throw new Error(`Calcolo ucciso dal sistema (SIGKILL), probabilmente per memoria esaurita: ${esito.stderrCoda.slice(-500)}`);
  }
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
  opz?: OpzioniPython,
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
  }, logger, "VSP", opz);
}

/** Orchestratore VCSP (loop VSP→CSP→costi-ombra→re-VSP in un unico processo). */
export async function runVcspOrchestrator(
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  input: unknown,
  opz?: OpzioniPython,
): Promise<any> {
  return spawnPythonJson("vcsp_orchestrator.py", [], input, logger, "VCSP", opz);
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

export type ModoVeicoli = "cpsat" | "vcsp";
type LogCalcolo = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

export interface OpzioniOttimizzazione {
  mode: ModoVeicoli;
  /** il feed, già risolto e controllato da chi lancia (getLatestFeedId nella rotta) */
  feedId: string;
  log: LogCalcolo;
  segnale?: AbortSignal;
  /** l'avanzamento della fase principale (VSP per i turni macchina, VCSP per il VCSP) */
  progresso?: (p: Progresso) => void;
  /** istante (ms) del tempo massimo */
  scadenza?: number;
}

/** La risposta HTTP che il calcolo produce: codice e corpo, come li dava la rotta. */
export interface EsitoOttimizzazione {
  codice: number;
  corpo: any;
  /** il calcolo non è finito da solo */
  motivo?: "fermato" | "scaduto";
}

/** INVARIANTE: non si ottimizza senza progetto Planner Studio.
 *  Lo Scheduling Engine lavora solo su feed materializzati dal PS, e tutto il
 *  dato condiviso (nodi, depositi, archi, zone) è scopato su quel progetto.
 *  Senza, il giro proseguirebbe in silenzio sui soli dati globali: un
 *  risultato plausibile ma costruito su un'altra rete. Meglio un errore
 *  parlante che una soluzione sbagliata. */
const SENZA_PROGETTO: EsitoOttimizzazione = {
  codice: 400,
  corpo: {
    error: "Progetto Planner Studio mancante",
    detail: "L'ottimizzazione richiede un progetto Scheduling collegato a un progetto Planner Studio: "
      + "nodi, depositi e archi fuorilinea sono definiti lì. Se il progetto è legacy, ricrealo dal Planner Studio.",
  },
};

/** Il 400 se la richiesta non ha il progetto Planner Studio (vale anche per il greedy). */
export function progettoMancante(corpo: unknown): EsitoOttimizzazione | null {
  return /^[0-9a-f-]{36}$/i.test(String((corpo as any)?.psProjectId ?? "")) ? null : SENZA_PROGETTO;
}

/** I controlli della richiesta, nell'ordine di sempre: progetto, data, linee, tipologie. */
export function leggiRichiesta(corpo: unknown):
  | { errore: EsitoOttimizzazione }
  | {
      dateYMD: string;
      routeVehicleMap: Record<string, VehicleType>;
      routeForcedMap: Record<string, boolean>;
      lockedChains: { vehicleId?: string; tripIds: string[] }[];
    } {
  const senzaProgetto = progettoMancante(corpo);
  if (senzaProgetto) return { errore: senzaProgetto };
  const body = corpo as {
    date?: string;
    routes?: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
    lockedChains?: { vehicleId?: string; tripIds: string[] }[];
  };
  const lockedChains = (Array.isArray(body.lockedChains) ? body.lockedChains : [])
    .filter((c): c is { vehicleId?: string; tripIds: string[] } => !!c && Array.isArray(c.tripIds))
    .map(c => ({
      ...(typeof c.vehicleId === "string" && c.vehicleId.trim() ? { vehicleId: c.vehicleId.trim() } : {}),
      tripIds: c.tripIds.map(t => String(t ?? "").trim()).filter(Boolean),
    }))
    .filter(c => c.tripIds.length > 0);

  const rawDate = body.date;
  if (!rawDate || typeof rawDate !== "string") {
    return { errore: { codice: 400, corpo: { error: "Parametro 'date' obbligatorio (YYYYMMDD o YYYY-MM-DD)" } } };
  }
  const dateYMD = rawDate.replace(/-/g, "");
  if (!/^\d{8}$/.test(dateYMD)) {
    return { errore: { codice: 400, corpo: { error: "Formato data non valido" } } };
  }

  if (!body.routes || !Array.isArray(body.routes) || body.routes.length === 0) {
    return { errore: { codice: 400, corpo: { error: "Parametro 'routes' obbligatorio" } } };
  }

  const validTypes = new Set(Object.keys(VEHICLE_SIZE));
  const routeVehicleMap: Record<string, VehicleType> = {};
  const routeForcedMap: Record<string, boolean> = {};
  for (const r of body.routes) {
    if (!r.routeId || !r.vehicleType || !validTypes.has(r.vehicleType)) {
      return { errore: { codice: 400, corpo: { error: `Tipo veicolo non valido: "${r.vehicleType}" per linea "${r.routeId}"` } } };
    }
    routeVehicleMap[r.routeId] = r.vehicleType;
    routeForcedMap[r.routeId] = !!r.forced;
  }


  return { dateYMD, routeVehicleMap, routeForcedMap, lockedChains };
}

/** Il 400 della richiesta, o null se si può calcolare (la rotta lo controlla prima di accodare). */
export function validaRichiesta(corpo: unknown): EsitoOttimizzazione | null {
  const l = leggiRichiesta(corpo);
  return "errore" in l ? l.errore : null;
}

/**
 * Turni macchina (mode="cpsat": vehicle_scheduler_cpsat.py) o ottimizzazione
 * INTEGRATA veicoli+guida (mode="vcsp": vcsp_orchestrator.py, loop
 * VSP→CSP→costi-ombra→re-VSP; la risposta ha la stessa forma del CP-SAT più la
 * sezione `vcsp` con i KPI per round e i turni guida del round migliore).
 *
 * Era l'handler di POST /service-program/cpsat e /vcsp: le stesse risposte,
 * senza req e res, così gira anche nel lavoratore dei calcoli.
 */
export async function eseguiOttimizzazione(corpo: unknown, o: OpzioniOttimizzazione): Promise<EsitoOttimizzazione> {
  const { mode, feedId, log } = o;
  // solo la fase principale arriva al chiamante: in VCSP il VSP interno va da 0 a 100 a ogni round
  const fase = mode === "vcsp" ? "VCSP" : "VSP";
  const opzPython: OpzioniPython = {
    segnale: o.segnale, scadenza: o.scadenza,
    ...(o.progresso ? { suProgresso: (p: Progresso) => { if (p.phase === fase) o.progresso!(p); } } : {}),
  };
  try {
    const letta = leggiRichiesta(corpo);
    if ("errore" in letta) return letta.errore;
    const { lockedChains, dateYMD, routeVehicleMap, routeForcedMap } = letta;

    const body = corpo as {
      date?: string;
      routes?: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
      tripVehicleOverrides?: Record<string, VehicleType>;
      /**
       * Override degli orari di partenza/arrivo per singolo tripId (in minuti dalla mezzanotte).
       * Usato dalla ri-ottimizzazione post-Analisi Intermodale: gli orari sono già stati
       * spostati per garantire le coincidenze, qui ricalcoliamo i turni macchina con i
       * nuovi tempi senza dover modificare il GTFS.
       */
      tripTimeOverrides?: Record<string, { departureMin: number; arrivalMin: number; departureTime?: string; arrivalTime?: string }>;
      timeLimit?: number;
      vehicleCosts?: Record<string, any>;
      solverIntensity?: string;
      /**
       * Parametri avanzati VSP esposti via UI (Fucina/OptimizerStep):
       * - minVehiclesPriority: off | soft | strict | lexicographic (regola #1)
       * - costRatesOverride: tariffe utente che sovrascrivono i default
       * - intensity, scenariosOverride, enableNoGoodCuts, ...
       */
      vspAdvanced?: Record<string, any>;
      /**
       * Planning Studio project ID (UUID). Se presente, il solver riceve
       * anche i cluster PS "logici" (kind!=interchange) come hint di transfer
       * a costo zero. I cluster di interscambio sono già propagati via mirror
       * legacy `stop_clusters` indipendentemente da questo campo.
       */
      psProjectId?: string;
      /**
       * Il lucchetto (Fucina → Ri-ottimizza): turni macchina che l'operatore
       * ha bloccato. Il solver li riceve come VINCOLI DURI — stesse corse,
       * stesso ordine, stessa matricola — e ricalcola solo il resto. Se un
       * turno bloccato non sta nel modello (corsa sparita, aggancio
       * impossibile) il solver risponde con un errore parlante → 422.
       */
      lockedChains?: { vehicleId?: string; tripIds: string[] }[];
    };

    const selectedRouteIds = new Set(Object.keys(routeVehicleMap));
    const timeLimitSec = body.timeLimit ?? 60;

    // 1. Active services
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      return { codice: 200, corpo: { status: "NO_INPUT", vehicleShifts: [], metrics: {} } };
    }

    // 2. Load trips (same as greedy endpoint). La colonna variant_code c'è dalle migrazioni.
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
      onDemand: gtfsTrips.onDemand,
      variantCode: gtfsTrips.variantCode,
    }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));

    const trips = allTrips.filter(t =>
      selectedRouteIds.has(t.routeId) && activeServices.has(t.serviceId)
    );

    if (trips.length === 0) {
      return { codice: 200, corpo: { status: "NO_INPUT", vehicleShifts: [], metrics: {} } };
    }

    // 3. Stop times
    const tripIds = trips.map(t => t.tripId);
    const stopTimesRaw = await db.execute<{
      trip_id: string; stop_id: string; stop_sequence: number;
      departure_time: string | null; arrival_time: string | null;
    }>(sql`
      SELECT trip_id, stop_id, stop_sequence, departure_time, arrival_time
      FROM gtfs_stop_times
      WHERE feed_id = ${feedId}
        AND trip_id IN ${sql.raw(`(${tripIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",")})`)}
      ORDER BY trip_id, stop_sequence
    `);

    const stByTrip: Record<string, typeof stopTimesRaw.rows> = {};
    for (const st of stopTimesRaw.rows) {
      if (!stByTrip[st.trip_id]) stByTrip[st.trip_id] = [];
      stByTrip[st.trip_id].push(st);
    }

    // 4. Route names + stop coords
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const routeNameMap = new Map(routeRows.map(r => [r.routeId, r.shortName || r.longName || r.routeId]));

    const stopRows = await db.select({
      stopId: gtfsStops.stopId,
      lat: gtfsStops.stopLat,
      lon: gtfsStops.stopLon,
      name: gtfsStops.stopName,
    }).from(gtfsStops).where(eq(gtfsStops.feedId!, feedId));
    const stopCoords = new Map(stopRows.map(s => [s.stopId, { lat: s.lat, lon: s.lon, name: s.name || s.stopId }]));

    // 4c. Flessibilità DICHIARATA IN PIANIFICAZIONE (cervello P↔TM↔TG):
    // flexMin per linea (default) e per corsa (override) dal progetto PS.
    // Nel feed materializzato route_id/trip_id GTFS = uuid PS, quindi il
    // lookup è diretto. Corsa senza dichiarazione = inchiodata (0).
    const flexByRoute = new Map<string, number>();
    const flexByTrip = new Map<string, number>();
    const psProjForFlex = typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)
      ? body.psProjectId : null;
    if (psProjForFlex) {
      try {
        const fr = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_routes
           WHERE project_id = ${psProjForFlex}::uuid AND attributes ? 'flexMin'`);
        for (const r of fr.rows ?? []) if (Number(r.flex) > 0) flexByRoute.set(String(r.id), Math.min(30, Number(r.flex)));
        const ft = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_trips
           WHERE project_id = ${psProjForFlex}::uuid AND attributes ? 'flexMin'`);
        for (const r of ft.rows ?? []) flexByTrip.set(String(r.id), Math.max(0, Math.min(30, Number(r.flex) || 0)));
        if (flexByRoute.size || flexByTrip.size) {
          log.info(`CP-SAT VSP: flessibilità dichiarata su ${flexByRoute.size} linee e ${flexByTrip.size} corse (progetto PS)`);
        }
      } catch { /* progetto PS senza flex: tutte le corse inchiodate */ }
    }

    // 5. Build trip blocks
    const tripBlocks: TripBlock[] = [];
    for (const t of trips) {
      const sts = stByTrip[t.tripId];
      if (!sts || sts.length === 0) continue;
      sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
      const firstDep = sts[0].departure_time || sts[0].arrival_time || "00:00:00";
      const lastArr = sts[sts.length - 1].arrival_time || sts[sts.length - 1].departure_time || firstDep;
      const firstStop = stopCoords.get(sts[0].stop_id);
      const lastStop = stopCoords.get(sts[sts.length - 1].stop_id);
      const routeName = routeNameMap.get(t.routeId) || t.routeId;

      // Applica eventuale override degli orari (post-Analisi Intermodale): gli orari
      // sono già stati spostati per garantire le coincidenze, qui ricalcoliamo i turni
      // macchina con i nuovi tempi senza dover modificare il GTFS.
      const ovr = body.tripTimeOverrides?.[t.tripId];
      const finalDepartureTime = ovr?.departureTime ?? firstDep;
      const finalArrivalTime = ovr?.arrivalTime ?? lastArr;
      const finalDepartureMin = typeof ovr?.departureMin === "number" ? ovr.departureMin : timeToMinutes(firstDep);
      const finalArrivalMin = typeof ovr?.arrivalMin === "number" ? ovr.arrivalMin : timeToMinutes(lastArr);

      tripBlocks.push({
        tripId: t.tripId,
        routeId: t.routeId,
        routeName,
        headsign: t.headsign,
        variantCode: (t as any).variantCode ?? null,
        directionId: t.directionId ?? 0,
        departureTime: finalDepartureTime,
        arrivalTime: finalArrivalTime,
        departureMin: finalDepartureMin,
        arrivalMin: finalArrivalMin,
        stopCount: sts.length,
        firstStopId: sts[0].stop_id,
        lastStopId: sts[sts.length - 1].stop_id,
        firstStopLat: firstStop?.lat ?? 43.6,
        firstStopLon: firstStop?.lon ?? 13.5,
        lastStopLat: lastStop?.lat ?? 43.6,
        lastStopLon: lastStop?.lon ?? 13.5,
        firstStopName: firstStop?.name || sts[0].stop_id,
        lastStopName: lastStop?.name || sts[sts.length - 1].stop_id,
        requiredVehicle: (body.tripVehicleOverrides?.[t.tripId] as VehicleType) ?? (routeVehicleMap[t.routeId] || "12m"),
        category: getServiceCategory(routeName),
        forced: routeForcedMap[t.routeId] ?? false,
        onDemand: !!t.onDemand,
        flexMin: flexByTrip.get(t.tripId) ?? flexByRoute.get(t.routeId) ?? 0,
      });
    }

    // Corse ESCLUSE dall'operatore: fuori dal solver ma restano SCOPERTE (unassigned),
    // così il traffico dati resta corretto (non spariscono, contano come non coperte).
    const excludedSet = new Set<string>(Array.isArray((body as any).excludedTripIds)
      ? (body as any).excludedTripIds.filter((x: any) => typeof x === "string") : []);
    const excludedBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => excludedSet.has(t.tripId)) : [];
    for (const b of excludedBlocks) (b as any).excludedByOperator = true;
    const solverBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => !excludedSet.has(t.tripId)) : tripBlocks;

    log.info(`CP-SAT VSP: ${solverBlocks.length} trips (${excludedBlocks.length} escluse), timeLimit=${timeLimitSec}s`);

    // Build route details for Python
    const routeDetailsForPy = Array.from(selectedRouteIds).map(rid => ({
      routeId: rid,
      routeName: routeNameMap.get(rid) || rid,
    }));

    /* ── 5b. Cluster utente (Planning Studio + legacy) per VSP ────────────
     * I cluster definiti dall'utente sono passati al CP-SAT come hint:
     * fermate dello stesso cluster vengono trattate come "stesso punto"
     * (deadhead km=0, tempo=0). Sorgenti aggregate:
     *  - cluster legacy (`stop_cluster_stops`): comprendono già il mirror
     *    PS→legacy dei kind='interchange' (cfr planning-studio-materialize)
     *  - cluster PS logici (kind!='interchange'): NON sono mirrorati,
     *    quindi li leggiamo direttamente da ps_stop_clusters/ps_stops
     *    se è specificato un psProjectId.
     * Lavoriamo per stop_id GTFS (chiave usata dal solver).
     */
    const psClustersForPy: { id: string; name: string; kind: string; stopIds: string[] }[] = [];
    const psProjectIdForClusters = typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)
      ? body.psProjectId : null;
    try {
      // 5b.1 — cluster legacy: SOLO globali + quelli mirrorati da QUESTO
      // progetto PS. Prima si leggeva l'intera tabella senza filtro: i nodi
      // di altri progetti entravano nel solver e le loro fermate venivano
      // trattate come "stesso punto" (fuorilinea 0). Con stop_id GTFS che si
      // ripetono tra feed diversi, questo falsava la matrice fuorilinea.
      const legacyRows = await db.execute<{ cluster_id: string; name: string; gtfs_stop_id: string }>(sql`
        SELECT scs.cluster_id::text AS cluster_id,
               COALESCE(c.name, 'Cluster') AS name,
               scs.gtfs_stop_id
          FROM stop_cluster_stops scs
          JOIN stop_clusters c ON c.id = scs.cluster_id
         WHERE c.source_ps_project_id IS NULL
            OR c.source_ps_project_id = ${psProjectIdForClusters}::uuid
      `);
      const legacyByCluster = new Map<string, { name: string; stopIds: Set<string> }>();
      for (const r of legacyRows.rows) {
        if (!legacyByCluster.has(r.cluster_id)) {
          legacyByCluster.set(r.cluster_id, { name: r.name, stopIds: new Set() });
        }
        legacyByCluster.get(r.cluster_id)!.stopIds.add(r.gtfs_stop_id);
      }
      for (const [cid, v] of legacyByCluster) {
        if (v.stopIds.size >= 2) {
          psClustersForPy.push({ id: cid, name: v.name, kind: "interchange", stopIds: Array.from(v.stopIds) });
        }
      }
      // 5b.2 — cluster PS logici (kind != interchange) per il psProjectId, se passato
      const psProjectId = psProjectIdForClusters;
      if (psProjectId) {
        const psRows = await db.execute<{ cluster_id: string; name: string; kind: string; gtfs_stop_id: string }>(sql`
          SELECT c.id::text AS cluster_id,
                 COALESCE(NULLIF(c.name, ''), 'Cluster') AS name,
                 COALESCE(c.kind, 'interchange') AS kind,
                 s.id::text AS gtfs_stop_id
            FROM ps_stops s
            JOIN ps_stop_clusters c ON c.id = s.cluster_id
           WHERE s.project_id = ${psProjectId}::uuid
             AND s.cluster_id IS NOT NULL
             AND COALESCE(c.kind, 'interchange') != 'interchange'
        `);
        const psByCluster = new Map<string, { name: string; kind: string; stopIds: Set<string> }>();
        for (const r of psRows.rows) {
          if (!psByCluster.has(r.cluster_id)) {
            psByCluster.set(r.cluster_id, { name: r.name, kind: r.kind, stopIds: new Set() });
          }
          psByCluster.get(r.cluster_id)!.stopIds.add(r.gtfs_stop_id);
        }
        for (const [cid, v] of psByCluster) {
          if (v.stopIds.size >= 2) {
            psClustersForPy.push({ id: cid, name: v.name, kind: v.kind, stopIds: Array.from(v.stopIds) });
          }
        }
      }
      if (psClustersForPy.length > 0) {
        const totalStops = psClustersForPy.reduce((s, c) => s + c.stopIds.length, 0);
        log.info(`CP-SAT VSP: ${psClustersForPy.length} user-cluster (${totalStops} stop) inviati al solver [scope PS ${psProjectIdForClusters}]`);
      }
    } catch (err: any) {
      log.error(`CP-SAT VSP: errore caricamento cluster utente: ${err?.message}`);
    }

    // 5c. Multi-deposito: selezione utente + matrice fuorilinea per il solver.
    // I depositi selezionati entrano nel SOLVER (domiciliazione + cap hard);
    // la matrice copre {depositi}×{capolinea} ∪ {capolinea}×{capolinea} con km
    // stradali OSRM (fallback Haversine×circuità).
    const depotSel = parseDepotSelection((body as any).depots);
    const allDepots = await loadDepotPoints(String((body as any).projectId ?? "") || null);
    const depotPoints = depotSel ? allDepots.filter(d => depotSel.ids.has(d.id)) : allDepots;

    let depotsForPy: { id: string; name: string; color: string; lat: number; lon: number; maxVehicles: number | null; fleet?: Record<string, number> }[] | undefined;
    let deadheadKm: Record<string, number> | undefined;
    let deadheadMin: Record<string, number> | undefined;
    // Esito della restrizione all'archivio «Archi fuorilinea» (per il log del
    // solver e la relazione): scope, archi, coppie ammesse/vietate.
    let deadheadArchive: {
      scope: string; arcs: number; ttAllowed: number; ttForbidden: number; depotLegsOutsideArchive: number;
      // tempi/km presi dall'archivio (custom_min ?? travel_min, custom_km ?? road_km) per le coppie del giro
      timesApplied?: number; kmApplied?: number; customTimes?: number; depotLegsMissing?: string[];
      // coppie senza arco proprio che prendono tempo/km dal verso opposto (andata = ritorno)
      mirroredPairs?: number;
    } | undefined;
    if (depotSel && depotPoints.length > 0) {
      depotsForPy = depotPoints.map(d => ({
        id: d.id, name: d.name, color: d.color, lat: d.lat, lon: d.lon,
        maxVehicles: depotSel.caps.get(d.id) ?? null,
        // flotta per TIPOLOGIA di veicolo (vincolo hard nella domiciliazione)
        ...(depotSel.fleets.get(d.id) ? { fleet: depotSel.fleets.get(d.id) } : {}),
      }));
      try {
        const depotNodes: DHNode[] = depotPoints.map(d => ({ lat: d.lat, lon: d.lon }));
        const terminalNodes: DHNode[] = [];
        for (const t of tripBlocks) {
          terminalNodes.push({ lat: t.firstStopLat, lon: t.firstStopLon });
          terminalNodes.push({ lat: t.lastStopLat, lon: t.lastStopLon });
        }
        const [outM, inM, ttM] = await Promise.all([
          buildDeadheadKmMatrix(depotNodes, terminalNodes),   // uscite deposito→capolinea
          buildDeadheadKmMatrix(terminalNodes, depotNodes),   // rientri capolinea→deposito
          buildDeadheadKmMatrix(terminalNodes, terminalNodes), // riposizionamenti
        ]);
        deadheadKm = { ...ttM.matrix, ...outM.matrix, ...inM.matrix };
        const osrm = outM.osrmPairs + inM.osrmPairs + ttM.osrmPairs;
        const total = outM.totalPairs + inM.totalPairs + ttM.totalPairs;
        log.info(`CP-SAT VSP: matrice fuorilinea ${total} coppie (${osrm} da OSRM, ${total - osrm} Haversine)`);

        /* ARCHIVIO «Archi fuorilinea» = elenco dei fuorilinea AMMESSI e dei
         * loro TEMPI e KM. Lo scheduling usa SOLO quelli: una coppia
         * capolinea↔capolinea che l'operatore non ha (o ha cancellato) è
         * vietata; le tratte deposito↔capolinea fuori archivio restano stimate
         * (il bus deve comunque uscire e rientrare) ma vengono contate ed
         * elencate. Per OGNI arco risolto sui nodi del giro (deposito per id,
         * capolinea per stop id, cluster espanso nelle sue fermate) il tempo è
         * custom_min (curato a mano) altrimenti travel_min, i km custom_km
         * altrimenti road_km: i minuti che l'operatore vede in Planning Studio
         * sono quelli che il solver usa (prima solo gli archi «curati a mano»
         * passavano, e solo se le coordinate coincidevano al 5° decimale: le
         * tratte deposito e i cluster restavano alla stima km/velocità + 5′).
         * Scope: archi del progetto PS collegato se ne esistono, altrimenti
         * gli archi globali; archivio vuoto = nessuna restrizione (matrice
         * completa, come prima). Precedenza: arco di progetto > globale; arco
         * su fermata > arco su cluster. */
        try {
          let psProjForArchive: string | null = null;
          const schedProjectIdA = String((body as any).projectId ?? "");
          if (/^[0-9a-f-]{36}$/i.test(schedProjectIdA)) {
            const pr = await db.execute<any>(sql`SELECT planning_studio_project_id FROM scheduling_projects WHERE id = ${schedProjectIdA}::uuid`);
            psProjForArchive = (pr.rows?.[0]?.planning_studio_project_id as string | undefined) ?? null;
          }
          // Percorso agente (agent-optimize): il progetto PS arriva come psProjectId
          // anche senza progetto scheduling collegato
          if (!psProjForArchive && typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)) {
            psProjForArchive = body.psProjectId;
          }
          // Archi GLOBALI come base + archi del PROGETTO che li sommano (e vincono
          // sull'omologo globale).
          const ARC_COLS = sql`from_key, from_type, from_lat, from_lon, to_key, to_type, to_lat, to_lon, ps_project_id, road_km, travel_min, custom_km, custom_min, source`;
          const archiveRows: any[] = psProjForArchive
            ? (await db.execute<any>(sql`SELECT ${ARC_COLS} FROM deadhead_arcs WHERE ps_project_id IS NULL OR ps_project_id = ${psProjForArchive}::uuid ORDER BY (ps_project_id IS NOT NULL)`)).rows ?? []
            : (await db.execute<any>(sql`SELECT ${ARC_COLS} FROM deadhead_arcs WHERE ps_project_id IS NULL`)).rows ?? [];
          const nProjectArcs = archiveRows.filter(a => a.ps_project_id).length;
          const archiveScope = nProjectArcs > 0 ? (archiveRows.length > nProjectArcs ? "globale+progetto" : "progetto") : "globale";
          if (archiveRows.length > 0) {
            // nodi di QUESTO giro: capolinea per stop id e coordinate, depositi per id
            const termCoordByStop = new Map<string, string>();
            const termCoordKeys = new Set<string>();
            const nameByCoord = new Map<string, string>();
            for (const t of tripBlocks) {
              const k1 = dhKey(t.firstStopLat, t.firstStopLon);
              const k2 = dhKey(t.lastStopLat, t.lastStopLon);
              termCoordKeys.add(k1); termCoordKeys.add(k2);
              if (t.firstStopId) termCoordByStop.set(String(t.firstStopId), k1);
              if (t.lastStopId) termCoordByStop.set(String(t.lastStopId), k2);
              if (!nameByCoord.has(k1)) nameByCoord.set(k1, t.firstStopName || String(t.firstStopId));
              if (!nameByCoord.has(k2)) nameByCoord.set(k2, t.lastStopName || String(t.lastStopId));
            }
            const depotCoordById = new Map<string, string>();
            const depotCoordKeys = new Set<string>();
            for (const d of depotPoints) {
              const k = dhKey(d.lat, d.lon);
              depotCoordById.set(String(d.id), k); depotCoordKeys.add(k);
              nameByCoord.set(k, `Deposito ${d.name}`);
            }
            // Un nodo dell'archivio → una o più chiavi coordinate di QUESTO giro:
            // deposito per id, capolinea per stop id (poi coordinate), cluster
            // espanso in tutte le sue fermate membre presenti nel giro.
            const clusterStops = new Map<string, string[]>();
            for (const c of psClustersForPy) clusterStops.set(String(c.id), c.stopIds.map(String));
            const isClusterNode = (key: string, type: string) => type === "cluster" || String(key).startsWith("cluster:");
            const nodeKeys = (key: string, type: string, lat: number, lon: number): string[] => {
              if (type === "depot") {
                const id = String(key).replace(/^depot:/, "");
                const k = depotCoordById.get(id) ?? (depotCoordKeys.has(dhKey(lat, lon)) ? dhKey(lat, lon) : null);
                return k ? [k] : [];
              }
              if (isClusterNode(key, type)) {
                const id = String(key).replace(/^cluster:/, "");
                const members = clusterStops.get(id) ?? [];
                const ks = members.map(sid => termCoordByStop.get(sid)).filter((k): k is string => !!k);
                return Array.from(new Set(ks));
              }
              if (String(key).startsWith("stop:")) {
                const k = termCoordByStop.get(String(key).slice(5));
                if (k) return [k];
              }
              const ck = dhKey(lat, lon);
              return termCoordKeys.has(ck) ? [ck] : [];
            };
            const allowed = new Set<string>();
            const archMin = new Map<string, number>();
            const archKm = new Map<string, number>();
            const archRank = new Map<string, number>();
            let resolvedArcs = 0, unresolvedArcs = 0, customTimes = 0;
            for (const a of archiveRows) {
              const kas = nodeKeys(a.from_key, a.from_type, Number(a.from_lat), Number(a.from_lon));
              const kbs = nodeKeys(a.to_key, a.to_type, Number(a.to_lat), Number(a.to_lon));
              if (!kas.length || !kbs.length) { unresolvedArcs++; continue; }
              resolvedArcs++;
              const viaCluster = isClusterNode(a.from_key, a.from_type) || isClusterNode(a.to_key, a.to_type);
              // progetto > globale; fermata > cluster
              const rank = (a.ps_project_id ? 2 : 0) + (viaCluster ? 0 : 1);
              const minRaw = a.custom_min ?? a.travel_min;
              const kmRaw = a.custom_km ?? a.road_km;
              const hasMin = minRaw != null && Number.isFinite(Number(minRaw)) && Number(minRaw) >= 0;
              const hasKm = kmRaw != null && Number.isFinite(Number(kmRaw)) && Number(kmRaw) >= 0;
              if (a.custom_min != null) customTimes++;
              for (const ka of kas) for (const kb of kbs) {
                if (ka === kb) continue;
                const key = `${ka}|${kb}`;
                allowed.add(key);
                if ((archRank.get(key) ?? -1) > rank) continue;
                archRank.set(key, rank);
                if (hasMin) archMin.set(key, Math.round(Number(minRaw) * 10) / 10);
                if (hasKm) archKm.set(key, Math.round(Number(kmRaw) * 100) / 100);
              }
            }
            /* ANDATA = RITORNO. I fuorilinea si considerano dello stesso tempo nei
             * due versi: se una coppia ha l'arco solo in un verso, il verso opposto
             * eredita ammissione, tempo e km; se li ha in entrambi, il tempo è il
             * tempo curato a mano (se solo un verso lo ha) altrimenti il maggiore
             * dei due tempi di percorrenza, così andata e ritorno coincidono. */
            let mirroredPairs = 0;
            const customKeys = new Set<string>();
            for (const a of archiveRows) {
              if (a.custom_min == null) continue;
              const kas = nodeKeys(a.from_key, a.from_type, Number(a.from_lat), Number(a.from_lon));
              const kbs = nodeKeys(a.to_key, a.to_type, Number(a.to_lat), Number(a.to_lon));
              for (const ka of kas) for (const kb of kbs) if (ka !== kb) customKeys.add(`${ka}|${kb}`);
            }
            for (const key of Array.from(allowed)) {
              const [ka, kb] = key.split("|");
              const rev = `${kb}|${ka}`;
              if (!allowed.has(rev)) {
                allowed.add(rev);
                mirroredPairs++;
                if (archMin.has(key)) archMin.set(rev, archMin.get(key)!);
                if (archKm.has(key)) archKm.set(rev, archKm.get(key)!);
                continue;
              }
              const mA = archMin.get(key), mB = archMin.get(rev);
              if (mA == null || mB == null || mA === mB) continue;
              const cA = customKeys.has(key), cB = customKeys.has(rev);
              const t = cA && !cB ? mA : (!cA && cB ? mB : (cA && cB ? null : Math.max(mA, mB)));
              if (t != null) { archMin.set(key, t); archMin.set(rev, t); }
            }
            if (resolvedArcs === 0) {
              // Archivio di un'altra rete/feed: nessun arco tocca i nodi di questo
              // giro → nessuna restrizione (matrice completa), ma lo diciamo.
              deadheadArchive = { scope: `${archiveScope} (non applicato: nessun arco sui nodi del giro)`, arcs: archiveRows.length, ttAllowed: 0, ttForbidden: 0, depotLegsOutsideArchive: 0, timesApplied: 0, kmApplied: 0, customTimes: 0 };
              log.warn(`CP-SAT VSP: archivio fuorilinea ${archiveScope} (${archiveRows.length} archi) non tocca i nodi di questo giro: matrice completa, nessuna restrizione`);
            } else {
              let ttAllowed = 0, ttForbidden = 0, depotOutside = 0, timesApplied = 0, kmApplied = 0;
              const missing: string[] = [];
              const describe = (key: string) => key.split("|").map(k => nameByCoord.get(k) ?? k).join(" → ");
              for (const key of Object.keys(ttM.matrix)) {
                if (allowed.has(key)) ttAllowed++;
                else { deadheadKm[key] = 9999; ttForbidden++; }
              }
              for (const key of [...Object.keys(outM.matrix), ...Object.keys(inM.matrix)]) {
                if (!allowed.has(key)) { depotOutside++; if (missing.length < 20) missing.push(describe(key)); }
              }
              // Tempi e km dell'archivio su TUTTE le coppie del giro che hanno un arco
              const minOverrides: Record<string, number> = {};
              for (const key of Object.keys(deadheadKm)) {
                if (deadheadKm[key] === 9999) continue;
                const km = archKm.get(key);
                const min = archMin.get(key);
                if (km != null) { deadheadKm[key] = km; kmApplied++; }
                if (min != null) { minOverrides[key] = min; timesApplied++; }
              }
              if (Object.keys(minOverrides).length > 0) deadheadMin = minOverrides;
              deadheadArchive = { scope: archiveScope, arcs: archiveRows.length, ttAllowed, ttForbidden, depotLegsOutsideArchive: depotOutside, timesApplied, kmApplied, customTimes, depotLegsMissing: missing, mirroredPairs };
              log.info(`CP-SAT VSP: archivio fuorilinea ${archiveScope} (${archiveRows.length} archi, ${resolvedArcs} sui nodi del giro, ${unresolvedArcs} non riconosciuti): ${ttAllowed} coppie capolinea ammesse, ${ttForbidden} vietate (riposizionamento via deposito se il tempo basta), ${depotOutside} tratte deposito fuori archivio (stimate); tempi dell'archivio su ${timesApplied} coppie (${customTimes} archi con tempo curato a mano, ${mirroredPairs} versi specchiati: andata = ritorno), km su ${kmApplied}`);
              if (missing.length) log.warn(`CP-SAT VSP: tratte deposito SENZA arco in archivio (tempo stimato km/velocità + buffer): ${missing.join("; ")}${depotOutside > missing.length ? `; … e altre ${depotOutside - missing.length}` : ""}`);
            }
          } else {
            log.info("CP-SAT VSP: archivio fuorilinea vuoto, matrice completa (nessuna restrizione)");
          }
        } catch (err: any) {
          log.warn({ err: err?.message }, "archivio fuorilinea non leggibile: matrice completa");
        }
      } catch (err: any) {
        log.warn({ err: err?.message }, "matrice fuorilinea non disponibile, il solver stima Haversine");
      }
    } else {
      deadheadArchive = { scope: "non applicato: nessun deposito selezionato (matrice fuorilinea non costruita)", arcs: 0, ttAllowed: 0, ttForbidden: 0, depotLegsOutsideArchive: 0 };
      log.warn("CP-SAT VSP: nessun deposito selezionato: matrice fuorilinea non costruita, archivio «Archi fuorilinea» NON applicato (il solver stima Haversine)");
    }

    // 5d. DELAY-ROBUST (Fase 2): profilo ritardi orario dai dati di traffico
    // reali (TomTom, ultimi 30 giorni). delayByHour[h] = minuti di ritardo
    // atteso per ORA di corsa nella fascia h, stimati dalla congestione media
    // (congestione 40% ≈ 6 min persi per ora di guida). Il solver li usa come
    // buffer δ sul concatenamento (off/media/alta).
    const robustnessLevel = String((body as any).robustness || "off").toLowerCase();
    let robustnessCfg: { level: string; delayByHour: Record<string, number> } | undefined;
    if (robustnessLevel === "media" || robustnessLevel === "alta") {
      const delayByHour: Record<string, number> = {};
      try {
        const tr = await db.execute<any>(sql`
          SELECT EXTRACT(HOUR FROM captured_at)::int AS h, avg(congestion_level) AS cong
            FROM traffic_snapshots
           WHERE captured_at > now() - interval '30 days'
           GROUP BY 1
        `);
        for (const r of tr.rows) {
          const d = Math.min(15, Math.round(Number(r.cong || 0) * 15 * 10) / 10);
          if (d > 0) delayByHour[String(r.h)] = d;
        }
      } catch { /* nessun dato traffico → il solver usa il profilo di default */ }
      robustnessCfg = { level: robustnessLevel, delayByHour };
      log.info(`VSP robustezza=${robustnessLevel}: profilo ritardi su ${Object.keys(delayByHour).length} fasce orarie${Object.keys(delayByHour).length === 0 ? " (default)" : " (traffico reale)"}`);
    }

    // 5e. NORMATIVA VSP (MAIOR-style): cambi linea, tripper, sosta capolinea,
    // max pezzi, vuoti interni. Whitelist dei campi accettati dal solver.
    let normativaCfg: Record<string, any> | undefined;
    const rawNorm = (body as any).vspNormativa;
    if (rawNorm && typeof rawNorm === "object") {
      const n: Record<string, any> = {};
      for (const k of ["costoCambioLinea", "maxCambiLinea", "maxPezziPerBlocco", "costoTripper", "tripperServizioMinMin", "maxSostaCapolineaMin"]) {
        const v = Number(rawNorm[k]);
        if (rawNorm[k] !== undefined && rawNorm[k] !== null && rawNorm[k] !== "" && Number.isFinite(v)) n[k] = v;
      }
      if (rawNorm.vietaCambiLinea) n.vietaCambiLinea = true;
      if (rawNorm.vietaVuotiInterni) n.vietaVuotiInterni = true;
      if (Object.keys(n).length > 0) normativaCfg = n;
    }

    // 5f. SAGOMA: fasce di punta e tetti di declassamento.
    // Il declassamento pesa in ragione della fascia, e le fasce del feriale
    // (7-9 e 17-19) non valgono di domenica, dove la punta è il pomeriggio:
    // senza questo default un mezzo ridotto alle 16 di domenica sarebbe
    // pagato come fosse morbida. L'operatore può sempre sovrascrivere.
    const sagomaCfg: Record<string, any> = {};
    const rawSagoma = (body as any).sagoma;
    if (rawSagoma && typeof rawSagoma === "object") {
      const fasce = (rawSagoma as any).fascePunta ?? (rawSagoma as any).peakWindows;
      if (Array.isArray(fasce)) sagomaCfg.fascePunta = fasce;
      for (const k of ["maxDeclassatePctPerLinea", "maxDeclassatePctPuntaPerLinea"]) {
        const v = Number((rawSagoma as any)[k]);
        if (Number.isFinite(v)) sagomaCfg[k] = v;
      }
      if ((rawSagoma as any).flotta && typeof (rawSagoma as any).flotta === "object") {
        sagomaCfg.flotta = (rawSagoma as any).flotta;
      }
    }
    if (!sagomaCfg.fascePunta) {
      const y = Number(dateYMD.slice(0, 4)), mo = Number(dateYMD.slice(4, 6)), d = Number(dateYMD.slice(6, 8));
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      if (dow === 0) sagomaCfg.fascePunta = [[15, 20]];
    }
    if (!sagomaCfg.flotta && Array.isArray(depotsForPy)) {
      const perTipo: Record<string, number> = {};
      for (const dep of depotsForPy as any[]) {
        const fl = dep?.fleet;
        if (fl && typeof fl === "object") {
          for (const [k, v] of Object.entries(fl)) {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) perTipo[k] = (perTipo[k] ?? 0) + n;
          }
        }
      }
      if (Object.keys(perTipo).length > 0) sagomaCfg.flotta = perTipo;
    }

    // 6. Spawn Python solver (CP-SAT puro, oppure orchestratore VCSP)
    const vspExtraConfig = {
      vehicleCosts: body.vehicleCosts || {},
      solverIntensity: body.solverIntensity || "normal",
      // Parametri avanzati VSP (regola #1 + override costi dalla UI)
      ...(body.vspAdvanced ? { vspAdvanced: body.vspAdvanced } : {}),
      // Robustezza ai ritardi (buffer δ data-driven)
      ...(robustnessCfg ? { robustness: robustnessCfg } : {}),
      // Normativa VSP (MAIOR-style)
      ...(normativaCfg ? { normativa: normativaCfg } : {}),
      // Sagoma: fasce di punta, tetti di declassamento, flotta per tipologia
      ...(Object.keys(sagomaCfg).length > 0 ? { sagoma: sagomaCfg } : {}),
    };
    let cpResult: any;
    if (mode === "vcsp") {
      // Relief points per corsa (fermate intermedie nei cluster) precomputati
      // UNA volta: l'orchestratore li riattacca ai blocchi di ogni round prima
      // di lanciare il CSP.
      const pseudoShifts: any[] = [{ trips: solverBlocks.map(tb => ({ type: "trip", tripId: tb.tripId })) }];
      try { await enrichTripsWithClusterStops(pseudoShifts as any, log); } catch { /* senza cluster il CSP taglia solo ai capolinea */ }
      const tripClusterStops: Record<string, any[]> = {};
      for (const t of pseudoShifts[0].trips as any[]) {
        if (Array.isArray(t.clusterStops) && t.clusterStops.length > 0) tripClusterStops[t.tripId] = t.clusterStops;
      }
      const vcspBody = (body as any).vcsp || {};
      // ── Parità col CSP standalone: la config turni guida della UI viene
      // arricchita con gli stessi dati DB (cluster di stacco, autovetture
      // aziendali, nodi di sosta) che riceve il CSP lanciato dall'area TG.
      const operatorCfg = (body as any).crewConfig
        ?? { bds: { serviceType: (body as any).serviceType || "urbano" } };
      const [allDbClusters, dbCompanyCars, crewRestPoints] = await Promise.all([
        loadClustersForPython(),
        loadCompanyCars(),
        loadRestPointsForScenario((body as any).projectId ?? null),
      ]);
      const selClusterIds = Array.isArray(operatorCfg?.selectedClusterIds) ? (operatorCfg.selectedClusterIds as string[]) : null;
      const crewDbClusters = selClusterIds && selClusterIds.length > 0
        ? allDbClusters.filter((c: any) => selClusterIds.includes(c.id))
        : allDbClusters;
      // ── Autovetture aziendali = vincolo RIGIDO, sempre ──
      // Il solver v4 applica il cap HARD solo se bds.optimizer.maxCompanyCars
      // è presente (altrimenti default 5, ignorando le autovetture reali).
      // Precedenza: campo "Autovetture aziendali" della UI (imposta entrambi)
      // > override esplicito dal pannello completo > impostazione DB.
      const explicitOptimizerCap = (operatorCfg as any)?.bds?.optimizer?.maxCompanyCars;
      const crewCompanyCars = typeof operatorCfg?.companyCars === "number"
        ? operatorCfg.companyCars
        : (typeof explicitOptimizerCap === "number" ? explicitOptimizerCap : dbCompanyCars);
      const { selectedClusterIds: _sci, companyCars: _cc, ...restOperatorCfg } = operatorCfg || {};
      const crewConfig = {
        ...restOperatorCfg,
        bds: {
          ...((restOperatorCfg as any).bds ?? {}),
          optimizer: {
            ...(((restOperatorCfg as any).bds ?? {}).optimizer ?? {}),
            maxCompanyCars: crewCompanyCars,
          },
        },
        clusters: crewDbClusters,
        companyCars: crewCompanyCars,
        restPoints: crewRestPoints,
      };
      // Passaggi sui capolinea altrui: senza questi la sonda vede solo le
      // coincidenze fatte da fermo e puo' rompere quelle fatte in transito.
      const pyTrips = buildPyTrips(solverBlocks);
      try {
        const transits = await loadTerminalTransits(feedId, solverBlocks, log);
        for (const t of pyTrips as any[]) {
          const tr = transits[t.tripId];
          if (tr && tr.length > 0) t.terminalTransits = tr;
        }
      } catch (e: any) { log.info(`loadTerminalTransits saltato: ${e?.message ?? e}`); }
      cpResult = await runVcspOrchestrator(log, {
        vsp: {
          trips: pyTrips,
          config: { timeLimit: timeLimitSec, ...vspExtraConfig },
          routeDetails: routeDetailsForPy,
          psClusters: psClustersForPy,
          ...(depotsForPy && depotsForPy.length > 0 ? { depots: depotsForPy } : {}),
          ...(deadheadKm && Object.keys(deadheadKm).length > 0 ? { deadheadKm } : {}),
          ...(deadheadMin && Object.keys(deadheadMin).length > 0 ? { deadheadMin } : {}),
          ...(deadheadArchive ? { deadheadArchive } : {}),
          ...(lockedChains.length > 0 ? { lockedChains } : {}),
        },
        crew: { config: crewConfig },
        vcsp: {
          rounds: Math.max(1, Math.min(10, Number(vcspBody.rounds) || 3)),
          crewTimeLimit: Number(vcspBody.crewTimeLimit) || 90,
          // Sonda di spostamento (cervello P↔TM↔TG): re-solve a caldo con le
          // corse spostate entro il flexMin dichiarato in Planning. 0 = off.
          probes: vcspBody.probes != null
            ? Math.max(0, Math.min(10, Number(vcspBody.probes) || 0))
            : 4,
          probeVspTime: Math.max(20, Math.min(300, Number(vcspBody.probeVspTime) || 60)),
          // Disturbo all'orario (€/corsa·minuto) e portata dei candidati guidati
          // dai turni: passano al Python così come arrivano dall'agente/UI.
          ...(Number.isFinite(Number(vcspBody.shiftPenaltyEur)) && vcspBody.shiftPenaltyEur != null
            ? { shiftPenaltyEur: Math.max(0, Number(vcspBody.shiftPenaltyEur)) } : {}),
          ...(vcspBody.crewShiftScope === "line" || vcspBody.crewShiftScope === "trip"
            ? { crewShiftScope: vcspBody.crewShiftScope } : {}),
          // Pazienza dell'early-stop (round consecutivi senza miglioramento):
          // i round oscillano per costruzione, e quanta ne serva si prova.
          ...(vcspBody.earlyStopPatience != null && Number.isFinite(Number(vcspBody.earlyStopPatience))
            ? { earlyStopPatience: Math.max(1, Math.min(10, Math.round(Number(vcspBody.earlyStopPatience)))) } : {}),
          // Memoria della sonda (lezioni dei giri precedenti): ordina la coda.
          ...(Array.isArray(vcspBody.probeMemory) && vcspBody.probeMemory.length > 0
            ? { probeMemory: vcspBody.probeMemory.slice(0, 200) } : {}),
          // Controllo della sonda (re-solve del best round senza spostamenti):
          // acceso salvo un false esplicito.
          ...(vcspBody.probeControl === false ? { probeControl: false } : {}),
          // Come il feedback passa da un round all'altro. penaltyStep=1 +
          // penaltyAnchor="last" + seedFromBest=false riportano il ciclo a
          // com'era prima della partenza a caldo, senza toccare il codice.
          ...(Number.isFinite(Number(vcspBody.penaltyStep)) && vcspBody.penaltyStep != null
            ? { penaltyStep: Math.min(1, Math.max(0.05, Number(vcspBody.penaltyStep))) } : {}),
          ...(vcspBody.penaltyAnchor === "best" || vcspBody.penaltyAnchor === "last"
            ? { penaltyAnchor: vcspBody.penaltyAnchor } : {}),
          ...(vcspBody.seedFromBest === false ? { seedFromBest: false } : {}),
        },
        tripClusterStops,
      }, opzPython);
    } else {
      cpResult = await runCPSATVehicleScheduler(
        solverBlocks, timeLimitSec, log,
        vspExtraConfig,
        routeDetailsForPy,
        psClustersForPy,
        depotsForPy,
        deadheadKm,
        deadheadMin,
        deadheadArchive,
        lockedChains,
        opzPython,
      );
    }

    // Il solver ha rifiutato un turno bloccato (corsa non in orario, aggancio
    // impossibile): il messaggio è già scritto per l'operatore, passa com'è.
    if (cpResult && typeof cpResult.error === "string" && cpResult.error) {
      log.info(`Solver: ${cpResult.error}`);
      return { codice: 422, corpo: { error: cpResult.error, errorKind: cpResult.errorKind ?? "solver" } };
    }

    // 7. Compute costs & score from CP-SAT shifts (reuse existing functions)
    const cpShifts: VehicleShift[] = cpResult.vehicleShifts || [];

    // 7b. Residenza di servizio per turno. Se il SOLVER ha già domiciliato i
    // turni (multi-deposito con cap hard, tratte uscita/rientro incluse) usiamo
    // la sua assegnazione; altrimenti fallback geometrico legacy.
    const solverAssigned = cpShifts.length > 0 && cpShifts.every((s: any) => s.residenzaDepotId);
    const depotCounts = solverAssigned
      ? cpShifts.reduce((m: Map<string, number>, s: any) => {
          m.set(s.residenzaDepotId, (m.get(s.residenzaDepotId) ?? 0) + 1);
          return m;
        }, new Map<string, number>())
      : assignResidenzaToShifts(cpShifts, tripBlocks, depotPoints, depotSel?.caps);

    const totalServiceMin = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalServiceMin, 0);
    const totalDeadheadMin = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalDeadheadMin, 0);
    const totalDeadheadKm = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalDeadheadKm, 0);
    const totalServiceHours = +(totalServiceMin / 60).toFixed(1);

    const costs = calculateCosts(cpShifts, tripBlocks.length, totalServiceHours);
    const score = calculateScore(cpShifts, tripBlocks.length, totalServiceMin, totalDeadheadMin, totalDeadheadKm, costs);

    // Hourly distribution
    const hourlyDist: { hour: number; trips: number }[] = [];
    for (let h = 4; h <= 26; h++) {
      hourlyDist.push({ hour: h, trips: tripBlocks.filter(t => Math.floor(t.departureMin / 60) === h).length });
    }

    const advisories = generateAdvisories(cpShifts, tripBlocks, costs, score, hourlyDist);
    // Vincolo flotta HARD: se il solver non ha potuto rispettare i cap per
    // deposito, riportiamo l'infeasibility come advisory CRITICA con il deficit.
    const fleetInfo = cpResult.metrics?.fleetInfeasibility;
    if (fleetInfo) {
      const perDep = Array.isArray(fleetInfo.perDepot) && fleetInfo.perDepot.length > 0
        ? ` Depositi oltre capacità: ${fleetInfo.perDepot.map((p: any) => `${p.name} ${p.vehicles}/${p.cap}`).join(", ")}.`
        : "";
      advisories.unshift({
        id: "fleet-infeasible",
        severity: "critical",
        category: "fleet",
        title: "Flotta insufficiente per il servizio",
        description: `Servono ${fleetInfo.required} veicoli ma la flotta disponibile nei depositi selezionati è ${fleetInfo.available} (mancano ${fleetInfo.deficit}).${perDep}`,
        impact: `${fleetInfo.deficit} veicol${fleetInfo.deficit === 1 ? "o" : "i"} mancant${fleetInfo.deficit === 1 ? "e" : "i"}`,
        action: "Aumenta le vetture disponibili nei depositi, aggiungi un deposito o riduci le linee dello scenario.",
        metric: fleetInfo.deficit,
      });
    } else if (!solverAssigned && depotSel?.caps.size) {
      // Fallback geometrico legacy: cap morbido → advisory warning
      const capAdv = depotCapacityAdvisory(depotCounts, depotSel.caps, depotPoints);
      if (capAdv) advisories.unshift(capAdv);
    }

    // Summary
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = { urbano: 0, extraurbano: 0 };
    let totalDepotReturns = 0;
    for (const s of cpShifts) {
      byType[s.vehicleType] = (byType[s.vehicleType] || 0) + 1;
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      totalDepotReturns += s.depotReturns;
    }

    const summary = {
      date: dateYMD,
      activeServices: activeServices.size,
      totalTrips: tripBlocks.length,
      selectedRoutes: selectedRouteIds.size,
      totalVehicles: cpShifts.length,
      byType, byCategory,
      totalServiceHours,
      totalDeadheadHours: +(totalDeadheadMin / 60).toFixed(1),
      totalDeadheadKm: +totalDeadheadKm.toFixed(1),
      depotReturns: totalDepotReturns,
      efficiency: totalServiceMin > 0
        ? +((totalServiceMin / (totalServiceMin + totalDeadheadMin)) * 100).toFixed(1)
        : 0,
      downsizedTrips: cpShifts.reduce((s: number, v: VehicleShift) => s + v.downsizedTrips, 0),
      // Multi-deposito: veicoli domiciliati per deposito (dal solver, cap hard)
      byDepot: cpResult.metrics?.depotAssignment?.perDepot
        ?? Array.from(depotCounts.entries()).map(([id, n]) => ({
          id, name: depotPoints.find(p => p.id === id)?.name ?? "Deposito",
          vehicles: n, cap: depotSel?.caps.get(id) ?? null,
        })),
    };

    // Route stats
    const routeStats: any[] = [];
    for (const [routeId, vType] of Object.entries(routeVehicleMap)) {
      const routeTrips = tripBlocks.filter(tb => tb.routeId === routeId);
      if (routeTrips.length === 0) continue;
      const vehiclesForRoute = new Set<string>();
      for (const s of cpShifts) {
        if (s.trips.some((t: any) => t.routeId === routeId)) vehiclesForRoute.add(s.vehicleId);
      }
      routeTrips.sort((a, b) => a.departureMin - b.departureMin);
      const rName = routeNameMap.get(routeId) || routeId;
      routeStats.push({
        routeId, routeName: rName, vehicleType: vType,
        category: getServiceCategory(rName),
        tripsCount: routeTrips.length, vehiclesNeeded: vehiclesForRoute.size,
        firstDeparture: routeTrips[0].departureTime,
        lastArrival: routeTrips[routeTrips.length - 1].arrivalTime,
      });
    }
    routeStats.sort((a: any, b: any) => b.tripsCount - a.tripsCount);

    return { codice: 200, corpo: {
      solver: mode === "vcsp" ? "vcsp" : "cpsat",
      shifts: cpShifts,
      // Le corse escluse dall'operatore risultano SCOPERTE (il CP-SAT copre tutte
      // le altre che riceve, quindi qui l'unica non-copertura è quella voluta).
      unassigned: excludedBlocks,
      routeStats,
      hourlyDist,
      summary,
      costs,
      score,
      advisories,
      solverMetrics: cpResult.metrics,
      costBreakdown: cpResult.costBreakdown || null,
      greedyComparison: cpResult.greedyComparison || null,
      // VCSP: KPI dei round, feedback costi-ombra e turni guida del best round
      ...(cpResult.vcsp ? { vcsp: cpResult.vcsp } : {}),
    } };
  } catch (err: any) {
    // stop o tempo massimo: chi ha lanciato decide (il gestore del lavoro)
    if (err instanceof CalcoloInterrotto) return { codice: 500, corpo: { error: err.message }, motivo: err.motivo };
    log.error(err, "Error in CP-SAT service-program");
    return { codice: 500, corpo: { error: err.message || "Errore nel solver CP-SAT" } };
  }
}
