/**
 * DRIVER SHIFTS — Turni Guida Urbani (con Cambi in Linea)
 *
 * Genera turni guida a partire da uno scenario turni macchina salvato.
 *
 * === NORMATIVA CONTRATTUALE ===
 *  INTERO:      nastro ≤ 7h15, unica ripresa
 *  SEMIUNICO:   2 riprese, interruzione 1h15–2h59, nastro ≤ 9h15, max ~12%
 *  SPEZZATO:    2 riprese, interruzione ≥ 3h00, nastro ≤ 10h30, max ~13%
 *  SUPPLEMENTO: nastro ≤ 2h30
 *
 *  Pre-turno: 12 min prima di ogni ripresa
 *  Target lavoro effettivo: 6h30–6h42
 *
 * === CAMBI IN LINEA ===
 *  In determinati cluster (zone con più capolinea), i conducenti possono
 *  scambiarsi il veicolo durante il servizio ("cambio in linea").
 *
 *  Cluster Ancona:
 *    1. Piazza Ugo Bassi
 *    2. Stazione FS
 *    3. Piazza Cavour (include Piazza Stamira, Via Vecchini)
 *    4. Piazza IV Novembre
 *    5. Tavernelle Capolinea
 *    6. Ospedale Regionale di Torrette (capolinea linee 30, 31, 35)
 *
 *  Deposito: Via Bocconi 35, Ancona
 *    → 10 min verso tutti i cluster centrali
 *    → 15 min verso fermate fuori zona centrale
 *
 *  5 autovetture aziendali per trasferimenti deposito ↔ cluster.
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { serviceProgramScenarios, stopClusters, stopClusterStops, appSettings, gtfsStopTimes, driverShiftScenarios } from "@workspace/db/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import { spawn } from "node:child_process";
import path from "node:path";
import { jobManager } from "../lib/job-manager.js";
import { strictLimiter } from "../middlewares/rate-limit";

// Scripts are at the monorepo root: ../../scripts relative to api-server/
// process.cwd() is artifacts/api-server when started via start-backend.sh,
// so we go up two levels to reach the monorepo root.
const SCRIPTS_DIR = path.resolve(process.cwd(), "..", "..", "scripts");

const router: IRouter = Router();

/* ═══════════════════════════════════════════════════════════════
 *  CONSTANTS & RULES
 * ═══════════════════════════════════════════════════════════════ */

const PRE_SHIFT_MIN = 12;
const TARGET_WORK_LOW  = 390;   // 6h30
const TARGET_WORK_HIGH = 402;   // 6h42
const COMPANY_CARS = 5;

const SHIFT_RULES = {
  intero:      { maxNastro: 435, maxPct: 100, intMin: 0,   intMax: 0   },
  semiunico:   { maxNastro: 555, maxPct: 12,  intMin: 75,  intMax: 179 },
  spezzato:    { maxNastro: 630, maxPct: 13,  intMin: 180, intMax: 999 },
  supplemento: { maxNastro: 150, maxPct: 100, intMin: 0,   intMax: 0   },
} as const;

type ShiftType = keyof typeof SHIFT_RULES;

const DEPOT_TRANSFER_CENTRAL = 10;
const DEPOT_TRANSFER_OUTER   = 15;

/* ═══════════════════════════════════════════════════════════════
 *  CLUSTER DI CAMBIO IN LINEA
 * ═══════════════════════════════════════════════════════════════ */

interface Cluster {
  id: string;
  name: string;
  keywords: string[];
  transferFromDepotMin: number;
}

const CLUSTERS: Cluster[] = [
  { id: "ugo_bassi",   name: "Piazza Ugo Bassi",    keywords: ["UGO BASSI", "U.BASSI"],                   transferFromDepotMin: 10 },
  { id: "stazione",    name: "Stazione FS",          keywords: ["STAZIONE F", "STAZIONE FS", "TRAIN STATION"], transferFromDepotMin: 10 },
  { id: "cavour",      name: "Piazza Cavour",        keywords: ["CAVOUR", "STAMIRA", "VECCHINI"],           transferFromDepotMin: 10 },
  { id: "4_novembre",  name: "Piazza IV Novembre",   keywords: ["IV NOVEMBRE", "4 NOVEMBRE"],               transferFromDepotMin: 10 },
  { id: "tavernelle",  name: "Tavernelle",           keywords: ["TAVERNELLE"],                               transferFromDepotMin: 10 },
  { id: "torrette",    name: "Ospedale Torrette",    keywords: ["OSPEDALE REGIONALE", "TORRETTE"],           transferFromDepotMin: 15 },
];

function matchCluster(stopName: string | undefined | null): string | null {
  if (!stopName) return null;
  const up = stopName.toUpperCase();
  for (const c of CLUSTERS) {
    for (const kw of c.keywords) {
      if (up.includes(kw)) return c.id;
    }
  }
  return null;
}

function clusterById(id: string): Cluster | undefined {
  return CLUSTERS.find(c => c.id === id);
}

function depotTransfer(stopName: string | undefined | null): number {
  const cl = matchCluster(stopName);
  return cl ? (clusterById(cl)?.transferFromDepotMin ?? DEPOT_TRANSFER_CENTRAL) : DEPOT_TRANSFER_OUTER;
}

/**
 * Carica i cluster dal DB. Se non ce ne sono, restituisce i cluster hardcoded
 * (CLUSTERS) convertiti nel formato Python-compatibile.
 */
async function loadClustersForPython(): Promise<any[]> {
  try {
    const dbClusters = await db.select().from(stopClusters).orderBy(stopClusters.name);
    if (dbClusters.length === 0) {
      // Fallback ai cluster hardcoded
      return CLUSTERS.map(c => ({
        id: c.id,
        name: c.name,
        keywords: c.keywords,
        transferFromDepotMin: c.transferFromDepotMin,
        stopIds: [],
        stopNames: [],
        stopLats: [],
        stopLons: [],
        color: "#3b82f6",
      }));
    }
    const allStops = await db.select().from(stopClusterStops);
    return dbClusters.map(c => {
      const cStops = allStops.filter(s => s.clusterId === c.id);
      return {
        id: c.id,
        name: c.name,
        keywords: [],  // Non servono: il Python matcha per stop_id
        transferFromDepotMin: c.transferFromDepotMin,
        stopIds: cStops.map(s => s.gtfsStopId),
        stopNames: cStops.map(s => s.stopName),
        stopLats: cStops.map(s => s.stopLat),
        stopLons: cStops.map(s => s.stopLon),
        color: c.color || "#3b82f6",
      };
    });
  } catch (err) {
    console.error("Error loading clusters from DB, using defaults:", err);
    return CLUSTERS.map(c => ({
      id: c.id,
      name: c.name,
      keywords: c.keywords,
      transferFromDepotMin: c.transferFromDepotMin,
      stopIds: [],
      stopNames: [],
      stopLats: [],
      stopLons: [],
      color: "#3b82f6",
    }));
  }
}

