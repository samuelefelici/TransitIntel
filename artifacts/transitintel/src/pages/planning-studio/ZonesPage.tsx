/**
 * PlannerStudio — ZONIZZAZIONE.
 *
 * Confini comunali su mappa + calcolo automatico dei km sviluppati per comune
 * dalle linee del progetto (per i corrispettivi chilometrici dovuti agli enti).
 *
 * Flusso:
 *   1. upload GeoJSON dei confini (es. comuni ISTAT / geojson-italy) → POST /zones/import
 *   2. selezione anno + "Calcola km per comune" → POST /planning-studio/:id/zones/compute
 *   3. tabella comune × km/anno (dettaglio per linea espandibile) + export CSV
 *   4. click su un comune → flyTo + highlight del poligono sulla mappa
 */
import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import Map, { Source, Layer, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Landmark, Upload, Trash2, Calculator, Download, Loader2,
  ChevronRight, ChevronDown, Info, Bus, FileText,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { MAPBOX_TOKEN, MAP_STYLES } from "@/pages/dashboard/constants";
import { getPsProject } from "@/lib/planning-studio-api";
import {
  exportZonizzazioneHtml,
  type CalendarKm, type WeekdayKm, type CalendarDef, type CategoryKm,
} from "./zonizzazione-export";

/* ─── Tipi API ─── */
interface Zone {
  id: string;
  name: string;
  istatCode: string | null;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: any };
}
interface ZoneRouteKm {
  routeId: string;
  shortName: string;
  color: string | null;
  kmYear: number;
  runsYear: number;
  kmPerRun: number;
  byCalendar?: CalendarKm[];
  byWeekday?: WeekdayKm[];
  byCategory?: CategoryKm[];
}
interface ZoneKm {
  zoneId: string;
  name: string;
  istatCode: string | null;
  totalKmYear: number;
  byRoute: ZoneRouteKm[];
}
interface ComputeResult {
  year: number;
  zones: ZoneKm[];
  unassignedKm: number;
  calendars?: CalendarDef[];
  totals?: { byCalendar: CalendarKm[]; byWeekday: WeekdayKm[]; byCategory?: CategoryKm[] };
  meta?: { zoneCount: number; variantCount: number; tripCount: number };
}

/* ─── Palette ciclica per i confini ─── */
const ZONE_COLORS = [
  "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24",
  "#60a5fa", "#fb7185", "#4ade80", "#e879f9", "#f97316",
];

