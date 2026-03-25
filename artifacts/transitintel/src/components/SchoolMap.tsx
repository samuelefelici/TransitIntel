import React, { useMemo, useState, useCallback, useRef } from "react";
import Map, { Source, Layer, Popup, MapRef } from "react-map-gl/mapbox";
import type { LayerProps } from "react-map-gl/mapbox";
import { GraduationCap, MapPin, Bus } from "lucide-react";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

/* ── Types ────────────────────────────────────────────── */
interface NearStop {
  name: string; lat: number; lng: number; stopId: string;
}

export interface SchoolMapItem {
  name: string; lat: number; lng: number;
  nearestStop: string; distM: number;
  nearestStopLat: number; nearestStopLng: number;
  entryBuses: number; exitBuses: number;
  entryRoutes: string[]; exitRoutes: string[];
  verdict: "ottimo" | "buono" | "sufficiente" | "critico";
  nearStops: NearStop[];
  connectedRoutes: { routeId: string; shortName: string; color: string }[];
}

export interface RouteShape {
  routeId: string; shortName: string; color: string; coordinates: number[][];
}

interface Props {
  items: SchoolMapItem[];
  routeShapes: RouteShape[];
}

/* ── Colors per verdict ─────────────────────────────── */
const V_COLOR: Record<string, string> = {
  ottimo: "#34d399",
  buono: "#60a5fa",
  sufficiente: "#fbbf24",
  critico: "#f87171",
};