/** Carica il numero di autovetture aziendali dal DB */
async function loadCompanyCars(): Promise<number> {
  try {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "company_cars"));
    if (row) {
      const val = typeof row.value === "number" ? row.value : parseInt(String(row.value), 10);
      return isNaN(val) ? COMPANY_CARS : val;
    }
  } catch { /* ignore */ }
  return COMPANY_CARS;
}

/**
 * Arricchisce i trip di ogni vehicle shift con le fermate intermedie
 * che appartengono a un cluster (clusterStops).
 * 
 * Batch query: gtfs_stop_times JOIN stop_cluster_stops per tutti i trip_id
 * di tutti i turni. Risultato: per ogni trip, lista di fermate intermedie
 * (esclusi capolinea partenza/arrivo) che stanno in un cluster.
 */
async function enrichTripsWithClusterStops(
  vehicleShifts: VehicleShift[],
  logger?: { info: (...a: any[]) => void },
): Promise<void> {
  // 1. Raccogli tutti i tripId da tutti i turni
  const allTripIds: string[] = [];
  for (const vs of vehicleShifts) {
    for (const t of vs.trips) {
      if (t.type === "trip" && t.tripId) {
        allTripIds.push(t.tripId);
      }
    }
  }
  if (allTripIds.length === 0) return;

  // 2. Carica tutti gli stop_id che appartengono a un cluster
  const clusterStopsDb = await db.select().from(stopClusterStops);
  const clusterStopIds = new Set(clusterStopsDb.map(s => s.gtfsStopId));
  if (clusterStopIds.size === 0) {
    logger?.info("enrichTripsWithClusterStops: no cluster stops in DB, skipping");
    return;
  }

  // Mappa stop_id → cluster info
  const stopToCluster = new Map<string, { clusterId: string; stopName: string }>();
  for (const cs of clusterStopsDb) {
    stopToCluster.set(cs.gtfsStopId, { clusterId: cs.clusterId, stopName: cs.stopName });
  }

  // 3. Batch query: fetch stop_times per tutti i trip (batch da 500)
  const BATCH = 500;
  const tripStopMap = new Map<string, Array<{ stopId: string; stopSequence: number; arrivalTime: string | null; departureTime: string | null }>>();

  for (let i = 0; i < allTripIds.length; i += BATCH) {
    const batch = allTripIds.slice(i, i + BATCH);
    const rows = await db.select({
      tripId: gtfsStopTimes.tripId,
      stopId: gtfsStopTimes.stopId,
      stopSequence: gtfsStopTimes.stopSequence,
      arrivalTime: gtfsStopTimes.arrivalTime,
      departureTime: gtfsStopTimes.departureTime,
    }).from(gtfsStopTimes)
      .where(inArray(gtfsStopTimes.tripId, batch));

    for (const r of rows) {
      if (!clusterStopIds.has(r.stopId)) continue; // solo fermate in cluster
      let arr = tripStopMap.get(r.tripId);
      if (!arr) { arr = []; tripStopMap.set(r.tripId, arr); }
      arr.push(r);
    }
  }

  // 4. Per ogni trip, aggiungi clusterStops (escludi prima e ultima fermata)
  for (const vs of vehicleShifts) {
    for (const t of vs.trips as any[]) {
      if (t.type !== "trip" || !t.tripId) continue;
      const stops = tripStopMap.get(t.tripId);
      if (!stops || stops.length === 0) {
        t.clusterStops = [];
        continue;
      }

      // Ordina per stop_sequence
      stops.sort((a, b) => a.stopSequence - b.stopSequence);

      // Escludi prima e ultima fermata (capolinea)
      const firstSeq = stops.length > 0 ? Math.min(...stops.map(s => s.stopSequence)) : -1;
      const lastSeq = stops.length > 0 ? Math.max(...stops.map(s => s.stopSequence)) : -1;

      // Prendiamo TUTTE le stop_times di questa corsa per sapere prima/ultima seq
      // Ma abbiamo solo le fermate filtrate per cluster. Per escludere capolinea,
      // confrontiamo con firstStopName/lastStopName se esistono, oppure seq bounds.
      // Approccio semplice: escludiamo fermata con seq == firstSeq se corrisponde al primo capolinea.
      // In realtà includiamo tutto, perché il capolinea potrebbe non essere in cluster.
      t.clusterStops = stops.map(s => {
        const ci = stopToCluster.get(s.stopId);
        return {
          stopId: s.stopId,
          stopName: ci?.stopName ?? s.stopId,
          stopSequence: s.stopSequence,
          clusterId: ci?.clusterId ?? "",
          arrivalTime: s.arrivalTime ?? "",
          departureTime: s.departureTime ?? "",
        };
      });
    }
  }

  const enriched = [...tripStopMap.values()].reduce((sum, v) => sum + v.length, 0);
  logger?.info(`enrichTripsWithClusterStops: ${enriched} cluster stops across ${tripStopMap.size}/${allTripIds.length} trips`);
}

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

interface VTrip {
  type: "trip" | "deadhead" | "depot";
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  firstStopName?: string;
  lastStopName?: string;
  firstStopLat?: number;
  firstStopLon?: number;
  lastStopLat?: number;
  lastStopLon?: number;
  stopCount?: number;
  durationMin?: number;
  deadheadKm?: number;
  deadheadMin?: number;
  directionId?: number;
  downsized?: boolean;
  originalVehicle?: string;
}

interface VehicleShift {
  vehicleId: string;
  vehicleType: string;
  category: string;
  trips: VTrip[];
  startMin: number;
  endMin: number;
  totalServiceMin: number;
  totalDeadheadMin: number;
  totalDeadheadKm: number;
  depotReturns: number;
  tripCount: number;
  fifoOrder: number;
  firstOut: number;
  lastIn: number;
  shiftDuration: number;
  downsizedTrips: number;
}

