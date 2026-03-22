import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import Map, { Source, Layer, Popup, MapMouseEvent, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity, MapPin, AlertTriangle, Layers, Users,
  Building2, Satellite, Sun, SlidersHorizontal,
  Search, X, ChevronDown, ChevronUp, Star, Clock,
  Bus, Route, TrendingUp,
} from "lucide-react";

import {
  useGetAnalysisStats, useGetTraffic, useGetPoi, useGetDemandScore,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

const MAP_STYLES: Record<string, string> = {
  dark:      "mapbox://styles/mapbox/dark-v11",
  city3d:    "mapbox://styles/mapbox/standard",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

type DayFilter = "tutti" | "feriale" | "sabato" | "domenica";

type ViewMode = "dark" | "city3d" | "satellite";

interface GtfsSummary {
  available: boolean;
  totalRoutes: number;
  totalStops: number;
  totalTrips: number;
  weekdayTrips: number;
  saturdayTrips: number;
  sundayTrips: number;
  firstDeparture?: string;
  lastArrival?: string;
  topRoutes: { name: string; color: string; trips: number }[];
}

const POI_CATEGORY_IT: Record<string, string> = {
  hospital:   "🏥 Ospedale",
  school:     "🏫 Scuola / Università",
  shopping:   "🛒 Centro Commerciale",
  industrial: "🏭 Zona Industriale",
  leisure:    "⚽ Svago / Sport",
  office:     "🏛️ Ufficio / P.A.",
  transit:    "🚌 Hub Trasporti",
};
const POI_COLOR: Record<string, string> = {
  hospital:   "#ef4444",
  school:     "#eab308",
  shopping:   "#a855f7",
  industrial: "#f97316",
  leisure:    "#22c55e",
  office:     "#3b82f6",
  transit:    "#06b6d4",
};

function congestionLabel(c: number): { text: string; color: string } {
  if (c < 0.3) return { text: "Scorrevole", color: "#22c55e" };
  if (c < 0.5) return { text: "Moderato",   color: "#84cc16" };
  if (c < 0.7) return { text: "Rallentato", color: "#eab308" };
  if (c < 0.85) return { text: "Intenso",    color: "#f97316" };
  return { text: "Critico", color: "#ef4444" };
}

interface RouteItem {
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  tripsCount: number | null;
}
interface ShapeVariant {
  shapeId: string;
  directionId: number;
  headsign: string | null;
  tripsCount: number;
  sampleTripId: string;
}
interface GtfsStop {
  id: string; stopId: string; stopName: string; stopCode: string | null;
  stopLat: number; stopLon: number; tripsCount: number;
  morningPeakTrips: number; eveningPeakTrips: number;
  serviceScore: number; wheelchairBoarding?: number;
  stopDesc?: string | null;
}
interface MapPopup {
  lng: number; lat: number;
  type: "traffic" | "poi" | "gtfsStop" | "shape";
  props: Record<string, any>;
}

export default function Dashboard() {
  const mapRef = useRef<MapRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("dark");
  const [gtfsSummary, setGtfsSummary] = useState<GtfsSummary | null>(null);
  const [selectedPoiCats, setSelectedPoiCats] = useState<string[]>(Object.keys(POI_COLOR));

  const is3D = viewMode === "city3d";

  const [layers, setLayers] = useState({
    traffic: true,
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

  // Route filter state
  const [showRouteFilter, setShowRouteFilter] = useState(false);
  const [routeList, setRouteList] = useState<RouteItem[]>([]);
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>([]);
  const [routeSearch, setRouteSearch] = useState("");

  // Shape variant filter (third level: line → direction → variant)
  const [variantsMap, setVariantsMap] = useState<Record<string, ShapeVariant[]>>({});
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]);
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null);
  const [loadingVariants, setLoadingVariants] = useState<string | null>(null);

  // Direction + time range + day filters
  const [selectedDirection, setSelectedDirection] = useState<0 | 1 | null>(null);
  const [hourFrom, setHourFrom] = useState<number>(4);
  const [hourTo, setHourTo] = useState<number>(26);
  const [dayFilter, setDayFilter] = useState<DayFilter>("tutti");
  const [timeBandRouteIds, setTimeBandRouteIds] = useState<string[] | null>(null);

  const [gtfsStops, setGtfsStops] = useState<GtfsStop[]>([]);
  const [shapesGeojson, setShapesGeojson] = useState<any>(null);
  const [popup, setPopup] = useState<MapPopup | null>(null);
  const [cursor, setCursor] = useState("grab");

  const { data: statsData }   = useGetAnalysisStats();
  const { data: trafficData } = useGetTraffic({ limit: 1000 });
  const { data: demandData }  = useGetDemandScore({});
  const { data: poiData }     = useGetPoi({});

  // Fetch GTFS summary for stats card
  useEffect(() => {
    fetch(`${getApiBase()}/api/gtfs/summary`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.available) setGtfsSummary(d); })
      .catch(() => {});
  }, []);

  // Fetch routes for filter panel, deduplicate by routeId — retry on transient failures
  useEffect(() => {
    let cancelled = false;
    const loadRoutes = (retries = 3) => {
      fetch(`${getApiBase()}/api/gtfs/routes`, { cache: "no-store" })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(d => {
          if (cancelled) return;
          const all: RouteItem[] = Array.isArray(d.data) ? d.data : [];
          const seen: Record<string, RouteItem> = {};
          for (const r of all) {
            if (!seen[r.routeId] || (r.tripsCount ?? 0) > (seen[r.routeId].tripsCount ?? 0)) {
              seen[r.routeId] = r;
            }
          }
          setRouteList(Object.values(seen));
        })
        .catch(err => {
          if (cancelled) return;
          console.warn(`Routes fetch failed (retries left: ${retries}):`, err?.message ?? err);
          if (retries > 0) setTimeout(() => loadRoutes(retries - 1), 800);
        });
    };
    loadRoutes();
    return () => { cancelled = true; };
  }, []);

  // Fetch GTFS stops — filtered by selected routes when available
  useEffect(() => {
    if (!layers.gtfsStops) return;
    const url = selectedRouteIds.length > 0
      ? `${getApiBase()}/api/gtfs/stops?routeIds=${selectedRouteIds.join(",")}&limit=5000`
      : `${getApiBase()}/api/gtfs/stops?limit=5000`;
    fetch(url)
      .then(r => r.json())
      .then(d => setGtfsStops(d.data || []))
      .catch(() => {});
  }, [layers.gtfsStops, selectedRouteIds.join(",")]);

  // Fetch active routes when time range or day filter changes (debounced 600ms)
  useEffect(() => {
    const isDefault = hourFrom === 4 && hourTo === 26 && dayFilter === "tutti";
    if (isDefault) { setTimeBandRouteIds(null); return; }
    const t = setTimeout(() => {
      const params = new URLSearchParams({ hourStart: String(hourFrom), hourEnd: String(hourTo) });
      if (dayFilter !== "tutti") params.set("day", dayFilter);
      fetch(`${getApiBase()}/api/gtfs/routes/active-by-band?${params}`, { cache: "no-store" })
        .then(r => r.json())
        .then(d => setTimeBandRouteIds(Array.isArray(d.routeIds) ? d.routeIds : null))
        .catch(() => setTimeBandRouteIds(null));
    }, 600);
    return () => clearTimeout(t);
  }, [hourFrom, hourTo, dayFilter]);

  // Fetch shapes — use shapeIds when specific variants selected, else routeIds
  const shapesFetchKey = useMemo(
    () => {
      if (selectedShapeIds.length > 0) {
        return "shapes:" + [...selectedShapeIds].sort().join(",") + "|" + hourFrom + "-" + hourTo + "|" + dayFilter;
      }
      const eff = selectedRouteIds.length > 0 ? selectedRouteIds : (timeBandRouteIds ?? []);
      return [...eff].sort().join(",") + "|" + (selectedDirection ?? "") + "|" + hourFrom + "-" + hourTo + "|" + dayFilter;
    },
    [selectedShapeIds, selectedRouteIds, selectedDirection, timeBandRouteIds, hourFrom, hourTo, dayFilter]
  );
  useEffect(() => {
    if (!layers.gtfsShapes) return;
    setShapesGeojson(null);
    const midHour = Math.round((hourFrom + hourTo) / 2);
    const params = new URLSearchParams({ segmented: "true", hour: String(midHour) });

    if (selectedShapeIds.length > 0) {
      // Specific shape variants selected — use shapeIds directly
      params.set("shapeIds", selectedShapeIds.join(","));
    } else {
      const eff = selectedRouteIds.length > 0 ? selectedRouteIds : (timeBandRouteIds ?? []);
      if (eff.length > 0) params.set("routeIds", eff.join(","));
      if (selectedDirection !== null) params.set("directionId", String(selectedDirection));
    }

    fetch(`${getApiBase()}/api/gtfs/shapes/geojson?${params}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => setShapesGeojson(d))
      .catch(() => {});
  }, [layers.gtfsShapes, shapesFetchKey]);

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

  const handleMapLoad = useCallback(() => setMapLoaded(true), []);
  const handleStyleData = useCallback(() => {
    if (!is3D) return;
    const m = mapRef.current?.getMap();
    setTimeout(() => { try { m?.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 }); } catch {} }, 300);
  }, [is3D]);

  // GeoJSON builders
  const trafficGeojson = useMemo(() => {
    if (!trafficData?.data) return null;
    return {
      type: "FeatureCollection",
      features: trafficData.data.map(t => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lng, t.lat] },
        properties: {
          congestion: t.congestionLevel, speed: t.speed,
          freeflow: t.freeflowSpeed, segmentId: t.segmentId,
        },
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
              category: p.category,
              name: p.name,
              rating: props.rating ?? null,
              vicinity: props.vicinity ?? null,
              userRatingsTotal: props.user_ratings_total ?? null,
              types: JSON.stringify(props.types ?? []),
              source: props.source ?? null,
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
          wheelchair: s.wheelchairBoarding ?? 0,
          desc: s.stopDesc ?? null,
        },
      })),
    };
  }, [gtfsStops]);

  const interactiveLayers = useMemo(() => {
    const ids: string[] = [];
    if (layers.traffic) ids.push("traffic-points");
    if (layers.poi) ids.push("poi-points");
    if (layers.gtfsStops) ids.push("gtfs-stops");
    if (layers.gtfsShapes) ids.push("gtfs-shapes-line");
    return ids;
  }, [layers]);

  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const feature = (e as any).features?.[0];
    if (!feature) { setPopup(null); return; }
    const layerId: string = feature.layer?.id || "";
    const props = feature.properties || {};
    const [lng, lat] = (feature.geometry as any)?.coordinates?.slice(0, 2) || [e.lngLat.lng, e.lngLat.lat];
    if (layerId === "traffic-points")   setPopup({ lng, lat, type: "traffic",   props });
    else if (layerId === "poi-points")  setPopup({ lng, lat, type: "poi",       props });
    else if (layerId === "gtfs-stops")  setPopup({ lng, lat, type: "gtfsStop",  props });
    else if (layerId === "gtfs-shapes-line") setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, type: "shape", props });
  }, []);

  const handleMouseMove = useCallback((e: MapMouseEvent) => {
    setCursor((e as any).features?.[0] ? "pointer" : "grab");
  }, []);

  const toggleRoute = useCallback((routeId: string) => {
    setSelectedRouteIds(prev =>
      prev.includes(routeId) ? prev.filter(id => id !== routeId) : [...prev, routeId]
    );
    // When deselecting a route, clear its variant selections
    setSelectedShapeIds(prev => {
      const routeShapes = (variantsMap[routeId] || []).map(v => v.shapeId);
      return prev.filter(s => !routeShapes.includes(s));
    });
    // Collapse variant panel if this route was expanded
    setExpandedRouteId(prev => prev === routeId ? null : prev);
  }, [variantsMap]);

  // Load variants when a route is expanded
  const loadVariants = useCallback((routeId: string) => {
    if (expandedRouteId === routeId) { setExpandedRouteId(null); return; }
    setExpandedRouteId(routeId);
    // Skip fetch if already cached
    if (variantsMap[routeId]) return;
    setLoadingVariants(routeId);
    const params = new URLSearchParams();
    if (selectedDirection !== null) params.set("directionId", String(selectedDirection));
    fetch(`${getApiBase()}/api/gtfs/routes/${routeId}/variants?${params}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setVariantsMap(prev => ({ ...prev, [routeId]: d.variants || [] }));
        setLoadingVariants(null);
      })
      .catch(() => setLoadingVariants(null));
  }, [expandedRouteId, variantsMap, selectedDirection]);

  // Invalidate variants cache when direction changes
  useEffect(() => {
    setVariantsMap({});
    setSelectedShapeIds([]);
    setExpandedRouteId(null);
  }, [selectedDirection]);

  const toggleShapeVariant = useCallback((shapeId: string) => {
    setSelectedShapeIds(prev =>
      prev.includes(shapeId) ? prev.filter(s => s !== shapeId) : [...prev, shapeId]
    );
  }, []);

  // Auto-enable stops layer when routes are selected
  useEffect(() => {
    if (selectedRouteIds.length > 0) {
      setLayers(prev => prev.gtfsStops ? prev : { ...prev, gtfsStops: true });
    }
  }, [selectedRouteIds.length]);

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.toLowerCase();
    return routeList.filter(r => {
      if (q && !(r.routeShortName || "").toLowerCase().includes(q) && !(r.routeLongName || "").toLowerCase().includes(q)) return false;
      if (timeBandRouteIds !== null && !timeBandRouteIds.includes(r.routeId)) return false;
      return true;
    });
  }, [routeList, routeSearch, timeBandRouteIds]);

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

  // Standard style (city3d) has built-in 3D buildings — only show custom layer for dark/satellite
  const showBuildings = layers.buildings && viewMode !== "city3d";

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* ── Time Range Bar — overlay at top of map ──────────────── */}
      <div className="absolute top-0 left-0 right-0 z-10 pointer-events-auto">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-background/80 backdrop-blur-xl border-b border-border/30">
          <Clock className="w-3 h-3 text-muted-foreground/70 shrink-0" />
          <span className="text-[10px] text-muted-foreground shrink-0">Orario</span>

          {/* From hour */}
          <select
            value={hourFrom}
            onChange={e => {
              const v = +e.target.value;
              setHourFrom(v);
              if (v >= hourTo) setHourTo(Math.min(v + 1, 26));
            }}
            className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            {Array.from({ length: 23 }, (_, i) => i + 4).map(h => (
              <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
            ))}
          </select>

          <span className="text-[10px] text-muted-foreground/60">→</span>

          {/* To hour */}
          <select
            value={hourTo}
            onChange={e => {
              const v = +e.target.value;
              setHourTo(v);
              if (v <= hourFrom) setHourFrom(Math.max(v - 1, 4));
            }}
            className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            {Array.from({ length: 22 }, (_, i) => i + 5).map(h => (
              <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
            ))}
          </select>

          <div className="w-px h-3.5 bg-border/40 mx-0.5 shrink-0" />

          {/* Day filter */}
          {(["tutti", "feriale", "sabato", "domenica"] as const).map(d => (
            <button key={d} onClick={() => setDayFilter(d)}
              className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                dayFilter === d
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
              }`}>
              {d === "tutti" ? "Tutti" : d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}

          {/* Active route count badge */}
          {timeBandRouteIds !== null && (
            <span className="ml-auto shrink-0 text-[10px] text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
              {timeBandRouteIds.length} linee attive
            </span>
          )}

          {/* Reset */}
          {(hourFrom !== 4 || hourTo !== 26 || dayFilter !== "tutti") && (
            <button
              onClick={() => { setHourFrom(4); setHourTo(26); setDayFilter("tutti"); }}
              className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-primary transition-colors ml-1"
            >
              Reset
            </button>
          )}
        </div>
      </div>

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
          "sky-atmosphere-sun": [0.0, 90.0],
          "sky-atmosphere-sun-intensity": 12,
          "sky-atmosphere-color": viewMode === "satellite" ? "rgba(25,50,100,1)" : "rgba(8,12,28,1)",
        }} />

        {/* Mapbox live traffic on roads */}
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
              "fill-extrusion-opacity": viewMode === "city3d" ? 0.88 : 0.75,
            }}
          />
        )}

        {/* Demand Heatmap */}
        {layers.demand && demandGeojson && (
          <Source type="geojson" data={demandGeojson as any}>
            <Layer id="demand-heatmap" type="heatmap" paint={{
              "heatmap-weight": ["get","score"],
              "heatmap-intensity": ["interpolate",["linear"],["zoom"],0,1,15,3],
              "heatmap-color": ["interpolate",["linear"],["heatmap-density"],
                0,"rgba(33,102,172,0)",0.2,"rgb(103,169,207)",0.5,"rgb(253,219,199)",0.8,"rgb(239,138,98)",1,"rgb(178,24,43)"],
              "heatmap-radius": ["interpolate",["linear"],["zoom"],0,8,15,40],
            }} />
          </Source>
        )}

        {/* GTFS Shapes */}
        {layers.gtfsShapes && shapesGeojson && (
          <Source type="geojson" data={shapesGeojson}>
            {/* Outer glow for high-congestion segments */}
            <Layer id="gtfs-shapes-halo" type="line"
              filter={["==", ["typeof", ["get","congestion"]], "number"]}
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9,10,14,20],
                "line-color": [
                  "interpolate",["linear"],["get","congestion"],
                  0,"#22c55e",0.45,"#eab308",0.7,"#f97316",1,"#ef4444",
                ],
                "line-opacity": [
                  "interpolate",["linear"],["get","congestion"],
                  0,0,0.3,0.06,0.6,0.15,1,0.3,
                ],
                "line-blur": 6,
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
            {/* Dark outline for readability */}
            <Layer id="gtfs-shapes-outline" type="line"
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9,3.5,12,5.5,14,9],
                "line-color": "#000000",
                "line-opacity": 0.25,
              }}
              layout={{ "line-cap":"round","line-join":"round" }}
            />
            {/* Main line — colored by congestion when data available, else route's own color */}
            <Layer id="gtfs-shapes-line" type="line"
              paint={{
                "line-width": ["interpolate",["linear"],["zoom"],9,2,12,3.5,14,6],
                "line-color": [
                  "case",
                  ["==", ["typeof", ["get","congestion"]], "number"],
                  [
                    "interpolate",["linear"],["get","congestion"],
                    0,"#22c55e",0.25,"#84cc16",0.5,"#eab308",0.7,"#f97316",0.9,"#ef4444",1,"#dc2626",
                  ],
                  ["coalesce",["get","routeColor"],"#60a5fa"],
                ],
                "line-opacity": 0.88,
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
              "circle-opacity": 0.1,
              "circle-blur": 1,
            }} />
            <Layer id="traffic-points" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,7,12,14,16,22],
              "circle-color": ["interpolate",["linear"],["get","congestion"],0,"#22c55e",0.3,"#84cc16",0.5,"#eab308",0.7,"#f97316",1,"#ef4444"],
              "circle-opacity": 0.92,
              "circle-stroke-width": 2,
              "circle-stroke-color": "rgba(255, 255, 255, 0.19)",
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
                "industrial","#f97316","leisure","#22c55e","office","#3b82f6","transit","#06b6d4","#ffffff"],
              "circle-opacity": 0.15,
              "circle-blur": 1,
            }} />
            <Layer id="poi-points" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,5,12,8,16,13],
              "circle-color": ["match",["get","category"],
                "school","#eab308","hospital","#ef4444","shopping","#a855f7",
                "industrial","#f97316","leisure","#22c55e","office","#3b82f6","transit","#06b6d4","#ffffff"],
              "circle-stroke-width": 1.5,
              "circle-stroke-color": "#ffffff",
              "circle-opacity": 0.9,
            }} />
          </Source>
        )}

        {/* GTFS Stops */}
        {layers.gtfsStops && gtfsStopsGeojson && (
          <Source type="geojson" data={gtfsStopsGeojson as any}>
            <Layer id="gtfs-stops" type="circle" paint={{
              "circle-radius": ["interpolate",["linear"],["zoom"],8,3,14,8],
              "circle-color": ["interpolate",["linear"],["coalesce",["get","score"],0],
                0,"#6b7280",30,"#ef4444",60,"#eab308",100,"#22c55e"],
              "circle-stroke-width": 1.5,
              "circle-stroke-color": "#fff",
              "circle-opacity": 0.9,
            }} />
          </Source>
        )}

        {/* Popup */}
        {popup && (
          <Popup longitude={popup.lng} latitude={popup.lat} onClose={() => setPopup(null)}
            closeOnClick={false} maxWidth="300px" style={{ zIndex: 100 }}>
            <PopupContent popup={popup} />
          </Popup>
        )}
      </Map>

      {/* ── Route Filter Panel ─────────────────────────────────── */}
      <AnimatePresence>
        {showRouteFilter && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-72 z-10 pointer-events-auto"
          >
            <Card className="bg-card/95 backdrop-blur-xl border-border/60 shadow-2xl">
              <CardContent className="p-3 space-y-2.5">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold flex items-center gap-1.5">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-primary" />
                    Filtra Linee GTFS
                  </span>
                  <div className="flex items-center gap-2">
                    {(selectedRouteIds.length > 0 || selectedDirection !== null || selectedShapeIds.length > 0) && (
                      <button onClick={() => { setSelectedRouteIds([]); setSelectedDirection(null); setSelectedShapeIds([]); setExpandedRouteId(null); setVariantsMap({}); }}
                        className="text-[10px] text-muted-foreground hover:text-foreground underline">
                        Reset
                      </button>
                    )}
                    <button onClick={() => setShowRouteFilter(false)}
                      className="text-muted-foreground hover:text-foreground">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Direction filter */}
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Verso (direction)</p>
                  <div className="grid grid-cols-3 gap-1">
                    {([
                      { val: null, label: "Entrambi" },
                      { val: 0,    label: "→ Andata" },
                      { val: 1,    label: "← Ritorno" },
                    ] as { val: 0|1|null; label: string }[]).map(opt => (
                      <button key={String(opt.val)} onClick={() => setSelectedDirection(opt.val)}
                        className={`px-2 py-1 rounded-lg border text-[10px] font-medium transition-all ${
                          selectedDirection === opt.val
                            ? "bg-primary/15 border-primary/40 text-primary"
                            : "border-border/40 text-muted-foreground hover:bg-muted/50"
                        }`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    value={routeSearch}
                    onChange={e => setRouteSearch(e.target.value)}
                    placeholder="Cerca linea..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted rounded-lg border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                {selectedRouteIds.length > 0 && (
                  <div className="text-[10px] text-primary bg-primary/10 rounded px-2 py-1">
                    {selectedRouteIds.length} {selectedRouteIds.length === 1 ? "linea selezionata" : "linee selezionate"}
                    {selectedDirection !== null && ` · ${selectedDirection === 0 ? "Andata" : "Ritorno"}`}
                    {selectedShapeIds.length > 0 && ` · ${selectedShapeIds.length} percors${selectedShapeIds.length === 1 ? "o" : "i"}`}
                  </div>
                )}

                {/* Route list with expandable variants */}
                <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1">
                  {filteredRoutes.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      {routeList.length === 0 ? "Carica un feed GTFS per vedere le linee" : "Nessun risultato"}
                    </p>
                  )}
                  {filteredRoutes.map(route => {
                    const isSelected = selectedRouteIds.includes(route.routeId);
                    const isExpanded = expandedRouteId === route.routeId;
                    const color = route.routeColor || "#6b7280";
                    const variants = variantsMap[route.routeId] || [];
                    const dirVariants = selectedDirection !== null
                      ? variants.filter(v => v.directionId === selectedDirection)
                      : variants;
                    return (
                      <div key={route.routeId}>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => toggleRoute(route.routeId)}
                            className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                              isSelected ? "bg-primary/15 border border-primary/30" : "hover:bg-muted/70 border border-transparent"
                            }`}
                          >
                            <div className="w-3 h-3 rounded-full shrink-0 border border-black/20" style={{ backgroundColor: color }} />
                            <span className="text-xs font-semibold shrink-0 w-8 truncate">{route.routeShortName || route.routeId}</span>
                            <span className="text-[10px] text-muted-foreground truncate flex-1">
                              {route.routeLongName || ""}
                            </span>
                            {route.tripsCount != null && (
                              <span className="text-[10px] text-muted-foreground shrink-0">{route.tripsCount}↗</span>
                            )}
                          </button>
                          {/* Expand button for variants */}
                          {isSelected && (
                            <button
                              onClick={() => loadVariants(route.routeId)}
                              className={`shrink-0 p-1 rounded-md transition-colors ${
                                isExpanded ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                              }`}
                              title="Mostra varianti percorso"
                            >
                              {loadingVariants === route.routeId ? (
                                <span className="w-3.5 h-3.5 block border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                              ) : isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                        {/* Variants sub-list */}
                        {isSelected && isExpanded && dirVariants.length > 0 && (
                          <div className="ml-5 pl-2 border-l-2 border-border/30 mt-0.5 mb-1 space-y-0.5">
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold py-0.5">
                              {dirVariants.length} percors{dirVariants.length === 1 ? "o" : "i"} distint{dirVariants.length === 1 ? "o" : "i"}
                            </p>
                            {dirVariants.map((v, idx) => {
                              const isShapeSelected = selectedShapeIds.includes(v.shapeId);
                              return (
                                <button
                                  key={v.shapeId}
                                  onClick={() => toggleShapeVariant(v.shapeId)}
                                  className={`w-full flex items-start gap-1.5 px-2 py-1 rounded-md text-left transition-colors text-[10px] ${
                                    isShapeSelected
                                      ? "bg-primary/15 border border-primary/30"
                                      : "hover:bg-muted/60 border border-transparent"
                                  }`}
                                >
                                  <Route className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
                                  <div className="flex-1 min-w-0">
                                    <div className="font-medium truncate">
                                      {v.headsign || `Percorso ${idx + 1}`}
                                    </div>
                                    <div className="text-muted-foreground">
                                      {v.directionId === 0 ? "→ And." : "← Rit."} · {v.tripsCount} cors{v.tripsCount === 1 ? "a" : "e"}
                                    </div>
                                  </div>
                                  {isShapeSelected && (
                                    <span className="text-primary text-xs">✓</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {isSelected && isExpanded && dirVariants.length === 0 && loadingVariants !== route.routeId && (
                          <p className="ml-5 pl-2 text-[10px] text-muted-foreground italic py-1">Nessuna variante trovata</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Map controls ─────────────────────────────────────────── */}
      <div className="absolute bottom-6 right-4 flex flex-col gap-2 pointer-events-auto">
        <div className="bg-card/90 backdrop-blur-xl border border-border/50 shadow-xl rounded-xl p-1 flex gap-1">
          {([
            { key: "dark"      as ViewMode, icon: <Sun className="w-3.5 h-3.5" />,       label: "Scuro" },
            { key: "city3d"    as ViewMode, icon: <Building2 className="w-3.5 h-3.5" />, label: "Città 3D" },
            { key: "satellite" as ViewMode, icon: <Satellite className="w-3.5 h-3.5" />, label: "Satellite" },
          ]).map(({ key, icon, label }) => (
            <button key={key} title={label}
              onClick={() => {
                setViewMode(key);
                if (key === "city3d") setLayers(p => ({ ...p, buildings: true }));
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                viewMode === key
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}>
              {icon}
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Stats Card ──────────────────────────────────────────── */}
      <div className="absolute top-10 left-4 md:w-72 pointer-events-none">
        <AnimatePresence>
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="pointer-events-auto">
            <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-2xl">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-bold">Stato Rete</h2>
                  <span className="ml-auto text-[10px] text-muted-foreground">Conerobus · Ancona/Marche</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <StatBox label="Linee totali"   value={gtfsSummary?.totalRoutes?.toString() ?? "--"} icon={<Route className="w-3.5 h-3.5" />}  color="text-blue-400" />
                  <StatBox label="Fermate"         value={gtfsSummary?.totalStops != null ? gtfsSummary.totalStops.toLocaleString("it-IT") : "--"} icon={<MapPin className="w-3.5 h-3.5" />}  color="text-cyan-400" />
                  <StatBox label="Corse (feriali)" value={gtfsSummary?.weekdayTrips != null ? gtfsSummary.weekdayTrips.toLocaleString("it-IT") : "--"} icon={<Bus className="w-3.5 h-3.5" />} color="text-green-400" />
                  <StatBox label="Corse (sabato)"  value={gtfsSummary?.saturdayTrips != null ? gtfsSummary.saturdayTrips.toLocaleString("it-IT") : "--"} icon={<TrendingUp className="w-3.5 h-3.5" />} color="text-amber-400" />
                </div>
                {/* Orario servizio */}
                {gtfsSummary?.firstDeparture && (
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-2.5 py-1.5">
                    <span>Prima corsa</span>
                    <span className="font-mono font-semibold text-foreground">{gtfsSummary.firstDeparture.substring(0,5)}</span>
                    <span>Ultima</span>
                    <span className="font-mono font-semibold text-foreground">{gtfsSummary.lastArrival?.substring(0,5)}</span>
                  </div>
                )}
                {/* Copertura population */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" /> Copertura pop.</span>
                    <span>{statsData?.coveragePercent?.toFixed(1) ?? 0}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-all duration-700"
                      style={{ width: `${statsData?.coveragePercent ?? 0}%` }} />
                  </div>
                </div>
                {/* Traffico */}
                {statsData?.avgCongestion != null && (
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="flex items-center gap-1 text-muted-foreground"><Activity className="w-3 h-3" /> Congestione media</span>
                    <span className="font-semibold" style={{ color: congestionLabel(statsData.avgCongestion).color }}>
                      {congestionLabel(statsData.avgCongestion).text} ({(statsData.avgCongestion * 100).toFixed(0)}%)
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Layers Panel ────────────────────────────────────────── */}
      <div className="absolute top-4 right-4 md:w-64 pointer-events-none">
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}
          className="pointer-events-auto space-y-2">

          {/* Layer toggles card — collapsible */}
          <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
            <button
              onClick={() => setLayersCollapsed(v => !v)}
              className="w-full p-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Layers className="w-4 h-4 text-primary" />
                Layer Mappa
              </span>
              {layersCollapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
            </button>
            <AnimatePresence initial={false}>
              {!layersCollapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <CardContent className="px-3 pb-3 pt-0 space-y-2.5 border-t border-border/30">
                    {(([
                      { key: "traffic",       label: "Sensori traffico",    hint: "clicca per dettaglio" },
                      { key: "mapboxTraffic", label: "Traffico strade",     hint: "live — strade principali" },
                      { key: "demand",        label: "Domanda (heatmap)" },
                      { key: "poi",           label: "Punti di interesse",  hint: "clicca per info" },
                      { key: "gtfsShapes",    label: "Percorsi GTFS",       hint: "colorati per congestione" },
                      { key: "gtfsStops",     label: "Fermate GTFS",        hint: "clicca per dettaglio" },
                    ] as Array<{ key: keyof typeof layers; label: string; hint?: string }>)).map(({ key, label, hint }) => (
                      <div key={key}>
                        <div className="flex items-center justify-between gap-2 pt-0.5">
                          <div>
                            <Label htmlFor={`layer-${key}`} className="text-sm cursor-pointer">{label}</Label>
                            {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
                          </div>
                          <Switch
                            id={`layer-${key}`}
                            checked={key === "buildings" ? showBuildings : layers[key]}
                            disabled={key === "buildings" && viewMode === "city3d"}
                            onCheckedChange={c => setLayers(p => ({ ...p, [key]: c }))}
                          />
                        </div>
                        {/* POI category filter pills */}
                        {key === "poi" && layers.poi && (
                          <div className="flex flex-wrap gap-1 mt-1.5 pl-0">
                            {Object.entries(POI_COLOR).map(([cat, color]) => {
                              const on = selectedPoiCats.includes(cat);
                              return (
                                <button key={cat}
                                  onClick={() => setSelectedPoiCats(prev => on ? prev.filter(c => c !== cat) : [...prev, cat])}
                                  className={`text-[9px] px-1.5 py-0.5 rounded-full border transition-all ${on ? "opacity-100" : "opacity-30"}`}
                                  style={{ borderColor: color, color }}>
                                  {POI_CATEGORY_IT[cat]?.split(" ")[0]} {cat.charAt(0).toUpperCase() + cat.slice(1)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Route filter button */}
                    {layers.gtfsShapes && (
                      <button
                        onClick={() => setShowRouteFilter(v => !v)}
                        className={`w-full mt-1 flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                          showRouteFilter || selectedRouteIds.length > 0 || selectedDirection !== null
                            ? "bg-primary/15 border-primary/40 text-primary"
                            : "bg-muted/40 border-border/40 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                          Filtra linee
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedRouteIds.length > 0 && (
                            <Badge className="text-[10px] h-4 px-1.5 bg-primary text-primary-foreground">{selectedRouteIds.length}</Badge>
                          )}
                          {selectedDirection !== null && (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1">{selectedDirection === 0 ? "→" : "←"}</Badge>
                          )}
                          {!selectedRouteIds.length && selectedDirection === null && (
                            <ChevronDown className="w-3.5 h-3.5" />
                          )}
                        </div>
                      </button>
                    )}
                  </CardContent>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>

          {/* Legend — single collapsible card */}
          {(layers.mapboxTraffic || layers.traffic || layers.poi || layers.gtfsShapes) && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
                <button
                  onClick={() => setLegendCollapsed(v => !v)}
                  className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-muted/20 transition-colors"
                >
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Legenda</span>
                  {legendCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
                <AnimatePresence initial={false}>
                  {!legendCollapsed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <CardContent className="px-3 pb-3 pt-0 space-y-3 border-t border-border/30">
                        {layers.gtfsShapes && (
                          <div className="space-y-1.5 pt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Percorsi — congestione</p>
                            {[
                              { color:"#22c55e", h:2,   label:"Scorrevole",    hint:"0–25%" },
                              { color:"#eab308", h:3.5, label:"Rallentato",    hint:"25–65%" },
                              { color:"#f97316", h:5.5, label:"Congestionato", hint:"65–85%" },
                              { color:"#ef4444", h:8,   label:"Critico",       hint:"> 85%" },
                            ].map(({ color, h, label, hint }) => (
                              <div key={label} className="flex items-center gap-2.5">
                                <div className="w-7 flex items-center"><div className="w-full rounded-full" style={{ backgroundColor: color, height: `${h}px` }} /></div>
                                <span className="text-xs text-foreground/80">{label}</span>
                                <span className="text-[10px] text-muted-foreground ml-auto">({hint})</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {layers.traffic && (
                          <div className="space-y-1.5 border-t border-border/20 pt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Sensori TomTom</p>
                            {[["#22c55e","Scorrevole"],["#eab308","Rallentato"],["#ef4444","Congestionato"]].map(([c,l]) => (
                              <div key={l} className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: c }} />
                                <span className="text-xs text-muted-foreground">{l}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {layers.mapboxTraffic && (
                          <div className="space-y-1.5 border-t border-border/20 pt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Traffico strade (live)</p>
                            {[["#22c55e","Scorrevole"],["#eab308","Moderato"],["#f97316","Intenso"],["#ef4444","Critico"]].map(([c,l]) => (
                              <div key={l} className="flex items-center gap-2">
                                <div className="w-6 h-2 rounded-full" style={{ backgroundColor: c }} />
                                <span className="text-xs text-muted-foreground">{l}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {layers.poi && (
                          <div className="space-y-1.5 border-t border-border/20 pt-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Punti di interesse</p>
                            {Object.entries(POI_COLOR).map(([cat, color]) => (
                              <div key={cat} className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full border border-black/30" style={{ backgroundColor: color }} />
                                <span className="text-xs text-muted-foreground">{POI_CATEGORY_IT[cat]?.replace(/^.+\s/, "") || cat}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function StatBox({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground flex items-center gap-1">{icon} {label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function PopupContent({ popup }: { popup: MapPopup }) {
  const { type, props } = popup;

  if (type === "traffic") {
    const cong = typeof props.congestion === "number" ? props.congestion : 0;
    const { text, color } = congestionLabel(cong);
    const speedReduction = props.freeflow > 0 ? Math.round((1 - props.speed / props.freeflow) * 100) : null;
    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-semibold text-sm text-gray-900">🚦 Sensore Traffico</div>
        <div className="text-[10px] text-gray-400 font-mono">{props.segmentId}</div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-bold" style={{ color }}>{text}</span>
          {speedReduction != null && speedReduction > 0 && (
            <span className="ml-auto text-xs text-red-500 font-semibold">−{speedReduction}% velocità</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
          <span className="text-gray-400">Velocità attuale</span><span className="font-bold">{props.speed?.toFixed(0)} km/h</span>
          <span className="text-gray-400">Flusso libero</span><span className="font-bold">{props.freeflow?.toFixed(0)} km/h</span>
          <span className="text-gray-400">Congestione</span><span className="font-bold">{Math.round(cong * 100)}%</span>
        </div>
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${cong * 100}%`, backgroundColor: color }} />
        </div>
      </div>
    );
  }

  if (type === "poi") {
    const catLabel = POI_CATEGORY_IT[props.category] || props.category;
    const catColor = POI_COLOR[props.category] || "#6b7280";
    const rating = typeof props.rating === "number" ? props.rating : null;
    const total = typeof props.userRatingsTotal === "number" ? props.userRatingsTotal : null;
    let types: string[] = [];
    try { types = JSON.parse(props.types || "[]"); } catch {}
    const displayTypes = types.filter(t => !["point_of_interest","establishment"].includes(t)).slice(0, 3);

    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-bold text-sm text-gray-900 leading-snug">{props.name}</div>
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs text-white font-medium" style={{ backgroundColor: catColor }}>
          {catLabel}
        </div>
        {rating != null && (
          <div className="flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            <span className="text-sm font-bold text-gray-800">{rating.toFixed(1)}</span>
            {total != null && <span className="text-xs text-gray-400">({total.toLocaleString("it-IT")} recensioni)</span>}
          </div>
        )}
        {props.vicinity && props.vicinity !== "null" && (
          <div className="text-xs text-gray-500 flex items-start gap-1">
            <MapPin className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{props.vicinity}</span>
          </div>
        )}
        {displayTypes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {displayTypes.map(t => (
              <span key={t} className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">{t.replace(/_/g," ")}</span>
            ))}
          </div>
        )}
        {props.source === "google_places" && (
          <div className="text-[9px] text-gray-400 border-t border-gray-100 pt-1">Fonte: Google Places</div>
        )}
      </div>
    );
  }

  if (type === "gtfsStop") {
    const score = typeof props.score === "number" ? props.score : 0;
    const hasData = props.trips > 0;
    const scoreColor = score >= 60 ? "#22c55e" : score >= 30 ? "#eab308" : "#ef4444";
    const scoreLabel = score >= 60 ? "Buono" : score >= 30 ? "Sufficiente" : "Insufficiente";
    const wheelchair = props.wheelchair === 1 || props.wheelchair === "1";

    return (
      <div className="space-y-2 min-w-[220px]">
        <div className="flex items-start justify-between gap-2">
          <div className="font-bold text-sm text-gray-900 leading-snug flex-1">{props.name}</div>
          {wheelchair && <span title="Accessibile" className="text-base shrink-0">♿</span>}
        </div>
        {props.code && props.code !== "-" && (
          <div className="text-[10px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded w-fit">Cod. {props.code}</div>
        )}
        {props.desc && props.desc !== "null" && (
          <div className="text-xs text-gray-500 italic">{props.desc}</div>
        )}
        {hasData ? (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700 bg-gray-50 rounded-lg p-2">
              <span className="text-gray-400">Corse giorno</span><span className="font-bold">{props.trips}</span>
              <span className="text-gray-400">Picco mattina</span><span className="font-bold">{props.morning} <span className="text-gray-400 font-normal">(7–9h)</span></span>
              <span className="text-gray-400">Picco sera</span><span className="font-bold">{props.evening} <span className="text-gray-400 font-normal">(17–19h)</span></span>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-400">Score servizio</span>
                <span className="font-bold text-xs" style={{ color: scoreColor }}>{scoreLabel} ({Math.round(score)})</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: scoreColor }} />
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-400 italic">Re-importa il feed GTFS per aggiornare i dati.</p>
        )}
      </div>
    );
  }

  if (type === "shape") {
    const cong = props.congestion;
    const speedReduction = typeof props.speedReduction === "number" ? props.speedReduction : null;
    const speed = typeof props.speed === "number" ? props.speed : null;
    const freeflow = typeof props.freeflow === "number" ? props.freeflow : null;
    const routeName = props.routeShortName || props.routeId;

    if (cong === null || cong === undefined) {
      return (
        <div className="space-y-1.5 min-w-[180px]">
          <div className="font-semibold text-sm text-gray-900">
            🚌 {routeName ? `Linea ${routeName}` : "Percorso GTFS"}
          </div>
          <div className="text-xs text-gray-400">Nessun sensore TomTom nelle vicinanze.</div>
        </div>
      );
    }

    const { text, color } = congestionLabel(cong);
    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-semibold text-sm text-gray-900">
          🚌 {routeName ? `Linea ${routeName}` : "Percorso GTFS"}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="font-bold text-sm" style={{ color }}>{text}</span>
          {speedReduction != null && speedReduction > 0 && (
            <span className="ml-auto text-xs font-bold text-red-500">−{speedReduction}% velocità</span>
          )}
        </div>
        {speed != null && freeflow != null && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-700">
            <span className="text-gray-400">Vel. attuale</span><span className="font-semibold">{speed.toFixed(0)} km/h</span>
            <span className="text-gray-400">Flusso libero</span><span className="font-semibold">{freeflow.toFixed(0)} km/h</span>
            <span className="text-gray-400">Congestione</span><span className="font-semibold">{Math.round(cong * 100)}%</span>
          </div>
        )}
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${cong * 100}%`, backgroundColor: color }} />
        </div>
        {speedReduction != null && speedReduction > 15 && (
          <div className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
            ⚠ Il traffico rallenta le corse del {speedReduction}% su questo tratto
          </div>
        )}
      </div>
    );
  }

  return null;
}