/* ── Component ──────────────────────────────────────── */
export default function SchoolMap({ items, routeShapes }: Props) {
  const mapRef = useRef<MapRef>(null);
  const [selected, setSelected] = useState<SchoolMapItem | null>(null);
  const [hoveredRoute, setHoveredRoute] = useState<string | null>(null);

  /* Compute map center from data */
  const center = useMemo(() => {
    if (items.length === 0) return { lat: 43.55, lng: 13.35 };
    const lat = items.reduce((s, i) => s + i.lat, 0) / items.length;
    const lng = items.reduce((s, i) => s + i.lng, 0) / items.length;
    return { lat, lng };
  }, [items]);

  /* ── GeoJSON: school markers ──────────────────────── */
  const schoolPoints = useMemo((): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: items.map((s, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: {
        name: s.name,
        verdict: s.verdict,
        color: V_COLOR[s.verdict],
        entryBuses: s.entryBuses,
        exitBuses: s.exitBuses,
        distM: s.distM,
        idx: i,
      },
    })),
  }), [items]);

  /* ── GeoJSON: nearest-stop markers ─────────────────── */
  const stopPoints = useMemo((): GeoJSON.FeatureCollection => {
    const seen = new Set<string>();
    const features: GeoJSON.Feature[] = [];
    for (const s of items) {
      for (const ns of s.nearStops) {
        if (!seen.has(ns.stopId)) {
          seen.add(ns.stopId);
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [ns.lng, ns.lat] },
            properties: { name: ns.name, stopId: ns.stopId },
          });
        }
      }
    }
    return { type: "FeatureCollection", features };
  }, [items]);

  /* ── GeoJSON: connection lines (school → nearest stop) ─── */
  const connectionLines = useMemo((): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: items
      .filter(s => s.nearestStopLat !== 0 && s.nearestStopLng !== 0)
      .map((s, i) => ({
        type: "Feature",
        id: i,
        geometry: {
          type: "LineString",
          coordinates: [
            [s.lng, s.lat],
            [s.nearestStopLng, s.nearestStopLat],
          ],
        },
        properties: {
          verdict: s.verdict,
          color: V_COLOR[s.verdict],
          distM: s.distM,
        },
      })),
  }), [items]);

  /* ── GeoJSON: route shapes ────────────────────────── */
  const routeFeatures = useMemo((): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: routeShapes
      .filter(r => r.coordinates && r.coordinates.length > 1)
      .map(r => {
        const color = r.color.startsWith("#") ? r.color : `#${r.color}`;
        return {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: r.coordinates },
          properties: {
            routeId: r.routeId,
            shortName: r.shortName,
            color,
            highlighted: hoveredRoute === r.routeId ? 1 : 0,
          },
        };
      }),
  }), [routeShapes, hoveredRoute]);

  /* ── Click handler ────────────────────────────────── */
  const onClick = useCallback((e: any) => {
    const feat = e.features?.[0];
    if (feat && feat.layer?.id === "school-circles") {
      const idx = feat.properties?.idx;
      if (idx != null && items[idx]) {
        setSelected(items[idx]);
        return;
      }
    }
    setSelected(null);
  }, [items]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="h-64 rounded-xl border border-border/30 flex items-center justify-center text-muted-foreground text-xs">
        Mapbox token mancante — configura VITE_MAPBOX_TOKEN
      </div>
    );
  }

  /* ── Layer styles ─────────────────────────────────── */
  const routeLineLayer: LayerProps = {
    id: "route-lines",
    type: "line",
    paint: {
      "line-color": ["get", "color"],
      "line-width": [
        "case",
        ["==", ["get", "highlighted"], 1], 4,
        1.8,
      ],
      "line-opacity": [
        "case",
        ["==", ["get", "highlighted"], 1], 0.9,
        0.35,
      ],
    },
  };

  const connectionLineLayer: LayerProps = {
    id: "connection-lines",
    type: "line",
    paint: {
      "line-color": ["get", "color"],
      "line-width": 2,
      "line-dasharray": [3, 3],
      "line-opacity": 0.6,
    },
  };

  const stopCircleLayer: LayerProps = {
    id: "stop-circles",
    type: "circle",
    paint: {
      "circle-radius": 4,
      "circle-color": "#94a3b8",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#1e293b",
      "circle-opacity": 0.7,
    },
  };

  const schoolCircleLayer: LayerProps = {
    id: "school-circles",
    type: "circle",
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        8, 5,
        12, 9,
        15, 14,
      ],
      "circle-color": ["get", "color"],
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#0f172a",
      "circle-opacity": 0.9,
    },
  };

  const schoolLabelLayer: LayerProps = {
    id: "school-labels",
    type: "symbol",
    layout: {
      "text-field": ["get", "name"],
      "text-size": 10,
      "text-offset": [0, 1.8],
      "text-anchor": "top",
      "text-max-width": 12,
    },
    paint: {
      "text-color": "#e2e8f0",
      "text-halo-color": "#0f172a",
      "text-halo-width": 1.5,
    },
    minzoom: 11,
  };

  return (
    <div className="rounded-xl border border-border/30 overflow-hidden relative" style={{ height: 420 }}>
      {/* Legend */}
      <div className="absolute top-3 left-3 z-10 bg-card/90 backdrop-blur-sm border border-border/40 rounded-xl px-3 py-2 space-y-1.5 shadow-xl">
        <p className="text-[10px] font-bold text-foreground/80 uppercase tracking-wider">Legenda</p>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] text-muted-foreground">Ottimo (≥30 bus)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />
          <span className="text-[10px] text-muted-foreground">Buono (15–29)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
          <span className="text-[10px] text-muted-foreground">Sufficiente (5–14)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <span className="text-[10px] text-muted-foreground">Critico (&lt;5 bus)</span>
        </div>
        <div className="flex items-center gap-1.5 pt-1 border-t border-border/30">
          <span className="w-3 h-0.5 bg-slate-400 rounded" />
          <span className="text-[10px] text-muted-foreground">Linee bus</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-400/70 border border-slate-600" />
          <span className="text-[10px] text-muted-foreground">Fermate</span>
        </div>
      </div>

      {/* Route shapes list (right side) */}
      <div className="absolute top-3 right-3 z-10 bg-card/90 backdrop-blur-sm border border-border/40 rounded-xl px-2.5 py-2 shadow-xl max-h-[380px] overflow-y-auto" style={{ width: 140 }}>
        <p className="text-[10px] font-bold text-foreground/80 uppercase tracking-wider mb-1.5">
          Linee ({routeShapes.length})
        </p>
        <div className="space-y-0.5">
          {routeShapes.map(r => {
            const c = r.color.startsWith("#") ? r.color : `#${r.color}`;
            return (
              <button
                key={r.routeId}
                onMouseEnter={() => setHoveredRoute(r.routeId)}
                onMouseLeave={() => setHoveredRoute(null)}
                className={`flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-left transition-all ${
                  hoveredRoute === r.routeId ? "bg-primary/10 scale-[1.02]" : "hover:bg-muted/20"
                }`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c }} />
                <span className="text-[10px] font-medium truncate">{r.shortName}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={{
          longitude: center.lng,
          latitude: center.lat,
          zoom: 9.5,
        }}
        style={{ width: "100%", height: "100%" }}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        interactiveLayerIds={["school-circles"]}
        onClick={onClick}
      >
        {/* Route shapes */}
        <Source id="route-shapes" type="geojson" data={routeFeatures}>
          <Layer {...routeLineLayer} />
        </Source>

        {/* Connection lines (school → nearest stop) */}
        <Source id="connections" type="geojson" data={connectionLines}>
          <Layer {...connectionLineLayer} />
        </Source>

        {/* Stop markers */}
        <Source id="stops" type="geojson" data={stopPoints}>
          <Layer {...stopCircleLayer} />
        </Source>

        {/* School markers */}
        <Source id="schools" type="geojson" data={schoolPoints}>
          <Layer {...schoolCircleLayer} />
          <Layer {...schoolLabelLayer} />
        </Source>

        {/* Popup */}
        {selected && (
          <Popup
            longitude={selected.lng}
            latitude={selected.lat}
            anchor="bottom"
            onClose={() => setSelected(null)}
            closeOnClick={false}
            maxWidth="280px"
          >
            <div className="space-y-2 p-1">
              <div className="flex items-start gap-2">
                <GraduationCap className="w-4 h-4 text-violet-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-bold text-slate-800 leading-tight">{selected.name}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white"
                      style={{ backgroundColor: V_COLOR[selected.verdict] }}
                    >
                      {selected.verdict.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {selected.entryBuses + selected.exitBuses} bus/giorno
                    </span>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-1.5">
                <div className="flex items-center gap-1 mb-1">
                  <MapPin className="w-3 h-3 text-slate-400" />
                  <span className="text-[10px] text-slate-600">
                    {selected.nearestStop} · {selected.distM}m
                  </span>
                </div>
                <div className="flex gap-3">
                  <div>
                    <span className="text-[9px] text-slate-400 block">Ingresso</span>
                    <span className="text-xs font-bold text-slate-700">{selected.entryBuses} bus</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-400 block">Uscita</span>
                    <span className="text-xs font-bold text-slate-700">{selected.exitBuses} bus</span>
                  </div>
                </div>
              </div>

              {selected.connectedRoutes.length > 0 && (
                <div className="border-t border-slate-200 pt-1.5">
                  <div className="flex items-center gap-1 mb-1">
                    <Bus className="w-3 h-3 text-slate-400" />
                    <span className="text-[10px] text-slate-500">Linee che servono questa scuola</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {selected.connectedRoutes.map(r => {
                      const c = r.color.startsWith("#") ? r.color : `#${r.color}`;
                      return (
                        <span
                          key={r.routeId}
                          className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white"
                          style={{ backgroundColor: c }}
                          onMouseEnter={() => setHoveredRoute(r.routeId)}
                          onMouseLeave={() => setHoveredRoute(null)}
                        >
                          {r.shortName}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}