interface Segment {
  idx: number;
  vehicleId: string;
  vehicleType: string;
  trips: VTrip[];
  startMin: number;
  endMin: number;
  durationMin: number;
  drivingMin: number;
  firstStop: string;
  lastStop: string;
  firstCluster: string | null;
  lastCluster: string | null;
}

interface RBlock {
  segment: Segment;
  cambio?: { cluster: string; clusterName: string; fromVehicle: string; toVehicle: string };
}

interface Ripresa {
  blocks: RBlock[];
  startMin: number;
  endMin: number;
  preTurnoMin: number;
  transferMin: number;
  transferType: "auto" | "bus" | "piedi";
  workMin: number;
}

interface DriverShift {
  driverId: string;
  type: ShiftType;
  riprese: Ripresa[];
  nastroStart: number;
  nastroEnd: number;
  nastroMin: number;
  workMin: number;
  interruptionMin: number;
  transferMin: number;
  preTurnoMin: number;
  cambiCount: number;
}

interface Summary {
  totalDriverShifts: number;  // Autisti = turni principali (intero + semiunico + spezzato)
  totalSupplementi?: number;   // Supplementi = straordinari
  totalShifts?: number;        // Tutti i turni
  byType: Record<ShiftType, number>;
  totalWorkHours: number;
  avgWorkMin: number;
  totalNastroHours: number;
  avgNastroMin: number;
  semiunicoPct: number;
  spezzatoPct: number;
  totalCambi: number;
  companyCarsUsed: number;
}

/* ═══════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════ */

function minToTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function fmtDur(m: number): string {
  return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;
}

function tripDriving(trips: VTrip[]): number {
  let d = 0;
  for (const t of trips) d += t.arrivalMin - t.departureMin;
  return d;
}

/* ═══════════════════════════════════════════════════════════════
 *  STEP 1 — Build atomic Segments from vehicle shifts
 * ═══════════════════════════════════════════════════════════════ */

function makeSegment(idx: number, vehicleId: string, vehicleType: string, trips: VTrip[]): Segment {
  const first = trips[0];
  const last = trips[trips.length - 1];
  const firstStop = first.firstStopName || "?";
  const lastStop = last.lastStopName || "?";
  return {
    idx, vehicleId, vehicleType, trips,
    startMin: first.departureMin,
    endMin: last.arrivalMin,
    durationMin: last.arrivalMin - first.departureMin,
    drivingMin: tripDriving(trips),
    firstStop, lastStop,
    firstCluster: matchCluster(firstStop),
    lastCluster: matchCluster(lastStop),
  };
}

function buildSegments(vehicleShifts: VehicleShift[]): Segment[] {
  const segments: Segment[] = [];
  let idx = 0;

  for (const shift of vehicleShifts) {
    if (shift.category !== "urbano") continue;

    const trips = shift.trips
      .filter(t => t.type === "trip")
      .sort((a, b) => a.departureMin - b.departureMin);
    if (trips.length === 0) continue;

    let currentTrips: VTrip[] = [trips[0]];

    for (let i = 1; i < trips.length; i++) {
      const prev = trips[i - 1];
      const curr = trips[i];
      const gap = curr.departureMin - prev.arrivalMin;

      const prevLastCluster = matchCluster(prev.lastStopName);
      const currFirstCluster = matchCluster(curr.firstStopName);

      // Split when gap is large enough for a real cambio (≥5 min at cluster) or big gap otherwise
      const atCluster = prevLastCluster !== null || currFirstCluster !== null;
      if ((atCluster && gap >= 5) || gap >= 20) {
        segments.push(makeSegment(idx++, shift.vehicleId, shift.vehicleType, currentTrips));
        currentTrips = [curr];
      } else {
        currentTrips.push(curr);
      }
    }

    if (currentTrips.length > 0) {
      segments.push(makeSegment(idx++, shift.vehicleId, shift.vehicleType, currentTrips));
    }
  }

  return segments;
}

/* ═══════════════════════════════════════════════════════════════
 *  STEP 2 — Greedy shift builder with cambio in linea
 * ═══════════════════════════════════════════════════════════════ */

const CAMBIO_TIME_MIN = 3;

