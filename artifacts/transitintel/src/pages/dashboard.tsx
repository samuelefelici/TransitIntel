import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import Map, { Source, Layer, Popup, MapMouseEvent, MapRef } from "react-map-gl/mapbox";
import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";

import {
  useGetAnalysisStats, useGetTraffic, useGetPoi, useGetDemandScore,
} from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api";
import {
  useGtfsSummary, useGtfsRoutes, useGtfsStops,
  useActiveRoutesByBand, useGtfsShapesGeojson, usePopulationChoropleth,
} from "@/hooks/use-gtfs-queries";

import type {
  ViewMode, DayFilter, GtfsSummary, RouteItem, GtfsStop, MapPopup, WalkData, LayersState,
} from "./dashboard/types";
import {
  MAPBOX_TOKEN, MAP_STYLES, POI_COLOR, renderPoiIcon,
} from "./dashboard/constants";
import { PopupContent } from "./dashboard/PopupContent";
import { TimeRangeBar } from "./dashboard/TimeRangeBar";
import { StatsCard } from "./dashboard/StatsCard";
import { RouteFilterPanel } from "./dashboard/RouteFilterPanel";
import { LayersPanel } from "./dashboard/LayersPanel";
import { LegendPanel } from "./dashboard/LegendPanel";
import { WalkabilityPanel } from "./dashboard/WalkabilityPanel";
import { ViewModeSelector } from "./dashboard/ViewModeSelector";

