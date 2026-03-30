/**
 * Custom React Query hooks for GTFS/dashboard endpoints
 * that are NOT in the generated OpenAPI hooks.
 */
import { useQuery } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api";

const BASE = () => getApiBase();

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── GTFS Summary ────────────────────────────────────────────────

export function useGtfsSummary() {
  return useQuery({
    queryKey: ["gtfs", "summary"],
    queryFn: () => apiFetch("/api/gtfs/summary"),
    staleTime: 60_000,
  });
}

// ── GTFS Routes (for filter panel) ──────────────────────────────

export function useGtfsRoutes() {
  return useQuery({
    queryKey: ["gtfs", "routes"],
    queryFn: () => apiFetch<{ data: any[] }>("/api/gtfs/routes"),
    staleTime: 60_000,
    retry: 3,
    retryDelay: 800,
  });
}

// ── GTFS Stops (filtered by routeIds) ───────────────────────────

export function useGtfsStops(routeIds: string[], enabled: boolean) {
  const key = routeIds.length > 0 ? routeIds.sort().join(",") : "all";
  const url = routeIds.length > 0
    ? `/api/gtfs/stops?routeIds=${routeIds.join(",")}&limit=5000`
    : `/api/gtfs/stops?limit=5000`;
  return useQuery({
    queryKey: ["gtfs", "stops", key],
    queryFn: () => apiFetch<{ data: any[] }>(url),
    enabled,
    staleTime: 30_000,
  });
}

// ── Active Routes by Time Band ──────────────────────────────────

export function useActiveRoutesByBand(hourFrom: number, hourTo: number, dayFilter: string, enabled: boolean) {
  const params = new URLSearchParams({ hourStart: String(hourFrom), hourEnd: String(hourTo) });
  if (dayFilter !== "tutti") params.set("day", dayFilter);
  return useQuery({
    queryKey: ["gtfs", "active-by-band", hourFrom, hourTo, dayFilter],
    queryFn: () => apiFetch<{ routeIds: string[] }>(`/api/gtfs/routes/active-by-band?${params}`),
    enabled,
    staleTime: 30_000,
  });
}

// ── GTFS Shapes GeoJSON ─────────────────────────────────────────

export function useGtfsShapesGeojson(
  routeIds: string[],
  directionId: 0 | 1 | null,
  midHour: number,
  enabled: boolean,
) {
  const params = new URLSearchParams({ segmented: "true", hour: String(midHour) });
  if (routeIds.length > 0) params.set("routeIds", routeIds.join(","));
  if (directionId !== null) params.set("directionId", String(directionId));
  return useQuery({
    queryKey: ["gtfs", "shapes-geojson", routeIds.sort().join(","), directionId, midHour],
    queryFn: () => apiFetch(`/api/gtfs/shapes/geojson?${params}`),
    enabled,
    staleTime: 30_000,
  });
}

// ── Population Choropleth ───────────────────────────────────────

export function usePopulationChoropleth(enabled: boolean) {
  return useQuery({
    queryKey: ["population", "choropleth"],
    queryFn: () => apiFetch("/api/population/choropleth"),
    enabled,
    staleTime: 5 * 60_000, // 5 min — static data
  });
}