function buildDriverShifts(vehicleShifts: VehicleShift[]): {
  driverShifts: DriverShift[];
  summary: Summary;
  unassignedSegments: Segment[];
} {
  const allSegments = buildSegments(vehicleShifts);
  allSegments.sort((a, b) => a.startMin - b.startMin);

  const used = new Set<number>();
  const shifts: DriverShift[] = [];
  let driverN = 0;

  function canChain(a: Segment, b: Segment): { ok: boolean; cambio: boolean; cluster: string | null; gap: number } {
    const gap = b.startMin - a.endMin;
    if (gap < 0) return { ok: false, cambio: false, cluster: null, gap };
    if (gap >= 75) return { ok: false, cambio: false, cluster: null, gap };

    // Same vehicle — always chainable with reasonable gap
    if (a.vehicleId === b.vehicleId) {
      return { ok: true, cambio: false, cluster: null, gap };
    }

    // Different vehicles: cambio in linea — last stop of A and first stop of B at same cluster
    if (a.lastCluster && b.firstCluster && a.lastCluster === b.firstCluster && gap >= CAMBIO_TIME_MIN) {
      return { ok: true, cambio: true, cluster: a.lastCluster, gap };
    }

    // Also allow if both are at ANY shared cluster (end of A OR start of B)
    if (a.lastCluster && a.lastCluster === b.firstCluster) {
      // Already handled above
    }

    return { ok: false, cambio: false, cluster: null, gap };
  }

  function ripresaWork(blocks: RBlock[], transferMin: number): number {
    let w = PRE_SHIFT_MIN + transferMin;
    for (const b of blocks) w += b.segment.drivingMin;
    for (let i = 1; i < blocks.length; i++) {
      w += blocks[i].segment.startMin - blocks[i - 1].segment.endMin;
    }
    return w;
  }

  function mkRipresa(blocks: RBlock[]): Ripresa {
    const firstStop = blocks[0].segment.firstStop;
    const transfer = depotTransfer(firstStop);
    const start = blocks[0].segment.startMin - PRE_SHIFT_MIN - transfer;
    const end = blocks[blocks.length - 1].segment.endMin;
    return {
      blocks, startMin: start, endMin: end,
      preTurnoMin: PRE_SHIFT_MIN, transferMin: transfer, transferType: "auto",
      workMin: ripresaWork(blocks, transfer),
    };
  }

  /* ── Pass 1: Build INTERO shifts (priorità massima) ── */
  // Tentiamo di costruire il maggior numero di turni INTERO possibile.
  // Ogni turno parte da un segmento e il greedy aggiunge segmenti concatenabili
  // (stesso veicolo o cambio in linea) fino al target di lavoro.
  for (let i = 0; i < allSegments.length; i++) {
    if (used.has(allSegments[i].idx)) continue;

    const firstSeg = allSegments[i];
    const transfer = depotTransfer(firstSeg.firstStop);
    const nastroStartCand = firstSeg.startMin - PRE_SHIFT_MIN - transfer;

    const blocks: RBlock[] = [{ segment: firstSeg }];
    const usedHere: number[] = [firstSeg.idx];
    let currentEnd = firstSeg.endMin;
    let totalWork = PRE_SHIFT_MIN + transfer + firstSeg.drivingMin;

    let searching = true;
    while (searching) {
      searching = false;
      let bestJ = -1;
      let bestScore = Infinity;
      let bestChain: { cambio: boolean; cluster: string | null; gap: number } | null = null;

      for (let j = 0; j < allSegments.length; j++) {
        const cand = allSegments[j];
        if (used.has(cand.idx) || usedHere.includes(cand.idx)) continue;
        if (cand.startMin < currentEnd - 1) continue;

        const chain = canChain(blocks[blocks.length - 1].segment, cand);
        if (!chain.ok) continue;

        const candNastro = cand.endMin - nastroStartCand;
        const candWork = totalWork + cand.drivingMin + chain.gap;

        if (candNastro > SHIFT_RULES.intero.maxNastro) continue;
        if (candWork > SHIFT_RULES.intero.maxNastro) continue;

        // Scoring: prefer filling towards target
        let score: number;
        if (totalWork < TARGET_WORK_LOW) {
          if (candWork <= TARGET_WORK_HIGH) {
            score = Math.abs(candWork - TARGET_WORK_LOW) + chain.gap * 0.1;
          } else {
            score = (candWork - TARGET_WORK_HIGH) * 2 + chain.gap * 0.1;
          }
        } else {
          score = Math.abs(candWork - TARGET_WORK_HIGH) * 2 + chain.gap * 0.2;
          if (candWork > TARGET_WORK_HIGH) score += (candWork - TARGET_WORK_HIGH) * 5;
        }

        if (score < bestScore) {
          bestScore = score;
          bestJ = j;
          bestChain = chain;
        }
      }

      if (bestJ >= 0 && bestChain) {
        const nextSeg = allSegments[bestJ];
        const block: RBlock = { segment: nextSeg };
        if (bestChain.cambio && bestChain.cluster) {
          const cl = clusterById(bestChain.cluster);
          block.cambio = {
            cluster: bestChain.cluster,
            clusterName: cl?.name || bestChain.cluster,
            fromVehicle: blocks[blocks.length - 1].segment.vehicleId,
            toVehicle: nextSeg.vehicleId,
          };
        }
        blocks.push(block);
        usedHere.push(nextSeg.idx);
        totalWork += nextSeg.drivingMin + bestChain.gap;
        currentEnd = nextSeg.endMin;
        searching = true;
      }
    }

    const nastroEnd = currentEnd;
    const nastroMin = nastroEnd - nastroStartCand;

    // Accept as INTERO if work >= 120 min (2h) — anything shorter goes to later passes
    if (nastroMin <= SHIFT_RULES.intero.maxNastro && totalWork >= 120) {
      for (const x of usedHere) used.add(x);
      driverN++;
      const rip = mkRipresa(blocks);
      const cambi = blocks.filter(b => b.cambio).length;
      shifts.push({
        driverId: `AUT-U${String(driverN).padStart(3, "0")}`,
        type: "intero",
        riprese: [rip],
        nastroStart: nastroStartCand, nastroEnd, nastroMin,
        workMin: totalWork, interruptionMin: 0,
        transferMin: rip.transferMin, preTurnoMin: PRE_SHIFT_MIN,
        cambiCount: cambi,
      });
    }
  }

  /* ── Pass 2: SEMIUNICO (priorità 2) — accoppia residui con pausa 1h15–2h59 ── */
  function buildRemainingGroups(): { blocks: RBlock[]; idxs: number[] }[] {
    const rem = allSegments.filter(s => !used.has(s.idx)).sort((a, b) => a.startMin - b.startMin);
    const groups: { blocks: RBlock[]; idxs: number[] }[] = [];
    const groupUsed = new Set<number>();
    for (let i = 0; i < rem.length; i++) {
      const seg = rem[i];
      if (used.has(seg.idx) || groupUsed.has(seg.idx)) continue;
      const blocks: RBlock[] = [{ segment: seg }];
      const idxs = [seg.idx];
      groupUsed.add(seg.idx);
      for (let j = i + 1; j < rem.length; j++) {
        const c = rem[j];
        if (used.has(c.idx) || groupUsed.has(c.idx)) continue;
        const chain = canChain(blocks[blocks.length - 1].segment, c);
        if (!chain.ok) continue;
        const bl: RBlock = { segment: c };
        if (chain.cambio && chain.cluster) {
          const cl = clusterById(chain.cluster);
          bl.cambio = { cluster: chain.cluster, clusterName: cl?.name || chain.cluster, fromVehicle: blocks[blocks.length - 1].segment.vehicleId, toVehicle: c.vehicleId };
        }
        blocks.push(bl);
        idxs.push(c.idx);
        groupUsed.add(c.idx);
        const w = ripresaWork(blocks, depotTransfer(blocks[0].segment.firstStop));
        if (w > TARGET_WORK_HIGH) break;
      }
      groups.push({ blocks, idxs });
    }
    return groups;
  }

  function pairGroups(targetType: "semiunico" | "spezzato") {
    const groups = buildRemainingGroups();
    const paired = new Set<number>();
    const rule = SHIFT_RULES[targetType];
    for (let i = 0; i < groups.length; i++) {
      if (paired.has(i) || groups[i].idxs.some(x => used.has(x))) continue;
      const first = groups[i];
      const firstRip = mkRipresa(first.blocks);
      let bestJ = -1;
      let bestScore = Infinity;
      for (let j = i + 1; j < groups.length; j++) {
        if (paired.has(j) || groups[j].idxs.some(x => used.has(x))) continue;
        const second = groups[j];
        const secondRip = mkRipresa(second.blocks);
        const rawGap = second.blocks[0].segment.startMin - first.blocks[first.blocks.length - 1].segment.endMin;
        const effectiveInt = rawGap - PRE_SHIFT_MIN - secondRip.transferMin;
        if (effectiveInt < rule.intMin || effectiveInt > rule.intMax) continue;
        const nastro = secondRip.endMin - firstRip.startMin;
        if (nastro > rule.maxNastro) continue;
        const work = firstRip.workMin + secondRip.workMin;
        const score = Math.abs(work - (TARGET_WORK_LOW + TARGET_WORK_HIGH) / 2);
        if (score < bestScore) { bestScore = score; bestJ = j; }
      }
      if (bestJ >= 0) {
        const second = groups[bestJ];
        const secondRip = mkRipresa(second.blocks);
        const rawGap = second.blocks[0].segment.startMin - first.blocks[first.blocks.length - 1].segment.endMin;
        const effectiveInt = rawGap - PRE_SHIFT_MIN - secondRip.transferMin;
        for (const x of first.idxs) used.add(x);
        for (const x of second.idxs) used.add(x);
        paired.add(i); paired.add(bestJ);
        driverN++;
        const cambi = [...first.blocks, ...second.blocks].filter(b => b.cambio).length;
        shifts.push({
          driverId: `AUT-U${String(driverN).padStart(3, "0")}`,
          type: targetType, riprese: [firstRip, secondRip],
          nastroStart: firstRip.startMin, nastroEnd: secondRip.endMin,
          nastroMin: secondRip.endMin - firstRip.startMin,
          workMin: firstRip.workMin + secondRip.workMin, interruptionMin: effectiveInt,
          transferMin: firstRip.transferMin + secondRip.transferMin,
          preTurnoMin: PRE_SHIFT_MIN * 2, cambiCount: cambi,
        });
      }
    }
  }

  // Pass 2: semiunici first (interruzione 1h15–2h59)
  pairGroups("semiunico");

  // Pass 3: spezzati (interruzione ≥ 3h)
  pairGroups("spezzato");

  /* ── Pass 4: SUPPLEMENTO — residui (pezzi di turno macchina rimasti fuori) ── */
  const still = allSegments.filter(s => !used.has(s.idx)).sort((a, b) => a.startMin - b.startMin);
  let si = 0;
  while (si < still.length) {
    const seg = still[si];
    if (used.has(seg.idx)) { si++; continue; }

    // Try to chain consecutive remaining segments
    const blocks: RBlock[] = [{ segment: seg }];
    const idxs = [seg.idx];

    for (let sj = si + 1; sj < still.length; sj++) {
      const c = still[sj];
      if (used.has(c.idx) || idxs.includes(c.idx)) continue;
      const chain = canChain(blocks[blocks.length - 1].segment, c);
      if (!chain.ok) continue;
      const bl: RBlock = { segment: c };
      if (chain.cambio && chain.cluster) {
        const cl = clusterById(chain.cluster);
        bl.cambio = { cluster: chain.cluster, clusterName: cl?.name || chain.cluster, fromVehicle: blocks[blocks.length - 1].segment.vehicleId, toVehicle: c.vehicleId };
      }
      blocks.push(bl);
      idxs.push(c.idx);
    }

    for (const x of idxs) used.add(x);

    const rip = mkRipresa(blocks);
    const nastroMin = rip.endMin - rip.startMin;
    const cambi = blocks.filter(b => b.cambio).length;
    driverN++;

    // Supplemento: residui di turno macchina (≤ 2h30)
    if (nastroMin <= SHIFT_RULES.supplemento.maxNastro) {
      shifts.push({ driverId: `AUT-U${String(driverN).padStart(3, "0")}`, type: "supplemento", riprese: [rip], nastroStart: rip.startMin, nastroEnd: rip.endMin, nastroMin, workMin: rip.workMin, interruptionMin: 0, transferMin: rip.transferMin, preTurnoMin: PRE_SHIFT_MIN, cambiCount: cambi });
    } else if (nastroMin <= SHIFT_RULES.intero.maxNastro) {
      // Too long for supplemento but fits intero
      shifts.push({ driverId: `AUT-U${String(driverN).padStart(3, "0")}`, type: "intero", riprese: [rip], nastroStart: rip.startMin, nastroEnd: rip.endMin, nastroMin, workMin: rip.workMin, interruptionMin: 0, transferMin: rip.transferMin, preTurnoMin: PRE_SHIFT_MIN, cambiCount: cambi });
    } else {
      // Force-split blocks that exceed intero nastro
      const allTrips = blocks.flatMap(b => b.segment.trips);
      const maxSpan = SHIFT_RULES.intero.maxNastro - PRE_SHIFT_MIN - DEPOT_TRANSFER_CENTRAL;
      const chunkSize = Math.max(2, Math.ceil(allTrips.length / Math.ceil(nastroMin / maxSpan)));
      for (let c = 0; c < allTrips.length; c += chunkSize) {
        const chunk = allTrips.slice(c, c + chunkSize);
        if (chunk.length === 0) continue;
        const mini = makeSegment(allSegments.length + c, blocks[0].segment.vehicleId, blocks[0].segment.vehicleType, chunk);
        const miniRip = mkRipresa([{ segment: mini }]);
        const mn = miniRip.endMin - miniRip.startMin;
        driverN++;
        shifts.push({ driverId: `AUT-U${String(driverN).padStart(3, "0")}`, type: mn <= SHIFT_RULES.supplemento.maxNastro ? "supplemento" : "intero", riprese: [miniRip], nastroStart: miniRip.startMin, nastroEnd: miniRip.endMin, nastroMin: mn, workMin: miniRip.workMin, interruptionMin: 0, transferMin: miniRip.transferMin, preTurnoMin: PRE_SHIFT_MIN, cambiCount: 0 });
      }
    }
    si++;
  }

  shifts.sort((a, b) => a.nastroStart - b.nastroStart);
  const unassigned = allSegments.filter(s => !used.has(s.idx));

  const byType: Record<ShiftType, number> = { intero: 0, semiunico: 0, spezzato: 0, supplemento: 0 };
  for (const s of shifts) byType[s.type]++;
  const totalShifts = shifts.length;
  const totalSuppl = byType.supplemento;
  const totalDrivers = totalShifts - totalSuppl;  // Autisti = turni principali
  const totalWork = shifts.reduce((s, d) => s + d.workMin, 0);
  const totalNastro = shifts.reduce((s, d) => s + d.nastroMin, 0);
  const totalCambi = shifts.reduce((s, d) => s + d.cambiCount, 0);
  const companyCarsUsed = Math.min(COMPANY_CARS, Math.ceil(totalDrivers / 10));

  return {
    driverShifts: shifts,
    summary: {
      totalDriverShifts: totalDrivers,
      totalSupplementi: totalSuppl,
      totalShifts: totalShifts,
      byType,
      totalWorkHours: +(totalWork / 60).toFixed(1),
      avgWorkMin: totalShifts > 0 ? +(totalWork / totalShifts).toFixed(0) : 0,
      totalNastroHours: +(totalNastro / 60).toFixed(1),
      avgNastroMin: totalShifts > 0 ? +(totalNastro / totalShifts).toFixed(0) : 0,
      semiunicoPct: totalDrivers > 0 ? +(byType.semiunico / totalDrivers * 100).toFixed(1) : 0,
      spezzatoPct: totalDrivers > 0 ? +(byType.spezzato / totalDrivers * 100).toFixed(1) : 0,
      totalCambi, companyCarsUsed,
    },
    unassignedSegments: unassigned,
  };
}