export default function Dashboard() {
  const mapRef = useRef<MapRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("dark");
  const [selectedPoiCats, setSelectedPoiCats] = useState<string[]>(Object.keys(POI_COLOR));

  const is3D = viewMode === "city3d" || viewMode === "city3d-dark";
  const isStandardStyle = viewMode === "city3d" || viewMode === "city3d-dark";

  const [layers, setLayers] = useState<LayersState>({
    traffic: false,
    mapboxTraffic: false,
    demand: false,
    poi: true,
    gtfsStops: false,
    gtfsShapes: true,
    buildings: false,
  });

  // Collapsible panels
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(true);
  const [statsCollapsed, setStatsCollapsed] = useState(false);

  // Route filter state
  const [showRouteFilter, setShowRouteFilter] = useState(false);
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>([]);
  const [routeSearch, setRouteSearch] = useState("");

  // Direction + time range + day filters
  const [selectedDirection, setSelectedDirection] = useState<0 | 1 | null>(null);
  const [hourFrom, setHourFrom] = useState<number>(4);
  const [hourTo, setHourTo] = useState<number>(26);
  const [dayFilter, setDayFilter] = useState<DayFilter>("tutti");

  const [popup, setPopup] = useState<MapPopup | null>(null);
  const [cursor, setCursor] = useState("grab");

  // Isochrone state
  const [isochroneGeojson, setIsochroneGeojson] = useState<any>(null);
  const [isochroneLoading, setIsochroneLoading] = useState(false);
  const [isochroneStop, setIsochroneStop] = useState<{ name: string; lat: number; lng: number } | null>(null);

  // Walkability coverage state
  const [walkData, setWalkData] = useState<WalkData | null>(null);
  const [walkLoading, setWalkLoading] = useState(false);
  const [walkMinutes, setWalkMinutes] = useState(10);
  const [walkPanelOpen, setWalkPanelOpen] = useState(false);

  // ── React Query hooks ─────────────────────────────────────────

  const { data: statsData }   = useGetAnalysisStats();
  const { data: trafficData } = useGetTraffic({ limit: 1000 });
  const { data: demandData }  = useGetDemandScore({});
  const { data: poiData }     = useGetPoi({});

  // GTFS data via custom hooks (replaces manual fetch + useEffect)
  const { data: choroplethGeojson } = usePopulationChoropleth(layers.demand);

  const { data: summaryRaw } = useGtfsSummary();
  const gtfsSummary = summaryRaw?.available ? summaryRaw as GtfsSummary : null;

  const { data: routesRaw } = useGtfsRoutes();
  const routeList = useMemo(() => {
    const all: RouteItem[] = Array.isArray(routesRaw?.data) ? routesRaw.data : [];
    const seen: Record<string, RouteItem> = {};
    for (const r of all) {
      if (!seen[r.routeId] || (r.tripsCount ?? 0) > (seen[r.routeId].tripsCount ?? 0)) {
        seen[r.routeId] = r;
      }
    }
    return Object.values(seen);
  }, [routesRaw]);

  const { data: stopsRaw } = useGtfsStops(selectedRouteIds, layers.gtfsStops);
  const gtfsStops: GtfsStop[] = stopsRaw?.data ?? [];

  // Debounced time band params (600ms) for active-by-band query
  const [debouncedBand, setDebouncedBand] = useState({ hourFrom, hourTo, dayFilter });
  useEffect(() => {
    const t = setTimeout(() => setDebouncedBand({ hourFrom, hourTo, dayFilter }), 600);
    return () => clearTimeout(t);
  }, [hourFrom, hourTo, dayFilter]);

  const isBandDefault = debouncedBand.hourFrom === 4 && debouncedBand.hourTo === 26 && debouncedBand.dayFilter === "tutti";
  const { data: bandData } = useActiveRoutesByBand(
    debouncedBand.hourFrom, debouncedBand.hourTo, debouncedBand.dayFilter,
    !isBandDefault,
  );
  const timeBandRouteIds = isBandDefault ? null : (bandData?.routeIds ?? null);

  // Effective route IDs for shapes
  const effectiveRouteIds = useMemo(
    () => selectedRouteIds.length > 0 ? selectedRouteIds : (timeBandRouteIds ?? []),
    [selectedRouteIds, timeBandRouteIds],
  );
  const midHour = Math.round((hourFrom + hourTo) / 2);
  const { data: shapesGeojson } = useGtfsShapesGeojson(
    effectiveRouteIds, selectedDirection, midHour, layers.gtfsShapes,
  );

  // ── Map effects ───────────────────────────────────────────────

  // 3D terrain
  useEffect(() => {
    if (!mapLoaded) return;
    const m = mapRef.current?.getMap();
    if (!m) return;
    const apply = () => {
      try {
        if (is3D) {
          m.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });
          m.easeTo({ pitch: 50, bearing: -14, duration: 900 });
        } else {
          m.setTerrain(null);
          m.easeTo({ pitch: 0, bearing: 0, duration: 900 });
        }
      } catch {}
    };
    const t = setTimeout(apply, 150);
    return () => clearTimeout(t);
  }, [is3D, mapLoaded]);

  const registerPoiImages = useCallback((m: ReturnType<NonNullable<typeof mapRef.current>["getMap"]>) => {
    for (const cat of Object.keys(POI_COLOR)) {
      const id = `poi-${cat}`;
      if (!m.hasImage(id)) {
        m.addImage(id, renderPoiIcon(cat), { pixelRatio: 2 });
      }
    }
  }, []);

  const handleMapLoad = useCallback(() => {
    setMapLoaded(true);
    const m = mapRef.current?.getMap();
    if (m) registerPoiImages(m);
  }, [registerPoiImages]);

  const handleStyleData = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (m) {
      registerPoiImages(m);
      if (isStandardStyle) {
        try {
          (m as any).setConfigProperty?.("basemap", "lightPreset", viewMode === "city3d-dark" ? "dusk" : "day");
        } catch {}
      }
    }
    if (!is3D) return;
    setTimeout(() => { try { m?.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 }); } catch {} }, 300);
  }, [is3D, isStandardStyle, viewMode, registerPoiImages]);

  // Apply lightPreset + atmosphere when switching between city3d ↔ city3d-dark
  useEffect(() => {
    if (!mapLoaded || !isStandardStyle) return;
    const m = mapRef.current?.getMap() as any;
    if (!m) return;
    try {
      if (viewMode === "city3d-dark") {
        m.setConfigProperty?.("basemap", "lightPreset", "dusk");
        m.setConfigProperty?.("basemap", "showPointOfInterestLabels", false);
        m.setConfigProperty?.("basemap", "showTransitLabels", false);
        m.setFog?.({
          "range": [2, 14],
          "color": "rgba(20, 15, 30, 0.6)",
          "high-color": "rgba(40, 25, 60, 0.5)",
          "horizon-blend": 0.06,
          "star-intensity": 0.35,
          "space-color": "rgba(8, 5, 18, 1)",
        });
        m.setLights?.([{
          "id": "night_sun",
          "type": "directional",
          "properties": {
            "color": "rgba(255, 180, 80, 1.0)",
            "intensity": 0.35,
            "direction": [210, 30],
            "cast-shadows": true,
            "shadow-intensity": 0.6,
          },
        }]);
      } else {
        m.setConfigProperty?.("basemap", "lightPreset", "day");
        m.setConfigProperty?.("basemap", "showPointOfInterestLabels", true);
        m.setConfigProperty?.("basemap", "showTransitLabels", true);
        m.setFog?.(null);
        m.setLights?.([]);
      }
    } catch {}
  }, [viewMode, mapLoaded, isStandardStyle]);

  // ── GeoJSON builders ──────────────────────────────────────────

  const trafficGeojson = useMemo(() => {
    if (!trafficData?.data) return null;
    return {
      type: "FeatureCollection",
      features: trafficData.data.map(t => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lng, t.lat] },
        properties: { congestion: t.congestionLevel, speed: t.speed, freeflow: t.freeflowSpeed, segmentId: t.segmentId },
      })),
    };
  }, [trafficData]);

  const demandGeojson = useMemo(() => {
    if (!demandData?.data) return null;
    return {
      type: "FeatureCollection",
      features: demandData.data.map(d => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: { score: d.score },
      })),
    };
  }, [demandData]);

  // Enrich choropleth with "covered" flag when walkability data is available
  const enrichedChoropleth = useMemo(() => {
    if (!choroplethGeojson) return null;
    if (!walkData?.isochroneUnion?.features?.length) return choroplethGeojson;

    const isoRings: number[][][] = [];
    for (const f of walkData.isochroneUnion.features) {
      const g = f.geometry as any;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates) isoRings.push(ring);
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) for (const ring of poly) isoRings.push(ring);
      }
    }

    const pip = (px: number, py: number, ring: number[][]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };

    const GRID = 0.01;
    const ringGrid: Record<string, number[]> = {};
    isoRings.forEach((ring, ri) => {
      const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
      const minC = Math.floor(Math.min(...lngs) / GRID);
      const maxC = Math.floor(Math.max(...lngs) / GRID);
      const minR = Math.floor(Math.min(...lats) / GRID);
      const maxR = Math.floor(Math.max(...lats) / GRID);
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const key = `${r},${c}`;
          if (!ringGrid[key]) ringGrid[key] = [];
          ringGrid[key].push(ri);
        }
      }
    });

    return {
      ...choroplethGeojson,
      features: choroplethGeojson.features.map((f: any) => {
        const geom = f.geometry;
        let cx = 0, cy = 0, n = 0;
        const outerRing = geom.type === "Polygon" ? geom.coordinates[0]
          : geom.type === "MultiPolygon" ? geom.coordinates[0][0] : null;
        if (outerRing) {
          for (const [x, y] of outerRing) { cx += x; cy += y; n++; }
          cx /= n; cy /= n;
        }
        let covered = 0;
        if (n > 0) {
          const cellKey = `${Math.floor(cy / GRID)},${Math.floor(cx / GRID)}`;
          const candidates = ringGrid[cellKey] || [];
          for (const ri of candidates) { if (pip(cx, cy, isoRings[ri])) { covered = 1; break; } }
        }
        return { ...f, properties: { ...f.properties, covered } };
      }),
    };
  }, [choroplethGeojson, walkData]);

  const poiGeojson = useMemo(() => {
    if (!poiData?.data) return null;
    return {
      type: "FeatureCollection",
      features: poiData.data
        .filter(p => selectedPoiCats.includes(p.category ?? ""))
        .map(p => {
          const props = p.properties as any ?? {};
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: {
              category: p.category, name: p.name,
              rating: props.rating ?? null, vicinity: props.vicinity ?? null,
              userRatingsTotal: props.user_ratings_total ?? null,
              types: JSON.stringify(props.types ?? []), source: props.source ?? null,
            },
          };
        }),
    };
  }, [poiData, selectedPoiCats]);

  const gtfsStopsGeojson = useMemo(() => {
    if (!gtfsStops.length) return null;
    return {
      type: "FeatureCollection",
      features: gtfsStops.map(s => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.stopLon, s.stopLat] },
        properties: {
          name: s.stopName, code: s.stopCode || "-",
          trips: s.tripsCount, morning: s.morningPeakTrips,
          evening: s.eveningPeakTrips, score: s.serviceScore,
          wheelchair: s.wheelchairBoarding ?? 0, desc: s.stopDesc ?? null,
        },
      })),
    };
  }, [gtfsStops]);

  // ── Map interaction handlers ──────────────────────────────────

  const interactiveLayers = useMemo(() => {
    const ids: string[] = [];
    if (layers.traffic) ids.push("traffic-points");
    if (layers.poi) ids.push("poi-points");
    if (layers.gtfsStops) ids.push("gtfs-stops");
    if (layers.gtfsShapes) ids.push("gtfs-shapes-line");
    if (layers.demand && enrichedChoropleth) ids.push("pop-choropleth-fill");
    return ids;
  }, [layers, enrichedChoropleth]);

  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const feature = (e as any).features?.[0];
    if (!feature) { setPopup(null); return; }
    const layerId: string = feature.layer?.id || "";
    const props = feature.properties || {};
    const [lng, lat] = (feature.geometry as any)?.coordinates?.slice(0, 2) || [e.lngLat.lng, e.lngLat.lat];
    if (layerId === "traffic-points")        setPopup({ lng, lat, type: "traffic",  props });
    else if (layerId === "poi-points")       setPopup({ lng, lat, type: "poi",      props });
    else if (layerId === "gtfs-stops")       setPopup({ lng, lat, type: "gtfsStop", props });
    else if (layerId === "gtfs-shapes-line") setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, type: "shape", props });
    else if (layerId === "pop-choropleth-fill") setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, type: "census", props });
  }, []);

  const handleMouseMove = useCallback((e: MapMouseEvent) => {
    setCursor((e as any).features?.[0] ? "pointer" : "grab");
  }, []);

  const toggleRoute = useCallback((routeId: string) => {
    setSelectedRouteIds(prev => prev.includes(routeId) ? prev.filter(id => id !== routeId) : [...prev, routeId]);
  }, []);

  // Auto-enable stops layer when routes are selected
  useEffect(() => {
    if (selectedRouteIds.length > 0) {
      setLayers(prev => prev.gtfsStops ? prev : { ...prev, gtfsStops: true });
    }
  }, [selectedRouteIds.length]);

  // Fetch isochrone for a given stop
  const fetchIsochrone = useCallback((lat: number, lng: number, name: string) => {
    setIsochroneLoading(true);
    setIsochroneStop({ name, lat, lng });
    fetch(`${getApiBase()}/api/analysis/isochrone?lat=${lat}&lng=${lng}&minutes=5,10`)
      .then(r => {
        if (r.status === 429) throw new Error("Rate limit raggiunto. Riprova tra 1 minuto.");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => { setIsochroneGeojson(data); setIsochroneLoading(false); })
      .catch(err => { console.error("Isochrone fetch failed:", err); setIsochroneLoading(false); });
  }, []);

  // Clear isochrone when popup is closed
  useEffect(() => {
    if (!popup) { setIsochroneGeojson(null); setIsochroneStop(null); }
  }, [popup]);

  // Walkability coverage analysis
  const runWalkability = useCallback(async () => {
    setWalkLoading(true);
    setWalkData(null);
    try {
      const params = new URLSearchParams({ minutes: String(walkMinutes) });
      if (selectedRouteIds.length > 0) params.set("routeIds", selectedRouteIds.join(","));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
      const r = await fetch(`${getApiBase()}/api/analysis/walkability-coverage?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setWalkData(json);
      if (json.isochroneUnion?.features?.length && mapRef.current) {
        const coords: [number, number][] = [];
        for (const f of json.isochroneUnion.features) {
          const g = f.geometry as any;
          const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
          for (const ring of rings) for (const c of ring) coords.push(c as [number, number]);
        }
        if (coords.length) {
          const lngs = coords.map(c => c[0]), lats = coords.map(c => c[1]);
          mapRef.current.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, duration: 1200 });
        }
      }
    } catch (err) {
      console.error("Walkability fetch failed:", err);
    } finally {
      setWalkLoading(false);
    }
  }, [walkMinutes, selectedRouteIds]);

  // Derived walkability chart data
  const walkDonut = useMemo(() => walkData ? [
    { name: "Coperta", value: walkData.coveredPopulation, fill: "#3b82f6" },
    { name: "Non coperta", value: walkData.totalPopulation - walkData.coveredPopulation, fill: "#334155" },
  ] : [], [walkData]);

  const walkBars = useMemo(() => walkData
    ? [...walkData.stops].sort((a, b) => b.coveredPop - a.coveredPop).slice(0, 8).map(s => ({
        name: s.stopName.length > 16 ? s.stopName.slice(0, 14) + "…" : s.stopName,
        full: s.stopName, pop: s.coveredPop,
      }))
    : [], [walkData]);

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.toLowerCase();
    return routeList.filter(r => {
      if (q && !(r.routeShortName || "").toLowerCase().includes(q) && !(r.routeLongName || "").toLowerCase().includes(q)) return false;
      if (timeBandRouteIds !== null && !timeBandRouteIds.includes(r.routeId)) return false;
      return true;
    });
  }, [routeList, routeSearch, timeBandRouteIds]);

  // ── View mode change handler ──────────────────────────────────

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    if (mode === "city3d" || mode === "city3d-dark") setLayers(p => ({ ...p, buildings: true }));
  }, []);

  // ── Render ────────────────────────────────────────────────────

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full items-center justify-center bg-card">
        <div className="text-center space-y-4 max-w-md p-8 border border-destructive/20 bg-destructive/5 rounded-2xl">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <h2 className="text-xl font-bold">Mapbox Token Mancante</h2>
        </div>
      </div>
    );
  }

  const showBuildings = layers.buildings && !isStandardStyle;

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* ── Time Range Bar ──────────────────────────────────────── */}
      <TimeRangeBar
        hourFrom={hourFrom}
        hourTo={hourTo}
        dayFilter={dayFilter}
        timeBandRouteIds={timeBandRouteIds}
        onHourFromChange={setHourFrom}
        onHourToChange={setHourTo}
        onDayFilterChange={setDayFilter}
        onReset={() => { setHourFrom(4); setHourTo(26); setDayFilter("tutti"); }}
      />

      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.45, latitude: 43.58, zoom: 10 }}
        mapStyle={MAP_STYLES[viewMode]}
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: "100%", height: "100%", paddingTop: 34 }}
        interactiveLayerIds={interactiveLayers}
        cursor={cursor}
        onClick={handleMapClick}
        onMouseMove={handleMouseMove}
        onLoad={handleMapLoad}
        onStyleData={handleStyleData}
      >
        {/* DEM for terrain */}
        <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />

        {/* Sky */}
        <Layer id="sky" type="sky" paint={{
          "sky-type": "atmosphere",
          "sky-atmosphere-sun": viewMode === "city3d" ? [0.0, 75.0]
            : viewMode === "city3d-dark" ? [0.0, 0.0] : [0.0, 90.0],
          "sky-atmosphere-sun-intensity": viewMode === "city3d" ? 8
            : viewMode === "city3d-dark" ? 3 : 12,
          "sky-atmosphere-color": viewMode === "satellite" ? "rgba(25,50,100,1)"
            : viewMode === "city3d" ? "rgba(85,140,200,1)"
            : viewMode === "city3d-dark" ? "rgba(30,18,48,1)"
            : "rgba(8,12,28,1)",
        }} />

        {/* Mapbox live traffic */}
        {layers.mapboxTraffic && (
          <Source id="mapbox-traffic" type="vector" url="mapbox://mapbox.mapbox-traffic-v1">
            <Layer id="mapbox-traffic-case" type="line" source-layer="traffic"
              paint={{ "line-width": ["interpolate",["linear"],["zoom"],7,3,14,8], "line-color":"#000","line-opacity":0.2 }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
            <Layer id="mapbox-traffic-lines" type="line" source-layer="traffic"
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],7,1.5,10,3,14,6],
                "line-color": ["match",["get","congestion"],"low","#22c55e","moderate","#eab308","heavy","#f97316","severe","#ef4444","#94a3b8"],
                "line-opacity": 0.9,
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
          </Source>
        )}

        {/* 3D buildings */}
        {showBuildings && (
          <Layer id="3d-buildings" type="fill-extrusion" source="composite" source-layer="building"
            filter={["==","extrude","yes"]} minzoom={14}
            paint={{
              "fill-extrusion-color": ["interpolate",["linear"],["zoom"],14,"#1e293b",17,"#334155"],
              "fill-extrusion-height": ["interpolate",["linear"],["zoom"],14,0,14.5,["get","height"]],
              "fill-extrusion-base": ["interpolate",["linear"],["zoom"],14,0,14.5,["get","min_height"]],
              "fill-extrusion-opacity": 0.75,
            }}
          />
        )}

        {/* Population Choropleth */}
        {layers.demand && enrichedChoropleth && (
          <Source id="pop-choropleth-src" type="geojson" data={enrichedChoropleth}>
            <Layer id="pop-choropleth-fill" type="fill"
              paint={{
                "fill-color": walkData ? [
                  "case",
                  ["==", ["get", "covered"], 1],
                  ["interpolate", ["linear"], ["get", "density"],
                    0, "#bbf7d0", 200, "#4ade80", 500, "#22c55e", 1000, "#16a34a", 3000, "#15803d", 8000, "#166534",
                  ],
                  ["interpolate", ["linear"], ["get", "density"],
                    0, "#ffffcc", 50, "#ffeda0", 200, "#feb24c", 500, "#fd8d3c", 1000, "#f03b20", 3000, "#bd0026", 8000, "#800026",
                  ],
                ] : [
                  "interpolate", ["linear"], ["get", "density"],
                  0, "#ffffcc", 50, "#ffeda0", 200, "#feb24c", 500, "#fd8d3c", 1000, "#f03b20", 3000, "#bd0026", 8000, "#800026",
                ],
                "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.3, 12, 0.4, 15, 0.35],
              }}
            />
            <Layer id="pop-choropleth-line" type="line"
              paint={{
                "line-color": walkData
                  ? ["case", ["==", ["get", "covered"], 1], "rgba(21,128,61,0.5)", "rgba(255,255,255,0.2)"]
                  : "rgba(255,255,255,0.2)",
                "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0, 12, 0.3, 15, 0.8],
              }}
            />
          </Source>
        )}

        {/* GTFS Shapes */}
        {layers.gtfsShapes && shapesGeojson && (
          <Source type="geojson" data={shapesGeojson}>
            <Layer id="gtfs-shapes-halo" type="line"
              filter={["==", ["typeof", ["get","congestion"]], "number"]}
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9,10,14,20],
                "line-color": ["interpolate",["linear"],["get","congestion"],0,"#22c55e",0.45,"#eab308",0.7,"#f97316",1,"#ef4444"],
                "line-opacity": ["interpolate",["linear"],["get","congestion"],0,0,0.3,0.06,0.6,0.15,1,0.3],
                "line-blur": 6,
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
            <Layer id="gtfs-shapes-outline" type="line"
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9,3.5,12,5.5,14,9],
                "line-color": viewMode === "city3d-dark" ? "#1a1028" : "#000000",
                "line-opacity": viewMode === "city3d-dark" ? 0.5 : 0.25,
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
            <Layer id="gtfs-shapes-line" type="line"
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9, viewMode === "city3d-dark" ? 2.5 : 2, 12, viewMode === "city3d-dark" ? 4.5 : 3.5, 14, viewMode === "city3d-dark" ? 7 : 6],
                "line-color": [
                  "case",
                  ["==", ["typeof", ["get","congestion"]], "number"],
                  ["interpolate",["linear"],["get","congestion"],0,"#22c55e",0.25,"#84cc16",0.5,"#eab308",0.7,"#f97316",0.9,"#ef4444",1,"#dc2626"],
                  ["coalesce",["get","routeColor"],"#60a5fa"],
                ],
                "line-opacity": viewMode === "city3d-dark" ? 1 : 0.88,
                ...(viewMode === "city3d-dark" ? { "line-emissive-strength": 0.85 } : {}),
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
          </Source>
        )}

        {/* TomTom Traffic Points */}
        {layers.traffic && trafficGeojson && (
          <Source type="geojson" data={trafficGeojson as any}>
            <Layer id="traffic-glow" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,18,14,35],
              "circle-color": ["interpolate",["linear"],["get","congestion"],0,"#22c55e",0.4,"#eab308",0.7,"#f97316",1,"#ef4444"],
              "circle-opacity": 0.1, "circle-blur": 1,
            }} />
            <Layer id="traffic-points" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,7,12,14,16,22],
              "circle-color": ["interpolate",["linear"],["get","congestion"],0,"#22c55e",0.3,"#84cc16",0.5,"#eab308",0.7,"#f97316",1,"#ef4444"],
              "circle-opacity": 0.92, "circle-stroke-width": 2, "circle-stroke-color": "rgba(255,255,255,0.19)",
            }} />
          </Source>
        )}

        {/* POI Points */}
        {layers.poi && poiGeojson && (
          <Source type="geojson" data={poiGeojson as any}>
            <Layer id="poi-glow" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,14,14,22],
              "circle-color": ["match",["get","category"],
                "school","#eab308","hospital","#ef4444","shopping","#a855f7",
                "industrial","#f97316","leisure","#22c55e","office","#3b82f6","transit","#06b6d4",
                "workplace","#64748b","worship","#d946ef","elderly","#f43f5e","parking","#94a3b8","tourism","#14b8a6",
                "#888888"],
              "circle-opacity": 0.15, "circle-blur": 1,
            }} />
            <Layer id="poi-points" type="symbol" layout={{
              "icon-image": ["concat","poi-",["get","category"]],
              "icon-size": ["interpolate",["linear"],["zoom"],8,0.35,12,0.55,16,0.75],
              "icon-allow-overlap": true, "icon-ignore-placement": true,
            }} paint={{ "icon-opacity": 0.95 }} />
          </Source>
        )}

        {/* GTFS Stops */}
        {layers.gtfsStops && gtfsStopsGeojson && (
          <Source type="geojson" data={gtfsStopsGeojson as any}>
            <Layer id="gtfs-stops" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8, viewMode === "city3d-dark" ? 4 : 3, 14, viewMode === "city3d-dark" ? 10 : 8],
              "circle-color": ["interpolate",["linear"],["coalesce",["get","score"],0],0,"#6b7280",30,"#ef4444",60,"#eab308",100,"#22c55e"],
              "circle-stroke-width": viewMode === "city3d-dark" ? 2 : 1.5,
              "circle-stroke-color": viewMode === "city3d-dark" ? "rgba(255,255,255,0.85)" : "#fff",
              "circle-opacity": 1,
              ...(viewMode === "city3d-dark" ? { "circle-emissive-strength": 0.9 } : {}),
            }} />
          </Source>
        )}

        {/* Isochrone walking polygons */}
        {isochroneGeojson && (
          <Source type="geojson" data={isochroneGeojson}>
            <Layer id="isochrone-fill" type="fill" paint={{
              "fill-color": ["match",["get","value"],300,"#3b82f6",600,"#1d4ed8","#2563eb"],
              "fill-opacity": ["match",["get","value"],300,0.3,600,0.15,0.2],
            }} />
            <Layer id="isochrone-outline" type="line" paint={{
              "line-color": ["match",["get","value"],300,"#2563eb",600,"#1e40af","#1d4ed8"],
              "line-width": 2, "line-opacity": 0.7, "line-dasharray": [2, 2],
            }} />
          </Source>
        )}

        {/* Walkability coverage polygons */}
        {walkData?.isochroneUnion && (
          <Source type="geojson" data={walkData.isochroneUnion}>
            <Layer id="walk-cover-fill" type="fill" paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.2 }} />
            <Layer id="walk-cover-outline" type="line" paint={{ "line-color": "#2563eb", "line-width": 1.5, "line-opacity": 0.5, "line-dasharray": [3, 2] }} />
          </Source>
        )}
        {walkData?.stops && (
          <Source type="geojson" data={{
            type: "FeatureCollection",
            features: walkData.stops.map(s => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
              properties: { name: s.stopName, pop: s.coveredPop },
            })),
          }}>
            <Layer id="walk-stop-dots" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["get","pop"],0,4,5000,10],
              "circle-color": "#22c55e", "circle-stroke-width": 1.5, "circle-stroke-color": "#fff", "circle-opacity": 0.9,
            }} />
          </Source>
        )}

        {/* Popup */}
        {popup && (
          <Popup longitude={popup.lng} latitude={popup.lat} onClose={() => setPopup(null)}
            closeOnClick={false} maxWidth="300px" style={{ zIndex: 100 }}>
            <PopupContent
              popup={popup}
              onShowIsochrone={fetchIsochrone}
              isochroneLoading={isochroneLoading}
              isochroneVisible={!!isochroneGeojson}
            />
          </Popup>
        )}
      </Map>

      {/* ── Route Filter Panel ─────────────────────────────────── */}
      <RouteFilterPanel
        visible={showRouteFilter}
        onClose={() => setShowRouteFilter(false)}
        routeSearch={routeSearch}
        onRouteSearchChange={setRouteSearch}
        selectedRouteIds={selectedRouteIds}
        selectedDirection={selectedDirection}
        onDirectionChange={setSelectedDirection}
        onResetSelection={() => { setSelectedRouteIds([]); setSelectedDirection(null); }}
        onToggleRoute={toggleRoute}
        filteredRoutes={filteredRoutes}
        routeListEmpty={routeList.length === 0}
      />

      {/* ── View mode selector ───────────────────────────────── */}
      <ViewModeSelector viewMode={viewMode} onViewModeChange={handleViewModeChange} />

      {/* ── Stats Card ──────────────────────────────────────────── */}
      <StatsCard
        collapsed={statsCollapsed}
        onToggle={() => setStatsCollapsed(v => !v)}
        gtfsSummary={gtfsSummary}
        dayFilter={dayFilter}
        avgCongestion={statsData?.avgCongestion}
      />

      {/* ── Layers & Legend panels ────────────────────────────── */}
      <div className="absolute top-4 right-4 md:w-64 pointer-events-none">
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}
          className="pointer-events-auto space-y-2">
          <LayersPanel
            collapsed={layersCollapsed}
            onToggle={() => setLayersCollapsed(v => !v)}
            layers={layers}
            onLayerChange={(key, val) => setLayers(p => ({ ...p, [key]: val }))}
            viewMode={viewMode}
            showBuildings={showBuildings}
            selectedPoiCats={selectedPoiCats}
            onPoiCatToggle={cat => setSelectedPoiCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])}
            showRouteFilter={showRouteFilter}
            selectedRouteIds={selectedRouteIds}
            selectedDirection={selectedDirection}
            onRouteFilterToggle={() => setShowRouteFilter(v => !v)}
          />
          <LegendPanel
            collapsed={legendCollapsed}
            onToggle={() => setLegendCollapsed(v => !v)}
            layers={layers}
            isochroneGeojson={isochroneGeojson}
            isochroneStop={isochroneStop}
            walkData={walkData}
          />
        </motion.div>
      </div>

      {/* ── Walkability Panel ────────────────────────────────── */}
      <WalkabilityPanel
        open={walkPanelOpen}
        onToggle={() => setWalkPanelOpen(v => !v)}
        walkData={walkData}
        walkLoading={walkLoading}
        walkMinutes={walkMinutes}
        onWalkMinutesChange={setWalkMinutes}
        onRun={runWalkability}
        selectedRouteCount={selectedRouteIds.length}
        walkDonut={walkDonut}
        walkBars={walkBars}
      />
    </div>
  );
}
