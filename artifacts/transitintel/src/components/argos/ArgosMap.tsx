/**
 * ArgosMap — rende un blocco ```map prodotto da Argos come mappa Mapbox reale.
 *
 * Lo spec è il JSON che Argos mette nel blocco, es:
 *   {"area":"Ancona","pois":true,"from":{lat,lng,label},"to":{lat,lng,label}}
 * La geometria delle linee arriva dal proxy /api/ai/argos/geo (→ Argos /geo/routes,
 * feed GTFS in esercizio). from/to sono disegnati direttamente dallo spec.
 */
import React from "react";
import { Map as MapGL, Source, Layer, Marker } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { MapPin, Loader2 } from "lucide-react";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";

type Pt = { lat: number; lng: number; label?: string };
type MapSpec = {
  area?: string; search?: string; routes?: string | string[]; pois?: boolean;
  from?: Pt; to?: Pt;
};
type GeoRoute = { name?: string; color?: string | null; path?: [number, number][] };
type GeoData = { routes?: GeoRoute[]; pois?: { lat: number; lng: number }[]; bbox?: [number, number, number, number] };

export default function ArgosMap({ spec }: { spec: MapSpec }) {
  const [data, setData] = React.useState<GeoData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const mapRef = React.useRef<MapRef | null>(null);

  const needsFetch = !!(spec.area || spec.search || spec.routes);

  React.useEffect(() => {
    if (!needsFetch) { setData({ routes: [] }); return; }
    let cancelled = false;
    setLoading(true); setErr(null);
    const qs = new URLSearchParams();
    if (spec.search) qs.set("search", spec.search);
    if (spec.area) qs.set("area", spec.area);
    if (spec.routes) qs.set("routes", Array.isArray(spec.routes) ? spec.routes.join(",") : String(spec.routes));
    if (spec.pois) qs.set("pois", "true");
    fetch(`${getApiBase()}/api/ai/argos/geo?${qs.toString()}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d?.error) setErr(d.error); else setData(d); } })
      .catch(e => { if (!cancelled) setErr(e?.message || "errore"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [spec.area, spec.search, JSON.stringify(spec.routes), spec.pois]); // eslint-disable-line react-hooks/exhaustive-deps

  // GeoJSON delle linee (path è [lat,lng] → Mapbox vuole [lng,lat]).
  const linesGeo = React.useMemo(() => ({
    type: "FeatureCollection" as const,
    features: (data?.routes || [])
      .filter(r => (r.path?.length || 0) > 1)
      .map(r => ({
        type: "Feature" as const,
        properties: { color: r.color ? (r.color.startsWith("#") ? r.color : `#${r.color}`) : "#a78bfa" },
        geometry: { type: "LineString" as const, coordinates: r.path!.map(p => [p[1], p[0]]) },
      })),
  }), [data]);

  const poisGeo = React.useMemo(() => ({
    type: "FeatureCollection" as const,
    features: (data?.pois || []).slice(0, 150).map(p => ({
      type: "Feature" as const, properties: {},
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    })),
  }), [data]);

  const fit = React.useCallback((map: any) => {
    const lngs: number[] = [], lats: number[] = [];
    if (data?.bbox) { lngs.push(data.bbox[0], data.bbox[2]); lats.push(data.bbox[1], data.bbox[3]); }
    for (const pt of [spec.from, spec.to]) if (pt) { lngs.push(pt.lng); lats.push(pt.lat); }
    if (!lngs.length) return;
    try {
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 26, duration: 0, maxZoom: 15 });
    } catch { /* noop */ }
  }, [data, spec.from, spec.to]);

  React.useEffect(() => { const m = mapRef.current?.getMap?.(); if (m) fit(m as any); }, [fit]);

  if (!MAPBOX_TOKEN) {
    return <div className="my-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">🗺️ Mappa non disponibile — VITE_MAPBOX_TOKEN non configurato.</div>;
  }

  return (
    <div className="my-2 rounded-xl overflow-hidden border border-violet-400/30 relative" style={{ height: 240 }}>
      <MapGL
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={{ longitude: spec.from?.lng ?? 13.5, latitude: spec.from?.lat ?? 43.6, zoom: 10 }}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        onLoad={(e) => fit(e.target as any)}
        attributionControl={false}
        style={{ width: "100%", height: "100%" }}
      >
        {linesGeo.features.length > 0 && (
          <Source id="argos-lines" type="geojson" data={linesGeo as any}>
            <Layer id="argos-lines-l" type="line"
              paint={{ "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.85 }}
              layout={{ "line-cap": "round", "line-join": "round" }} />
          </Source>
        )}
        {poisGeo.features.length > 0 && (
          <Source id="argos-pois" type="geojson" data={poisGeo as any}>
            <Layer id="argos-pois-l" type="circle"
              paint={{ "circle-radius": 3, "circle-color": "#fb923c", "circle-opacity": 0.8 }} />
          </Source>
        )}
        {spec.from && (
          <Marker longitude={spec.from.lng} latitude={spec.from.lat} anchor="bottom">
            <MapPin className="w-5 h-5 text-emerald-400 drop-shadow" />
          </Marker>
        )}
        {spec.to && (
          <Marker longitude={spec.to.lng} latitude={spec.to.lat} anchor="bottom">
            <MapPin className="w-5 h-5 text-rose-400 drop-shadow" />
          </Marker>
        )}
      </MapGL>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-violet-200 text-xs gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> carico la mappa…
        </div>
      )}
      {err && !loading && (
        <div className="absolute bottom-1 left-1 right-1 rounded bg-rose-500/20 border border-rose-400/40 px-2 py-1 text-[10px] text-rose-200">
          {err}
        </div>
      )}
    </div>
  );
}