/* ═══════════════════════════════════════════════════════════════
 *  SERIALIZATION
 * ═══════════════════════════════════════════════════════════════ */

function serializeShifts(driverShifts: DriverShift[]) {
  return driverShifts.map(ds => ({
    driverId: ds.driverId,
    type: ds.type,
    nastroStart: minToTime(ds.nastroStart),
    nastroEnd: minToTime(ds.nastroEnd),
    nastroStartMin: ds.nastroStart,
    nastroEndMin: ds.nastroEnd,
    nastroMin: ds.nastroMin,
    nastro: fmtDur(ds.nastroMin),
    workMin: ds.workMin,
    work: fmtDur(ds.workMin),
    interruptionMin: ds.interruptionMin,
    interruption: ds.interruptionMin > 0 ? fmtDur(ds.interruptionMin) : null,
    transferMin: ds.transferMin,
    preTurnoMin: ds.preTurnoMin,
    cambiCount: ds.cambiCount,
    riprese: ds.riprese.map(r => ({
      startTime: minToTime(r.startMin),
      endTime: minToTime(r.endMin),
      startMin: r.startMin,
      endMin: r.endMin,
      preTurnoMin: r.preTurnoMin,
      transferMin: r.transferMin,
      transferType: r.transferType,
      workMin: r.workMin,
      vehicleIds: [...new Set(r.blocks.map(b => b.segment.vehicleId))],
      vehicleType: r.blocks[0]?.segment.vehicleType || "12m",
      cambi: r.blocks.filter(b => b.cambio).map(b => ({
        cluster: b.cambio!.cluster,
        clusterName: b.cambio!.clusterName,
        fromVehicle: b.cambio!.fromVehicle,
        toVehicle: b.cambio!.toVehicle,
        atMin: b.segment.startMin,
        atTime: minToTime(b.segment.startMin),
      })),
      trips: r.blocks.flatMap(b => b.segment.trips.map(t => ({
        tripId: t.tripId,
        routeId: t.routeId,
        routeName: t.routeName,
        headsign: t.headsign,
        departureTime: t.departureTime,
        arrivalTime: t.arrivalTime,
        departureMin: t.departureMin,
        arrivalMin: t.arrivalMin,
        firstStopName: t.firstStopName,
        lastStopName: t.lastStopName,
        vehicleId: b.segment.vehicleId,
        vehicleType: b.segment.vehicleType,
      }))),
    })),
  }));
}

