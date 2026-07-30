import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes, gtfsShapes, pointsOfInterest, censusSections } from "@workspace/db/schema";
import { sql, inArray, eq, and } from "drizzle-orm";
import { haversineKm, timeToMinutes, minToTime, walkMinutes } from "../lib/geo-utils";
import { getLatestFeedId } from "./gtfs-helpers";
import {
  resolveSource, loadShapes, loadStops, loadActiveTrips, loadPassages,
  parseDayKind, projectBbox, type DayKind,
} from "./intermodal-source";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/* Lo scoping dell'Intermodale vive in ./intermodal-source: legge il
 * PROGETTO VIVO (ps_*) invece di uno snapshot GTFS. Le vecchie
 * resolveScope/activeServiceIds risolvevano il feed materializzato o,
 * peggio, quello sorgente: sono state rimosse perché erano la causa dei
 * dati diversi da quelli del progetto. Restano qui solo gli helper che
 * non dipendono da quella risoluzione. */

/** Filtro feed riusabile (ramo GTFS, fuori da un progetto). */
export const feedWhere = (col: any, feedId: string | null) => (feedId ? eq(col, feedId) : sql`TRUE`);

export type { DayKind };
export { parseDayKind };

/** Bbox (con margine) del comune ISTAT, dai centroidi delle sezioni di censimento. */
export async function municipalityBbox(
  municipality: string,
): Promise<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null> {
  const p6 = municipality.slice(0, 6), p5 = municipality.slice(0, 5);
  const rows = await db.select({
    istatCode: censusSections.istatCode,
    centroidLat: censusSections.centroidLat,
    centroidLng: censusSections.centroidLng,
  }).from(censusSections);
  const matching = rows.filter(r => r.istatCode && (r.istatCode.slice(0, 6) === p6 || r.istatCode.slice(0, 5) === p5));
  if (matching.length === 0) return null;
  const lats = matching.map(r => r.centroidLat);
  const lngs = matching.map(r => r.centroidLng);
  const padLat = 0.02, padLng = 0.03; // ~2-3 km di margine
  return {
    minLat: Math.min(...lats) - padLat, maxLat: Math.max(...lats) + padLat,
    minLng: Math.min(...lngs) - padLng, maxLng: Math.max(...lngs) + padLng,
  };
}


// ═══════════════════════════════════════════════════════════════════════
// INTERMODAL — Analyze bus ↔ rail / ferry connections (GTFS-based)
// ═══════════════════════════════════════════════════════════════════════

