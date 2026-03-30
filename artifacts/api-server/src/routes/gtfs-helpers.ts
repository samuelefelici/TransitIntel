/**
 * Shared helpers, constants and utility functions used across GTFS sub-modules.
 */
import { parse } from "csv-parse/sync";
import { db } from "@workspace/db";
import { gtfsFeeds, gtfsCalendar, gtfsCalendarDates, gtfsTrips } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm } from "../lib/geo-utils";

// ── CSV / Shape helpers ───────────────────────────────────────
export function parseCsv(content: string): Record<string, string>[] {
  try {
    return parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    return [];
  }
}

export function buildShapeGeojson(shapePoints: Record<string, string>[]): { shapeId: string; geojson: object }[] {
  const byShape: Record<string, { seq: number; lng: number; lat: number }[]> = {};
  for (const p of shapePoints) {
    const id = p["shape_id"] || p["shape_id "];
    if (!id) continue;
    const lng = parseFloat(p["shape_pt_lon"] || "0");
    const lat = parseFloat(p["shape_pt_lat"] || "0");
    const seq = parseInt(p["shape_pt_sequence"] || "0");
    if (!byShape[id]) byShape[id] = [];
    byShape[id].push({ seq, lng, lat });
  }
  return Object.entries(byShape).map(([shapeId, pts]) => {
    pts.sort((a, b) => a.seq - b.seq);
    return {
      shapeId,
      geojson: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts.map(p => [p.lng, p.lat]) },
        properties: { shapeId },
      },
    };
  });
}

// ── Feed helpers ──────────────────────────────────────────────
export async function getLatestFeedId(): Promise<string | null> {
  const rows = await db.select({ id: gtfsFeeds.id }).from(gtfsFeeds).orderBy(sql`uploaded_at DESC`).limit(1);
  return rows[0]?.id ?? null;
}

// ── Service / Day helpers ─────────────────────────────────────
export function classifyServiceByName(serviceId: string): { weekday: boolean; saturday: boolean; sunday: boolean } {
  const id = serviceId.toLowerCase().trim();
  if (id === "tutti" || id === "all" || id === "everyday" || id === "feriale+festivo") {
    return { weekday: true, saturday: true, sunday: true };
  }
  if (id === "sabato" || id.startsWith("sab") || id.includes("saturday")) {
    return { weekday: false, saturday: true, sunday: false };
  }
  if (id === "festivo" || id === "domenica" || id.startsWith("fest") || id.includes("sunday") || id.includes("domenica")) {
    return { weekday: false, saturday: false, sunday: true };
  }
  if (id.includes("feriale") || id.includes("feriali") || id.includes("lun") || id.includes("weekday") || id.includes("ven")) {
    return { weekday: true, saturday: false, sunday: false };
  }
  return { weekday: true, saturday: true, sunday: true };
}

export async function buildServiceDayMap(feedId: string): Promise<Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }>> {
  const cal = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
  const map: Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }> = {};
  for (const c of cal) {
    map[c.serviceId] = {
      weekday: (c.monday + c.tuesday + c.wednesday + c.thursday + c.friday) >= 1,
      saturday: c.saturday === 1,
      sunday: c.sunday === 1,
    };
  }
  if (cal.length === 0) {
    const dowRows = await db.execute<{
      service_id: string; weekdays: string; saturdays: string; sundays: string;
    }>(sql`
      SELECT
        service_id,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) IN (1,2,3,4,5) THEN 1 ELSE 0 END)::int AS weekdays,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) = 6 THEN 1 ELSE 0 END)::int AS saturdays,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) = 0 THEN 1 ELSE 0 END)::int AS sundays
      FROM gtfs_calendar_dates
      WHERE feed_id = ${feedId} AND exception_type = '1'
      GROUP BY service_id
    `);
    for (const row of dowRows.rows) {
      map[row.service_id] = {
        weekday:  parseInt(row.weekdays)  > 0,
        saturday: parseInt(row.saturdays) > 0,
        sunday:   parseInt(row.sundays)   > 0,
      };
    }
    const tripSvcs = await db.execute<{ service_id: string }>(sql`
      SELECT DISTINCT service_id FROM gtfs_trips WHERE feed_id = ${feedId}
    `);
    for (const { service_id } of tripSvcs.rows) {
      if (!map[service_id]) map[service_id] = classifyServiceByName(service_id);
    }
  }
  return map;
}

// ── Traffic model constants ───────────────────────────────────
export const HOURLY_MODEL: Record<number, number> = {
   0: 0.05,  1: 0.04,  2: 0.03,  3: 0.03,  4: 0.05,  5: 0.09,
   6: 0.20,  7: 0.52,  8: 0.68,  9: 0.52, 10: 0.42, 11: 0.36,
  12: 0.40, 13: 0.44, 14: 0.34, 15: 0.32, 16: 0.42, 17: 0.60,
  18: 0.68, 19: 0.50, 20: 0.30, 21: 0.18, 22: 0.12, 23: 0.08,
  24: 0.06, 25: 0.05, 26: 0.04,
};

export const ANCONA_CENTER = { lng: 13.516, lat: 43.616 };

export function modelCongestion(hour: number, lng: number, lat: number): number {
  const h = Math.max(0, Math.min(26, Math.round(hour)));
  const base = HOURLY_MODEL[h] ?? 0.05;
  const dist = Math.sqrt((lng - ANCONA_CENTER.lng) ** 2 + (lat - ANCONA_CENTER.lat) ** 2);
  const zoneFactor = dist < 0.04 ? 1.30
    : dist < 0.08 ? 1.10
    : dist < 0.16 ? 1.00
    : dist < 0.30 ? 0.75
    : 0.55;
  const jitter = (Math.sin((lng * 23.7 + lat * 47.3) * 100) * 0.5 + 0.5) * 0.24 - 0.12;
  return Math.min(0.98, Math.max(0.02, base * zoneFactor + jitter * base));
}

export const TIME_BANDS = [
  { id: "00-06", label: "Notte (0–6h)",          speedFactor: 1.45 },
  { id: "07-09", label: "Picco mattino (7–9h)",   speedFactor: 0.68 },
  { id: "09-12", label: "Mattina (9–12h)",        speedFactor: 1.10 },
  { id: "12-15", label: "Pranzo (12–15h)",        speedFactor: 1.02 },
  { id: "15-19", label: "Picco sera (15–19h)",    speedFactor: 0.76 },
  { id: "19-22", label: "Sera (19–22h)",          speedFactor: 1.18 },
  { id: "22-24", label: "Tarda sera (22–24h)",    speedFactor: 1.42 },
] as const;

export const DEFAULT_SPEED_KMH = 40;

export const DAY_CONGESTION_MULT: Record<string, number> = {
  weekday: 1.00,
  saturday: 0.58,
  sunday: 0.28,
};

export function nearestShapeIdx(stopLat: number, stopLon: number, coords: [number, number][]): { idx: number; distKm: number } {
  let minSq = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const dSq = (lat - stopLat) ** 2 + (lng - stopLon) ** 2;
    if (dSq < minSq) { minSq = dSq; bestIdx = i; }
  }
  return { idx: bestIdx, distKm: Math.sqrt(minSq) * 111 };
}

export function shapeSegmentDist(coords: [number, number][], fromIdx: number, toIdx: number): number {
  let d = 0;
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  for (let i = start; i < end; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    d += haversineKm(lat1, lng1, lat2, lng2);
  }
  return d;
}
