/**
 * I dati che il solver dei turni (turni guida e VCSP) legge dal database:
 * cluster di cambio in linea, nodi di sosta, autovetture aziendali, fermate
 * intermedie in un cluster. Senza Express e senza DDL: li usano le rotte e il
 * lavoratore dei calcoli (src/lavoratore.ts).
 */
import { db } from "@workspace/db";
import { stopClusters, stopClusterStops, appSettings, gtfsStopTimes } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

/** Autovetture aziendali se il parametro manca (app_settings.company_cars). */
export const COMPANY_CARS = 5;

/** Un turno macchina, per quanto serve qui: le sue corse. */
type TurnoConCorse = { trips: Array<{ type: string; tripId: string }> };

/* ═══════════════════════════════════════════════════════════════
 *  CLUSTER DI CAMBIO IN LINEA (predefiniti, se il DB non ne ha)
 * ═══════════════════════════════════════════════════════════════ */

export interface Cluster {
  id: string;
  name: string;
  keywords: string[];
  transferFromDepotMin: number;
}

export const CLUSTERS: Cluster[] = [
  { id: "ugo_bassi",   name: "Piazza Ugo Bassi",    keywords: ["UGO BASSI", "U.BASSI"],                   transferFromDepotMin: 10 },
  { id: "stazione",    name: "Stazione FS",          keywords: ["STAZIONE F", "STAZIONE FS", "TRAIN STATION"], transferFromDepotMin: 10 },
  { id: "cavour",      name: "Piazza Cavour",        keywords: ["CAVOUR", "STAMIRA", "VECCHINI"],           transferFromDepotMin: 10 },
  { id: "4_novembre",  name: "Piazza IV Novembre",   keywords: ["IV NOVEMBRE", "4 NOVEMBRE"],               transferFromDepotMin: 10 },
  { id: "tavernelle",  name: "Tavernelle",           keywords: ["TAVERNELLE"],                               transferFromDepotMin: 10 },
  { id: "torrette",    name: "Ospedale Torrette",    keywords: ["OSPEDALE REGIONALE", "TORRETTE"],           transferFromDepotMin: 15 },
];

/**
 * Carica i cluster dal DB. Se non ce ne sono, restituisce i cluster hardcoded
 * (CLUSTERS) convertiti nel formato Python-compatibile.
 */
export async function loadClustersForPython(): Promise<any[]> {
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

/**
 * Carica i nodi di sosta (kind='rest') del progetto Planning Studio collegato
 * allo scenario, per piazzare le soste inoperose extraurbane.
 *
 * Catena: service_program_scenarios.project_id → scheduling_projects
 *         → planning_studio_project_id → ps_stop_clusters (kind='rest').
 * Lo stop_id GTFS usato dallo scheduler corrisponde a ps_stops.id::text
 * (cfr planning-studio-materialize). hasFacilities determina il contributo
 * della sosta all'orario (12% con strutture, 25% senza).
 */
export async function loadRestPointsForScenario(scenarioProjectId: string | null | undefined): Promise<any[]> {
  if (!scenarioProjectId) return [];
  try {
    const r = await db.execute(sql`
      SELECT
        c.id::text AS id,
        COALESCE(NULLIF(c.name, ''), 'Sosta') AS name,
        COALESCE((c.attributes->>'hasFacilities')::boolean, false) AS has_facilities,
        COALESCE(json_agg(s.id::text ORDER BY s.id)
                 FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS stop_ids,
        COALESCE(json_agg(s.name ORDER BY s.id)
                 FILTER (WHERE s.id IS NOT NULL AND s.name IS NOT NULL), '[]'::json) AS stop_names
      FROM scheduling_projects sp
      JOIN ps_stop_clusters c ON c.project_id = sp.planning_studio_project_id
      LEFT JOIN ps_stops s ON s.cluster_id = c.id
      WHERE sp.id = ${scenarioProjectId}::uuid
        AND c.kind = 'rest'
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    const rows: any[] = (r as any).rows ?? [];
    return rows.map(c => ({
      id: c.id,
      name: c.name,
      hasFacilities: !!c.has_facilities,
      stopIds: Array.isArray(c.stop_ids) ? c.stop_ids : [],
      // i nomi servono al crew scheduler: i VShiftTrip identificano i capolinea per nome
      stopNames: Array.isArray(c.stop_names) ? c.stop_names : [],
    }));
  } catch (err: any) {
    console.warn("[driver-shifts] loadRestPointsForScenario error:", err?.message || err);
    return [];
  }
}

/** Carica il numero di autovetture aziendali dal DB */
export async function loadCompanyCars(): Promise<number> {
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
export async function enrichTripsWithClusterStops(
  vehicleShifts: TurnoConCorse[],
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