/** Bounding box [minLon,minLat,maxLon,maxLat] di un Polygon/MultiPolygon. */
function geomBBox(geometry: Zone["geometry"]): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords: any) => {
    if (typeof coords?.[0] === "number") {
      if (coords[0] < minX) minX = coords[0];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[1] > maxY) maxY = coords[1];
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  };
  walk(geometry?.coordinates);
  if (!isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

/** Centroide approssimato (media dei vertici del primo ring) per le label. */
function geomLabelPoint(geometry: Zone["geometry"]): [number, number] | null {
  const bb = geomBBox(geometry);
  if (!bb) return null;
  return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
}

const fmtKm = (v: number) =>
  v.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function PlanningStudioZonesPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  const mapRef = useRef<MapRef>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [result, setResult] = useState<ComputeResult | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });

  const zonesQ = useQuery({
    queryKey: ["zones"],
    queryFn: () => apiFetch<{ zones: Zone[] }>("/api/zones").then((r) => r.zones),
  });
  const zones = zonesQ.data ?? [];

  /* ─── Upload GeoJSON confini ─── */
  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error("File non valido: atteso GeoJSON"); }
      return apiFetch<{ ok: boolean; inserted: number; updated: number; skipped: number }>(
        "/api/zones/import",
        { method: "POST", body: JSON.stringify(json) },
      );
    },
    onSuccess: (r) => {
      toast.success(`Confini importati: ${r.inserted} nuovi, ${r.updated} aggiornati${r.skipped ? `, ${r.skipped} scartati` : ""}`);
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e: any) => toast.error(e?.message || "Errore import confini"),
  });

  // Import one-click dei 47 comuni della provincia di Ancona: il GeoJSON
  // (fonte openpolis/geojson-italy, confini ISTAT) è incluso negli asset.
  const anconaMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}data/comuni-provincia-ancona.geojson`);
      if (!res.ok) throw new Error("GeoJSON comuni non trovato negli asset");
      const json = await res.json();
      return apiFetch<{ ok: boolean; inserted: number; updated: number; skipped: number }>(
        "/api/zones/import",
        { method: "POST", body: JSON.stringify(json) },
      );
    },
    onSuccess: (r) => {
      toast.success(`Comuni provincia di Ancona importati: ${r.inserted} nuovi, ${r.updated} aggiornati`);
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e: any) => toast.error(e?.message || "Errore import comuni Ancona"),
  });

  const clearMut = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>("/api/zones", { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Confini eliminati");
      setResult(null);
      setSelectedZoneId(null);
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
    onError: (e: any) => toast.error(e?.message || "Errore eliminazione"),
  });

  /* ─── Compute km per comune ─── */
  const computeMut = useMutation({
    mutationFn: () =>
      apiFetch<ComputeResult>(
        `/api/planning-studio/projects/${projectId}/zones/compute?year=${year}`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      setResult(r);
      if (r.zones.length === 0) toast.info("Nessuna linea interseca i confini caricati");
      else toast.success(`Calcolo completato: ${r.zones.length} comuni interessati`);
    },
    onError: (e: any) => toast.error(e?.message || "Errore calcolo"),
  });

  /* ─── GeoJSON per la mappa (fill + line + label) ─── */
  const zonesFC = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: zones.map((z, i) => ({
        type: "Feature" as const,
        geometry: z.geometry,
        properties: {
          id: z.id,
          name: z.name,
          color: ZONE_COLORS[i % ZONE_COLORS.length],
          selected: z.id === selectedZoneId ? 1 : 0,
        },
      })),
    };
  }, [zones, selectedZoneId]);

  const labelsFC = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: zones
        .map((z, i) => {
          const pt = geomLabelPoint(z.geometry);
          if (!pt) return null;
          return {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: pt },
            properties: { name: z.name, color: ZONE_COLORS[i % ZONE_COLORS.length] },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    };
  }, [zones]);

  /* ─── flyTo su un comune ─── */
  const flyToZone = (zoneId: string) => {
    setSelectedZoneId(zoneId);
    const z = zones.find((zz) => zz.id === zoneId);
    if (!z) return;
    const bb = geomBBox(z.geometry);
    if (!bb) return;
    mapRef.current?.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 900 });
  };

  /* ─── Fit iniziale quando arrivano le zone ─── */
  const didFit = useRef(false);
  const fitAllZones = () => {
    if (didFit.current || zones.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const z of zones) {
      const bb = geomBBox(z.geometry);
      if (!bb) continue;
      minX = Math.min(minX, bb[0]); minY = Math.min(minY, bb[1]);
      maxX = Math.max(maxX, bb[2]); maxY = Math.max(maxY, bb[3]);
    }
    if (!isFinite(minX)) return;
    mapRef.current?.fitBounds([[minX, minY], [maxX, maxY]], { padding: 60, duration: 0 });
    didFit.current = true;
  };

  /* ─── Export CSV (client-side) ─── */
  const exportCsv = () => {
    if (!result) return;
    const rows: string[] = ["Comune;Codice ISTAT;Linea;Km/anno;Corse/anno;Km/corsa"];
    for (const z of result.zones) {
      rows.push(`${z.name};${z.istatCode ?? ""};TOTALE;${z.totalKmYear.toFixed(1).replace(".", ",")};;`);
      for (const r of z.byRoute) {
        rows.push(
          `${z.name};${z.istatCode ?? ""};${r.shortName};${r.kmYear.toFixed(1).replace(".", ",")};${r.runsYear};${r.kmPerRun.toFixed(1).replace(".", ",")}`,
        );
      }
    }
    const total = result.zones.reduce((s, z) => s + z.totalKmYear, 0);
    rows.push(`TOTALE GENERALE;;;${total.toFixed(1).replace(".", ",")};;`);
    rows.push(`Km fuori zona;;;${result.unassignedKm.toFixed(1).replace(".", ",")};;`);
    const blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zonizzazione_km_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ─── Export PDF/HTML (documento tecnico stampabile) ─── */
  const exportPdf = () => {
    if (!result) return;
    // async: apre subito la finestra (anti popup-block), poi embedda il logo
    void exportZonizzazioneHtml(result, {
      year: result.year,
      projectName: projectQ.data?.name,
      agencyName: "Conerobus",
    });
  };

  const toggleExpand = (zoneId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  };

  const grandTotal = result ? result.zones.reduce((s, z) => s + z.totalKmYear, 0) : 0;
  const yearOptions = useMemo(() => {
    const cur = new Date().getFullYear();
    return Array.from({ length: 7 }, (_, i) => cur - 2 + i);
  }, []);

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Landmark className="w-5 h-5 text-cyan-400" />
          <h1 className="font-semibold text-sm">Zonizzazione — km per comune</h1>
        </div>
        {projectQ.data && (
          <span className="text-xs text-slate-500 ml-2">{projectQ.data.name}</span>
        )}

        <div className="flex-1" />

        {/* Upload confini */}
        <input
          ref={fileRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importMut.mutate(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => anconaMut.mutate()}
          disabled={anconaMut.isPending}
          title="Importa i 47 comuni della provincia di Ancona (confini ISTAT, inclusi nell'app)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600/90 hover:bg-amber-600 text-xs text-white font-medium"
        >
          {anconaMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Landmark className="w-3.5 h-3.5" />}
          Comuni prov. Ancona
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700"
        >
          {importMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Altro GeoJSON…
        </button>
        {zones.length > 0 && (
          <button
            onClick={() => { if (confirm("Eliminare tutti i confini caricati?")) clearMut.mutate(); }}
            disabled={clearMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-rose-900/50 text-xs text-slate-400 hover:text-rose-300 border border-slate-700"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Svuota
          </button>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ─── Pannello sinistro: calcolo + risultati ─── */}
        <aside className="w-[460px] border-r border-slate-800 flex flex-col bg-slate-950">
          {/* Controlli calcolo */}
          <div className="p-3 border-b border-slate-800 space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400">Anno</label>
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
              >
                {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <button
                onClick={() => computeMut.mutate()}
                disabled={computeMut.isPending || zones.length === 0}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold"
              >
                {computeMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calculator className="w-3.5 h-3.5" />}
                Calcola km per comune
              </button>
              {result && (
                <>
                  <button
                    onClick={exportPdf}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-800/60 hover:bg-cyan-700/70 text-xs text-cyan-100 border border-cyan-700"
                    title="Esporta documento tecnico stampabile (PDF/HTML) con il dettaglio dei calcoli"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    PDF
                  </button>
                  <button
                    onClick={exportCsv}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700"
                    title="Esporta CSV"
                  >
                    <Download className="w-3.5 h-3.5" />
                    CSV
                  </button>
                </>
              )}
            </div>
            <div className="text-[10px] text-slate-500">
              {zones.length > 0
                ? <>{zones.length} confini caricati · le corse/anno sono derivate da calendari, eccezioni e validità delle corse</>
                : <>Nessun confine caricato — usa i confini ISTAT dei comuni (es. <span className="text-slate-400">geojson-italy</span>, file <span className="font-mono">limits_IT_municipalities.geojson</span>)</>}
            </div>
          </div>

          {/* Risultati */}
          <div className="flex-1 overflow-auto">
            {!result && (
              <div className="flex flex-col items-center justify-center h-full p-8 text-sm text-slate-600 text-center">
                <Info className="w-6 h-6 mb-2" />
                {zones.length === 0
                  ? "Importa prima i confini comunali in formato GeoJSON."
                  : "Seleziona l'anno e lancia il calcolo per ottenere i km sviluppati in ogni comune."}
              </div>
            )}

            {result && (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-900 text-slate-400">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Comune</th>
                    <th className="text-right px-3 py-2 font-medium">Km/anno {result.year}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {result.zones.map((z) => {
                    const isOpen = expanded.has(z.zoneId);
                    const isSel = selectedZoneId === z.zoneId;
                    return (
                      <ZoneRow
                        key={z.zoneId}
                        zone={z}
                        isOpen={isOpen}
                        isSelected={isSel}
                        onSelect={() => flyToZone(z.zoneId)}
                        onToggle={() => toggleExpand(z.zoneId)}
                      />
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 bg-slate-900">
                  <tr className="border-t border-slate-700 font-semibold">
                    <td className="px-3 py-2 text-slate-200">Totale generale</td>
                    <td className="px-3 py-2 text-right text-cyan-300 font-mono">{fmtKm(grandTotal)}</td>
                    <td />
                  </tr>
                  <tr className="text-slate-500">
                    <td className="px-3 py-1.5">Km fuori da ogni comune</td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtKm(result.unassignedKm)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </aside>

        {/* ─── Mappa ─── */}
        <section className="flex-1 relative">
          {!MAPBOX_TOKEN ? (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              Token Mapbox mancante (VITE_MAPBOX_TOKEN)
            </div>
          ) : (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={{ longitude: 12.5, latitude: 42.0, zoom: 5 }}
              mapStyle={MAP_STYLES.dark}
              onLoad={fitAllZones}
              onClick={(e) => {
                // Click su un poligono → seleziona il comune
                const f = e.features?.[0];
                const id = f?.properties?.id;
                if (id) flyToZone(String(id));
              }}
              interactiveLayerIds={["zones-fill"]}
            >
              <NavigationControl position="top-right" />

              {zones.length > 0 && (
                <>
                  <Source id="zones" type="geojson" data={zonesFC}>
                    {/* Fill leggero, colore ciclico per comune */}
                    <Layer
                      id="zones-fill"
                      type="fill"
                      paint={{
                        "fill-color": ["get", "color"],
                        "fill-opacity": ["case", ["==", ["get", "selected"], 1], 0.35, 0.12],
                      }}
                    />
                    {/* Bordo marcato */}
                    <Layer
                      id="zones-line"
                      type="line"
                      paint={{
                        "line-color": ["get", "color"],
                        "line-width": ["case", ["==", ["get", "selected"], 1], 3, 1.5],
                        "line-opacity": 0.9,
                      }}
                    />
                  </Source>
                  {/* Label nome comune */}
                  <Source id="zone-labels" type="geojson" data={labelsFC}>
                    <Layer
                      id="zones-label"
                      type="symbol"
                      layout={{
                        "text-field": ["get", "name"],
                        "text-size": 11,
                        "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
                      }}
                      paint={{
                        "text-color": "#e2e8f0",
                        "text-halo-color": "#0f172a",
                        "text-halo-width": 1.2,
                      }}
                    />
                  </Source>
                </>
              )}
            </Map>
          )}

          {zonesQ.isLoading && (
            <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded bg-slate-900/80 text-xs text-slate-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Caricamento confini…
            </div>
          )}

          {/* Stato vuoto: nessun confine caricato → CTA impossibile da mancare */}
          {!zonesQ.isLoading && zones.length === 0 && MAPBOX_TOKEN && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 backdrop-blur-[2px]">
              <div className="max-w-md mx-4 rounded-2xl border border-slate-700 bg-slate-900/95 p-6 text-center shadow-2xl">
                <Landmark className="w-10 h-10 mx-auto mb-3 text-amber-400" />
                <p className="text-sm font-semibold text-slate-100 mb-1">Nessun confine caricato</p>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                  Per calcolare i km sviluppati per comune servono i confini amministrativi.
                  I 47 comuni della provincia di Ancona sono già inclusi nell'app: un click e via.
                </p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => anconaMut.mutate()}
                    disabled={anconaMut.isPending}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-sm font-bold text-black"
                  >
                    {anconaMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Landmark className="w-4 h-4" />}
                    Carica comuni provincia di Ancona
                  </button>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="px-3 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 border border-slate-700"
                  >
                    Altro GeoJSON…
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ─── Riga comune (espandibile con dettaglio linee) ─── */
function ZoneRow({ zone, isOpen, isSelected, onSelect, onToggle }: {
  zone: ZoneKm;
  isOpen: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-t border-slate-900 cursor-pointer hover:bg-slate-900 ${
          isSelected ? "bg-cyan-500/10" : ""
        }`}
        onClick={onSelect}
      >
        <td className="px-3 py-2">
          <div className={`font-medium ${isSelected ? "text-cyan-300" : "text-slate-200"}`}>{zone.name}</div>
          {zone.istatCode && (
            <div className="text-[10px] text-slate-600 font-mono">ISTAT {zone.istatCode}</div>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-200">{fmtKm(zone.totalKmYear)}</td>
        <td className="pr-2">
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="p-1 rounded hover:bg-slate-800 text-slate-500"
            title={isOpen ? "Chiudi dettaglio" : "Dettaglio per linea"}
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </td>
      </tr>
      {isOpen && zone.byRoute.map((r) => (
        <tr key={r.routeId} className="bg-slate-900/40 text-[11px]">
          <td className="pl-6 pr-3 py-1.5">
            <div className="flex items-center gap-2">
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                style={{ backgroundColor: r.color ? `#${r.color}` : "#475569", color: "#fff" }}
              >
                {r.shortName}
              </span>
              <span className="text-slate-500">
                <Bus className="w-3 h-3 inline mr-1" />
                {r.runsYear.toLocaleString("it-IT")} corse/anno · {fmtKm(r.kmPerRun)} km/corsa
              </span>
            </div>
          </td>
          <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmtKm(r.kmYear)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}
