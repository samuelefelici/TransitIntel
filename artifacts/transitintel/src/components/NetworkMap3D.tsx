/**
 * Mappa di rete 3D interattiva (Mapbox GL JS, stile Standard).
 * Mostra le linee selezionate come tracciati colorati su edifici 3D + terreno,
 * con i nodi logici / interscambi evidenziati. Esplorabile (ruota/inclina/zoom).
 * Sorgente dati: /api/planning-studio/:projectId/timetables/network.
 */
import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapGL, Source, Layer, Marker, NavigationControl, FullscreenControl } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { Camera, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";

interface NStop {
  stopId: string; name: string; lat: number; lon: number;
  clusterId?: string | null; clusterName?: string | null;
  clusterLogical?: boolean; clusterLat?: number | null; clusterLon?: number | null;
}
interface NLine { routeId: string; shortName: string | null; longName: string | null; color: string | null; stops: NStop[] }
interface NData { projectId: string; lines: NLine[]; cityNodes?: Array<{ name: string; lat: number; lon: number }> }

function col(c: string | null | undefined): string {
  if (!c) return "#2563eb";
  return c.startsWith("#") ? c : `#${c}`;
}

export type NetLineStyle = "solid" | "dashed" | "dotted";
export type NetNodeLabels = "logical" | "all";

// Pattern dasharray (in unità di larghezza linea). Per i puntini usiamo un dash
// quasi nullo + line-cap "round" così ogni tratto diventa un cerchietto.
const DASH_PATTERN: Record<NetLineStyle, [number, number] | null> = {
  solid: null,
  dashed: [2, 1.6],
  dotted: [0.1, 2],
};

export default function NetworkMap3D({
  projectId, routeIds, colorOverrides,
  lineStyles, nodeLabels = "logical",
}: {
  projectId: string; routeIds: string[]; colorOverrides?: Record<string, string>;
  lineStyles?: Record<string, NetLineStyle>; nodeLabels?: NetNodeLabels;
}) {
  const mapRef = useRef<MapRef>(null);
  const q = useQuery({
    queryKey: ["timetables", "net3d", projectId, [...routeIds].sort().join(",")],
    queryFn: () => apiFetch<NData>(
      `/api/planning-studio/${encodeURIComponent(projectId)}/timetables/network?routeIds=${routeIds.map(encodeURIComponent).join(",")}`,
    ),
    enabled: !!projectId && routeIds.length > 0 && !!MAPBOX_TOKEN,
  });
  const data = q.data;

  const { fc, bbox, nodes, lineW } = useMemo(() => {
    const lines = (data?.lines ?? []).filter((l) => l.stops.length >= 2);
    const features = lines.map((l) => ({
      type: "Feature" as const,
      properties: {
        color: col(colorOverrides?.[l.routeId] ?? l.color),
        style: (lineStyles?.[l.routeId] ?? "solid") as NetLineStyle,
      },
      geometry: { type: "LineString" as const, coordinates: l.stops.map((s) => [s.lon, s.lat]) },
    }));
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const l of lines) for (const st of l.stops) {
      if (st.lon < w) w = st.lon; if (st.lon > e) e = st.lon;
      if (st.lat < s) s = st.lat; if (st.lat > n) n = st.lat;
    }
    const map = new Map<string, { lon: number; lat: number; name: string; lines: Set<string>; logical: boolean }>();
    for (const l of lines) for (const st of l.stops) {
      const key = (st.clusterLogical && st.clusterId) ? `c:${st.clusterId}` : `s:${st.stopId}`;
      const lon = st.clusterLogical ? (st.clusterLon ?? st.lon) : st.lon;
      const lat = st.clusterLogical ? (st.clusterLat ?? st.lat) : st.lat;
      const name = st.clusterLogical ? (st.clusterName || st.name) : st.name;
      let m = map.get(key);
      if (!m) { m = { lon, lat, name, lines: new Set<string>(), logical: !!st.clusterLogical }; map.set(key, m); }
      m.lines.add(l.routeId); if (st.clusterLogical) m.logical = true;
    }
    const nodes = [...map.values()].filter((m) => m.logical || m.lines.size >= 2);
    // Spessore calibrato sul numero di linee: poche → pieno, tante → sottile,
    // così con molte linee selezionate la mappa non diventa confusionaria.
    const nLines = lines.length;
    const k = Math.max(0.42, Math.min(1, 1 - (nLines - 3) * 0.06));
    const lineW: [number, number] = [3 * k, 6 * k];
    return {
      fc: { type: "FeatureCollection" as const, features },
      bbox: (isFinite(w) ? [w, s, e, n] : null) as [number, number, number, number] | null,
      nodes,
      lineW,
    };
  }, [data, colorOverrides, lineStyles]);

  if (!MAPBOX_TOKEN) {
    return <div className="p-4 text-xs text-muted-foreground">VITE_MAPBOX_TOKEN non configurato — mappa 3D non disponibile.</div>;
  }
  if (!routeIds.length) {
    return <div className="p-4 text-xs text-muted-foreground">Seleziona almeno una linea per la mappa 3D.</div>;
  }

  const center = bbox
    ? { longitude: (bbox[0] + bbox[2]) / 2, latitude: (bbox[1] + bbox[3]) / 2 }
    : { longitude: 13.5, latitude: 43.6 };

  function exportPng() {
    const ref: any = mapRef.current;
    const canvas: HTMLCanvasElement | undefined = ref?.getCanvas?.() ?? ref?.getMap?.().getCanvas?.();
    if (!canvas) return;
    try {
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `mappa-rete-3d-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
    } catch { /* canvas tainted/non disponibile */ }
  }

  return (
    <div className="relative rounded-xl border border-border/60 overflow-hidden" style={{ height: "70vh" }}>
      {q.isLoading && (
        <div className="absolute z-10 top-2 left-2 px-2 py-1 rounded bg-background/80 text-xs flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico mappa…
        </div>
      )}
      <button
        onClick={exportPng}
        className="absolute z-10 bottom-2 left-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/85 hover:bg-background border border-border/60 text-xs font-medium shadow"
        title="Esporta la vista come immagine PNG"
      >
        <Camera className="w-3.5 h-3.5" /> Esporta PNG
      </button>
      <MapGL
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={{ longitude: center.longitude, latitude: center.latitude, zoom: 12, pitch: 55, bearing: -18 }}
        style={{ width: "100%", height: "100%" }}
        preserveDrawingBuffer
        mapStyle="mapbox://styles/mapbox/streets-v12"
        attributionControl={false}
        onLoad={(ev: any) => {
          const m = ev.target;
          try {
            if (bbox) m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 70, pitch: 55, bearing: -18, duration: 0 });
          } catch { /* noop */ }
          try {
            if (!m.getSource("mapbox-dem")) {
              m.addSource("mapbox-dem", { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 512, maxzoom: 14 });
              m.setTerrain({ source: "mapbox-dem", exaggeration: 1.1 });
            }
          } catch { /* noop */ }
          // Palazzi 3D: estrusione colorata per altezza (i più alti risaltano),
          // a basso zoom così si abbraccia tutta la città. Sotto le etichette.
          try {
            if (!m.getLayer("net3d-buildings")) {
              const layers = m.getStyle().layers || [];
              const labelLayerId = layers.find((l: any) => l.type === "symbol" && l.layout?.["text-field"])?.id;
              m.addLayer({
                id: "net3d-buildings",
                source: "composite",
                "source-layer": "building",
                filter: ["==", ["get", "extrude"], "true"],
                type: "fill-extrusion",
                minzoom: 10,
                paint: {
                  "fill-extrusion-color": ["interpolate", ["linear"], ["get", "height"],
                    0, "#dfe3ee", 15, "#c7cfe2", 40, "#9fb0d6", 90, "#6f87c4", 180, "#48619e"],
                  "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 10, ["get", "height"], 16, ["get", "height"]],
                  "fill-extrusion-base": ["get", "min_height"],
                  "fill-extrusion-opacity": 0.85,
                },
              }, labelLayerId);
            }
          } catch { /* noop */ }
        }}
      >
        <NavigationControl position="top-right" visualizePitch />
        <FullscreenControl position="top-right" />
        {fc.features.length > 0 && (
          <Source id="net3d" type="geojson" data={fc as any}>
            {/* Un layer per stile di tratto: lo stile è per-linea (proprietà
                "style" della feature). Mapbox non supporta line-dasharray
                data-driven, quindi filtriamo per stile. */}
            <Layer
              id="net3d-line-solid"
              type="line"
              filter={["==", ["get", "style"], "solid"]}
              paint={{
                "line-color": ["get", "color"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, lineW[0], 14, lineW[1]],
                "line-opacity": 0.95,
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
            <Layer
              id="net3d-line-dashed"
              type="line"
              filter={["==", ["get", "style"], "dashed"]}
              paint={{
                "line-color": ["get", "color"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, lineW[0], 14, lineW[1]],
                "line-opacity": 0.95,
                "line-dasharray": DASH_PATTERN.dashed!,
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
            <Layer
              id="net3d-line-dotted"
              type="line"
              filter={["==", ["get", "style"], "dotted"]}
              paint={{
                "line-color": ["get", "color"],
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, lineW[0], 14, lineW[1]],
                "line-opacity": 0.95,
                "line-dasharray": DASH_PATTERN.dotted!,
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
          </Source>
        )}
        {nodes.map((nd, i) => (
          <Marker key={i} longitude={nd.lon} latitude={nd.lat} anchor="center">
            <div className="flex items-center gap-1">
              {/* Solo i nodi logici sono evidenziati (pallino grande + bordo
                  spesso). Gli interscambi/fermate restano un puntino discreto,
                  anche se ci passano più linee. */}
              <span style={{ width: nd.logical ? 13 : 6, height: nd.logical ? 13 : 6, borderRadius: "50%", background: "#fff", border: nd.logical ? "3px solid #111" : "1.5px solid #555", boxShadow: "0 1px 3px rgba(0,0,0,.4)" }} />
              {(nd.logical || nodeLabels === "all") && (
                <span style={{ fontSize: 11, fontWeight: 800, color: "#111", background: "rgba(255,255,255,.82)", padding: "0 4px", borderRadius: 4, whiteSpace: "nowrap" }}>{nd.name}</span>
              )}
            </div>
          </Marker>
        ))}
      </MapGL>
    </div>
  );
}