/* ═══════════════════════════════════════════════════════════════
 *  ROUTES
 * ═══════════════════════════════════════════════════════════════ */

async function loadAndGenerate(scenarioId: string) {
  const [scenario] = await db.select().from(serviceProgramScenarios)
    .where(eq(serviceProgramScenarios.id, scenarioId));

  if (!scenario) return { error: "Scenario non trovato", status: 404 };

  const vehicleShifts = (scenario.result as any)?.shifts as VehicleShift[] | undefined;
  if (!vehicleShifts || vehicleShifts.length === 0)
    return { error: "Lo scenario non contiene turni macchina", status: 400 };

  const { driverShifts, summary, unassignedSegments } = buildDriverShifts(vehicleShifts);

  return {
    data: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      date: scenario.date,
      driverShifts: serializeShifts(driverShifts),
      summary,
      unassignedBlocks: unassignedSegments.length,
      clusters: CLUSTERS.map(c => ({ id: c.id, name: c.name, transferMin: c.transferFromDepotMin })),
      companyCars: COMPANY_CARS,
    },
  };
}

router.post("/driver-shifts/:scenarioId", strictLimiter, async (req, res) => {
  try {
    const result = await loadAndGenerate((req.params.scenarioId as string));
    if (result.error) { res.status(result.status!).json({ error: result.error }); return; }
    res.json(result.data);
  } catch (err: any) {
    req.log.error(err, "Error generating driver shifts");
    res.status(500).json({ error: err.message });
  }
});