// Known intermodal hubs (Province of Ancona)
// Now includes ARRIVALS (incoming trains/ferries) — the key use case:
// passenger arrives by train/ferry → walks to bus stop → catches bus to destination
/** Sorgente unica di posizione/fermate degli hub curati (vedi coincidence-zones). */
export const INTERMODAL_HUBS: {
  id: string; name: string; type: "railway" | "port" | "airport";
  lat: number; lng: number;
  gtfsStopIds: string[];
  // Departures FROM this hub (treno/nave parte)
  typicalDepartures: { destination: string; times: string[] }[];
  // Arrivals TO this hub (treno/nave arriva — passeggero scende)
  typicalArrivals: { origin: string; times: string[] }[];
  // Vista settimanale opzionale (popolata da sync-schedules per hub auto)
  weeklyDepartures?: { destination: string; times: string[] }[][];
  weeklyArrivals?: { origin: string; times: string[] }[][];
  weekStart?: string;
  description: string;
  // Walk time from platform to nearest bus stop area (minutes)
  platformWalkMinutes: number;
}[] = [
  {
    id: "rail-ancona",
    name: "Stazione FS Ancona",
    type: "railway",
    lat: 43.607348, lng: 13.49776447,
    gtfsStopIds: ["13", "18", "153", "20006", "20044"],
    description: "Stazione centrale di Ancona — hub ferroviario principale (IC, FR, Regionali)",
    platformWalkMinutes: 3, // stazione grande, dal binario all'uscita
    typicalDepartures: [
      { destination: "Roma (IC/FR)", times: ["06:10","07:35","08:55","10:35","12:10","14:10","16:10","17:35","18:55","20:10"] },
      { destination: "Milano (IC/FR)", times: ["05:50","06:50","08:50","10:50","12:50","14:50","16:25","17:50","19:50"] },
      { destination: "Pesaro/Rimini (R)", times: ["05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:30","10:30","11:30","12:30","13:30","14:30","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:30","20:30","21:30"] },
      { destination: "Foligno/Fabriano (R)", times: ["06:20","07:20","08:20","10:20","12:20","14:20","16:20","18:20","20:20"] },
    ],
    typicalArrivals: [
      { origin: "Roma (IC/FR)", times: ["08:45","10:15","11:50","13:45","15:50","17:45","19:10","20:45","22:10"] },
      { origin: "Milano (IC/FR)", times: ["07:10","09:10","11:10","13:10","15:10","17:10","18:35","20:10","22:10"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:25","06:55","07:25","07:55","08:25","08:55","09:55","10:55","11:55","12:55","13:55","14:55","15:55","16:25","16:55","17:25","17:55","18:25","18:55","19:55","20:55","21:55"] },
      { origin: "Foligno/Fabriano (R)", times: ["07:40","08:40","09:40","11:40","13:40","15:40","17:40","19:40","21:40"] },
    ],
  },
  {
    id: "rail-falconara",
    name: "Stazione FS Falconara Marittima",
    type: "railway",
    lat: 43.6301852, lng: 13.39739496,
    gtfsStopIds: ["20026", "20027"],
    description: "Stazione di Falconara — nodo ferrovia Adriatica / linea per Roma",
    platformWalkMinutes: 2,
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:10","06:40","07:10","07:40","08:10","08:40","09:40","10:40","11:40","12:40","13:40","14:40","15:40","16:10","16:40","17:10","17:40","18:10","18:40","19:40","20:40"] },
      { destination: "Roma (via Orte)", times: ["06:35","10:05","14:05","17:35"] },
      { destination: "Pesaro/Rimini (R)", times: ["06:15","07:15","08:15","09:15","11:15","13:15","15:15","17:15","19:15","21:15"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:30","07:00","07:30","08:00","08:30","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","16:30","17:00","17:30","18:00","18:30","19:00","20:00","21:00"] },
      { origin: "Roma (via Orte)", times: ["10:30","14:30","18:30","21:30"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:50","07:50","08:50","09:50","11:50","13:50","15:50","17:50","19:50","21:50"] },
    ],
  },
  {
    id: "rail-palombina",
    name: "Stazione Palombina Nuova",
    type: "railway",
    lat: 43.61802912, lng: 13.42590525,
    gtfsStopIds: ["20020", "20034"],
    description: "Fermata ferroviaria Palombina — collegamento costiero",
    platformWalkMinutes: 1,
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:20","07:20","08:20","09:20","12:20","14:20","16:20","17:20","18:20","19:20"] },
      { destination: "Falconara (R)", times: ["06:45","07:45","08:45","10:45","13:45","15:45","17:45","19:45"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:55","07:55","08:55","10:55","13:55","15:55","17:55","19:55"] },
      { origin: "Falconara (R)", times: ["06:35","07:35","08:35","09:35","12:35","14:35","16:35","17:35","18:35","19:35"] },
    ],
  },
  {
    id: "port-ancona",
    name: "Porto di Ancona (Terminal Passeggeri)",
    type: "port",
    lat: 43.61864036, lng: 13.50938321,
    gtfsStopIds: ["20003", "20047"],
    description: "Terminal traghetti — linee per Croazia, Grecia, Albania",
    platformWalkMinutes: 8, // sbarco nave → uscita terminal → fermata
    typicalDepartures: [
      { destination: "Spalato (HR) - Jadrolinija", times: ["19:00"] },
      { destination: "Spalato (HR) - SNAV", times: ["17:30"] },
      { destination: "Patrasso (GR) - Minoan/Anek", times: ["13:30","17:00"] },
      { destination: "Durazzo (AL) - Adria Ferries", times: ["21:00"] },
      { destination: "Igoumenitsa (GR)", times: ["13:30","17:00"] },
    ],
    typicalArrivals: [
      { origin: "Spalato (HR) - Jadrolinija", times: ["07:00"] },
      { origin: "Spalato (HR) - SNAV", times: ["09:00"] },
      { origin: "Patrasso (GR) - Minoan/Anek", times: ["08:00","15:00"] },
      { origin: "Durazzo (AL) - Adria Ferries", times: ["07:30"] },
      { origin: "Igoumenitsa (GR)", times: ["08:00","15:00"] },
    ],
  },
  {
    id: "airport-falconara",
    name: "Aeroporto Raffaello Sanzio (Falconara)",
    type: "airport",
    lat: 43.61632, lng: 13.36244,
    gtfsStopIds: ["20159", "20184", "20158", "20185", "20160", "20183"],
    description: "Aeroporto delle Marche — voli nazionali e internazionali",
    platformWalkMinutes: 5, // uscita terminal → fermata bus più vicina (Castelferretti)
    typicalDepartures: [
      { destination: "Roma Fiumicino (Ryanair)", times: ["06:30","13:15","19:00"] },
      { destination: "Milano Bergamo (Ryanair)", times: ["07:00","17:30"] },
      { destination: "Londra Stansted (Ryanair)", times: ["12:45"] },
      { destination: "Bruxelles Charleroi", times: ["14:30"] },
      { destination: "Düsseldorf", times: ["10:00"] },
      { destination: "Tirana (Albania)", times: ["09:00","18:00"] },
    ],
    typicalArrivals: [
      { origin: "Roma Fiumicino (Ryanair)", times: ["10:30","16:15","22:00"] },
      { origin: "Milano Bergamo (Ryanair)", times: ["09:45","20:15"] },
      { origin: "Londra Stansted (Ryanair)", times: ["12:00"] },
      { origin: "Bruxelles Charleroi", times: ["14:00"] },
      { origin: "Düsseldorf", times: ["09:30"] },
      { origin: "Tirana (Albania)", times: ["08:30","17:30"] },
    ],
  },
  {
    id: "rail-torrette",
    name: "Stazione di Ancona Torrette",
    type: "railway",
    lat: 43.60393, lng: 13.45299,
    gtfsStopIds: ["20335", "20466", "20011", "20039", "20370", "20467"],
    description: "Fermata ferroviaria Torrette — adiacente Ospedale Regionale Ospedali Riuniti",
    platformWalkMinutes: 2, // fermata piccola, accesso diretto
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:25","07:25","08:25","09:25","12:25","14:25","16:25","17:25","18:25","19:25"] },
      { destination: "Falconara (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
      { origin: "Falconara (R)", times: ["06:30","07:30","08:30","09:30","12:30","14:30","16:30","17:30","18:30","19:30"] },
    ],
  },
];

// Alias for backward-compat: intermodal code used timeToMin / minToTime
const timeToMin = timeToMinutes;

// ═══════════════════════════════════════════════════════════════════════
//  DYNAMIC SCHEDULE STORE — orari sincronizzati per hub auto-discovered
// ═══════════════════════════════════════════════════════════════════════
//
// Ogni volta che viene chiamato POST /intermodal/sync-schedules per un
// hub non curato (railway/port/airport scoperto da GTFS), proviamo a
// recuperare orari reali e li salviamo in memoria (in-process cache).
// Chiave: hubId generato da discoverHubs (es. "gtfs-railway-CI001").
// ═══════════════════════════════════════════════════════════════════════
// Indice 0 = Lunedì, 6 = Domenica
type WeeklyDepartures = { destination: string; times: string[] }[][];
type WeeklyArrivals = { origin: string; times: string[] }[][];

interface HubSchedule {
  // Vista aggregata (unione di tutti i giorni) — back-compat UI esistente
  typicalArrivals: { origin: string; times: string[] }[];
  typicalDepartures: { destination: string; times: string[] }[];
  // Vista settimanale: weeklyDepartures[0] = lun, [6] = dom
  weeklyDepartures?: WeeklyDepartures;
  weeklyArrivals?: WeeklyArrivals;
  weekStart?: string; // ISO date del lunedì di riferimento
  fetchedAt: string;
  source: string; // "viaggiatreno" | "fallback" | ...
}
const dynamicHubSchedules = new Map<string, HubSchedule>();
export { dynamicHubSchedules };
export type { HubSchedule };

/* ── Persistenza degli orari sincronizzati ────────────────────────────
 * La Map vive nel processo: dopo un restart (o su un'altra replica) gli
 * orari scaricati sparivano e il frontend rilanciava 112 chiamate a
 * ViaggiaTreno per stazione. Ora si appoggiano a una tabella additiva. */
let schedulesTableReady = false;
async function ensureSchedulesTable(): Promise<void> {
  if (schedulesTableReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS intermodal_hub_schedules (
      hub_id      text PRIMARY KEY,
      payload     jsonb NOT NULL,
      fetched_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  schedulesTableReady = true;
}

/** Carica in memoria gli orari persistiti (una volta per processo). */
let persistedLoaded = false;
export async function loadPersistedSchedules(): Promise<void> {
  if (persistedLoaded) return;
  try {
    await ensureSchedulesTable();
    const r = await db.execute<any>(sql`SELECT hub_id, payload FROM intermodal_hub_schedules`);
    for (const row of ((r as any).rows ?? [])) {
      const p = row.payload;
      if (p && typeof p === "object") dynamicHubSchedules.set(String(row.hub_id), p as HubSchedule);
    }
  } catch { /* tabella non creabile: si resta sulla cache in memoria */ }
  persistedLoaded = true;
}

async function persistSchedule(hubId: string, sched: HubSchedule): Promise<void> {
  try {
    await ensureSchedulesTable();
    await db.execute(sql`
      INSERT INTO intermodal_hub_schedules (hub_id, payload, fetched_at)
      VALUES (${hubId}, ${JSON.stringify(sched)}::jsonb, now())
      ON CONFLICT (hub_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`);
  } catch { /* best-effort */ }
}

/**
 * Prova a recuperare arrivi/partenze treni per una stazione dal suo nome
 * usando l'API pubblica ViaggiaTreno (RFI). Best-effort: se non trova la
 * stazione o l'API è irraggiungibile, ritorna null.
 *
 * @param stationName Nome della fermata GTFS (es. "STAZIONE FS - CAPOLINEA")
 * @param hint Nome del comune come fallback (es. "Jesi")
 */
export async function fetchTrainScheduleFromViaggiaTreno(
  stationName: string,
  hint?: string | null,
  deadline?: number,
): Promise<HubSchedule | null> {
  // Lista di candidate query: prima pulita dallo stopName, poi il hint
  const candidates: string[] = [];
  const cleaned = stationName
    .replace(/STAZIONE\s+(FS|AUTOLINEE)\s*/i, "")
    .replace(/\bFS\b/i, "")
    .replace(/CAPOLINEA/i, "")
    .replace(/FRONTE\s+CAVALCAVIA/i, "")
    .replace(/[-–—]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 3)[0];
  if (cleaned && cleaned.length >= 3) candidates.push(cleaned.toUpperCase());
  if (hint && hint.length >= 3) candidates.push(hint.toUpperCase());

  for (const q of candidates) {
    if (deadline && Date.now() > deadline) break;
    const sched = await tryFetchViaggiaTreno(q, deadline);
    if (sched) return sched;
  }
  return null;
}

async function tryFetchViaggiaTreno(query: string, deadline?: number): Promise<HubSchedule | null> {
  try {
    // 1) Autocomplete per trovare stationCode
    const autocompleteUrl = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/autocompletaStazione/${encodeURIComponent(query)}`;
    const acResp = await fetch(autocompleteUrl, { signal: AbortSignal.timeout(5000) });
    if (!acResp.ok) { console.warn("[viaggiatreno] autocomplete !ok for", query, acResp.status); return null; }
    const acText = await acResp.text();
    const firstLine = acText.split("\n").find(l => l.includes("|"));
    if (!firstLine) { console.warn("[viaggiatreno] no results for", query, "body:", acText.slice(0, 200)); return null; }
    const parts = firstLine.split("|").map(s => s.trim());
    const stationCode = parts[1];
    if (!stationCode) { console.warn("[viaggiatreno] no stationCode in", firstLine); return null; }
    console.info(`[viaggiatreno] ${query} → ${stationCode}`);

    // 2) Strategia: scarichiamo orari per OGGI + 6 giorni successivi (rolling)
    //    e li indicizziamo per dayOfWeek (0=Lun..6=Dom). ViaggiaTreno NON
    //    ritorna dati per giorni passati, quindi questa strategia copre
    //    sempre tutti i 7 giorni della settimana con dati reali.
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

    // 3) Per ogni giorno (offset 0..6), scarichiamo 8 fasce orarie
    //    (05,08,11,13,15,17,19,21). Ogni call copre ~90 min.
    //    Totale: 7 × 8 × 2 (dep+arr) = 112 chiamate per stazione.
    const hoursToSample = [5, 8, 11, 13, 15, 17, 19, 21];
    type Job = { dayIdx: number; type: "dep" | "arr"; url: string };
    const jobs: Job[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() + offset);
      // Indice 0 = Lunedì, 6 = Domenica
      const jsDow = day.getDay();
      const dayIdx = jsDow === 0 ? 6 : jsDow - 1;
      for (const h of hoursToSample) {
        const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0);
        const ts = d.toString().replace(/GMT.*$/, "").trim();
        jobs.push({ dayIdx, type: "dep", url: `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationCode}/${encodeURIComponent(ts)}` });
        jobs.push({ dayIdx, type: "arr", url: `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/arrivi/${stationCode}/${encodeURIComponent(ts)}` });
      }
    }

    // weekDepMaps[dayIdx] = Map<destination, Set<HH:MM>>
    const weekDepMaps: Map<string, Set<string>>[] = Array.from({ length: 7 }, () => new Map());
    const weekArrMaps: Map<string, Set<string>>[] = Array.from({ length: 7 }, () => new Map());

    // Batch di 6 chiamate parallele per non stressare l'API (totale 84/stazione)
    const BATCH = 6;
    for (let i = 0; i < jobs.length; i += BATCH) {
      // Budget di tempo: se lo scaricamento completo (7 giorni × 8 fasce) non
      // sta nel tempo concesso alla richiesta HTTP, ci si ferma e si restituisce
      // ciò che si è raccolto finora. Il resto lo completa il cron notturno.
      // Senza questo, una singola stazione poteva superare il timeout del
      // gateway e far fallire l'intero endpoint con un 500.
      if (deadline && Date.now() > deadline) {
        console.warn(`[viaggiatreno] deadline raggiunta per ${stationCode}: dati parziali (${i}/${jobs.length} job)`);
        break;
      }
      const batch = jobs.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(({ url }) =>
        fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null).catch(() => null),
      ));
      for (let j = 0; j < batch.length; j++) {
        const data = results[j];
        const job = batch[j];
        if (!Array.isArray(data)) continue;
        if (job.type === "dep") {
          const m = weekDepMaps[job.dayIdx];
          for (const t of data) {
            const dest = t?.destinazione || t?.destinazioneEstera;
            const time = t?.compOrarioPartenza;
            if (dest && time && /^\d{2}:\d{2}/.test(time)) {
              if (!m.has(dest)) m.set(dest, new Set());
              m.get(dest)!.add(time.slice(0, 5));
            }
          }
        } else {
          const m = weekArrMaps[job.dayIdx];
          for (const t of data) {
            const origin = t?.origine || t?.origineEstera;
            const time = t?.compOrarioArrivo;
            if (origin && time && /^\d{2}:\d{2}/.test(time)) {
              if (!m.has(origin)) m.set(origin, new Set());
              m.get(origin)!.add(time.slice(0, 5));
            }
          }
        }
      }
    }

    // Trasforma i Map per giorno in array serializzabili
    const weeklyDepartures: WeeklyDepartures = weekDepMaps.map(m =>
      [...m.entries()].map(([destination, s]) => ({ destination, times: [...s].sort() }))
    );
    const weeklyArrivals: WeeklyArrivals = weekArrMaps.map(m =>
      [...m.entries()].map(([origin, s]) => ({ origin, times: [...s].sort() }))
    );

    // Aggregazione globale (unione di tutti i giorni) per back-compat UI
    const aggDep = new Map<string, Set<string>>();
    const aggArr = new Map<string, Set<string>>();
    for (const dayMap of weekDepMaps) {
      for (const [dest, times] of dayMap.entries()) {
        if (!aggDep.has(dest)) aggDep.set(dest, new Set());
        for (const t of times) aggDep.get(dest)!.add(t);
      }
    }
    for (const dayMap of weekArrMaps) {
      for (const [orig, times] of dayMap.entries()) {
        if (!aggArr.has(orig)) aggArr.set(orig, new Set());
        for (const t of times) aggArr.get(orig)!.add(t);
      }
    }
    const typicalDepartures = [...aggDep.entries()].map(([destination, s]) => ({ destination, times: [...s].sort() }));
    const typicalArrivals = [...aggArr.entries()].map(([origin, s]) => ({ origin, times: [...s].sort() }));

    const dayLabels = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
    const perDayCount = weekDepMaps.map((m, i) => `${dayLabels[i]}=${[...m.values()].reduce((s, set) => s + set.size, 0)}`).join(" ");
    console.info(`[viaggiatreno] ${stationCode} weekly dep counts: ${perDayCount} | total dest=${aggDep.size} orig=${aggArr.size}`);

    if (typicalDepartures.length === 0 && typicalArrivals.length === 0) return null;

    // weekStart = oggi (data della prima campionatura)
    const yyyy = today0.getFullYear();
    const mm = String(today0.getMonth() + 1).padStart(2, "0");
    const dd = String(today0.getDate()).padStart(2, "0");
    const weekStart = `${yyyy}-${mm}-${dd}`;

    return {
      typicalDepartures,
      typicalArrivals,
      weeklyDepartures,
      weeklyArrivals,
      weekStart,
      fetchedAt: new Date().toISOString(),
      source: "viaggiatreno",
    };
  } catch (e) {
    console.warn("[viaggiatreno] error:", (e as Error).message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  HUB DISCOVERY — scopre dinamicamente hub da GTFS stops + bbox
// ═══════════════════════════════════════════════════════════════════════
//
// Trova stazioni, autostazioni, porti, aeroporti leggendo i nomi delle
// fermate GTFS. Utile quando l'area servita è diversa da quella degli
// hub hardcoded (es. urbano di Jesi, Senigallia, Fabriano).
//
// Pattern di detection (case-insensitive) applicati a `stop_name`:
//   ▸ RAILWAY  : "stazione", "staz.", " fs ", "ferrovia", "railway"
//   ▸ BUS HUB  : "autostazione", "terminal bus", "stazione autolinee"
//   ▸ AIRPORT  : "aeroporto", "airport"
//   ▸ PORT     : "porto", "scalo marittimo", "ferry"
// ═══════════════════════════════════════════════════════════════════════

type HubType = "railway" | "port" | "airport" | "bus_terminal";

interface DiscoveredHub {
  id: string;
  name: string;
  type: HubType;
  lat: number;
  lng: number;
  gtfsStopIds: string[];
  description: string;
  platformWalkMinutes: number;
  typicalDepartures: { destination: string; times: string[] }[];
  typicalArrivals: { origin: string; times: string[] }[];
  weeklyDepartures?: { destination: string; times: string[] }[][];
  weeklyArrivals?: { origin: string; times: string[] }[][];
  weekStart?: string;
  source: "curated" | "gtfs-auto";
  /** Da dove vengono gli orari mostrati:
   *  - "live"    : scaricati da ViaggiaTreno (reali, con data di fetch)
   *  - "stima"   : tabella indicativa interna, NON verificata
   *  - "assente" : nessun orario disponibile per questo hub */
  scheduleSource: "live" | "stima" | "assente";
  scheduleFetchedAt?: string;
}
export type { HubType, DiscoveredHub };

/** Fiducia sul dato-orario, normalizzata: è l'UNICO vocabolario usato dal
 *  frontend per il badge. "reale" = scaricato (ViaggiaTreno) con data,
 *  "stima" = tabella interna non verificata, "assente" = nessun orario. */
export type DataTrust = "reale" | "stima" | "assente";
export function scheduleTrust(src: "live" | "stima" | "assente" | undefined | null): DataTrust {
  return src === "live" ? "reale" : src === "stima" ? "stima" : "assente";
}

/** ID hub STABILE: non deve cambiare tra sync, analyze e GET, altrimenti gli
 *  orari salvati non si ritrovano più. Derivato dal tipo + dagli stopId
 *  ordinati (hash deterministico), non da group[0].stopId che dipende
 *  dall'ordine di query. */
export function stableHubId(type: string, stopIds: string[]): string {
  const key = [...stopIds].filter(Boolean).sort().join("|");
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = (h * 31 + key.charCodeAt(i)) | 0; }
  return `gtfs-${type}-${(h >>> 0).toString(36)}`;
}

const HUB_PATTERNS: Array<{ re: RegExp; type: HubType; walkMin: number }> = [
  { re: /\b(aeroporto|airport)\b/i,                                                                           type: "airport",       walkMin: 5 },
  { re: /\b(porto|scalo maritti|ferry|marina)\b/i,                                                            type: "port",          walkMin: 4 },
  { re: /\b(autostazione|stazione autolinee|terminal bus|capolinea bus)\b/i,                                  type: "bus_terminal",  walkMin: 1 },
  { re: /\b(stazione|staz\.|ferrovia(ria)?|railway|\bf\.s\.\b|\bfs\b|treno|binar)/i,                           type: "railway",       walkMin: 2 },
];

/**
 * Classifica una fermata in base al nome. Restituisce null se non è un hub.
 */
function classifyStopAsHub(stopName: string | null): { type: HubType; walkMin: number } | null {
  if (!stopName) return null;
  const n = stopName.toLowerCase();
  // Segnali FORTI: qualificano senza ambiguità.
  if (/\b(aeroporto|airport)\b/.test(n)) return { type: "airport", walkMin: 5 };
  if (/\b(porto|scalo maritti|imbarco|terminal traghett|ferry)\b/.test(n)) return { type: "port", walkMin: 4 };
  if (/\b(autostazione|stazione autolinee|terminal bus|capolinea bus)\b/.test(n)) return { type: "bus_terminal", walkMin: 1 };
  // Railway forte: "stazione FS/ferroviaria", binario, treno, ferrovia.
  if (/\b(stazione\s+(fs|ferroviaria|centrale)|ferrovia(ria)?|\bf\.?s\.?\b|binari?o?|treno|scalo ferroviario|railway)\b/.test(n)) {
    return { type: "railway", walkMin: 2 };
  }
  /* Railway DEBOLE: "stazione"/"staz." da sole generano fantasmi
   * ("Via Stazione", "Piazza della Stazione"). Le accettiamo solo se il
   * nome NON è chiaramente una via/piazza e verrà confermato altrove
   * (prossimità a una stazione reale — vedi discoverHubs). */
  if (/\bstaz(ione|\.)\b/.test(n) && !/\b(via|viale|piazza|largo|corso|rotonda|parcheggio)\b/.test(n)) {
    return { type: "railway", walkMin: 3 };
  }
  return null;
}

/**
 * Raggruppa fermate classificate come hub che si trovano entro ~250m l'una
 * dall'altra e con stessa tipologia: vengono unite in un unico hub logico
 * (tipicamente binari/capolinea diversi dello stesso scalo).
 */
function clusterHubStops(
  hubStops: Array<{ stopId: string; stopName: string; lat: number; lng: number; type: HubType; walkMin: number }>,
): DiscoveredHub[] {
  const CLUSTER_KM = 0.25;
  const clusters: Array<typeof hubStops> = [];
  const used = new Set<number>();
  for (let i = 0; i < hubStops.length; i++) {
    if (used.has(i)) continue;
    const group = [hubStops[i]]; used.add(i);
    for (let j = i + 1; j < hubStops.length; j++) {
      if (used.has(j)) continue;
      if (hubStops[j].type !== hubStops[i].type) continue;
      if (haversineKm(hubStops[i].lat, hubStops[i].lng, hubStops[j].lat, hubStops[j].lng) <= CLUSTER_KM) {
        group.push(hubStops[j]); used.add(j);
      }
    }
    clusters.push(group);
  }
  return clusters.map((group) => {
    /* Nome e coordinata dalla fermata più "ferroviaria" del gruppo, non da
     * group[0]: così lo scalo prende il nome del fabbricato/binario e non
     * quello di una fermata bus vicina, e il punto è la stazione, non la
     * media del gruppo. */
    const railScore = (nm: string) =>
      /\b(stazione\s+(fs|ferroviaria|centrale)|ferrovia|\bf\.?s\.?\b|binari?o?|treno)\b/i.test(nm) ? 2
        : /\bstaz/i.test(nm) ? 1 : 0;
    const anchor = [...group].sort((a, b) => railScore(b.stopName) - railScore(a.stopName))[0];
    const latAvg = group.reduce((s, x) => s + x.lat, 0) / group.length;
    const lngAvg = group.reduce((s, x) => s + x.lng, 0) / group.length;
    const baseName = (anchor.stopName || group[0].stopName).replace(/\s*\([^)]*\)\s*$/, "").trim();
    const cleanName = baseName.length > 60 ? baseName.slice(0, 57) + "…" : baseName;
    const stopIds = group.map(g => g.stopId);
    return {
      id: stableHubId(group[0].type, stopIds),
      name: cleanName,
      type: group[0].type,
      // Per lo scalo ferroviario, il punto è la stazione (anchor), non la media.
      lat: group[0].type === "railway" ? anchor.lat : latAvg,
      lng: group[0].type === "railway" ? anchor.lng : lngAvg,
      gtfsStopIds: stopIds,
      description: group[0].type === "railway"
        ? "Stazione rilevata automaticamente dai dati GTFS"
        : group[0].type === "bus_terminal"
          ? "Autostazione / capolinea rilevato dai dati GTFS"
          : group[0].type === "airport"
            ? "Aeroporto rilevato dai dati GTFS"
            : "Scalo marittimo rilevato dai dati GTFS",
      platformWalkMinutes: group[0].walkMin,
      typicalDepartures: [],
      typicalArrivals: [],
      source: "gtfs-auto" as const,
      scheduleSource: "assente" as const,
    };
  });
}

/**
 * Stazioni ferroviarie dai POI Google già sincronizzati.
 *
 * discoverHubs scopre gli hub SOLO dalle fermate del progetto: una stazione
 * reale che non ha una fermata-bus omonima (è il caso di Jesi) restava
 * invisibile. I POI di categoria "transit" importati da Google Places
 * (cron.ts → syncPoiFromGoogle) contengono le stazioni con
 * properties.types = [train_station, transit_station, …]: sono la sorgente
 * autorevole per agganciarle sulla mappa, senza chiamate live a ogni richiesta.
 */
async function discoverStationsFromPois(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null,
): Promise<DiscoveredHub[]> {
  try {
    const rows: any[] = (((await db.execute<any>(sql`
      SELECT id::text AS id, name, lat, lng, properties
        FROM points_of_interest
       WHERE category = 'transit'
       ${bbox
          ? sql`AND lat BETWEEN ${bbox.minLat} AND ${bbox.maxLat}
                AND lng BETWEEN ${bbox.minLng} AND ${bbox.maxLng}`
          : sql``}`)) as any).rows) ?? [];
    const out: DiscoveredHub[] = [];
    for (const r of rows) {
      const props = typeof r.properties === "string" ? JSON.parse(r.properties) : (r.properties ?? {});
      const types: string[] = Array.isArray(props.types) ? props.types : [];
      const name: string = r.name || "";
      // Solo ferrovie: train_station diretto, oppure transit_station col nome
      // che parla di stazione (evita fermate bus taggate transit_station).
      const isTrain = types.includes("train_station")
        || (types.includes("transit_station") && /stazione|ferroviar|\bfs\b|\bf\.s\.\b/i.test(name));
      if (!isTrain) continue;
      const lat = typeof r.lat === "string" ? parseFloat(r.lat) : r.lat;
      const lng = typeof r.lng === "string" ? parseFloat(r.lng) : r.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const placeId: string = props.place_id || r.id;
      out.push({
        // ID stabile ancorato al place_id Google: gli orari sincronizzati si
        // ritrovano tra sync/analyze/GET anche senza fermate GTFS.
        id: stableHubId("railway", [`gpoi:${placeId}`]),
        name: (name.replace(/\s*\([^)]*\)\s*$/, "").trim()) || "Stazione ferroviaria",
        type: "railway",
        lat, lng,
        gtfsStopIds: [],
        description: "Stazione ferroviaria rilevata dai POI Google Places",
        platformWalkMinutes: 2,
        typicalDepartures: [],
        typicalArrivals: [],
        source: "gtfs-auto",
        scheduleSource: "assente",
      });
    }
    return out;
  } catch {
    // POI non ancora sincronizzati o tabella assente: non è un errore bloccante.
    return [];
  }
}

/* Cache in-memory delle stazioni chieste live a Google: le stazioni non si
 * spostano, quindi una TTL lunga evita di pagare/rallentare ogni richiesta. */
const liveStationCache = new Map<string, { at: number; hubs: DiscoveredHub[] }>();
const LIVE_STATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Fallback live: se nei POI sincronizzati non c'è una stazione per l'area,
 * la si chiede a Google Places (type=train_station) attorno al box del
 * progetto. Serve quando il sync POI non ha ancora popolato la categoria
 * "transit". Nessuna chiave configurata → nessuna chiamata, nessun errore.
 */
async function liveGoogleStations(
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null,
): Promise<DiscoveredHub[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !box || box.minLat > box.maxLat) return [];
  const cacheKey = [box.minLat, box.minLng, box.maxLat, box.maxLng].map(v => v.toFixed(2)).join("_");
  const cached = liveStationCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_STATION_TTL_MS) return cached.hubs;

  const lat = (box.minLat + box.maxLat) / 2;
  const lng = (box.minLng + box.maxLng) / 2;
  // Raggio = mezza diagonale del box (in metri), con un minimo utile e il
  // tetto di 50 km imposto dall'API.
  const halfDiagKm = haversineKm(box.minLat, box.minLng, box.maxLat, box.maxLng) / 2;
  const radius = Math.min(50000, Math.max(3000, Math.round(halfDiagKm * 1000)));
  try {
    const params = new URLSearchParams({
      location: `${lat},${lng}`, radius: String(radius), type: "train_station", key: apiKey,
    });
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) throw new Error(`Google Places HTTP ${resp.status}`);
    const json = await resp.json() as any;
    if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
      throw new Error(`Google Places: ${json.status}`);
    }
    const hubs: DiscoveredHub[] = [];
    for (const place of (json.results ?? [])) {
      const pLat = place.geometry?.location?.lat, pLng = place.geometry?.location?.lng;
      const name: string = place.name || "";
      const placeId: string = place.place_id;
      if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || !placeId) continue;
      // Confina all'area richiesta: nearbysearch è circolare e sfora il box.
      if (pLat < box.minLat || pLat > box.maxLat || pLng < box.minLng || pLng > box.maxLng) continue;
      hubs.push({
        id: stableHubId("railway", [`gpoi:${placeId}`]),
        name: (name.replace(/\s*\([^)]*\)\s*$/, "").trim()) || "Stazione ferroviaria",
        type: "railway", lat: pLat, lng: pLng, gtfsStopIds: [],
        description: "Stazione ferroviaria rilevata da Google Places",
        platformWalkMinutes: 2, typicalDepartures: [], typicalArrivals: [],
        source: "gtfs-auto", scheduleSource: "assente",
      });
    }
    liveStationCache.set(cacheKey, { at: Date.now(), hubs });
    return hubs;
  } catch {
    // Rete/quote/chiave: si restituisce la cache stantia se c'è, altrimenti nulla.
    return cached?.hubs ?? [];
  }
}

/**
 * Discovery principale: dati i filtri (bbox / municipality / routeIds)
 * restituisce la lista di hub da considerare, unione di:
 *   1) hub curati (INTERMODAL_HUBS) interni al bbox
 *   2) hub rilevati automaticamente dalle fermate GTFS
 *   3) stazioni ferroviarie dai POI Google (sorgente reale, non dedotta)
 */
export async function discoverHubs(opts: {
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  routeIds?: Set<string> | null;
  municipality?: string | null; // codice ISTAT 5-6 cifre (es. 42021 = Jesi)
  includeCurated?: boolean;
  /** rete su cui cercare gli hub: senza, si leggerebbero tutti i feed insieme */
  feedId?: string | null;
  /** progetto Planner Studio: gli hub si scoprono dalle SUE fermate vive */
  psProjectId?: string | null;
}): Promise<DiscoveredHub[]> {
  const { bbox, routeIds, includeCurated = true, feedId = null, psProjectId = null } = opts;
  const out: DiscoveredHub[] = [];

  /* Area del progetto (bbox delle sue fermate, con tolleranza): serve sia a
   * filtrare gli hub curati sia a confinare le stazioni dai POI Google, così
   * un progetto non eredita stazioni lontane dalla sua rete. */
  let projectBox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
  if (psProjectId) {
    const r = await db.execute<any>(sql`
      SELECT min(lat) AS min_lat, max(lat) AS max_lat, min(lon) AS min_lng, max(lon) AS max_lng
        FROM ps_stops WHERE project_id = ${psProjectId}::uuid`);
    const b = (r as any).rows?.[0];
    if (b?.min_lat != null) {
      const pad = 0.05; // ~5 km di tolleranza attorno alla rete
      projectBox = {
        minLat: Number(b.min_lat) - pad, maxLat: Number(b.max_lat) + pad,
        minLng: Number(b.min_lng) - pad, maxLng: Number(b.max_lng) + pad,
      };
    } else {
      projectBox = { minLat: 1, maxLat: -1, minLng: 1, maxLng: -1 }; // progetto senza fermate
    }
  }

  // 1. Hub curati filtrati per bbox
  if (includeCurated) {
    const curated: DiscoveredHub[] = INTERMODAL_HUBS.map(h => ({
      id: h.id, name: h.name, type: h.type as HubType, lat: h.lat, lng: h.lng,
      gtfsStopIds: [...h.gtfsStopIds],
      description: h.description,
      platformWalkMinutes: h.platformWalkMinutes,
      typicalDepartures: h.typicalDepartures,
      typicalArrivals: h.typicalArrivals,
      source: "curated",
      // Gli orari cablati nel codice sono una STIMA indicativa, non un orario
      // ufficiale: va dichiarato, altrimenti l'analisi sembra fondata su dati
      // reali. Il sync ViaggiaTreno li sostituisce (→ "live").
      scheduleSource: ((h.typicalArrivals.length || h.typicalDepartures.length) ? "stima" : "assente") as "stima" | "assente",
    }));
    /* Gli hub curati sono cablati su un territorio preciso (provincia di
     * Ancona). Dentro un progetto di un'altra area comparivano comunque,
     * come poli fantasma sempre "non serviti": dati che col progetto non
     * c'entrano nulla. Si tengono solo se cadono nell'area effettivamente
     * coperta dalle fermate del progetto. */
    const inBox = (h: DiscoveredHub, b: typeof bbox) =>
      !b || (h.lat >= b.minLat && h.lat <= b.maxLat && h.lng >= b.minLng && h.lng <= b.maxLng);
    for (const h of curated) {
      if (!inBox(h, bbox)) continue;
      if (!inBox(h, projectBox)) continue;
      // Le fermate GTFS cablate appartengono a un altro feed: dentro un
      // progetto non identificano nulla e vanno lasciate fuori.
      if (psProjectId) h.gtfsStopIds = [];
      out.push(h);
    }
  }

  // 2. Scopri hub dalle fermate GTFS
  // Se routeIds è specificato, limitiamo alle fermate di quelle routes
  let candidateStopIds: Set<string> | null = null;
  if (routeIds && routeIds.size > 0) {
    const tripRows = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
      .from(gtfsTrips).where(feedWhere(gtfsTrips.feedId, feedId));
    const relevantTripIds = new Set(tripRows.filter(t => routeIds.has(t.routeId)).map(t => t.tripId));
    candidateStopIds = new Set();
    const tripArr = [...relevantTripIds];
    for (let i = 0; i < tripArr.length; i += 500) {
      const batch = tripArr.slice(i, i + 500);
      if (batch.length === 0) continue;
      const stRows = await db.select({ stopId: gtfsStopTimes.stopId }).from(gtfsStopTimes)
        .where(and(feedWhere(gtfsStopTimes.feedId, feedId),
          sql`${gtfsStopTimes.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`));
      for (const r of stRows) candidateStopIds.add(r.stopId);
    }
  }

  /* Le fermate su cui si cercano stazioni/porti/aeroporti devono essere
   * quelle del PROGETTO quando si lavora dentro un progetto: leggere il
   * feed materializzato significherebbe scoprire hub su fermate che
   * nel progetto sono già state cancellate. */
  const allStops = psProjectId
    ? (((await db.execute<any>(sql`
        SELECT id::text AS "stopId", name AS "stopName", lat, lon AS lng, location_type AS "locationType"
          FROM ps_stops WHERE project_id = ${psProjectId}::uuid
         ORDER BY id`)) as any).rows ?? [])
    : (((await db.execute<any>(sql`
        SELECT stop_id AS "stopId", stop_name AS "stopName", stop_lat AS lat, stop_lon AS lng,
               location_type AS "locationType"
          FROM gtfs_stops WHERE ${feedId ? sql`feed_id = ${feedId}::uuid` : sql`TRUE`}
         ORDER BY stop_id`)) as any).rows ?? []);

  const hubStops: Array<{ stopId: string; stopName: string; lat: number; lng: number; type: HubType; walkMin: number }> = [];
  for (const s of allStops) {
    const sLat = typeof s.lat === "string" ? parseFloat(s.lat) : s.lat;
    const sLng = typeof s.lng === "string" ? parseFloat(s.lng) : s.lng;
    if (!sLat || !sLng) continue;
    if (bbox && (sLat < bbox.minLat || sLat > bbox.maxLat || sLng < bbox.minLng || sLng > bbox.maxLng)) continue;
    if (candidateStopIds && !candidateStopIds.has(s.stopId)) continue;
    /* Le fermate marcate come STAZIONE nei dati (location_type=1) sono la
     * verità: valgono come ferroviarie anche se il gestore le chiama
     * "Piazza Rosselli". È l'aggancio reale che rende robusta la detection. */
    const isRealStation = Number((s as any).locationType) === 1;
    const cls = isRealStation ? { type: "railway" as HubType, walkMin: 2 } : classifyStopAsHub(s.stopName);
    if (!cls) continue;
    // Evita duplicati con hub curati (match diretto su stopId)
    if (out.some(h => h.gtfsStopIds.includes(s.stopId))) continue;
    hubStops.push({
      stopId: s.stopId, stopName: s.stopName || "", lat: sLat as number, lng: sLng as number,
      type: cls.type, walkMin: cls.walkMin,
    });
  }

  const discovered = clusterHubStops(hubStops);
  // Evita duplicati per vicinanza con hub curati (≤ 300m stesso tipo)
  const filtered = discovered.filter(d => !out.some(h => h.type === d.type && haversineKm(h.lat, h.lng, d.lat, d.lng) <= 0.3));
  out.push(...filtered);

  // 3. Stazioni ferroviarie dai POI Google (sorgente reale): coprono le
  //    stazioni prive di una fermata-bus omonima nel progetto (es. Jesi).
  //    Confinate all'area rilevante (bbox esplicito o box del progetto).
  const stationBox = bbox ?? projectBox;
  let poiStations = await discoverStationsFromPois(stationBox);
  // Se i POI sincronizzati non hanno stazioni per l'area, chiedile a Google live.
  if (poiStations.length === 0) poiStations = await liveGoogleStations(stationBox);
  for (const st of poiStations) {
    if (out.some(h => h.id === st.id)) continue; // stesso place_id già presente
    // Niente doppioni con una stazione già rilevata a ≤ 400 m.
    if (out.some(h => h.type === "railway" && haversineKm(h.lat, h.lng, st.lat, st.lng) <= 0.4)) continue;
    out.push(st);
  }

  // ─── Applica gli orari sincronizzati (ViaggiaTreno) ─────────────────
  // Vale per TUTTI gli hub, curati compresi: un orario reale sostituisce
  // sempre la tabella-stima interna.
  await loadPersistedSchedules();
  for (const h of out) {
    const cached = dynamicHubSchedules.get(h.id);
    if (!cached) continue;
    h.typicalArrivals = cached.typicalArrivals;
    h.typicalDepartures = cached.typicalDepartures;
    if (cached.weeklyDepartures) h.weeklyDepartures = cached.weeklyDepartures;
    if (cached.weeklyArrivals) h.weeklyArrivals = cached.weeklyArrivals;
    if (cached.weekStart) h.weekStart = cached.weekStart;
    h.scheduleSource = "live";
    h.scheduleFetchedAt = cached.fetchedAt;
  }

  // ─── Fallback: se dopo tutto questo non ci sono hub nel bbox ──────
  // Crea un hub sintetico "Centro città" al centro del bbox, tipo
  // bus_terminal, per permettere comunque l'analisi POI/fermate.
  // Utile per comuni piccoli i cui GTFS non taggano esplicitamente
  // stazioni/autostazioni (es. linee urbane di servizio).
  if (out.length === 0 && bbox) {
    out.push({
      id: `synthetic-center-${[bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng].map(v => v.toFixed(3)).join("_")}`,
      name: "Centro urbano (riferimento)",
      type: "bus_terminal",
      lat: (bbox.minLat + bbox.maxLat) / 2,
      lng: (bbox.minLng + bbox.maxLng) / 2,
      gtfsStopIds: [],
      description: "Nessun hub intermodale rilevato automaticamente. Riferimento sintetico al centro dell'area analizzata.",
      platformWalkMinutes: 0,
      typicalDepartures: [],
      typicalArrivals: [],
      source: "gtfs-auto",
      scheduleSource: "assente",
    });
  }

  return out;
}

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/hubs — return hub definitions for map
//   Query params (tutti opzionali):
//     - municipality : codice ISTAT 5-6 cifre (es. 42021 = Jesi) o nome comune
//     - routeIds     : CSV di routeId GTFS (limita a fermate di quelle routes)
//     - bbox         : "minLat,minLng,maxLat,maxLng"
// ──────────────────────────────────────────────────────────
router.get("/intermodal/hubs", async (req, res) => {
  try {
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;
    const routeIdsCsv = (req.query.routeIds as string | undefined)?.trim() || "";
    const bboxStr = (req.query.bbox as string | undefined)?.trim() || "";

    let bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
    if (bboxStr) {
      const [a, b, c, d] = bboxStr.split(",").map(Number);
      if ([a, b, c, d].every(n => Number.isFinite(n))) {
        bbox = { minLat: Math.min(a, c), maxLat: Math.max(a, c), minLng: Math.min(b, d), maxLng: Math.max(b, d) };
      }
    } else if (municipality) {
      bbox = await municipalityBbox(municipality);
    }

    const routeIds = routeIdsCsv
      ? new Set(routeIdsCsv.split(",").map(s => s.trim()).filter(Boolean))
      : null;

    const srcH = await resolveSource(req);
    const hubs = await discoverHubs({ bbox, routeIds, municipality, feedId: srcH.feedId, psProjectId: srcH.psProjectId });

    res.json(hubs.map(h => ({
      id: h.id, name: h.name, type: h.type,
      lat: h.lat, lng: h.lng,
      description: h.description,
      platformWalkMinutes: h.platformWalkMinutes,
      source: h.source,
      departures: h.typicalDepartures.reduce((s, d) => s + d.times.length, 0),
      arrivals: h.typicalArrivals.reduce((s, a) => s + a.times.length, 0),
      destinations: h.typicalDepartures.map(d => d.destination),
      origins: h.typicalArrivals.map(a => a.origin),
    })));
  } catch (err) {
    req.log.error(err, "Error discovering intermodal hubs");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/municipalities — lista comuni disponibili
// Estratti dai census sections per permettere all'utente di
// selezionare l'ambito (es. "Jesi", "Senigallia") dalla UI.
// ──────────────────────────────────────────────────────────
router.get("/intermodal/municipalities", async (_req, res) => {
  try {
    const rows = await db.select({ istatCode: censusSections.istatCode }).from(censusSections);
    const set = new Set<string>();
    for (const r of rows) if (r.istatCode) set.add(r.istatCode.slice(0, 6));
    const COMUNE_NAMES: Record<string, string> = {
      "420010": "Agugliano", "420020": "Ancona", "420030": "Arcevia", "420040": "Barbara",
      "420050": "Belvedere Ostrense", "420060": "Camerano", "420070": "Camerata Picena",
      "420100": "Castelfidardo", "420110": "Castelleone di Suasa", "420120": "Castelplanio",
      "420130": "Cerreto d'Esi", "420140": "Chiaravalle", "420150": "Corinaldo",
      "420160": "Cupramontana", "420170": "Fabriano", "420180": "Falconara Marittima",
      "420190": "Filottrano", "420200": "Genga", "420210": "Jesi", "420220": "Loreto",
      "420230": "Maiolati Spontini", "420240": "Mergo", "420250": "Monsano",
      "420260": "Montecarotto", "420270": "Montemarciano", "420290": "Monte Roberto",
      "420300": "Monte San Vito", "420310": "Morro d'Alba", "420320": "Numana",
      "420330": "Offagna", "420340": "Osimo", "420350": "Ostra", "420360": "Ostra Vetere",
      "420370": "Poggio San Marcello", "420380": "Polverigi", "420400": "Rosora",
      "420410": "San Marcello", "420420": "San Paolo di Jesi", "420430": "Santa Maria Nuova",
      "420440": "Sassoferrato", "420450": "Senigallia", "420460": "Serra de' Conti",
      "420470": "Serra San Quirico", "420480": "Sirolo", "420490": "Staffolo",
      "420500": "Trecastelli",
    };
    const out = [...set]
      .map(code => ({ code, name: COMUNE_NAMES[code] || `Comune ${code}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/intermodal/analyze — PASSENGER-CENTRIC intermodal analysis
//
// CORE CONCEPT: passenger arrives by train/ferry → walks from platform
// to bus stop → waits for bus. We analyze:
//   1. Walking time from hub to each nearby bus stop (distance-based)
//   2. For each arrival (train/ferry): what is the first bus the
//      passenger can catch, considering walk time?
//   3. Where does each bus go? (destination analysis)
//   4. "Bus already left" scenarios (bus departed before walk completed)
//   5. Gap windows with zero outbound service
// ──────────────────────────────────────────────────────────────────
router.get("/intermodal/analyze", async (req, res) => {
  try {
    const maxWalkKm = parseFloat(req.query.radius as string) || 0.5;
    const routeIdsParam = (req.query.routeIds as string | undefined)?.trim();
    const routeIdsFilter: Set<string> | null = routeIdsParam
      ? new Set(routeIdsParam.split(",").map(s => s.trim()).filter(Boolean))
      : null;
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;
    // Rete analizzata (progetto PS o feed corrente) e tipo di giorno.
    /* Anche le coincidenze devono guardare il progetto VIVO: altrimenti
     * una linea cancellata continuerebbe a comparire tra i bus che
     * servono la stazione. */
    const srcA = await resolveSource(req);
    const feedId = srcA.feedId;
    const psProjectId = srcA.psProjectId;
    const day = parseDayKind(req.query.day);
    const calendarId = String(req.query.calendarId ?? "").trim() || null;
    const categoryId = String(req.query.categoryId ?? "").trim() || null;
    const activeTripsA = await loadActiveTrips(srcA, day, calendarId, categoryId);

    // ─── Hub list: curated + auto-discovered (filtered by ambito) ──────
    let bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
    if (municipality) bbox = await municipalityBbox(municipality);
    const effectiveHubs = await discoverHubs({ bbox, routeIds: routeIdsFilter, municipality, feedId, psProjectId });

    // 1. Fermate della rete del progetto (o del feed, fuori da un progetto)
    const allStops = (await loadStops(srcA)).map(x => ({
      stopId: x.stopId, stopName: x.stopName, lat: x.lat, lng: x.lng,
    }));

    // 2. Find nearby bus stops per hub (within maxWalkKm)
    const hubNearbyStops: Record<string, { stopId: string; stopName: string; lat: number; lng: number; distKm: number; walkMin: number }[]> = {};
    for (const hub of effectiveHubs) {
      const nearby: typeof hubNearbyStops[string] = [];
      for (const stop of allStops) {
        const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
        const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
        if (!sLat || !sLng) continue;
        const d = haversineKm(hub.lat, hub.lng, sLat as number, sLng as number);
        if (d <= maxWalkKm) {
          const totalWalk = hub.platformWalkMinutes + walkMinutes(d);
          nearby.push({
            stopId: stop.stopId, stopName: stop.stopName || "",
            lat: sLat as number, lng: sLng as number,
            distKm: +d.toFixed(3), walkMin: totalWalk,
          });
        }
      }
      nearby.sort((a, b) => a.distKm - b.distKm);
      hubNearbyStops[hub.id] = nearby;
    }

    // 3. Fetch stop_times for all relevant stops
    const allRelevantStopIds = [
      ...effectiveHubs.flatMap(h => h.gtfsStopIds),
      ...Object.values(hubNearbyStops).flatMap(arr => arr.map(s => s.stopId)),
    ];
    const uniqueStopIds = [...new Set(allRelevantStopIds)];

    /* Passaggi alle fermate rilevanti: loadPassages legge il progetto vivo
     * e tiene già solo le corse circolanti nel giorno scelto, restituendo
     * la linea di ciascuna. */
    let hubStopTimes = await loadPassages(srcA, uniqueStopIds, activeTripsA);

    const tripRouteMap: Record<string, string> = {};
    for (const p of hubStopTimes) tripRouteMap[p.tripId] = p.routeId;

    const tripsBeforeCalendar = activeTripsA.size;
    const tripsAfterCalendar = new Set(hubStopTimes.map(st => st.tripId)).size;

    // Apply routeIds filter (if provided): keep only stop_times belonging to selected routes
    if (routeIdsFilter && routeIdsFilter.size > 0) {
      hubStopTimes = hubStopTimes.filter(st => {
        const rId = tripRouteMap[st.tripId];
        return rId ? routeIdsFilter.has(rId) : false;
      });
    }

    // Route info
    const gtfsRoutesAll = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes).where(feedWhere(gtfsRoutes.feedId, feedId));
    const routeMap: Record<string, { shortName: string | null; longName: string | null; color: string | null }> = {};
    for (const r of gtfsRoutesAll) routeMap[r.routeId] = { shortName: r.shortName, longName: r.longName, color: r.color };

    // 5. For each trip, find where it ENDS (destination) by looking at last stop
    // We need trip → last stop name for destination analysis
    // Fetch all stop_times for relevant trips to get the last stops
    const tripDestinations: Record<string, string> = {};
    const tripLastStopSeq: Record<string, { seq: number; stopId: string }> = {};
    for (const st of hubStopTimes) {
      const prev = tripLastStopSeq[st.tripId];
      if (!prev || (st.stopSequence || 0) > prev.seq) {
        tripLastStopSeq[st.tripId] = { seq: st.stopSequence || 0, stopId: st.stopId };
      }
    }
    // We also need the LAST stop of each trip (the actual terminal) — fetch from full stop_times
    // For performance, we'll use the route long name as destination proxy
    // But also get last stops from the data we have
    for (const [tripId, info] of Object.entries(tripLastStopSeq)) {
      const lastStop = allStops.find(s => s.stopId === info.stopId);
      if (lastStop) tripDestinations[tripId] = lastStop.stopName || info.stopId;
    }

    // 6. Analyze each hub — ARRIVAL PERSPECTIVE
    const hubAnalyses: any[] = [];

    for (const hub of effectiveHubs) {
      const nearbyStops = hubNearbyStops[hub.id] || [];
      const nearbyStopIds = new Set([...hub.gtfsStopIds, ...nearbyStops.map(s => s.stopId)]);
      const isServed = nearbyStops.length > 0 || hub.gtfsStopIds.length > 0;

      // Build stop → walkMin map
      const stopWalkMap: Record<string, number> = {};
      for (const ns of nearbyStops) stopWalkMap[ns.stopId] = ns.walkMin;
      for (const sid of hub.gtfsStopIds) {
        if (!stopWalkMap[sid]) stopWalkMap[sid] = hub.platformWalkMinutes + 1;
      }

      // Get all stop_times at this hub's stops
      const hubTimes = hubStopTimes.filter(st => nearbyStopIds.has(st.stopId));

      // Group by route — for bus lines panel
      const byRoute: Record<string, { times: Set<string>; destinations: Set<string> }> = {};
      for (const st of hubTimes) {
        const rId = tripRouteMap[st.tripId];
        if (!rId) continue;
        const t = st.departureTime || st.arrivalTime;
        if (!t) continue;
        if (!byRoute[rId]) byRoute[rId] = { times: new Set<string>(), destinations: new Set<string>() };
        byRoute[rId].times.add(t);
        // Add route long name as proxy destination
        const rInfo = routeMap[rId];
        if (rInfo?.longName) {
          // Extract destination from route name (usually "A - B" format)
          const parts = rInfo.longName.split(/[-–—>/]/);
          if (parts.length >= 2) byRoute[rId].destinations.add(parts[parts.length - 1].trim());
        }
        // Also add trip-specific last stop
        const dest = tripDestinations[st.tripId];
        if (dest) byRoute[rId].destinations.add(dest);
      }

      const busLines = Object.entries(byRoute).map(([rId, info]) => ({
        routeId: rId,
        routeShortName: routeMap[rId]?.shortName || rId,
        routeLongName: routeMap[rId]?.longName || "",
        routeColor: routeMap[rId]?.color || null,
        tripsCount: info.times.size,
        times: [...info.times].sort(),
        destinations: [...info.destinations],
      }));

      // ── ARRIVAL-BASED ANALYSIS ──
      // For each train/ferry ARRIVAL: passenger steps off → walks X min → arrives at bus stop
      // → finds next bus departure → how long does they wait? is there a bus at all?
      const arrivalConnections: {
        origin: string;          // where the train/ferry came from
        arrivalTime: string;     // when it arrives at hub
        walkMin: number;         // min walk to nearest usable stop
        atBusStopTime: string;   // when passenger physically reaches bus stop
        firstBus: {
          departureTime: string;
          routeShortName: string;
          routeLongName: string;
          stopName: string;
          waitMin: number;        // minutes waiting at bus stop
          destination: string;    // where the bus goes
        } | null;
        allBusOptions: {          // all buses within 60 min of arrival at stop
          departureTime: string;
          routeShortName: string;
          waitMin: number;
          destination: string;
        }[];
        justMissed: {             // buses that LEFT before passenger could walk there
          departureTime: string;
          routeShortName: string;
          missedByMin: number;
          destination: string;
        }[];
        status: "ok" | "long-wait" | "no-bus" | "just-missed";
        totalTransferMin: number | null; // walk + wait = total transfer time
      }[] = [];

      if (hub.typicalArrivals && isServed) {
        for (const arr of hub.typicalArrivals) {
          for (const t of arr.times) {
            const arrivalMin = timeToMin(t);

            // Find nearest stop walk time
            const minWalk = nearbyStops.length > 0
              ? Math.min(...nearbyStops.map(s => s.walkMin))
              : hub.platformWalkMinutes + 1;

            const atStopMin = arrivalMin + minWalk;
            const maxWaitMin = 60; // max acceptable wait
            const atStopTime = minToTime(atStopMin);

            // Find ALL bus departures from nearby stops AFTER passenger arrives
            interface BusOption {
              departureMin: number;
              routeId: string;
              routeShortName: string;
              routeLongName: string;
              stopId: string;
              stopName: string;
              waitMin: number;
              destination: string;
            }

            const options: BusOption[] = [];
            const justMissed: { departureTime: string; routeShortName: string; missedByMin: number; destination: string }[] = [];

            for (const st of hubTimes) {
              const depTime = st.departureTime || st.arrivalTime;
              if (!depTime) continue;
              const busDepMin = timeToMin(depTime);
              if (busDepMin <= 0) continue;

              const rId = tripRouteMap[st.tripId];
              if (!rId) continue;
              const rInfo = routeMap[rId];
              const shortName = rInfo?.shortName || rId;
              const longName = rInfo?.longName || "";

              // Walk time to THIS specific stop
              const walkToThisStop = stopWalkMap[st.stopId] || minWalk;
              const passengerArrivalAtThisStop = arrivalMin + walkToThisStop;

              // Extract destination for this trip
              let dest = tripDestinations[st.tripId] || "";
              if (!dest && longName) {
                const parts = longName.split(/[-–—>/]/);
                if (parts.length >= 2) dest = parts[parts.length - 1].trim();
              }

              const stopInfo = nearbyStops.find(s => s.stopId === st.stopId);
              const sName = stopInfo?.stopName || st.stopId;

              if (busDepMin >= passengerArrivalAtThisStop && busDepMin <= passengerArrivalAtThisStop + maxWaitMin) {
                // Bus is catchable!
                options.push({
                  departureMin: busDepMin,
                  routeId: rId, routeShortName: shortName, routeLongName: longName,
                  stopId: st.stopId, stopName: sName,
                  waitMin: busDepMin - passengerArrivalAtThisStop,
                  destination: dest,
                });
              } else if (busDepMin < passengerArrivalAtThisStop && busDepMin >= arrivalMin) {
                // Bus LEFT while passenger was still walking!
                justMissed.push({
                  departureTime: depTime,
                  routeShortName: shortName,
                  missedByMin: passengerArrivalAtThisStop - busDepMin,
                  destination: dest,
                });
              }
            }

            // Sort by wait time, dedupe by route
            options.sort((a, b) => a.waitMin - b.waitMin);

            // Best first bus
            const firstBus = options.length > 0 ? {
              departureTime: minToTime(options[0].departureMin),
              routeShortName: options[0].routeShortName,
              routeLongName: options[0].routeLongName,
              stopName: options[0].stopName,
              waitMin: options[0].waitMin,
              destination: options[0].destination,
            } : null;

            // Top bus options (different routes, within 60 min)
            const seenRoutes = new Set<string>();
            const allBusOptions: typeof arrivalConnections[0]["allBusOptions"] = [];
            for (const opt of options) {
              const key = opt.routeId;
              if (seenRoutes.has(key)) continue;
              seenRoutes.add(key);
              allBusOptions.push({
                departureTime: minToTime(opt.departureMin),
                routeShortName: opt.routeShortName,
                waitMin: opt.waitMin,
                destination: opt.destination,
              });
              if (allBusOptions.length >= 8) break;
            }

            // Dedupe just-missed (unique routes, closest miss)
            const missedByRoute: Record<string, typeof justMissed[0]> = {};
            for (const jm of justMissed) {
              if (!missedByRoute[jm.routeShortName] || jm.missedByMin < missedByRoute[jm.routeShortName].missedByMin) {
                missedByRoute[jm.routeShortName] = jm;
              }
            }
            const uniqueMissed = Object.values(missedByRoute)
              .sort((a, b) => a.missedByMin - b.missedByMin)
              .slice(0, 5);

            // Determine status
            let status: "ok" | "long-wait" | "no-bus" | "just-missed" = "no-bus";
            if (firstBus) {
              status = firstBus.waitMin > 25 ? "long-wait" : "ok";
            } else if (uniqueMissed.length > 0) {
              status = "just-missed";
            }

            arrivalConnections.push({
              origin: arr.origin,
              arrivalTime: t,
              walkMin: minWalk,
              atBusStopTime: atStopTime,
              firstBus,
              allBusOptions,
              justMissed: uniqueMissed,
              status,
              totalTransferMin: firstBus ? (minWalk + firstBus.waitMin) : null,
            });
          }
        }
      }

      // ── DEPARTURE CONNECTIONS (original logic, but with walk-time-aware matching) ──
      const departureConnections: {
        destination: string; departureTime: string;
        bestBusArrival: string | null; bestBusRoute: string | null;
        waitMinutes: number | null; missedBy: number | null;
      }[] = [];

      if (hub.typicalDepartures && isServed) {
        for (const dep of hub.typicalDepartures) {
          for (const t of dep.times) {
            const depMin = timeToMin(t);
            // Passenger must arrive at hub X minutes before departure
            // (includes walk from bus stop to platform)
            const minWalk = nearbyStops.length > 0
              ? Math.min(...nearbyStops.map(s => s.walkMin))
              : hub.platformWalkMinutes + 1;
            const latestBusArrival = depMin - minWalk; // must step off bus by this time
            const maxWait = 60;
            let bestBus: number | null = null;
            let bestBusRoute: string | null = null;

            for (const st of hubTimes) {
              const bm = timeToMin(st.arrivalTime || st.departureTime || "");
              if (bm <= 0) continue;
              if (bm <= latestBusArrival && bm >= depMin - maxWait) {
                if (bestBus === null || bm > bestBus) {
                  bestBus = bm;
                  const rId = tripRouteMap[st.tripId];
                  bestBusRoute = rId ? (routeMap[rId]?.shortName || rId) : null;
                }
              }
            }

            let missedBy: number | null = null;
            if (bestBus === null) {
              const tooLate = hubTimes
                .map(st => timeToMin(st.arrivalTime || st.departureTime || ""))
                .filter(bm => bm > latestBusArrival && bm <= depMin + 15)
                .sort((a, b) => a - b);
              if (tooLate.length > 0) missedBy = tooLate[0] - latestBusArrival;
            }

            departureConnections.push({
              destination: dep.destination,
              departureTime: t,
              bestBusArrival: bestBus !== null ? minToTime(bestBus) : null,
              bestBusRoute,
              waitMinutes: bestBus !== null ? latestBusArrival - bestBus : null,
              missedBy,
            });
          }
        }
      }

      // ── DESTINATION COVERAGE ANALYSIS ──
      // From this hub, what destinations can you reach by bus?
      // Group by destination name, show how many trips/day, first and last
      const destinationCoverage: {
        destination: string;
        routeShortName: string;
        routeLongName: string;
        tripsPerDay: number;
        firstDeparture: string;
        lastDeparture: string;
        avgFrequencyMin: number | null;
      }[] = [];

      for (const bl of busLines) {
        for (const dest of bl.destinations) {
          if (!dest) continue;
          const times = bl.times.sort();
          let avgFreq: number | null = null;
          if (times.length >= 2) {
            const mins = times.map(timeToMin);
            const gaps = mins.slice(1).map((m, i) => m - mins[i]);
            avgFreq = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
          }
          destinationCoverage.push({
            destination: dest,
            routeShortName: bl.routeShortName,
            routeLongName: bl.routeLongName,
            tripsPerDay: bl.tripsCount,
            firstDeparture: times[0] || "",
            lastDeparture: times[times.length - 1] || "",
            avgFrequencyMin: avgFreq,
          });
        }
      }

      // ── HOURLY GAP ANALYSIS (now includes arrival perspective) ──
      const allBusDepartureMinutes = hubTimes
        .map(st => timeToMin(st.departureTime || st.arrivalTime || ""))
        .filter(m => m > 0)
        .sort((a, b) => a - b);

      const gapAnalysis: { hour: number; busDepartures: number; hubArrivals: number; hubDepartures: number; gap: boolean }[] = [];
      for (let h = 5; h <= 23; h++) {
        const busDeps = allBusDepartureMinutes.filter(m => m >= h * 60 && m < (h + 1) * 60).length;
        const hubArrivals = hub.typicalArrivals.reduce((sum, a) => {
          return sum + a.times.filter(t => { const m = timeToMin(t); return m >= h * 60 && m < (h + 1) * 60; }).length;
        }, 0);
        const hubDeps = hub.typicalDepartures.reduce((sum, dep) => {
          return sum + dep.times.filter(t => { const m = timeToMin(t); return m >= h * 60 && m < (h + 1) * 60; }).length;
        }, 0);
        gapAnalysis.push({
          hour: h,
          busDepartures: busDeps,
          hubArrivals: hubArrivals,
          hubDepartures: hubDeps,
          gap: (hubArrivals > 0 || hubDeps > 0) && busDeps === 0,
        });
      }

      // ── WAIT TIME DISTRIBUTION ──
      const waitDistribution: { range: string; count: number }[] = [
        { range: "0-5 min", count: 0 },
        { range: "5-10 min", count: 0 },
        { range: "10-15 min", count: 0 },
        { range: "15-25 min", count: 0 },
        { range: "25-40 min", count: 0 },
        { range: "40-60 min", count: 0 },
        { range: "> 60 min / nessun bus", count: 0 },
      ];
      for (const ac of arrivalConnections) {
        if (!ac.firstBus) {
          waitDistribution[6].count++;
        } else if (ac.firstBus.waitMin <= 5) waitDistribution[0].count++;
        else if (ac.firstBus.waitMin <= 10) waitDistribution[1].count++;
        else if (ac.firstBus.waitMin <= 15) waitDistribution[2].count++;
        else if (ac.firstBus.waitMin <= 25) waitDistribution[3].count++;
        else if (ac.firstBus.waitMin <= 40) waitDistribution[4].count++;
        else waitDistribution[5].count++;
      }

      // Stats
      const arrivalStats = {
        totalArrivals: arrivalConnections.length,
        withBus: arrivalConnections.filter(c => c.firstBus !== null).length,
        noBus: arrivalConnections.filter(c => c.status === "no-bus").length,
        justMissed: arrivalConnections.filter(c => c.status === "just-missed").length,
        longWait: arrivalConnections.filter(c => c.status === "long-wait").length,
        ok: arrivalConnections.filter(c => c.status === "ok").length,
        avgWaitMin: (() => {
          const waits = arrivalConnections.filter(c => c.firstBus).map(c => c.firstBus!.waitMin);
          return waits.length > 0 ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : null;
        })(),
        avgTotalTransferMin: (() => {
          const transfers = arrivalConnections.filter(c => c.totalTransferMin !== null).map(c => c.totalTransferMin!);
          return transfers.length > 0 ? Math.round(transfers.reduce((s, t) => s + t, 0) / transfers.length) : null;
        })(),
      };

      // ── SERVICE SCORE per hub senza orari curati (auto-discovered) ──
      // Metrica 0-100 basata su: copertura oraria (6-22), linee servite,
      // destinazioni coperte, frequenza media.
      // Serve a valutare "quanto bene il servizio urbano copre questo nodo"
      // anche quando non disponiamo di orari treni/navi.
      let serviceScore: {
        score: number;               // 0-100
        hoursCovered: number;         // ore 6-22 con almeno 1 bus
        linesServing: number;
        destinationsReached: number;
        avgFrequencyMin: number | null;
        level: "eccellente" | "buono" | "sufficiente" | "carente" | "assente";
      } | null = null;
      if (hub.source === "gtfs-auto") {
        const hoursCovered = gapAnalysis.filter(g => g.busDepartures > 0).length;
        const linesServing = busLines.length;
        const destinationsReached = new Set(destinationCoverage.map(d => d.destination)).size;
        const freqs = destinationCoverage.map(d => d.avgFrequencyMin).filter((f): f is number => f != null);
        const avgFrequencyMin = freqs.length > 0 ? Math.round(freqs.reduce((s, f) => s + f, 0) / freqs.length) : null;
        // Score: 40% copertura oraria + 25% linee + 20% destinazioni + 15% frequenza
        const hourScore = Math.min(100, (hoursCovered / 17) * 100); // 17 ore attese 6-22
        const lineScore = Math.min(100, linesServing * 20);           // 5 linee = max
        const destScore = Math.min(100, destinationsReached * 12);    // 8+ destinazioni = max
        const freqScore = avgFrequencyMin != null ? Math.max(0, 100 - avgFrequencyMin * 2) : 50;
        const raw = hourScore * 0.4 + lineScore * 0.25 + destScore * 0.2 + freqScore * 0.15;
        const score = Math.round(raw);
        const level: "eccellente" | "buono" | "sufficiente" | "carente" | "assente" =
          score >= 80 ? "eccellente" : score >= 60 ? "buono" : score >= 40 ? "sufficiente" : score > 0 ? "carente" : "assente";
        serviceScore = { score, hoursCovered, linesServing, destinationsReached, avgFrequencyMin, level };
      }

      hubAnalyses.push({
        hub: {
          id: hub.id, name: hub.name, type: hub.type,
          lat: hub.lat, lng: hub.lng,
          description: hub.description,
          platformWalkMinutes: hub.platformWalkMinutes,
          source: hub.source,
          // Provenienza degli orari usati per le coincidenze di questo hub
          scheduleSource: hub.scheduleSource,
          scheduleFetchedAt: hub.scheduleFetchedAt,
          // Vocabolario unico per il badge di fiducia lato frontend
          dataTrust: scheduleTrust(hub.scheduleSource),
        },
        isServed,
        nearbyStops: nearbyStops.slice(0, 20),
        busLines,
        arrivalConnections,       // NEW: passenger arrives → catches bus
        departureConnections: departureConnections, // keep legacy: passenger takes bus → catches train
        destinationCoverage,      // NEW: where can you go from here
        gapAnalysis,
        waitDistribution,         // NEW: histogram of wait times
        arrivalStats,             // NEW: stats focused on arrivals
        serviceScore,             // NEW: 0-100 score for auto-discovered hubs (urban coverage)
        stats: {
          totalBusTrips: allBusDepartureMinutes.length,
          totalHubDepartures: departureConnections.length,
          covered: departureConnections.filter(c => c.bestBusArrival !== null).length,
          missed: departureConnections.filter(c => c.bestBusArrival === null).length,
          avgWaitMin: (() => {
            const waits = departureConnections.filter(c => c.waitMinutes !== null).map(c => c.waitMinutes!);
            return waits.length > 0 ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : null;
          })(),
        },
      });
    }

    // 7. PASSENGER-CENTRIC SUGGESTIONS
    const suggestions: {
      priority: "critical" | "high" | "medium" | "low";
      type: string; hub: string; description: string;
      details?: string;
      suggestedTimes?: string[];
    }[] = [];

    for (const hc of hubAnalyses) {
      if (!hc.isServed || hc.nearbyStops.length === 0) {
        suggestions.push({
          priority: "critical", type: "extend-route", hub: hc.hub.name,
          description: `Nessuna fermata bus entro ${maxWalkKm} km da ${hc.hub.name}. Passeggeri in arrivo non hanno trasporto pubblico.`,
          details: `Il ${hc.hub.type === "railway" ? "treno" : hc.hub.type === "airport" ? "volo" : "traghetto"} arriva ma i passeggeri non possono proseguire in bus.`,
        });
        continue;
      }

      // Critical: arrivals with NO bus at all
      const noBus = hc.arrivalConnections.filter((c: any) => c.status === "no-bus");
      if (noBus.length > 0) {
        const times = noBus.map((c: any) => c.arrivalTime).join(", ");
        suggestions.push({
          priority: "critical", type: "no-service", hub: hc.hub.name,
          description: `${noBus.length} arrivi ${hc.hub.type === "railway" ? "treno" : hc.hub.type === "airport" ? "volo" : "nave"} senza NESSUN bus disponibile entro 60 min.`,
          details: `Orari critici: ${times}. I passeggeri restano senza trasporto.`,
          suggestedTimes: noBus.map((c: any) => minToTime(timeToMin(c.arrivalTime) + (c.walkMin || 5) + 3)),
        });
      }

      // High: "just missed" — bus left while walking
      const justMissedArrivals = hc.arrivalConnections.filter((c: any) => c.status === "just-missed");
      if (justMissedArrivals.length > 0) {
        const examples = justMissedArrivals.slice(0, 3).map((c: any) =>
          `${c.origin} arr. ${c.arrivalTime}: bus partito ${c.justMissed[0]?.missedByMin || "?"} min prima`
        ).join("; ");
        suggestions.push({
          priority: "high", type: "just-missed", hub: hc.hub.name,
          description: `${justMissedArrivals.length} arrivi dove il bus parte PRIMA che il passeggero arrivi alla fermata (tempo cammino: ${hc.nearbyStops[0]?.walkMin || "?"} min).`,
          details: examples,
          suggestedTimes: justMissedArrivals.map((c: any) =>
            minToTime(timeToMin(c.arrivalTime) + (c.walkMin || 5) + 3)
          ).slice(0, 5),
        });
      }

      // High: long waits (>25 min at bus stop)
      const longWaits = hc.arrivalConnections.filter((c: any) => c.status === "long-wait");
      if (longWaits.length > 3) {
        suggestions.push({
          priority: "high", type: "long-wait", hub: hc.hub.name,
          description: `${longWaits.length} arrivi con attesa alla fermata bus > 25 min.`,
          details: `Tempo medio di trasferimento totale (cammino+attesa): ${hc.arrivalStats.avgTotalTransferMin || "?"} min.`,
        });
      }

      // Medium: gap hours
      const gapHours = hc.gapAnalysis.filter((g: any) => g.gap);
      if (gapHours.length > 0) {
        suggestions.push({
          priority: "medium", type: "gap-hours", hub: hc.hub.name,
          description: `Fasce orarie senza bus ma con arrivi treno/nave: ${gapHours.map((g: any) => `${g.hour}:00`).join(", ")}.`,
          suggestedTimes: gapHours.map((g: any) => minToTime(g.hour * 60 + 15)),
        });
      }

      // Low: walk time too long
      const avgWalk = hc.nearbyStops.length > 0
        ? Math.round(hc.nearbyStops.reduce((s: number, ns: any) => s + ns.walkMin, 0) / hc.nearbyStops.length)
        : 0;
      if (avgWalk > 10) {
        suggestions.push({
          priority: "medium", type: "walk-distance", hub: hc.hub.name,
          description: `Tempo medio di cammino piattaforma→fermata: ${avgWalk} min. Considerare fermata più vicina.`,
        });
      }

      // ── Hub auto-discovered: suggerimenti basati su serviceScore ──
      if (hc.serviceScore) {
        const ss = hc.serviceScore;
        if (ss.level === "assente" || ss.level === "carente") {
          suggestions.push({
            priority: ss.level === "assente" ? "critical" : "high",
            type: "weak-coverage",
            hub: hc.hub.name,
            description: `Copertura del servizio urbano ${ss.level} su questo hub (score ${ss.score}/100).`,
            details: `${ss.linesServing} linee · ${ss.destinationsReached} destinazioni · ${ss.hoursCovered}/17 ore coperte${ss.avgFrequencyMin != null ? ` · frequenza media ${ss.avgFrequencyMin} min` : ""}. Aggiungere corse o estendere linee per migliorare l'accessibilità del nodo intermodale.`,
          });
        } else if (ss.level === "sufficiente") {
          suggestions.push({
            priority: "medium",
            type: "moderate-coverage",
            hub: hc.hub.name,
            description: `Copertura sufficiente ma migliorabile (score ${ss.score}/100).`,
            details: `${ss.hoursCovered}/17 ore coperte${ss.avgFrequencyMin != null ? ` · frequenza ${ss.avgFrequencyMin} min` : ""}. Valutare potenziamento fasce orarie scoperte.`,
          });
        }
      }
    }

    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // 8. Proposed schedule adjustments
    const proposedSchedule: {
      action: "add" | "shift" | "extend";
      hubId: string; hubName: string;
      currentTime?: string; proposedTime: string;
      reason: string;
      impact: string;
    }[] = [];

    for (const hc of hubAnalyses) {
      if (!hc.isServed) continue;

      // For each arrival with no bus or just-missed: propose a new bus trip
      for (const ac of hc.arrivalConnections) {
        if (ac.status === "no-bus" || ac.status === "just-missed") {
          const proposedBusTime = minToTime(timeToMin(ac.arrivalTime) + ac.walkMin + 3);
          proposedSchedule.push({
            action: "add", hubId: hc.hub.id, hubName: hc.hub.name,
            proposedTime: proposedBusTime,
            reason: `Coincidenza con ${ac.origin} in arrivo alle ${ac.arrivalTime}`,
            impact: `Passeggeri da ${ac.origin} potranno prendere il bus dopo ${ac.walkMin + 3} min di cammino`,
          });
        } else if (ac.status === "long-wait" && ac.firstBus) {
          // Propose shifting the bus earlier
          const idealTime = minToTime(timeToMin(ac.arrivalTime) + ac.walkMin + 3);
          proposedSchedule.push({
            action: "shift", hubId: hc.hub.id, hubName: hc.hub.name,
            currentTime: ac.firstBus.departureTime,
            proposedTime: idealTime,
            reason: `Riduce attesa da ${ac.firstBus.waitMin} min a ~3 min per passeggeri da ${ac.origin}`,
            impact: `Tempo trasferimento totale da ${ac.totalTransferMin} min a ${ac.walkMin + 3} min`,
          });
        }
      }
    }

    // 9. Summary
    const totalArrivalConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalConnections.length, 0);
    const okConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.ok, 0);
    const longWaitConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.longWait, 0);
    const noBusConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.noBus, 0);
    const justMissedConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.justMissed, 0);

    res.json({
      hubs: hubAnalyses,
      summary: {
        totalHubs: effectiveHubs.length,
        curatedHubs: effectiveHubs.filter(h => h.source === "curated").length,
        discoveredHubs: effectiveHubs.filter(h => h.source === "gtfs-auto").length,
        servedHubs: hubAnalyses.filter((h: any) => h.isServed && h.nearbyStops.length > 0).length,
        // Arrival-based (primary)
        totalArrivals: totalArrivalConnections,
        arrivalOk: okConnections,
        arrivalLongWait: longWaitConnections,
        arrivalNoBus: noBusConnections,
        arrivalJustMissed: justMissedConnections,
        arrivalCoveragePercent: totalArrivalConnections > 0
          ? Math.round(((okConnections + longWaitConnections) / totalArrivalConnections) * 100) : 0,
        // Departure-based (legacy)
        totalDepartures: hubAnalyses.reduce((s: number, h: any) => s + h.departureConnections.length, 0),
        departureCovered: hubAnalyses.reduce((s: number, h: any) => s + h.stats.covered, 0),
        // Averages
        avgWaitAtStop: (() => {
          const waits = hubAnalyses.flatMap((h: any) =>
            h.arrivalConnections.filter((c: any) => c.firstBus).map((c: any) => c.firstBus.waitMin));
          return waits.length > 0 ? Math.round(waits.reduce((s: number, w: number) => s + w, 0) / waits.length) : null;
        })(),
        avgTotalTransfer: (() => {
          const transfers = hubAnalyses.flatMap((h: any) =>
            h.arrivalConnections.filter((c: any) => c.totalTransferMin !== null).map((c: any) => c.totalTransferMin));
          return transfers.length > 0 ? Math.round(transfers.reduce((s: number, t: number) => s + t, 0) / transfers.length) : null;
        })(),
        totalBusLines: hubAnalyses.reduce((s: number, h: any) => s + h.busLines.length, 0),
        // Qualità del dato: quanti hub hanno orari REALI e quanti solo stime
        hubsWithLiveSchedule: effectiveHubs.filter(h => h.scheduleSource === "live").length,
        hubsWithEstimatedSchedule: effectiveHubs.filter(h => h.scheduleSource === "stima").length,
        hubsWithoutSchedule: effectiveHubs.filter(h => h.scheduleSource === "assente").length,
      },
      suggestions,
      proposedSchedule,
      // Ambito dell'analisi: rete, progetto e giorno-tipo effettivamente usati
      scope: {
        psProjectId, feedId, day,
        // "ps" = dati vivi del progetto; "gtfs" = feed (uso fuori progetto)
        source: srcA.kind,
        calendarApplied: activeTripsA.size > 0,
        tripsConsidered: tripsAfterCalendar,
        tripsBeforeCalendar,
      },
      config: { maxWalkKm, walkSpeedKmh: 4.5 },
    });
  } catch (err) {
    req.log.error(err, "Error analyzing intermodal connections");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/hub/:hubId/routes — bus routes GeoJSON for a hub
// ──────────────────────────────────────────────────────────
router.get("/intermodal/hub/:hubId/routes", async (req, res) => {
  try {
    // Cercava solo tra gli hub CURATI: ogni hub auto-scoperto (id
    // "gtfs-railway-…") dava 404. Ora si passa dalla discovery completa.
    const srcR = await resolveSource(req);
    const feedId = srcR.feedId;
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;
    const allHubs = await discoverHubs({ bbox: null, municipality, feedId, psProjectId: srcR.psProjectId });
    const hub = allHubs.find(h => h.id === req.params.hubId);
    if (!hub) { res.status(404).json({ error: "Hub non trovato" }); return; }

    const maxWalkKm = parseFloat(req.query.radius as string) || 0.5;

    // Find nearby stops
    const allStops = await loadStops(srcR);

    const nearbyStops: { stopId: string; stopName: string; lat: number; lng: number; distKm: number }[] = [];
    for (const stop of allStops) {
      const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
      const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
      if (!sLat || !sLng) continue;
      const d = haversineKm(hub.lat, hub.lng, sLat as number, sLng as number);
      if (d <= maxWalkKm) {
        nearbyStops.push({ stopId: stop.stopId, stopName: stop.stopName || "", lat: sLat as number, lng: sLng as number, distKm: +d.toFixed(3) });
      }
    }

    // Get route IDs serving these stops
    const stopIds = [...hub.gtfsStopIds, ...nearbyStops.map(s => s.stopId)];
    if (stopIds.length === 0) { res.json({ hub, nearbyStops: [], routes: [] }); return; }

    const stRows = await db.select({
      stopId: gtfsStopTimes.stopId,
      tripId: gtfsStopTimes.tripId,
    }).from(gtfsStopTimes)
      .where(and(feedWhere(gtfsStopTimes.feedId, feedId),
        sql`${gtfsStopTimes.stopId} IN (${sql.join(stopIds.map(id => sql`${id}`), sql`, `)})`));

    const tripIds = [...new Set(stRows.map(r => r.tripId))];
    const tripRouteMap: Record<string, string> = {};
    if (tripIds.length > 0) {
      for (let i = 0; i < tripIds.length; i += 500) {
        const batch = tripIds.slice(i, i + 500);
        const rows = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
          .from(gtfsTrips)
          .where(and(feedWhere(gtfsTrips.feedId, feedId),
            sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`));
        for (const r of rows) tripRouteMap[r.tripId] = r.routeId;
      }
    }

    const routeIds = [...new Set(Object.values(tripRouteMap))];
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes)
      .where(and(feedWhere(gtfsRoutes.feedId, feedId),
        sql`${gtfsRoutes.routeId} IN (${sql.join(routeIds.map(id => sql`${id}`), sql`, `)})`));

    res.json({ hub, nearbyStops, routes });
  } catch (err) {
    req.log.error(err, "Error fetching hub routes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/shapes — bus route shapes as GeoJSON
// Returns FeatureCollection for display as glowing routes on map
// ──────────────────────────────────────────────────────────
router.get("/intermodal/shapes", async (req, res) => {
  try {
    /* Le geometrie disegnate devono essere quelle del PROGETTO VIVO: prima
     * si leggevano da gtfs_shapes del feed materializzato, quindi una linea
     * cancellata dal progetto continuava a comparire sulla mappa. */
    const src = await resolveSource(req);
    const routeIdsParam = (req.query.routeIds as string | undefined)?.trim();
    const routeIdsFilter: Set<string> | null = routeIdsParam
      ? new Set(routeIdsParam.split(",").map(s => s.trim()).filter(Boolean))
      : null;

    const fc = await loadShapes(src, routeIdsFilter);
    res.json(fc);
  } catch (err) {
    req.log.error(err, "Error fetching intermodal shapes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/pois — POIs connected to hubs
// Train hubs → work POIs (office, hospital, school, industrial)
// Port hub → tourism POIs (leisure, shopping)
// ──────────────────────────────────────────────────────────
router.get("/intermodal/pois", async (req, res) => {
  try {
    const maxDistKm = parseFloat(req.query.radius as string) || 3;
    const routeIdsParam = (req.query.routeIds as string | undefined)?.trim();
    const routeIdsFilter: Set<string> | null = routeIdsParam
      ? new Set(routeIdsParam.split(",").map(s => s.trim()).filter(Boolean))
      : null;
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;

    const srcP = await resolveSource(req);
    // Area di riferimento: comune scelto, altrimenti l'impronta della rete del
    // progetto. Confina i POI mostrati sulla mappa all'area effettiva.
    let bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
    if (municipality) bbox = await municipalityBbox(municipality);
    else bbox = await projectBbox(srcP);

    const effectiveHubs = await discoverHubs({ bbox, routeIds: routeIdsFilter, municipality, feedId: srcP.feedId, psProjectId: srcP.psProjectId });
    const inArea = (lat: number, lng: number) =>
      !bbox || (lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng);

    // Define POI categories per hub type
    const WORK_CATEGORIES = ["office", "hospital", "school", "industrial"];
    const TOURISM_CATEGORIES = ["leisure", "shopping"];

    // Fetch all relevant POIs
    const workPois = (await db.select({
      id: pointsOfInterest.id,
      name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
    }).from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, WORK_CATEGORIES))
      .limit(5000)).filter(p => inArea(p.lat, p.lng));

    const tourismPois = (await db.select({
      id: pointsOfInterest.id,
      name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
    }).from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, TOURISM_CATEGORIES))
      .limit(3000)).filter(p => inArea(p.lat, p.lng));

    // For each hub, find relevant POIs within radius and build connections
    const hubPois: {
      hubId: string;
      hubName: string;
      hubType: HubType;
      hubLat: number;
      hubLng: number;
      pois: {
        id: string;
        name: string | null;
        category: string;
        lat: number;
        lng: number;
        distKm: number;
        travelContext: string;
      }[];
    }[] = [];

    for (const hub of effectiveHubs) {
      const isPort = hub.type === "port";
      const isAirport = hub.type === "airport";
      const isBusTerm = hub.type === "bus_terminal";
      // Railway & bus_terminal: lavoro. Port: turismo. Airport: entrambi.
      const relevantPois = isAirport
        ? [...workPois, ...tourismPois]
        : isPort
          ? tourismPois
          : isBusTerm
            ? [...workPois, ...tourismPois]
            : workPois;
      const travelContext = isAirport ? "Lavoro + Turismo"
        : isPort ? "Turismo"
        : isBusTerm ? "Intermodale" : "Lavoro";

      const nearby = relevantPois
        .map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
          distKm: +haversineKm(hub.lat, hub.lng, p.lat, p.lng).toFixed(2),
          travelContext,
        }))
        .filter(p => p.distKm <= maxDistKm)
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, 50);

      hubPois.push({
        hubId: hub.id,
        hubName: hub.name,
        hubType: hub.type,
        hubLat: hub.lat,
        hubLng: hub.lng,
        pois: nearby,
      });
    }

    // Summary stats
    const totalPois = hubPois.reduce((s, h) => s + h.pois.length, 0);
    const categoryBreakdown: Record<string, number> = {};
    for (const hp of hubPois) {
      for (const p of hp.pois) {
        categoryBreakdown[p.category] = (categoryBreakdown[p.category] || 0) + 1;
      }
    }

    res.json({
      hubPois,
      summary: { totalPois, categoryBreakdown, hubCount: effectiveHubs.length },
      config: { maxDistKm, workCategories: WORK_CATEGORIES, tourismCategories: TOURISM_CATEGORIES },
    });
  } catch (err) {
    req.log.error(err, "Error fetching intermodal POIs");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/intermodal/sync-schedules — Update hub schedules
// In production: would fetch from Trenitalia/RFI/ferry APIs
// Here: returns current data with a "last synced" timestamp
// ──────────────────────────────────────────────────────────
let lastSyncTimestamp: string | null = null;

router.post("/intermodal/sync-schedules", async (req, res) => {
  try {
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;

    // Calcola bbox dal municipality se fornito (come negli altri endpoint)
    let bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
    if (municipality) bbox = await municipalityBbox(municipality);

    const srcS = await resolveSource(req);
    const effectiveHubs = await discoverHubs({ bbox, municipality, feedId: srcS.feedId, psProjectId: srcS.psProjectId });

    // Mappa codice ISTAT → nome comune (per hint a ViaggiaTreno)
    let municipalityName: string | null = null;
    if (municipality) {
      const COMUNE_NAMES: Record<string, string> = {
        "420010": "Agugliano", "420020": "Ancona", "420030": "Arcevia", "420040": "Barbara",
        "420050": "Belvedere Ostrense", "420060": "Camerano", "420070": "Camerata Picena",
        "420100": "Castelfidardo", "420110": "Castelleone di Suasa", "420120": "Castelplanio",
        "420130": "Cerreto d'Esi", "420140": "Chiaravalle", "420150": "Corinaldo",
        "420160": "Cupramontana", "420170": "Fabriano", "420180": "Falconara Marittima",
        "420190": "Filottrano", "420200": "Genga", "420210": "Jesi", "420220": "Loreto",
        "420230": "Maiolati Spontini", "420240": "Mergo", "420250": "Monsano",
        "420260": "Montecarotto", "420270": "Montemarciano", "420290": "Monte Roberto",
        "420300": "Monte San Vito", "420310": "Morro d'Alba", "420320": "Numana",
        "420330": "Offagna", "420340": "Osimo", "420350": "Ostra", "420360": "Ostra Vetere",
        "420370": "Poggio San Marcello", "420380": "Polverigi", "420400": "Rosora",
        "420410": "San Marcello", "420420": "San Paolo di Jesi", "420430": "Santa Maria Nuova",
        "420440": "Sassoferrato", "420450": "Senigallia", "420460": "Serra de' Conti",
        "420470": "Serra San Quirico", "420480": "Sirolo", "420490": "Staffolo",
        "420500": "Trecastelli",
      };
      municipalityName = COMUNE_NAMES[municipality.slice(0, 6)] || COMUNE_NAMES[municipality.slice(0, 5) + "0"] || null;
    }

    // ─── Sync per hub railway discovered (ViaggiaTreno) ─────────────
    const syncResults: Array<{
      id: string; name: string; type: string;
      source: "curated" | "gtfs-auto" | "live";
      status: "ok" | "skipped" | "failed";
      arrivals: number; departures: number;
      daysCovered?: number;
      weekStart?: string;
      fetchedFrom: string | null;
    }> = [];

    /* Budget di tempo per l'intera richiesta: lo scraping ViaggiaTreno è
     * pesante (fino a ~112 chiamate per stazione) e con più hub ferroviari
     * poteva superare il timeout del gateway → 500. Con un budget, ogni
     * stazione scarica finché c'è tempo e poi ci si ferma: il cron notturno
     * completa il resto. Gli hub non raggiunti restano "skipped". */
    const syncDeadline = Date.now() + 18000;

    for (const h of effectiveHubs) {
      // Le stazioni passano SEMPRE da ViaggiaTreno, anche quelle curate: la
      // tabella interna è solo una stima e non va spacciata per orario reale.
      if (h.type === "railway") {
        // Oltre il budget non si avviano nuove stazioni: si segnano come non
        // ancora sincronizzate, senza rischiare il timeout dell'endpoint.
        if (Date.now() > syncDeadline) {
          syncResults.push({
            id: h.id, name: h.name, type: h.type,
            source: h.source === "curated" ? "curated" : "gtfs-auto", status: "skipped",
            arrivals: 0, departures: 0,
            fetchedFrom: "in coda: verrà completato dalla sync automatica",
          });
          continue;
        }
        // Ogni stazione isolata: un errore o una lentezza non deve far fallire
        // l'intero endpoint (prima un singolo throw → 500 per tutto).
        let sched: HubSchedule | null = null;
        try {
          sched = await fetchTrainScheduleFromViaggiaTreno(h.name, municipalityName, syncDeadline);
        } catch (e) {
          console.warn(`[sync-schedules] hub ${h.name} fallito:`, (e as Error).message);
        }
        if (sched) {
          dynamicHubSchedules.set(h.id, sched);
          await persistSchedule(h.id, sched);
          const daysCovered = sched.weeklyDepartures
            ? sched.weeklyDepartures.filter(d => d.length > 0).length
            : undefined;
          syncResults.push({
            id: h.id, name: h.name, type: h.type, source: "live", status: "ok",
            arrivals: sched.typicalArrivals.reduce((s, a) => s + a.times.length, 0),
            departures: sched.typicalDepartures.reduce((s, d) => s + d.times.length, 0),
            daysCovered,
            weekStart: sched.weekStart,
            fetchedFrom: sched.source,
          });
        } else {
          syncResults.push({
            id: h.id, name: h.name, type: h.type,
            source: h.source === "curated" ? "curated" : "gtfs-auto", status: "failed",
            arrivals: h.source === "curated" ? h.typicalArrivals.reduce((s, a) => s + a.times.length, 0) : 0,
            departures: h.source === "curated" ? h.typicalDepartures.reduce((s, d) => s + d.times.length, 0) : 0,
            fetchedFrom: h.source === "curated" ? "stima interna (non verificata)" : null,
          });
        }
      } else {
        // Porti / aeroporti / autostazioni: nessuna API pubblica gratuita.
        // Gli orari eventualmente presenti restano dichiarati come stima.
        syncResults.push({
          id: h.id, name: h.name, type: h.type,
          source: h.source === "curated" ? "curated" : "gtfs-auto", status: "skipped",
          arrivals: h.typicalArrivals.reduce((s, a) => s + a.times.length, 0),
          departures: h.typicalDepartures.reduce((s, d) => s + d.times.length, 0),
          fetchedFrom: h.scheduleSource === "stima" ? "stima interna (non verificata)" : null,
        });
      }
    }

    lastSyncTimestamp = new Date().toISOString();

    const okLive = syncResults.filter(r => r.status === "ok" && r.source === "live").length;
    const failed = syncResults.filter(r => r.status === "failed").length;

    res.json({
      success: true,
      syncedAt: lastSyncTimestamp,
      hubs: syncResults,
      summary: {
        total: syncResults.length,
        liveFetched: okLive,
        curated: syncResults.filter(r => r.source === "curated").length,
        failed,
        skipped: syncResults.filter(r => r.status === "skipped").length,
      },
      message: okLive > 0
        ? `Orari aggiornati: ${okLive} hub da ViaggiaTreno, ${syncResults.length - okLive} da dati interni${failed > 0 ? `, ${failed} falliti` : ""}`
        : `Sincronizzati ${syncResults.length} hub (nessuna API live disponibile per questi hub)`,
    });
  } catch (err) {
    req.log.error(err, "Error syncing schedules");
    res.status(500).json({ error: "Errore sincronizzazione orari" });
  }
});

router.get("/intermodal/sync-status", async (_req, res) => {
  res.json({
    lastSyncedAt: lastSyncTimestamp,
    curatedHubCount: INTERMODAL_HUBS.length,
    dynamicHubCount: dynamicHubSchedules.size,
  });
});

/**
 * Sync AUTOMATICA degli orari treni (usata dal cron, senza sessione utente):
 * per ogni hub FERROVIARIO del feed in esercizio scarica gli orari reali da
 * ViaggiaTreno e li persiste. È ciò che rende l'acquisizione automatica invece
 * che manuale (POST /intermodal/sync-schedules). Porti/aeroporti sono saltati
 * (nessuna API pubblica gratuita).
 */
export async function syncAllRailwaySchedules(): Promise<{
  syncedAt: string; total: number; liveFetched: number; failed: number;
}> {
  const feedId = await getLatestFeedId();
  const effectiveHubs = await discoverHubs({ feedId, psProjectId: null });
  let liveFetched = 0, failed = 0, total = 0;
  for (const h of effectiveHubs) {
    if (h.type !== "railway") continue;
    total++;
    const sched = await fetchTrainScheduleFromViaggiaTreno(h.name, null);
    if (sched) {
      dynamicHubSchedules.set(h.id, sched);
      await persistSchedule(h.id, sched);
      liveFetched++;
    } else {
      failed++;
    }
  }
  lastSyncTimestamp = new Date().toISOString();
  return { syncedAt: lastSyncTimestamp, total, liveFetched, failed };
}

// GET /api/intermodal/hub-schedule/:hubId
// Restituisce lo schedule settimanale completo (weeklyDepartures/Arrivals)
// per un hub. Utile per il popup hub nel frontend.
router.get("/intermodal/hub-schedule/:hubId", async (req, res) => {
  const hubId = req.params.hubId;
  // Idrata la persistenza PRIMA del lookup: dopo un riavvio gli orari
  // salvati sono su DB, non in memoria — senza questo la GET dava 404.
  await loadPersistedSchedules();

  // 1) L'orario REALE sincronizzato (ViaggiaTreno) VINCE sempre: prima si
  //    restituiva il curato-stima e il frontend mostrava "live" su numeri
  //    inventati. Ora la cache dinamica ha la precedenza.
  const dyn = dynamicHubSchedules.get(hubId);
  if (dyn) {
    res.json({
      hubId,
      source: dyn.source,
      dataTrust: "reale",
      typicalDepartures: dyn.typicalDepartures,
      typicalArrivals: dyn.typicalArrivals,
      weeklyDepartures: dyn.weeklyDepartures || null,
      weeklyArrivals: dyn.weeklyArrivals || null,
      weekStart: dyn.weekStart || null,
      fetchedAt: dyn.fetchedAt,
    });
    return;
  }
  // 2) Solo in fallback: la tabella curata, dichiarata come STIMA.
  const curated = INTERMODAL_HUBS.find(h => h.id === hubId);
  if (curated) {
    const hasTimes = curated.typicalArrivals.length || curated.typicalDepartures.length;
    res.json({
      hubId,
      source: "curated",
      dataTrust: hasTimes ? "stima" : "assente",
      typicalDepartures: curated.typicalDepartures,
      typicalArrivals: curated.typicalArrivals,
      weeklyDepartures: null,
      weeklyArrivals: null,
      weekStart: null,
      fetchedAt: null,
    });
    return;
  }
  res.json({ hubId, source: "none", dataTrust: "assente", typicalDepartures: [], typicalArrivals: [],
    weeklyDepartures: null, weeklyArrivals: null, weekStart: null, fetchedAt: null });
});

export default router;