router.get("/driver-shifts/:scenarioId", async (req, res) => {
  try {
    const result = await loadAndGenerate((req.params.scenarioId as string));
    if (result.error) { res.status(result.status!).json({ error: result.error }); return; }
    res.json(result.data);
  } catch (err: any) {
    req.log.error(err, "Error generating driver shifts");
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  CP-SAT CREW SCHEDULING V4 (BDS-inspired)
 *  Spawn python crew_scheduler_v4.py
 * ═══════════════════════════════════════════════════════════════ */

async function runCPSATCrewScheduler(
  vehicleShifts: VehicleShift[],
  timeLimitSec: number,
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  extraConfig?: Record<string, any>,
): Promise<any> {
  const scriptPath = path.resolve(SCRIPTS_DIR, "crew_scheduler_v4.py");

  // Carica cluster e autovetture dal DB
  const [dbClusters, dbCompanyCars] = await Promise.all([
    loadClustersForPython(),
    loadCompanyCars(),
  ]);

  // Arricchisci ogni trip con le fermate intermedie in cluster (per tagli intra-corsa)
  await enrichTripsWithClusterStops(vehicleShifts, logger);

  const result = await new Promise<string>((resolve, reject) => {
    const py = spawn("python3", [scriptPath, String(timeLimitSec)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      logger.info(`CSP stderr: ${d.toString().trim()}`);
    });

    py.on("error", (err) => reject(new Error(`Errore avvio Python: ${err.message}`)));

    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    const inputJson = JSON.stringify({
      vehicleShifts,
      config: {
        timeLimit: timeLimitSec,
        clusters: dbClusters,
        companyCars: dbCompanyCars,
        ...extraConfig,
      },
    });
    py.stdin.write(inputJson);
    py.stdin.end();
  });

  return JSON.parse(result);
}

/** POST /api/driver-shifts/:scenarioId/cpsat — CP-SAT crew scheduling (sync, legacy) */
router.post("/driver-shifts/:scenarioId/cpsat", strictLimiter, async (req, res) => {
  try {
    const timeLimitSec = (req.body as any)?.timeLimit ?? 60;

    const [scenario] = await db.select().from(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, (req.params.scenarioId as string)));

    if (!scenario) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const vehicleShifts = (scenario.result as any)?.shifts as VehicleShift[] | undefined;
    if (!vehicleShifts || vehicleShifts.length === 0) {
      res.status(400).json({ error: "Lo scenario non contiene turni macchina" }); return;
    }

    req.log.info(`CP-SAT CSP: ${vehicleShifts.length} vehicle shifts, timeLimit=${timeLimitSec}s`);

    const cpResult = await runCPSATCrewScheduler(vehicleShifts, timeLimitSec, req.log);

    res.json({
      solver: "cpsat",
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      date: scenario.date,
      driverShifts: cpResult.driverShifts || [],
      summary: cpResult.summary || {},
      unassignedBlocks: cpResult.metrics?.uncoverableTasks ?? 0,
      clusters: cpResult.clusters || CLUSTERS.map(c => ({ id: c.id, name: c.name, transferMin: c.transferFromDepotMin })),
      companyCars: cpResult.companyCars || COMPANY_CARS,
      solverMetrics: cpResult.metrics || {},
    });
  } catch (err: any) {
    req.log.error(err, "Error in CP-SAT crew scheduling");
    res.status(500).json({ error: err.message || "Errore nel solver CP-SAT turni guida" });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  ASYNC CP-SAT (Job-based) — Background processing + SSE
 * ═══════════════════════════════════════════════════════════════ */

/** POST /api/driver-shifts/:scenarioId/cpsat/async — Launch async optimization, returns 202 + jobId */
router.post("/driver-shifts/:scenarioId/cpsat/async", strictLimiter, async (req, res) => {
  try {
    const body = req.body as any || {};
    const timeLimitSec = body.timeLimit ?? 120;
    const operatorConfig = body.config ?? {};

    const [scenario] = await db.select().from(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, (req.params.scenarioId as string)));

    if (!scenario) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const vehicleShifts = (scenario.result as any)?.shifts as VehicleShift[] | undefined;
    if (!vehicleShifts || vehicleShifts.length === 0) {
      res.status(400).json({ error: "Lo scenario non contiene turni macchina" }); return;
    }

    const scriptPath = path.resolve(SCRIPTS_DIR, "crew_scheduler_v4.py");

    // Carica cluster e autovetture dal DB
    const [dbClusters, dbCompanyCars] = await Promise.all([
      loadClustersForPython(),
      loadCompanyCars(),
    ]);

    const jobId = jobManager.createJob({
      scenarioId: (req.params.scenarioId as string),
      scriptPath,
      args: [String(timeLimitSec)],
      inputJson: {
        vehicleShifts,
        config: {
          timeLimit: timeLimitSec,
          clusters: dbClusters,
          companyCars: dbCompanyCars,
          ...operatorConfig,
        },
      },
      logger: req.log,
      metadata: {
        scenarioName: scenario.name,
        date: scenario.date,
      },
    });

    req.log.info(`Async CSP job started: ${jobId}, scenario=${(req.params.scenarioId as string)}, timeLimit=${timeLimitSec}s`);

    res.status(202).json({
      jobId,
      scenarioId: (req.params.scenarioId as string),
      status: "queued",
      message: "Ottimizzazione avviata in background",
    });
  } catch (err: any) {
    req.log.error(err, "Error starting async CP-SAT job");
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/driver-shifts/jobs/:jobId/stream — SSE progress stream */
router.get("/driver-shifts/jobs/:jobId/stream", (req, res) => {
  const job = jobManager.getJob((req.params.jobId as string));
  if (!job) { res.status(404).json({ error: "Job non trovato" }); return; }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx
  res.flushHeaders();

  // Send current state immediately
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("status", {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
  });

  // If already done, send result and close
  if (job.status === "completed" || job.status === "failed" || job.status === "stopped") {
    if (job.status === "completed" && job.result) {
      const cpResult = job.result as any;
      sendEvent("result", {
        jobId: job.id,
        status: "completed",
        data: {
          solver: "cpsat",
          scenarioId: job.scenarioId,
          scenarioName: job.metadata?.scenarioName ?? "",
          date: job.metadata?.date ?? "",
          driverShifts: cpResult.driverShifts || [],
          summary: cpResult.summary || {},
          unassignedBlocks: cpResult.metrics?.uncoverableTasks ?? 0,
          clusters: cpResult.clusters || CLUSTERS.map(c => ({ id: c.id, name: c.name, transferMin: c.transferFromDepotMin })),
          companyCars: cpResult.companyCars || COMPANY_CARS,
          solverMetrics: cpResult.metrics || {},
        },
      });
    } else {
      sendEvent("error", { jobId: job.id, status: job.status, error: job.error });
    }
    res.end();
    return;
  }

  // Subscribe to progress events
  const emitter = jobManager.getJobEmitter((req.params.jobId as string));
  if (!emitter) { res.end(); return; }

  const onProgress = (evt: { jobId: string; status: string; progress: unknown }) => {
    sendEvent("progress", evt);
  };

  const onDone = () => {
    const finalJob = jobManager.getJob((req.params.jobId as string));
    if (finalJob?.status === "completed" && finalJob.result) {
      const cpResult = finalJob.result as any;
      sendEvent("result", {
        jobId: finalJob.id,
        status: "completed",
        data: {
          solver: "cpsat",
          scenarioId: finalJob.scenarioId,
          scenarioName: finalJob.metadata?.scenarioName ?? "",
          date: finalJob.metadata?.date ?? "",
          driverShifts: cpResult.driverShifts || [],
          summary: cpResult.summary || {},
          unassignedBlocks: cpResult.metrics?.uncoverableTasks ?? 0,
          clusters: cpResult.clusters || CLUSTERS.map(c => ({ id: c.id, name: c.name, transferMin: c.transferFromDepotMin })),
          companyCars: cpResult.companyCars || COMPANY_CARS,
          solverMetrics: cpResult.metrics || {},
        },
      });
    } else if (finalJob) {
      sendEvent("error", { jobId: finalJob.id, status: finalJob.status, error: finalJob.error });
    }
    cleanup();
    res.end();
  };

  const cleanup = () => {
    emitter.off("progress", onProgress);
    emitter.off("done", onDone);
  };

  emitter.on("progress", onProgress);
  emitter.on("done", onDone);

  // Client disconnect
  req.on("close", cleanup);
});

/** GET /api/driver-shifts/jobs/:jobId — Polling endpoint */
router.get("/driver-shifts/jobs/:jobId", (req, res) => {
  const job = jobManager.getJob((req.params.jobId as string));
  if (!job) { res.status(404).json({ error: "Job non trovato" }); return; }

  const response: any = {
    jobId: job.id,
    scenarioId: job.scenarioId,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (job.status === "completed" && job.result) {
    const cpResult = job.result as any;
    response.data = {
      solver: "cpsat",
      scenarioId: job.scenarioId,
      scenarioName: job.metadata?.scenarioName ?? "",
      date: job.metadata?.date ?? "",
      driverShifts: cpResult.driverShifts || [],
      summary: cpResult.summary || {},
      unassignedBlocks: cpResult.metrics?.uncoverableTasks ?? 0,
      clusters: cpResult.clusters || CLUSTERS.map(c => ({ id: c.id, name: c.name, transferMin: c.transferFromDepotMin })),
      companyCars: cpResult.companyCars || COMPANY_CARS,
      solverMetrics: cpResult.metrics || {},
    };
  } else if (job.status === "failed" || job.status === "stopped") {
    response.error = job.error;
  }

  res.json(response);
});

/** POST /api/driver-shifts/jobs/:jobId/stop — Stop a running job */
router.post("/driver-shifts/jobs/:jobId/stop", (req, res) => {
  const ok = jobManager.stopJob((req.params.jobId as string));
  if (!ok) {
    res.status(400).json({ error: "Job non trovato o non in esecuzione" });
    return;
  }
  res.json({ jobId: (req.params.jobId as string), status: "stopped" });
});

/** POST /api/driver-shifts/:scenarioId/compare — Compare greedy vs CP-SAT */
router.post("/driver-shifts/:scenarioId/compare", async (req, res) => {
  try {
    const timeLimitSec = (req.body as any)?.timeLimit ?? 60;

    // Run greedy
    const greedyResult = await loadAndGenerate((req.params.scenarioId as string));
    if (greedyResult.error) {
      res.status(greedyResult.status!).json({ error: greedyResult.error });
      return;
    }

    // Run CP-SAT
    const [scenario] = await db.select().from(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, (req.params.scenarioId as string)));
    if (!scenario) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const vehicleShifts = (scenario.result as any)?.shifts as VehicleShift[] | undefined;
    if (!vehicleShifts || vehicleShifts.length === 0) {
      res.status(400).json({ error: "Lo scenario non contiene turni macchina" }); return;
    }

    let cpsatResult: any;
    try {
      cpsatResult = await runCPSATCrewScheduler(vehicleShifts, timeLimitSec, req.log);
    } catch (cpErr: any) {
      req.log.error(cpErr, "CP-SAT failed in compare, using greedy only");
      cpsatResult = null;
    }

    const greedy = greedyResult.data!;
    const cpsat = cpsatResult ? {
      driverShifts: cpsatResult.driverShifts || [],
      summary: cpsatResult.summary || {},
      solverMetrics: cpsatResult.metrics || {},
    } : null;

    // Delta
    const delta = cpsat ? {
      driverShifts: (greedy.summary.totalDriverShifts || 0) - (cpsat.summary.totalDriverShifts || 0),
      totalWorkHours: +((greedy.summary.totalWorkHours || 0) - (cpsat.summary.totalWorkHours || 0)).toFixed(1),
      totalCambi: (greedy.summary.totalCambi || 0) - (cpsat.summary.totalCambi || 0),
    } : null;

    res.json({ greedy, cpsat, delta });
  } catch (err: any) {
    req.log.error(err, "Error in driver-shifts compare");
    res.status(500).json({ error: err.message });
  }
});


/* ═══════════════════════════════════════════════════════════════
 *  DRIVER-SHIFT SCENARIOS — CRUD
 * ═══════════════════════════════════════════════════════════════ */

// POST — save a driver-shift scenario
router.post("/driver-shifts/:scenarioId/scenarios", async (req, res) => {
  try {
    const scenarioId = req.params.scenarioId as string;
    const { name, result: dssResult, config } = req.body;
    if (!name || !dssResult) { res.status(400).json({ error: "name and result required" }); return; }
    const [row] = await db.insert(driverShiftScenarios).values({
      serviceProgramScenarioId: scenarioId,
      name,
      result: dssResult,
      config: config ?? null,
    }).returning();
    res.json(row);
  } catch (err: any) {
    req.log.error(err, "Error saving driver-shift scenario");
    res.status(500).json({ error: err.message });
  }
});

// GET — list saved driver-shift scenarios (lightweight summary)
router.get("/driver-shifts/:scenarioId/scenarios", async (req, res) => {
  try {
    const scenarioId = req.params.scenarioId as string;
    const rows = await db.select().from(driverShiftScenarios)
      .where(eq(driverShiftScenarios.serviceProgramScenarioId, scenarioId))
      .orderBy(desc(driverShiftScenarios.createdAt));
    const list = rows.map(r => {
      const res = r.result as any;
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        summary: res?.summary ?? {},
      };
    });
    res.json(list);
  } catch (err: any) {
    req.log.error(err, "Error listing driver-shift scenarios");
    res.status(500).json({ error: err.message });
  }
});

// GET — load full driver-shift scenario
router.get("/driver-shifts/:scenarioId/scenarios/:dssId", async (req, res) => {
  try {
    const [row] = await db.select().from(driverShiftScenarios)
      .where(eq(driverShiftScenarios.id, (req.params.dssId as string)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err: any) {
    req.log.error(err, "Error loading driver-shift scenario");
    res.status(500).json({ error: err.message });
  }
});

// DELETE — remove a driver-shift scenario
router.delete("/driver-shifts/:scenarioId/scenarios/:dssId", async (req, res) => {
  try {
    await db.delete(driverShiftScenarios)
      .where(eq(driverShiftScenarios.id, (req.params.dssId as string)));
    res.json({ ok: true });
  } catch (err: any) {
    req.log.error(err, "Error deleting driver-shift scenario");
    res.status(500).json({ error: err.message });
  }
});

export default router;
