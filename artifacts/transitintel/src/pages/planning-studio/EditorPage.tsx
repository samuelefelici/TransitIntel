/**
 * PlannerStudio — Editor progetto.
 *
 * Layout: sidebar sx (tab Fermate / Linee / Calendari) + mappa Mapbox.
 *
 * Modalità (tool):
 *   - 'select'        — naviga, clicca elementi per vederli/modificarli
 *   - 'addStop'       — ogni clic sulla mappa apre mini-form nuova fermata
 *   - 'editVariant'   — editor variante: sequenza fermate (drag&drop sx) +
 *                       tracciatore percorso stile Google Maps (clic su mappa
 *                       aggiunge waypoint snap-ato via OSRM, drag waypoint per
 *                       spostare, toggle modalità manuale per tratti fuori rete)
 */
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import Map, {
  Marker, Source, Layer, NavigationControl, Popup,
  type MapRef, type MapMouseEvent,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { unzipSync } from "fflate";
import {
  ArrowLeft, MapPin, Bus, Calendar as CalendarIcon, Layers, Plus, Trash2,
  Save, X, Crosshair, Route as RouteIcon, GripVertical, Loader2, Check,
  PenLine, MousePointer2, Settings2, Users, Activity, ChevronRight,
  Palette, Upload, AlertTriangle, FileArchive, FolderOpen, Database,
  ChevronDown, ChevronUp, Pencil, Search, Flame, Building2, Grip, Share2, Ban, Undo2,
  Eye, EyeOff, PanelLeft,
} from "lucide-react";
import SharePsProjectDialog from "@/components/planning-studio/SharePsProjectDialog";
import TripCountBadge from "@/components/planning-studio/TripCountBadge";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import ConfirmDialog, { type ConfirmRequest } from "@/components/planning-studio/ConfirmDialog";
import { getApiBase, apiFetch } from "@/lib/api";
import OperationalEditWarning from "@/components/planning-studio/OperationalEditWarning";
import {
  getPsProject, type PsProject,
  listPsStops, createPsStop, updatePsStop, deletePsStop, type PsStop,
  listPsRoutes, createPsRoute, updatePsRoute, deletePsRoute, type PsRoute,
  listPsVariants, createPsVariant, getPsVariant, deletePsVariant, updatePsVariant,
  setPsVariantStops, setPsVariantShape, type PsVariant, type PsVariantStop,
  type PsWaypoint, type PsShape,
  routeSnap,
  listPsNoGoZones, createPsNoGoZone, deletePsNoGoZone, type PsNoGoZone,
  listPsCalendars, type PsCalendar,
  importPsGtfs, previewPsGtfs, type PsImportCounts, type PsGtfsPreviewRoute, type PsMergeImportCounts,
  listPsClusters, createPsCluster, updatePsCluster, deletePsCluster,
  setPsClusterStops, suggestPsClusters,
  type PsCluster, type PsClusterKind, type PsClusterSuggestion,
} from "@/lib/planning-studio-api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const DEFAULT_VIEW = { longitude: 12.4964, latitude: 41.9028, zoom: 11 }; // Roma

type Tool = "select" | "addStop" | "editVariant";
type DataPanel = "stops" | "routes" | "calendars" | "clusters" | "ne-clusters" | "ne-depots" | null;
/* Gruppi della toolbar: ogni gruppo apre un menu a tendina con sottovoci */
type ToolbarMenu = "pannelli" | "vista" | "progetto";

/* ─── Tipi cluster/depositi globali (Network Engine) ─── */
interface GlobalClusterStop { gtfsStopId: string; stopName: string; stopLat: number; stopLon: number; }
interface GlobalCluster {
  id: string; name: string; color: string;
  isInterchange?: boolean; isLogical?: boolean;
  stops: GlobalClusterStop[];
}
interface GlobalDepot {
  id: string; name: string; color: string;
  lat: number | null; lon: number | null;
  /** null = globale (tutti i progetti); valorizzato = solo quel progetto PS */
  psProjectId?: string | null;
  address?: string | null;
  capacity?: number | null;
  operatingHoursStart?: string | null;
  operatingHoursEnd?: string | null;
  hasDiesel?: boolean; hasMethane?: boolean; hasElectric?: boolean;
  chargingPoints?: number | null; cngPoints?: number | null;
  notes?: string | null;
}

/* ─── Nodi (ps_stop_clusters): tipo Logico vs Di cambio ───
 * Storage: due flag indipendenti in attributes.isLogical / attributes.isInterchange.
 * Backward-compat: se i flag sono assenti si derivano dall'enum legacy `kind`.
 * Un nodo può essere logico oppure logico+di cambio: la forma sulla mappa
 * riflette il tipo (● = logico, ▲ = logico e di cambio). */
function isInterchangeOf(c: PsCluster | null | undefined): boolean {
  if (!c) return false;
  const v = (c.attributes as any)?.isInterchange;
  if (typeof v === "boolean") return v;
  return c.kind === "interchange";
}
function isLogicalOf(c: PsCluster | null | undefined): boolean {
  if (!c) return false;
  const v = (c.attributes as any)?.isLogical;
  if (typeof v === "boolean") return v;
  return c.kind === "none";
}

/* Convex hull (Andrew monotone chain) — per disegnare poligono cluster */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/* Ray-casting: punto dentro poligono (coordinate [lon, lat]) */
function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > pt[1]) !== (yj > pt[1]))
      && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ─── Edit tracciato (vista percorso): costanti + helpers ─── */
// Numero massimo di vertici draggabili mostrati durante l'edit del tracciato.
// Oltre questa soglia campioniamo 1 vertice ogni N e ricostruiamo i segmenti
// non campionati interpolando lo spostamento (vedi moveShapeVertex).
const SHAPE_EDIT_MAX_VERTICES = 60;

/* Indici dei vertici campionati: tutti se pochi, 1 ogni N se la LineString
 * è densa. Primo e ultimo punto sono sempre inclusi. */
function sampleVertexIndices(n: number): number[] {
  if (n <= SHAPE_EDIT_MAX_VERTICES) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / SHAPE_EDIT_MAX_VERTICES);
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

/* Indice di inserimento di un via-point lungo il percorso (drag stile Google
 * Maps): proietta il punto di presa sulla polyline, ne calcola l'ascissa
 * curvilinea e la mappa sul tratto waypoint→waypoint corrispondente usando le
 * legDistances OSRM. Fallback: coppia di waypoint col segmento retto più vicino. */
function viaInsertIndex(
  geom: [number, number][] | null,
  legs: number[] | null,
  wpts: { lng: number; lat: number }[],
  p: [number, number],
): number {
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111320; // metri per grado di longitudine
  const ky = 110540;                                     // metri per grado di latitudine
  const projT = (a: [number, number], b: [number, number]): { d2: number; t: number } => {
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    return { d2: px * px + py * py, t };
  };
  if (geom && geom.length >= 2 && legs && legs.length === wpts.length - 1 && wpts.length >= 2) {
    let best = Infinity, bestArc = 0, arc = 0;
    for (let i = 0; i < geom.length - 1; i++) {
      const segLen = lineLengthM([geom[i], geom[i + 1]]);
      const { d2, t } = projT(geom[i], geom[i + 1]);
      if (d2 < best) { best = d2; bestArc = arc + segLen * t; }
      arc += segLen;
    }
    // Le legs OSRM ≈ lunghezza polyline ma non identiche: normalizza in proporzione.
    const legsTotal = legs.reduce((s, l) => s + l, 0);
    if (arc > 0 && legsTotal > 0) {
      const target = (bestArc / arc) * legsTotal;
      let cum = 0;
      for (let k = 0; k < legs.length; k++) {
        cum += legs[k];
        if (target <= cum) return k + 1; // tra wpts[k] e wpts[k+1]
      }
      return wpts.length - 1;
    }
  }
  // Fallback: coppia col segmento retto più vicino al punto di presa.
  let best = Infinity, idx = Math.max(1, wpts.length - 1);
  for (let i = 0; i < wpts.length - 1; i++) {
    const { d2 } = projT([wpts[i].lng, wpts[i].lat], [wpts[i + 1].lng, wpts[i + 1].lat]);
    if (d2 < best) { best = d2; idx = i + 1; }
  }
  return idx;
}

/* Corrispondenza sequenza fermate ↔ waypoints (match per stopId in ordine,
 * robusto ai duplicati e ai via liberi interposti). */
function waypointIndexForStopPos(wpts: PsWaypoint[], stopsList: PsVariantStop[], idx: number): number {
  let w = 0;
  for (let sPos = 0; sPos <= idx && sPos < stopsList.length; sPos++) {
    while (w < wpts.length && wpts[w].stopId !== stopsList[sPos].stopId) w++;
    if (w >= wpts.length) return -1;
    if (sPos === idx) return w;
    w++;
  }
  return -1;
}
function stopPosForWaypointIdx(wpts: PsWaypoint[], stopsList: PsVariantStop[], wIdx: number): number {
  if (!wpts[wIdx]?.stopId) return -1;
  let w = 0;
  for (let sPos = 0; sPos < stopsList.length; sPos++) {
    while (w < wpts.length && wpts[w].stopId !== stopsList[sPos].stopId) w++;
    if (w >= wpts.length) return -1;
    if (w === wIdx) return sPos;
    w++;
  }
  return -1;
}

/* ─── Import KML/KMZ/ZIP di un percorso ───
 * Formati supportati (export GIS aziendale incluso):
 *  - fermate: Placemark con Point; il CODICE fermata sta in <name> OPPURE in
 *    ExtendedData (SimpleData/Data, es. name="SIGLAUNIV" → "CI001");
 *  - percorsi: un Placemark con LineString PER PERCORSO, etichettato dai campi
 *    ExtendedData (es. CODICE/CODLINEA/CODVERSO) — se ce n'è più di uno
 *    l'operatore sceglie quale importare;
 *  - KMZ/ZIP: vengono letti TUTTI i .kml interni (es. Fermate.kml + Percorsi.kml). */
interface KmlParsed {
  points: { code: string; lat: number; lon: number }[];
  tracks: { label: string; coords: [number, number][] }[];
}
/** Campi ExtendedData (SimpleData e Data/value) di un Placemark. */
function kmlExtendedFields(pm: Element): { key: string; val: string }[] {
  const out: { key: string; val: string }[] = [];
  for (const sd of Array.from(pm.getElementsByTagName("SimpleData"))) {
    const v = sd.textContent?.trim();
    if (v) out.push({ key: sd.getAttribute("name") ?? "", val: v });
  }
  for (const d of Array.from(pm.getElementsByTagName("Data"))) {
    const v = d.getElementsByTagName("value")[0]?.textContent?.trim();
    if (v) out.push({ key: d.getAttribute("name") ?? "", val: v });
  }
  return out;
}
/** Codice fermata di un Placemark: <name>, altrimenti il campo ExtendedData
 *  più plausibile (nome campo tipo SIGLA…, COD…, ID…), altrimenti il primo. */
function kmlPlacemarkCode(pm: Element): string {
  const name = pm.getElementsByTagName("name")[0]?.textContent?.trim();
  if (name) return name;
  const fields = kmlExtendedFields(pm);
  const pref = fields.find(f => /sigla|cod|id|fermata|stop|palina/i.test(f.key));
  return (pref ?? fields[0])?.val ?? "";
}
function parseKmlText(xml: string): KmlParsed {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("File KML non valido (XML malformato)");
  }
  const parseCoords = (raw: string): [number, number][] => {
    // "lon,lat[,alt] lon,lat[,alt] …" separati da spazi/newline
    const out: [number, number][] = [];
    for (const tok of raw.trim().split(/\s+/)) {
      const p = tok.split(",");
      const lon = Number(p[0]), lat = Number(p[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    }
    return out;
  };
  const points: KmlParsed["points"] = [];
  const tracks: KmlParsed["tracks"] = [];
  for (const pm of Array.from(doc.getElementsByTagName("Placemark"))) {
    // Point = fermata (anche dentro MultiGeometry)
    for (const pt of Array.from(pm.getElementsByTagName("Point"))) {
      const raw = pt.getElementsByTagName("coordinates")[0]?.textContent ?? "";
      const c = parseCoords(raw);
      const code = kmlPlacemarkCode(pm);
      if (c.length > 0 && code) points.push({ code, lon: c[0][0], lat: c[0][1] });
    }
    // LineString = UN percorso per Placemark (segmenti multipli concatenati)
    const coords: [number, number][] = [];
    for (const ls of Array.from(pm.getElementsByTagName("LineString"))) {
      coords.push(...parseCoords(ls.getElementsByTagName("coordinates")[0]?.textContent ?? ""));
    }
    if (coords.length >= 2) {
      const name = pm.getElementsByTagName("name")[0]?.textContent?.trim();
      const fields = kmlExtendedFields(pm);
      const label = name || fields.map(f => f.val).join(" · ") || `percorso ${tracks.length + 1}`;
      tracks.push({ label, coords });
    }
  }
  return { points, tracks };
}
/** Proiezione di un punto su una polilinea: distanza minima (m) e progressiva
 *  lungo il tracciato (m) — equirettangolare, ok su scala urbana. */
function projectOnPath(coords: [number, number][], p: [number, number]): { distM: number; alongM: number } {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
  const rel = (c: [number, number]) => [(c[0] - p[0]) * kx, (c[1] - p[1]) * ky] as const;
  let best = { distM: Infinity, alongM: 0 };
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = rel(coords[i - 1]), b = rel(coords[i]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2)) : 0;
    const px = a[0] + t * dx, py = a[1] + t * dy;
    const d = Math.hypot(px, py);
    const segLen = Math.sqrt(len2);
    if (d < best.distM) best = { distM: d, alongM: acc + t * segLen };
    acc += segLen;
  }
  return best;
}

/* Lunghezza in metri di una LineString (haversine) — usata per ricalcolare
 * distanceM dopo un edit manuale dei vertici. */
function lineLengthM(coords: [number, number][]): number {
  const R = 6371000;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

interface VariantEditorState {
  variantId: string;
  routeId: string;
  routeColor: string;
  stops: PsVariantStop[];          // sequenza ordinata
  waypoints: PsWaypoint[];         // ancore lungo il percorso
  shapeMode: "driving" | "manual"; // modalità di snap globale (i singoli waypoint hanno comunque il loro mode)
  geometry: { type: "LineString"; coordinates: [number, number][] } | null;
  distanceM: number | null;
  durationS: number | null;
  /** arrivo lato marciapiede alle fermate (OSRM approaches=curb) */
  curb: boolean;
  /** km per tratta waypoint→waypoint (su strada, dalle legs OSRM) */
  legDistances: number[] | null;
  /** zone vietate attraversate dal tracciato corrente */
  violations: { zoneId: string; name: string }[];
  dirty: boolean;
}

/* ─── Vista percorso: variante selezionata dal pannello Linee.
 * Mostra lista ordinata delle fermate + tracciato evidenziato sulla mappa,
 * con possibilità di entrare in modalità "Edita tracciato". ─── */
interface RouteViewState {
  routeId: string;
  variantId: string;
  variantName: string;
  direction: number;
  routeShortName: string;
  routeColor: string;
  stops: PsVariantStop[];   // sequenza ordinata (seq, nome, coordinate)
  shape: PsShape | null;    // shape salvato (GeoJSON LineString)
}

/* ─── Edit tracciato: copia di lavoro della LineString della variante ─── */
interface ShapeEditState {
  coordinates: [number, number][]; // geometria corrente in lavorazione
  vertexIdx: number[];             // indici dei vertici campionati (Marker draggabili)
  distanceM: number | null;        // da OSRM dopo "Snap"; null se editata a mano
  durationS: number | null;
  dirty: boolean;
}

export default function PlanningStudioEditorPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [, navigate] = useLocation();

  /* ─── State ─── */
  const [project, setProject] = useState<PsProject | null>(null);
  const [stops, setStops] = useState<PsStop[]>([]);
  const [routes, setRoutes] = useState<PsRoute[]>([]);
  const [calendars, setCalendars] = useState<PsCalendar[]>([]);
  const [clusters, setClusters] = useState<PsCluster[]>([]);
  const [routeVariants, setRouteVariants] = useState<Record<string, PsVariant[]>>({});
  const [loading, setLoading] = useState(true);

  const [activePanel, setActivePanel] = useState<DataPanel>(null);
  const [tool, setTool] = useState<Tool>("select");

  // Selezione entità (per inspector floating)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(null);

  // ── Filtro visibilità fermate sulla mappa ─────────────────
  // 'all'   = tutte le fermate del progetto (può essere lento con molte ferm.)
  // 'none'  = nessuna (default per partire veloce)
  // 'route' = solo le fermate appartenenti alle linee in routeFilterIds
  type StopsFilter = "all" | "none" | "route";
  // Default "all": le fermate devono essere VISIBILI sulla mappa (il layer GPU
  // regge migliaia di punti). "none"/"route" restano come filtri opzionali.
  const [stopsFilter, setStopsFilter] = useState<StopsFilter>("all");
  const [routeFilterIds, setRouteFilterIds] = useState<Set<string>>(new Set());
  // Cache: routeId → Set<stopId> appartenenti alle varianti di quella linea.
  // Popolato on-demand quando l'utente seleziona la linea nel filtro.
  const [routeStopIds, setRouteStopIds] = useState<Record<string, Set<string>>>({});

  // Import GTFS dialog
  const [importOpen, setImportOpen] = useState(false);
  // Creazione MANUALE: nasconde l'onboarding-overlay per poter lavorare a mano.
  const [manualMode, setManualMode] = useState(false);
  const [importingStops, setImportingStops] = useState(false);
  const stopsTxtRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  // Modalità: "merge" = re-import non distruttivo (UUID conservati per chiave
  // stabile: validità/cluster/UDP sopravvivono); "replace" = wipe storico.
  const [importMode, setImportMode] = useState<"replace" | "merge">("replace");
  // Anteprima del merge (dryRun): conteggi esatti prima di applicare
  const [importMergePreview, setImportMergePreview] = useState<PsMergeImportCounts | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PsImportCounts | null>(null);
  // Fase intermedia: dopo la LETTURA del file si sceglie QUALI linee importare.
  const [previewing, setPreviewing] = useState(false);
  const [previewRoutes, setPreviewRoutes] = useState<PsGtfsPreviewRoute[] | null>(null);
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());
  const [routeSearch, setRouteSearch] = useState("");

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [editingStop, setEditingStop] = useState<PsStop | null>(null);
  const [pendingStop, setPendingStop] = useState<{ lat: number; lon: number } | null>(null);

  const [openRouteId, setOpenRouteId] = useState<string | null>(null);
  const [editor, setEditor] = useState<VariantEditorState | null>(null);
  // Ancora di inserimento: se ≠ null, la prossima fermata cliccata viene inserita
  // DOPO questo indice della sequenza (invece che in coda), e l'ancora avanza.
  const [insertAfterIdx, setInsertAfterIdx] = useState<number | null>(null);
  // Timestamp dell'ultimo salvataggio riuscito della variante (conferma visiva).
  const [variantSavedAt, setVariantSavedAt] = useState<number | null>(null);
  // ── Annulla (editor variante): snapshot di stops+waypoints prima di ogni modifica ──
  const [editorHistory, setEditorHistory] = useState<{ stops: PsVariantStop[]; waypoints: PsWaypoint[] }[]>([]);
  // ── Drag della linea del percorso (stile Google Maps): via-point in inserimento ──
  const dragViaRef = useRef<{ insertIdx: number } | null>(null);
  const [dragViaPos, setDragViaPos] = useState<[number, number] | null>(null);
  const suppressClickRef = useRef(false);
  const [lineHover, setLineHover] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Vista percorso (selezione variante → fermate + tracciato) ──────
  const [routeView, setRouteView] = useState<RouteViewState | null>(null);
  // ── Multi-visualizzazione LINEE: routeId → tracciati di tutte le varianti ──
  const [multiShown, setMultiShown] = useState<Record<string, { color: string; features: any[] }>>({});
  const [multiLoading, setMultiLoading] = useState<string | null>(null);
  async function toggleShowRoute(route: PsRoute) {
    if (multiShown[route.id]) {
      setMultiShown(prev => { const n = { ...prev }; delete n[route.id]; return n; });
      return;
    }
    setMultiLoading(route.id);
    try {
      const vs = await listPsVariants(projectId, route.id);
      const features: any[] = [];
      for (const v of vs) {
        try {
          const d = await getPsVariant(projectId, v.id);
          if (d.shape?.geometry) features.push({ type: "Feature", properties: { variant: v.name }, geometry: d.shape.geometry });
        } catch { /* variante senza shape */ }
      }
      if (!features.length) { toast.info(`"${route.shortName}": nessun tracciato disegnato`); return; }
      const color = (route.color || "#10b981").startsWith("#") ? (route.color || "#10b981") : `#${route.color}`;
      setMultiShown(prev => ({ ...prev, [route.id]: { color, features } }));
    } catch (e: any) {
      toast.error("Errore caricamento tracciati", { description: e?.message });
    } finally {
      setMultiLoading(null);
    }
  }
  // Edit tracciato: copia di lavoro della LineString (null = non in edit)
  const [shapeEdit, setShapeEdit] = useState<ShapeEditState | null>(null);
  const [shapeEditBusy, setShapeEditBusy] = useState(false);   // snap OSRM in corso
  const [shapeEditSaving, setShapeEditSaving] = useState(false);
  // Toggle "Mostra altre fermate" durante l'edit (tutte le fermate progetto, dimmed)
  const [showOtherStops, setShowOtherStops] = useState(false);

  // ── Cluster editor (interattivo sulla mappa) ───────────────
  // mode "draw" = utente sta cliccando per disegnare poligono area
  // mode "stops" = utente sta cliccando le fermate per togglarle nel cluster
  // clusterId = null → creazione nuovo cluster; altrimenti modifica esistente
  type ClusterDraw = {
    mode: "draw" | "stops";
    clusterId: string | null;
    name: string;
    kind: PsClusterKind;
    isLogical: boolean;
    isInterchange: boolean;
    isRest: boolean;
    hasFacilities: boolean;
    radiusM: number;
    color: string;
    polygon: [number, number][]; // [lon, lat]
    pendingStopIds: Set<string>;
  };
  const [clusterDraw, setClusterDraw] = useState<ClusterDraw | null>(null);
  // Tooltip nome fermata al passaggio del cursore (utile disegnando i percorsi).
  const [hoverStop, setHoverStop] = useState<{ name: string; lon: number; lat: number } | null>(null);
  // ── Mappa: stile + 3D toggle ───────────────────────────────
  // Stile "standard" Mapbox: chiaro, dettagliato, supporta nativamente edifici 3D
  // e landmark via setConfigProperty('basemap', 'show3dObjects', …).
  const [is3D, setIs3D] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const mapRef = useRef<MapRef>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  /* ─── Layer overlay: Cluster (Network Engine) e Depositi ─── */
  const [globalClusters, setGlobalClusters] = useState<GlobalCluster[]>([]);
  const [depots, setDepots] = useState<GlobalDepot[]>([]);
  const [overlayLoading, setOverlayLoading] = useState<{ clusters?: boolean; depots?: boolean }>({});
  // I layer rimangono visibili anche quando il pannello viene chiuso o se ne apre un altro
  const [showGlobalClusters, setShowGlobalClusters] = useState(false);
  const [showDepots, setShowDepots] = useState(false);
  const [editingDepot, setEditingDepot] = useState<GlobalDepot | null>(null);
  // Dettaglio deposito in sola lettura (click sul marker)
  const [depotInfo, setDepotInfo] = useState<GlobalDepot | null>(null);
  // ── Zone vietate bus (poligoni per progetto) ──
  const [noGoZones, setNoGoZones] = useState<PsNoGoZone[]>([]);
  const [showNoGo, setShowNoGo] = useState(false);
  const [zoneDraw, setZoneDraw] = useState<{ polygon: [number, number][] } | null>(null);
  const [zoneInfo, setZoneInfo] = useState<{ id: string; name: string; lng: number; lat: number } | null>(null);
  const [creatingDepotAt, setCreatingDepotAt] = useState<{ lat: number; lon: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [pickingDepotLocation, setPickingDepotLocation] = useState(false);
  const [depotModalHidden, setDepotModalHidden] = useState(false);

  /* ─── Toolbar: menu a tendina aperto + chiusura con click fuori ─── */
  const [openMenu, setOpenMenu] = useState<ToolbarMenu | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      // Chiude il menu se il click avviene fuori dalla barra dei menu
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  // Reload helpers (riusabili dai pannelli dopo CRUD)
  const reloadGlobalClusters = useCallback(async () => {
    setOverlayLoading(s => ({ ...s, clusters: true }));
    try {
      // Stessa regola del solver: globali + mirror di QUESTO progetto. Senza
      // lo scope il pannello mostrava anche i nodi di altri progetti, che il
      // solver non usa (e viceversa).
      const r = await fetch(`${getApiBase()}/api/clusters?psScope=${projectId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const arr: GlobalCluster[] = Array.isArray(j) ? j : (j.data ?? []);
      setGlobalClusters(arr);
    } catch (e: any) { toast.error("Errore caricamento cluster", { description: e?.message }); }
    finally { setOverlayLoading(s => ({ ...s, clusters: false })); }
  }, [projectId]);
  const reloadDepots = useCallback(async () => {
    setOverlayLoading(s => ({ ...s, depots: true }));
    try {
      // Globali + depositi di QUESTO progetto (quelli di altri progetti restano fuori)
      const r = await fetch(`${getApiBase()}/api/depots?psProjectId=${projectId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const arr: GlobalDepot[] = Array.isArray(j) ? j : (j.data ?? []);
      setDepots(arr);
    } catch (e: any) { toast.error("Errore caricamento depositi", { description: e?.message }); }
    finally { setOverlayLoading(s => ({ ...s, depots: false })); }
  }, [projectId]);

  /* ─── Zone vietate: load + geojson ─── */
  const reloadNoGoZones = useCallback(async () => {
    if (!projectId) return;
    try { setNoGoZones(await listPsNoGoZones(projectId)); }
    catch { /* endpoint assente su backend vecchio: silenzioso */ }
  }, [projectId]);
  useEffect(() => { void reloadNoGoZones(); }, [reloadNoGoZones]);

  const noGoZonesGeoJSON = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: noGoZones.filter(z => z.active && z.polygon.length >= 3).map(z => ({
      type: "Feature" as const,
      properties: { id: z.id, name: z.name },
      geometry: { type: "Polygon" as const, coordinates: [[...z.polygon, z.polygon[0]]] },
    })),
  }), [noGoZones]);

  /** Import fermate da un file stops.txt (GTFS) → bulk insert. Per creazione manuale. */
  const importStopsTxt = useCallback(async (file: File) => {
    setImportingStops(true);
    try {
      const text = await file.text();
      // CSV parser che gestisce virgolette e virgole dentro i campi.
      const parseLine = (line: string): string[] => {
        const out: string[] = []; let cur = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
          else { if (c === '"') inQ = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
        }
        out.push(cur); return out;
      };
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) { toast.error("File vuoto o senza righe fermata"); return; }
      const header = parseLine(lines[0]).map(h => h.trim().toLowerCase());
      const col = (r: string[], name: string) => { const i = header.indexOf(name); return i >= 0 ? (r[i] ?? "").trim() : ""; };
      const stopsPayload = lines.slice(1).map(parseLine).map(r => {
        const lat = Number(col(r, "stop_lat")); const lon = Number(col(r, "stop_lon"));
        return {
          code: col(r, "stop_code") || col(r, "stop_id") || null,
          name: col(r, "stop_name"),
          lat, lon,
          locationType: col(r, "location_type") ? Number(col(r, "location_type")) : 0,
          attributes: {
            gtfsStopId: col(r, "stop_id") || undefined,
            parentStation: col(r, "parent_station") || undefined,
            wheelchairBoarding: col(r, "wheelchair_boarding") || undefined,
          },
        };
      }).filter(s => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
      if (stopsPayload.length === 0) { toast.error("Nessuna fermata valida", { description: "Attese colonne stop_name, stop_lat, stop_lon" }); return; }
      const r = await apiFetch<{ inserted: number }>(`/api/planning-studio/projects/${projectId}/stops/bulk`, {
        method: "POST", body: JSON.stringify({ stops: stopsPayload }),
      });
      toast.success(`${r.inserted} fermate importate`, { description: "Ora crea linee, varianti e orari." });
      const s = await listPsStops(projectId);
      setStops(s);
      setManualMode(true);
      setActivePanel("stops");
      if (s.length > 0) setTimeout(() => fitToCoords(s.map(x => [x.lon, x.lat] as [number, number])), 200);
    } catch (e: any) {
      toast.error("Import fermate fallito", { description: e?.message });
    } finally {
      setImportingStops(false);
      if (stopsTxtRef.current) stopsTxtRef.current.value = "";
    }
  }, [projectId]);

  // Lazy fetch quando si attivano
  useEffect(() => {
    if (showGlobalClusters && globalClusters.length === 0 && !overlayLoading.clusters) reloadGlobalClusters();
  }, [showGlobalClusters]);
  useEffect(() => {
    if (showDepots && depots.length === 0 && !overlayLoading.depots) reloadDepots();
  }, [showDepots]);

  // Mappa: psStopId → { color, interchange } del nodo a cui appartiene.
  // Combina due sorgenti:
  //   (a) cluster PS del progetto (sempre, anche senza overlay): match diretto
  //       per cluster_id sulla fermata. Colore = attributes.color o default per kind.
  //   (b) overlay legacy "Nodi globali (Network)" se attivo: match per code/coord.
  // (a) ha precedenza su (b) per coerenza con la lista nel pannello.
  // `interchange` guida la FORMA del marker fermata: ▲ se il nodo è anche di
  // cambio, ● se è solo logico (vedi layer ps-stops-triangle / ps-stops-circle).
  type StopNodeInfo = { color: string; interchange: boolean };
  const stopIdToNode: { [k: string]: StopNodeInfo } = useMemo(() => {
    const out: { [k: string]: StopNodeInfo } = {};

    // (a) Cluster PS — sempre attivi, basta che la fermata abbia clusterId
    if (clusters.length > 0) {
      const nodeByClusterId: { [k: string]: StopNodeInfo } = {};
      for (const c of clusters) {
        const custom = (c.attributes && typeof (c.attributes as any).color === "string")
          ? (c.attributes as any).color : null;
        nodeByClusterId[c.id] = {
          color: custom || (c.kind === "interchange" ? "#0ea5e9" : c.kind === "rest" ? "#f59e0b" : "#64748b"),
          interchange: isInterchangeOf(c),
        };
      }
      for (const s of stops) {
        if (s.clusterId && nodeByClusterId[s.clusterId]) {
          out[s.id] = nodeByClusterId[s.clusterId];
        }
      }
    }

    // (b) Cluster legacy overlay (solo se toggle on) — non sovrascrive (a)
    if (showGlobalClusters) {
      const byCode: { [k: string]: StopNodeInfo } = {};
      const byCoord: { [k: string]: StopNodeInfo } = {};
      for (const c of globalClusters) {
        const info: StopNodeInfo = { color: c.color || "#0ea5e9", interchange: !!c.isInterchange };
        for (const cs of (c.stops || [])) {
          if (cs.gtfsStopId) byCode[String(cs.gtfsStopId)] = info;
          if (Number.isFinite(cs.stopLat) && Number.isFinite(cs.stopLon)) {
            byCoord[`${cs.stopLat.toFixed(5)},${cs.stopLon.toFixed(5)}`] = info;
          }
        }
      }
      for (const s of stops) {
        if (out[s.id]) continue;
        const key = `${Number(s.lat).toFixed(5)},${Number(s.lon).toFixed(5)}`;
        const info = (s.code && byCode[s.code]) || byCoord[key];
        if (info) out[s.id] = info;
      }
    }

    return out;
  }, [showGlobalClusters, globalClusters, stops, clusters]);

  // GeoJSON poligoni cluster (convex hull) — visibile solo se toggle on
  const clustersGeoJSON = useMemo(() => {
    if (!showGlobalClusters) return null;
    const features: any[] = [];
    for (const c of globalClusters) {
      const pts = (c.stops || [])
        .filter(s => Number.isFinite(s.stopLon) && Number.isFinite(s.stopLat))
        .map(s => [Number(s.stopLon), Number(s.stopLat)] as [number, number]);
      if (pts.length === 0) continue;
      // isInterchange guida la forma delle fermate del nodo (▲ vs ●) nei layer ne-clusters-*
      const props = { id: c.id, name: c.name, color: c.color || "#0ea5e9", isInterchange: !!c.isInterchange };
      if (pts.length >= 3) {
        const hull = convexHull(pts);
        if (hull.length >= 3) {
          const ring = [...hull, hull[0]];
          features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
        }
      }
      // Punti delle fermate del cluster (sempre)
      for (const p of pts) {
        features.push({ type: "Feature", properties: { ...props, isStop: true }, geometry: { type: "Point", coordinates: p } });
      }
      // Centroide per l'etichetta del nome
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      features.push({ type: "Feature", properties: { ...props, isLabel: true }, geometry: { type: "Point", coordinates: [cx, cy] } });
    }
    return { type: "FeatureCollection", features } as any;
  }, [showGlobalClusters, globalClusters]);

  /* ─── Fermate visibili sulla mappa (in base al filtro stopsFilter) ─── */
  // Ritorna solo le fermate che devono essere disegnate. Se lo stopsFilter è
  // 'route' includiamo solo quelle appartenenti alle linee selezionate
  // (routeFilterIds + cache routeStopIds). La fermata selezionata è SEMPRE
  // visibile, anche con filter='none', così la "Cerca fermata" continua a
  // funzionare.
  const visibleStops = useMemo<PsStop[]>(() => {
    // Quando il pannello cluster è aperto (creazione/edit) servono SEMPRE
    // tutte le fermate, altrimenti l'utente non può cliccarle per assegnarle.
    if (activePanel === "clusters" || clusterDraw) return stops;
    // Pannello Fermate aperto o editing di una variante (percorso): le fermate
    // devono essere visibili/cliccabili a prescindere dal filtro scelto.
    if (activePanel === "stops" || editor) return stops;
    if (showGlobalClusters) {
      // In modalità "vista cluster" mostriamo solo le fermate dentro un cluster:
      // i layer ne-clusters-* le disegnano già, quindi qui tagliamo a 0 (più la
      // selezionata se serve).
      return selectedStopId ? stops.filter(s => s.id === selectedStopId) : [];
    }
    if (stopsFilter === "all") return stops;
    if (stopsFilter === "none") {
      return selectedStopId ? stops.filter(s => s.id === selectedStopId) : [];
    }
    // 'route'
    const allowed = new Set<string>();
    for (const rid of routeFilterIds) {
      const set = routeStopIds[rid];
      if (set) for (const sid of set) allowed.add(sid);
    }
    if (selectedStopId) allowed.add(selectedStopId);
    return stops.filter(s => allowed.has(s.id));
  }, [stops, stopsFilter, routeFilterIds, routeStopIds, selectedStopId, showGlobalClusters, activePanel, clusterDraw, editor]);

  // GeoJSON delle fermate visibili (usato dai layer Mapbox: 1 source, N layer
  // gestiti dalla GPU, 100x più veloce di N <Marker> React).
  const visibleStopsGeoJSON = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: visibleStops.map(s => {
      const node = stopIdToNode[s.id];
      const inSeq = editor?.stops.find(vs => vs.stopId === s.id);
      return {
        type: "Feature" as const,
        id: s.id, // serve per feature-state
        properties: {
          id: s.id,
          name: s.name,
          color: node?.color || (inSeq ? "#34d399" : "#ffffff"),
          inSeq: !!inSeq,
          // Forma: "tri" (▲) se la fermata appartiene a un nodo logico E di
          // cambio, "dot" (●) altrimenti — simbologia condivisa con la legenda.
          shape: node?.interchange ? "tri" : "dot",
        },
        geometry: { type: "Point" as const, coordinates: [Number(s.lon), Number(s.lat)] },
      };
    }),
  }), [visibleStops, stopIdToNode, editor?.stops]);

  // GeoJSON delle fermate della variante selezionata (vista percorso):
  // evidenziate sulla mappa con il colore della linea + numero di sequenza.
  const routeViewStopsGeoJSON = useMemo(() => {
    if (!routeView) return null;
    return {
      type: "FeatureCollection" as const,
      features: routeView.stops.map(s => ({
        type: "Feature" as const,
        properties: { id: s.stopId, name: s.stopName, seq: s.seq },
        geometry: { type: "Point" as const, coordinates: [Number(s.lon), Number(s.lat)] },
      })),
    };
  }, [routeView]);

  // GeoJSON delle "altre fermate" del progetto (non appartenenti alla variante),
  // mostrate dimmed durante l'edit del tracciato per agganciare la linea.
  const isShapeEditing = shapeEdit !== null;
  const routeViewOtherStopsGeoJSON = useMemo(() => {
    if (!routeView || !isShapeEditing || !showOtherStops) return null;
    const inVariant = new Set(routeView.stops.map(s => s.stopId));
    return {
      type: "FeatureCollection" as const,
      features: stops
        .filter(s => !inVariant.has(s.id))
        .map(s => ({
          type: "Feature" as const,
          properties: { id: s.id, name: s.name },
          geometry: { type: "Point" as const, coordinates: [Number(s.lon), Number(s.lat)] },
        })),
    };
  }, [routeView, isShapeEditing, showOtherStops, stops]);

  // Carica e cache stopIds per una linea (somma stop di tutte le sue varianti).
  const loadRouteStopIds = useCallback(async (routeId: string) => {
    if (routeStopIds[routeId]) return;
    try {
      let vs = routeVariants[routeId];
      if (!vs) {
        vs = await listPsVariants(projectId, routeId);
        setRouteVariants(prev => ({ ...prev, [routeId]: vs! }));
      }
      const ids = new Set<string>();
      for (const v of vs) {
        try {
          const data = await getPsVariant(projectId, v.id);
          for (const s of (data.stops || [])) ids.add(s.stopId);
        } catch { /* ignore singola variante */ }
      }
      setRouteStopIds(prev => ({ ...prev, [routeId]: ids }));
    } catch (e: any) {
      toast.error("Errore caricamento fermate linea", { description: e?.message });
    }
  }, [projectId, routeStopIds, routeVariants]);

  // Quando l'utente attiva una linea nel filtro, autoscarica le sue fermate.
  useEffect(() => {
    if (stopsFilter !== "route") return;
    for (const rid of routeFilterIds) {
      if (!routeStopIds[rid]) void loadRouteStopIds(rid);
    }
  }, [stopsFilter, routeFilterIds, routeStopIds, loadRouteStopIds]);

  /* ─── Load ─── */
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          getPsProject(projectId),
          listPsStops(projectId),
          listPsRoutes(projectId),
          listPsCalendars(projectId),
          listPsClusters(projectId),
        ]);
        const [pR, sR, rR, cR, clR] = results;
        if (pR.status === "fulfilled") setProject(pR.value);
        else { toast.error("Errore caricamento progetto", { description: (pR.reason as any)?.message }); return; }
        if (sR.status === "fulfilled") setStops(sR.value); else toast.warning("Fermate non caricate");
        if (rR.status === "fulfilled") setRoutes(rR.value); else toast.warning("Linee non caricate");
        if (cR.status === "fulfilled") setCalendars(cR.value); else toast.warning("Calendari non caricati");
        if (clR.status === "fulfilled") setClusters(clR.value); else toast.warning("Nodi non caricati");
      } catch (e: any) {
        toast.error("Errore caricamento", { description: e?.message });
      } finally { setLoading(false); }
    })();
  }, [projectId]);

  /* ─── Map handlers ─── */
  const handleMapClick = useCallback((e: MapMouseEvent) => {
    // Click sintetico generato dal rilascio di un drag della linea: ignora.
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    const { lng, lat } = e.lngLat;

    // Modalità "disegna zona vietata": ogni clic aggiunge un vertice.
    // Doppio click chiude e salva (gestito in onDblClick).
    if (zoneDraw) {
      setZoneDraw(prev => prev ? { polygon: [...prev.polygon, [lng, lat]] } : prev);
      return;
    }

    // Modalità "disegna area cluster": ogni clic aggiunge un vertice al poligono.
    // Doppio click chiude il poligono (gestito da onDblClick separatamente).
    if (clusterDraw && clusterDraw.mode === "draw") {
      setClusterDraw(prev => prev ? { ...prev, polygon: [...prev.polygon, [lng, lat]] } : prev);
      return;
    }

    // Click su una fermata renderizzata via Layer (stops circle)
    const features = (e as any).features as any[] | undefined;
    const stopFeat = features?.find(f => f?.layer?.id === "ps-stops-circle" || f?.layer?.id === "ps-stops-circle-hit");
    if (stopFeat) {
      const stopId: string | undefined = stopFeat.properties?.id;
      if (stopId) {
        const s = stops.find(x => x.id === stopId);
        if (s) {
          // Modalità "tocca fermate per cluster": toggle inclusion
          if (clusterDraw && clusterDraw.mode === "stops") {
            setClusterDraw(prev => {
              if (!prev) return prev;
              const next = new Set(prev.pendingStopIds);
              next.has(s.id) ? next.delete(s.id) : next.add(s.id);
              return { ...prev, pendingStopIds: next };
            });
            return;
          }
          if (tool === "editVariant" && editor) {
            addStopToSequence(s);
          } else {
            setSelectedStopId(s.id);
          }
          return;
        }
      }
    }

    // Click su una zona vietata → card info con eliminazione.
    // SOLO in modalità selezione: durante l'editing variante il click dentro la
    // zona deve continuare ad aggiungere waypoint (serve proprio per aggirarla).
    const zoneFeat = features?.find(f => f?.layer?.id === "ps-nogo-fill");
    if (zoneFeat?.properties?.id && tool === "select" && !editor) {
      setZoneInfo({ id: String(zoneFeat.properties.id), name: String(zoneFeat.properties.name ?? "Zona vietata"), lng, lat });
      return;
    }

    // Modalità "scegli posizione deposito": cattura il click e ripristina il modale
    if (pickingDepotLocation && editingDepot) {
      setEditingDepot({ ...editingDepot, lat, lon: lng });
      setPickingDepotLocation(false);
      setDepotModalHidden(false);
      toast.success("Posizione selezionata", { description: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
      return;
    }

    // Tool 'addStop': mostra form pendente
    if (tool === "addStop") {
      setPendingStop({ lat, lon: lng });
      return;
    }

    // Tool 'editVariant': il click a vuoto NON aggiunge più waypoint (troppo
    // facile sbagliare). Le deviazioni si fanno TRASCINANDO la linea del
    // percorso (stile Google Maps); le fermate cliccandole. Ctrl+Z annulla.
    if (tool === "editVariant" && editor) {
      return;
    }
    // select: deseleziona
    setSelectedStopId(null);
  }, [tool, editor, pickingDepotLocation, editingDepot, stops, clusterDraw, zoneDraw]);

  /* ─── Stops CRUD ─── */
  async function handleSaveStop(stopOrCreate: { name: string; code?: string; lat: number; lon: number }, existingId?: string) {
    try {
      if (existingId) {
        const updated = await updatePsStop(projectId, existingId, stopOrCreate);
        setStops(s => s.map(x => x.id === existingId ? updated : x));
        toast.success("Fermata aggiornata");
      } else {
        const created = await createPsStop(projectId, stopOrCreate);
        setStops(s => [...s, created]);
        toast.success("Fermata creata");
      }
      setPendingStop(null);
      setEditingStop(null);
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e?.message });
    }
  }

  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  // Poligono appena chiuso in attesa di nome (dialog zona vietata)
  const [zoneNameAsk, setZoneNameAsk] = useState<Array<[number, number]> | null>(null);
  const [zoneNameDraft, setZoneNameDraft] = useState("");
  const [zoneSaving, setZoneSaving] = useState(false);
  async function saveNamedZone() {
    if (!zoneNameAsk || !zoneNameDraft.trim() || zoneSaving) return;
    setZoneSaving(true);
    try {
      await createPsNoGoZone(projectId, { name: zoneNameDraft.trim(), polygon: zoneNameAsk });
      toast.success("Zona vietata creata", { description: "I percorsi che la attraversano verranno segnalati." });
      setZoneNameAsk(null); setZoneNameDraft("");
      await reloadNoGoZones();
      if (editor && editor.waypoints.length >= 2) recomputeShape(editor.waypoints, editor.shapeMode);
    } catch (err: any) {
      toast.error("Errore creazione zona", { description: err?.message });
    } finally { setZoneSaving(false); }
  }

  /** Cleanup locale dopo l'eliminazione di una variante (la LINEA resta sempre). */
  function afterVariantDeleted(id: string) {
    let ownerRouteId: string | null = null;
    setRouteVariants(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].some(v => v.id === id)) ownerRouteId = k;
        next[k] = next[k].filter(v => v.id !== id);
      }
      return next;
    });
    if (ownerRouteId) {
      setRoutes(rs => rs.map(r => r.id === ownerRouteId
        ? { ...r, variantCount: Math.max(0, (r.variantCount ?? 1) - 1) } : r));
    }
    toast.success("Percorso eliminato", { description: "La linea resta (anche con 0 percorsi)." });
  }

  function askDeleteStop(id: string) {
    const st = stops.find(x => x.id === id);
    setConfirmReq({
      title: `Eliminare la fermata${st ? ` "${st.name}"` : ""}?`,
      message: "L'eliminazione fallisce se la fermata è ancora usata da un percorso.",
      confirmLabel: "Elimina",
      onConfirm: () => handleDeleteStop(id),
    });
  }

  async function handleDeleteStop(id: string) {
    try {
      await deletePsStop(projectId, id);
      setStops(s => s.filter(x => x.id !== id));
      if (selectedStopId === id) setSelectedStopId(null);
      if (editingStop?.id === id) setEditingStop(null);
      toast.success("Fermata eliminata");
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    }
  }

  /* ─── Routes & variants ─── */
  async function handleCreateRoute(input: { shortName: string; longName?: string; color?: string }): Promise<PsRoute | undefined> {
    try {
      const r = await createPsRoute(projectId, input);
      setRoutes(rs => [...rs, r]);
      toast.success("Linea creata");
      return r;
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
      return undefined;
    }
  }

  /** Modifica linea esistente (codice, nome, colore) — la linea resta editabile
   *  anche DOPO la creazione, dal pulsante matita nel pannello Linee. */
  async function handleUpdateRoute(id: string, patch: { shortName?: string; longName?: string | null; color?: string }): Promise<boolean> {
    try {
      const updated = await updatePsRoute(projectId, id, patch as any);
      setRoutes(rs => rs.map(r => (r.id === id ? { ...r, ...updated } : r)));
      toast.success("Linea aggiornata");
      return true;
    } catch (e: any) {
      toast.error("Errore aggiornamento linea", { description: e?.message });
      return false;
    }
  }

  async function loadVariants(routeId: string) {
    if (routeVariants[routeId]) return;
    try {
      const vs = await listPsVariants(projectId, routeId);
      setRouteVariants(prev => ({ ...prev, [routeId]: vs }));
    } catch (e: any) {
      toast.error("Errore varianti", { description: e?.message });
    }
  }

  async function handleCreateVariant(routeId: string, name: string, direction: number): Promise<PsVariant | undefined> {
    try {
      const v = await createPsVariant(projectId, routeId, { name, direction });
      setRouteVariants(prev => ({ ...prev, [routeId]: [...(prev[routeId] || []), v] }));
      toast.success("Variante creata");
      return v;
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
      return undefined;
    }
  }

  /** Modifica METADATI variante (codice es. "21A", nome, verso) — non il tracciato. */
  async function handleUpdateVariantMeta(
    routeId: string, variantId: string,
    patch: { code?: string | null; name?: string; direction?: number },
  ): Promise<boolean> {
    try {
      const v = await updatePsVariant(projectId, variantId, patch);
      setRouteVariants(prev => ({
        ...prev,
        [routeId]: (prev[routeId] || []).map(x => (x.id === variantId ? { ...x, ...v } : x)),
      }));
      toast.success("Percorso aggiornato", {
        description: `${v.code || "codice auto"} · ${v.name} · ${v.direction === 1 ? "ritorno" : "andata"}`,
      });
      return true;
    } catch (e: any) {
      toast.error("Errore aggiornamento percorso", { description: e?.message });
      return false;
    }
  }

  async function startEditingVariant(routeId: string, variantId: string) {
    try {
      // Chiudi l'eventuale vista percorso per non sovrapporre i pannelli
      setRouteView(null);
      setShapeEdit(null);
      setShowOtherStops(false);
      const data = await getPsVariant(projectId, variantId);
      const route = routes.find(r => r.id === routeId);
      setEditor({
        variantId,
        routeId,
        routeColor: route?.color || "#10b981",
        stops: data.stops || [],
        waypoints: data.shape?.waypoints || [],
        shapeMode: ((data.shape?.mode as any) || "driving"),
        geometry: data.shape?.geometry || null,
        distanceM: data.shape?.distanceM ?? null,
        durationS: data.shape?.durationS ?? null,
        curb: false, // OFF di default: con fermate georeferenziate male produce giri dell'isolato
        legDistances: null,
        violations: [],
        dirty: false,
      });
      setTool("editVariant");
      setInsertAfterIdx(null);
      setEditorHistory([]);
      setVariantSavedAt(null);
      // fit map sui waypoint o sulle fermate della variante
      const coords = data.shape?.geometry?.coordinates?.length
        ? data.shape.geometry.coordinates
        : data.stops.map(s => [s.lon, s.lat] as [number, number]);
      if (coords.length > 0) fitToCoords(coords);
    } catch (e: any) {
      toast.error("Errore caricamento variante", { description: e?.message });
    }
  }

  function exitEditor() {
    if (editor?.dirty && !confirm("Hai modifiche non salvate. Uscire comunque?")) return;
    setEditor(null);
    setInsertAfterIdx(null);
    setEditorHistory([]);
    setTool("select");
  }

  function fitToCoords(coords: [number, number][]) {
    if (!mapRef.current || coords.length === 0) return;
    const lons = coords.map(c => c[0]); const lats = coords.map(c => c[1]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    mapRef.current.fitBounds(bounds, { padding: 80, duration: 500 });
  }

  // ── Resize della mappa quando il container cambia dimensione ──
  // Necessario perché Mapbox non rileva i cambi del parent (es. sidebar
  // che si apre/chiude) senza un evento window.resize.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !mapContainerRef.current) return;
    const map = mapRef.current.getMap() as any;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { try { map.resize(); } catch {} });
    });
    ro.observe(mapContainerRef.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [mapReady]);

  // ── Toggle 2D / 3D ─────────────────────────────────────────
  // Anima pitch e abilita/disabilita gli oggetti 3D dello stile Standard.
  // Manteniamo sempre il light preset "day" per non scurire la mappa.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current.getMap() as any;
    try {
      map.setConfigProperty?.("basemap", "show3dObjects", is3D);
      map.setConfigProperty?.("basemap", "lightPreset", "day");
    } catch { /* style non Standard: nessun problema */ }
    map.easeTo({
      pitch: is3D ? 60 : 0,
      bearing: is3D ? -17 : 0,
      duration: 800,
    });
  }, [is3D, mapReady]);

  // Auto-fit: appena la mappa è pronta e ci sono fermate, inquadra l'estensione
  // del progetto (GTFS importato o fermate create manualmente). Si esegue una
  // sola volta per non disturbare il pan dell'utente.
  const didAutoFitRef = useRef(false);
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (didAutoFitRef.current) return;
    if (stops.length === 0) return;
    const lats = stops.map(s => Number(s.lat)).filter(n => Number.isFinite(n));
    const lons = stops.map(s => Number(s.lon)).filter(n => Number.isFinite(n));
    if (lats.length === 0) return;
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    mapRef.current.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 14 });
    didAutoFitRef.current = true;
  }, [mapReady, stops]);


  /* ─── Variant editor: snap routing ───
   * Il percorso passa sull'ASSE STRADA: chiamata OSRM multi-punto (niente
   * inversioni a U alle fermate intermedie), arrivo lato marciapiede (curb)
   * SOLO sui waypoint-fermata, km per tratta dalle legs (distanza su strada).
   * Tratti forzati: un waypoint "manuale" rende retti i segmenti adiacenti
   * (corsie riservate/varchi che OSRM non conosce). Le zone vietate del
   * progetto vengono verificate server-side → violazioni segnalate. */
  async function recomputeShape(wpts: PsWaypoint[], mode: "driving" | "manual", curbOverride?: boolean) {
    if (wpts.length < 2) {
      setEditor(prev => prev ? { ...prev, geometry: null, distanceM: 0, durationS: 0, legDistances: null, violations: [], dirty: true } : prev);
      return;
    }
    setSnapBusy(true);
    try {
      const points: [number, number][] = wpts.map(w => [w.lng, w.lat]);
      // Segmento i (tra waypoint i e i+1) manuale se uno dei due estremi è manuale.
      const modes = wpts.slice(0, -1).map((w, i) =>
        (mode === "manual" || w.mode === "manual" || wpts[i + 1].mode === "manual") ? "manual" as const : "driving" as const);
      const curb = curbOverride ?? editor?.curb ?? false;
      const r = await routeSnap(points, mode, {
        modes,
        curb,
        curbMask: wpts.map(w => !!w.stopId), // curb solo alle fermate, i via liberi restano liberi
        projectId,
      });
      setEditor(prev => prev ? {
        ...prev,
        geometry: r.geometry,
        distanceM: r.distanceM,
        durationS: r.durationS,
        legDistances: r.legDistances ?? null,
        violations: r.violations ?? [],
        dirty: true,
      } : prev);
      if (r.violations && r.violations.length > 0) {
        toast.warning(`Il percorso attraversa ${r.violations.length} zona/e vietata/e`, {
          description: `${r.violations.map(v => v.name).join(", ")} — forza il tracciato con un waypoint (clic mappa) o un tratto manuale (clic sul waypoint).`,
        });
      }
      if (r.legModes?.includes("manual_fallback")) {
        toast.warning("OSRM non raggiungibile su alcuni tratti", {
          description: "I tratti evidenziati sono in linea retta (fallback): riprova lo snap più tardi.",
        });
      }
    } catch (e: any) {
      toast.error("Errore snap routing", { description: e?.message });
    } finally { setSnapBusy(false); }
  }

  /** Alterna il modo di un waypoint: snap ↔ manuale (forza i tratti adiacenti). */
  function toggleWaypointMode(idx: number) {
    if (!editor) return;
    pushEditorHistory();
    const wpts = editor.waypoints.map((w, i) =>
      i === idx ? { ...w, mode: (w.mode === "manual" ? "snap" : "manual") as PsWaypoint["mode"] } : w);
    setEditor({ ...editor, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  /** Attiva/disattiva l'arrivo lato marciapiede e ricalcola. */
  function toggleCurb() {
    if (!editor) return;
    const next = !editor.curb;
    setEditor({ ...editor, curb: next, dirty: true });
    recomputeShape(editor.waypoints, editor.shapeMode, next);
  }

  /* ─── Annulla (editor variante) ─── */
  /** Snapshot per l'Annulla: chiamare PRIMA di modificare stops/waypoints. */
  function pushEditorHistory() {
    if (!editor) return;
    const snap = { stops: editor.stops, waypoints: editor.waypoints };
    setEditorHistory(h => [...h.slice(-29), snap]); // max 30 passi
  }

  /* ─── Import KML/KMZ nel percorso in editing ───
   * 1) parse del file (KMZ = zip → primo .kml interno);
   * 2) ANTEPRIMA di abbinamento: ogni Placemark puntuale viene abbinato a una
   *    fermata a sistema per CODICE identico (fallback: nome, poi vicinanza <30 m);
   * 3) alla conferma: sequenza fermate + tracciato caricati nell'editor,
   *    sempre modificabili dall'operatore prima del salvataggio. ─── */
  const kmlInputRef = useRef<HTMLInputElement | null>(null);
  type KmlMatchRow = {
    code: string; lat: number; lon: number;
    match: PsStop | null;
    matchBy: "codice" | "nome" | "vicinanza" | null;
    distM: number | null;   // distanza punto KML ↔ fermata abbinata
  };
  const [kmlPreview, setKmlPreview] = useState<null | {
    fileName: string;
    points: KmlMatchRow[];                                              // tutti i punti del file, già abbinati
    tracks: { label: string; coords: [number, number][]; lengthM: number }[];
  }>(null);
  const [kmlTrackIdx, setKmlTrackIdx] = useState(0);
  const [kmlMaxDist, setKmlMaxDist] = useState("30"); // fermata "sul percorso" se entro N metri
  useEffect(() => { setKmlTrackIdx(0); }, [kmlPreview?.fileName]);

  async function handleKmlFile(file: File) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
      const xmls: string[] = [];
      if (isZip || /\.(kmz|zip)$/i.test(file.name)) {
        const entries = unzipSync(buf);
        // legge TUTTI i .kml (es. Fermate.kml + Percorsi.kml nello stesso zip)
        for (const n of Object.keys(entries).filter(n2 => /\.kml$/i.test(n2)).sort()) {
          xmls.push(new TextDecoder("utf-8").decode(entries[n]));
        }
        if (xmls.length === 0) throw new Error("Nessun file .kml dentro l'archivio");
      } else {
        xmls.push(new TextDecoder("utf-8").decode(buf));
      }
      const points: KmlParsed["points"] = [];
      const tracks: KmlParsed["tracks"] = [];
      for (const xml of xmls) {
        const parsed = parseKmlText(xml);
        points.push(...parsed.points);
        tracks.push(...parsed.tracks);
      }
      if (points.length === 0 && tracks.length === 0) {
        throw new Error("Il file non contiene né fermate (Placemark puntuali) né percorsi (LineString)");
      }
      // Indici di abbinamento sulle fermate a sistema
      const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
      // NB: "Map" qui è il componente react-map-gl → serve globalThis.Map
      const byCode = new globalThis.Map<string, PsStop>();
      const byName = new globalThis.Map<string, PsStop>();
      for (const s of stops) {
        const c = norm(s.code);
        if (c && !byCode.has(c)) byCode.set(c, s);
        const n = norm(s.name);
        if (n && !byName.has(n)) byName.set(n, s);
      }
      const rows: KmlMatchRow[] = points.map(p => {
        let match: PsStop | null = byCode.get(norm(p.code)) ?? null;
        let matchBy: KmlMatchRow["matchBy"] = match ? "codice" : null;
        if (!match) { match = byName.get(norm(p.code)) ?? null; if (match) matchBy = "nome"; }
        if (!match) {
          // fallback prudente: fermata più vicina entro 30 m
          let best: PsStop | null = null, bestD = 30;
          for (const s of stops) {
            const d = lineLengthM([[p.lon, p.lat], [s.lon, s.lat]]);
            if (d < bestD) { bestD = d; best = s; }
          }
          if (best) { match = best; matchBy = "vicinanza"; }
        }
        const distM = match ? Math.round(lineLengthM([[p.lon, p.lat], [match.lon, match.lat]])) : null;
        return { code: p.code, lat: p.lat, lon: p.lon, match, matchBy, distM };
      });
      setKmlPreview({
        fileName: file.name,
        points: rows,
        tracks: tracks.map(t => ({ ...t, lengthM: lineLengthM(t.coords) })),
      });
    } catch (e: any) {
      toast.error("Import KML/KMZ fallito", { description: e?.message });
    }
  }

  /* Righe effettive dell'anteprima: se c'è un tracciato selezionato, tiene solo
   * le fermate ENTRO la distanza massima e le ORDINA per progressiva lungo il
   * percorso (le fermate dell'export sono spesso tutta la rete). */
  const kmlSel = useMemo(() => {
    if (!kmlPreview) return null;
    const track = kmlPreview.tracks[kmlTrackIdx] ?? null;
    if (!track) {
      return { track: null as null | typeof track, rows: kmlPreview.points.map(p => ({ ...p, alongM: null as number | null, trackDistM: null as number | null })), excluded: 0 };
    }
    const maxD = Math.max(5, Number(kmlMaxDist) || 30);
    const rows = kmlPreview.points
      .map(p => {
        const pr = projectOnPath(track.coords, [p.lon, p.lat] as [number, number]);
        return { ...p, alongM: pr.alongM as number | null, trackDistM: Math.round(pr.distM) as number | null };
      })
      .filter(r => (r.trackDistM ?? Infinity) <= maxD)
      .sort((a, b) => (a.alongM ?? 0) - (b.alongM ?? 0));
    return { track, rows, excluded: kmlPreview.points.length - rows.length };
  }, [kmlPreview, kmlTrackIdx, kmlMaxDist]);

  /** Conferma dell'anteprima: carica sequenza fermate + tracciato nell'editor. */
  function applyKmlImport() {
    if (!editor || !kmlPreview || !kmlSel) return;
    const matched = kmlSel.rows.filter(r => r.match);
    const track = kmlSel.track;
    if (matched.length < 2 && !(track && track.coords.length >= 2)) {
      toast.error("Servono almeno 2 fermate abbinate o un tracciato per caricare il percorso");
      return;
    }
    pushEditorHistory();
    const stopsList: PsVariantStop[] = matched.map((r, i) => ({
      seq: i + 1,
      stopId: r.match!.id,
      stopName: r.match!.name,
      stopCode: r.match!.code,
      lat: r.match!.lat, lon: r.match!.lon,
      pickupType: 0, dropOffType: 0, timepoint: 1,
    }));
    const wpts: PsWaypoint[] = stopsList.map(s => ({
      lng: s.lon, lat: s.lat, stopId: s.stopId,
      mode: editor.shapeMode === "manual" ? "manual" : "snap",
    }));
    // Tracciato: LineString scelta se presente, altrimenti spezzata fermata→fermata
    const coords: [number, number][] = track && track.coords.length >= 2
      ? track.coords
      : stopsList.map(s => [s.lon, s.lat] as [number, number]);
    const geometry = coords.length >= 2 ? { type: "LineString" as const, coordinates: coords } : null;
    setEditor({
      ...editor,
      stops: stopsList,
      waypoints: wpts,
      geometry,
      distanceM: geometry ? Math.round(lineLengthM(geometry.coordinates)) : null,
      durationS: null,
      legDistances: null,
      violations: [],
      dirty: true,
    });
    setInsertAfterIdx(null);
    if (geometry) fitToCoords(geometry.coordinates);
    else if (stopsList.length > 0) fitToCoords(stopsList.map(s => [s.lon, s.lat] as [number, number]));
    const unmatched = kmlSel.rows.length - matched.length;
    toast.success(`Percorso caricato dal file: ${matched.length} fermate${track ? ` + tracciato ${track.label}` : ""}`, {
      description: `${unmatched > 0 ? `${unmatched} fermate del file non abbinate (saltate). ` : ""}Il percorso resta modificabile: ricontrolla e premi Salva.`,
      duration: 6000,
    });
    setKmlPreview(null);
  }
  function undoEditor() {
    if (!editor || editorHistory.length === 0) return;
    const last = editorHistory[editorHistory.length - 1];
    setEditorHistory(h => h.slice(0, -1));
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: last.stops, waypoints: last.waypoints, dirty: true });
    recomputeShape(last.waypoints, editor.shapeMode);
  }
  // Ctrl/Cmd+Z quando l'editor variante è attivo (non dentro input di testo).
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        undoEditor();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });


  function moveWaypoint(idx: number, lngLat: [number, number]) {
    if (!editor) return;
    pushEditorHistory();
    const wpts = editor.waypoints.map((w, i) => i === idx ? { ...w, lng: lngLat[0], lat: lngLat[1] } : w);
    setEditor({ ...editor, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function removeWaypoint(idx: number) {
    if (!editor) return;
    pushEditorHistory();
    // Se il waypoint è una fermata, va tolta anche dalla sequenza (coerenza
    // elenco ↔ percorso); i via liberi si rimuovono e basta.
    const stopPos = stopPosForWaypointIdx(editor.waypoints, editor.stops, idx);
    const wpts = editor.waypoints.filter((_, i) => i !== idx);
    const list = stopPos >= 0
      ? editor.stops.filter((_, i) => i !== stopPos).map((s, i) => ({ ...s, seq: i + 1 }))
      : editor.stops;
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: list, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function changeShapeMode(mode: "driving" | "manual") {
    if (!editor) return;
    setEditor({ ...editor, shapeMode: mode, dirty: true });
    recomputeShape(editor.waypoints, mode);
  }

  /* ─── Variant editor: stops sequence ─── */
  function addStopToSequence(stop: PsStop) {
    if (!editor) return;
    pushEditorHistory();
    const vs: PsVariantStop = {
      seq: 0, // rinumerato sotto
      stopId: stop.id,
      stopName: stop.name,
      stopCode: stop.code,
      lat: stop.lat, lon: stop.lon,
      pickupType: 0, dropOffType: 0, timepoint: 1,
    };
    // Punto di inserimento: dopo l'ancora se attiva, altrimenti in coda.
    const at = insertAfterIdx != null
      ? Math.min(insertAfterIdx + 1, editor.stops.length)
      : editor.stops.length;
    const stopsList = [...editor.stops];
    stopsList.splice(at, 0, vs);
    const renum = stopsList.map((s, i) => ({ ...s, seq: i + 1 }));

    // Waypoint corrispondente: se inseriamo dopo un'ancora, mettiamo il waypoint
    // subito dopo quello della fermata-ancora così lo shape segue la sequenza.
    const newWpt: PsWaypoint = {
      lng: stop.lon, lat: stop.lat, stopId: stop.id,
      mode: editor.shapeMode === "manual" ? "manual" : "snap",
    };
    const wpts = [...editor.waypoints];
    let wAt = wpts.length;
    if (insertAfterIdx != null && insertAfterIdx >= 0 && insertAfterIdx < editor.stops.length) {
      const anchorStopId = editor.stops[insertAfterIdx].stopId;
      const wIdx = wpts.findIndex(w => w.stopId === anchorStopId);
      if (wIdx >= 0) wAt = wIdx + 1;
    }
    wpts.splice(wAt, 0, newWpt);

    // UN SOLO setEditor: prima c'erano due update con stato stale e il secondo
    // (waypoints) sovrascriveva il primo → la fermata non entrava in sequenza.
    setEditor({ ...editor, stops: renum, waypoints: wpts, dirty: true });
    if (insertAfterIdx != null) setInsertAfterIdx(at); // l'ancora avanza: i click successivi inseriscono in ordine
    recomputeShape(wpts, editor.shapeMode);
  }

  function moveStopInSequence(from: number, to: number) {
    if (!editor) return;
    pushEditorHistory();
    const list = [...editor.stops];
    const [m] = list.splice(from, 1);
    list.splice(to, 0, m);
    const renum = list.map((s, i) => ({ ...s, seq: i + 1 }));
    // Riordino: i via lungo i vecchi tratti non hanno più senso → waypoints
    // ricostruiti dalle sole fermate nel nuovo ordine, percorso ricalcolato.
    const wpts: PsWaypoint[] = renum.map(s => ({ lng: s.lon, lat: s.lat, stopId: s.stopId, mode: "snap" }));
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: renum, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function removeStopFromSequence(idx: number) {
    if (!editor) return;
    pushEditorHistory();
    // Rimuove anche il waypoint corrispondente, così il percorso non ci passa più.
    const wIdx = waypointIndexForStopPos(editor.waypoints, editor.stops, idx);
    const wpts = wIdx >= 0 ? editor.waypoints.filter((_, i) => i !== wIdx) : editor.waypoints;
    const list = editor.stops.filter((_, i) => i !== idx).map((s, i) => ({ ...s, seq: i + 1 }));
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: list, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  /** Rimuove più fermate dalla sequenza in un colpo solo (selezione multipla). */
  function removeStopsFromSequence(idxs: number[]) {
    if (!editor || idxs.length === 0) return;
    pushEditorHistory();
    const wDrop = new Set(
      idxs.map(i => waypointIndexForStopPos(editor.waypoints, editor.stops, i)).filter(i => i >= 0),
    );
    const wpts = editor.waypoints.filter((_, i) => !wDrop.has(i));
    const drop = new Set(idxs);
    const list = editor.stops.filter((_, i) => !drop.has(i)).map((s, i) => ({ ...s, seq: i + 1 }));
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: list, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  /** Inverte l'ordine della sequenza (per creare il percorso di ritorno). */
  function reverseSequence() {
    if (!editor || editor.stops.length < 2) return;
    pushEditorHistory();
    const list = [...editor.stops].reverse().map((s, i) => ({ ...s, seq: i + 1 }));
    // Waypoints ricostruiti dalle fermate invertite (i via dell'andata non valgono al ritorno).
    const wpts: PsWaypoint[] = list.map(s => ({ lng: s.lon, lat: s.lat, stopId: s.stopId, mode: "snap" }));
    setInsertAfterIdx(null);
    setEditor({ ...editor, stops: list, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  /** Svuota completamente la sequenza: niente fermate ⇒ niente percorso. */
  function clearSequence() {
    if (!editor) return;
    pushEditorHistory();
    setInsertAfterIdx(null);
    setEditor({
      ...editor, stops: [], waypoints: [],
      geometry: null, distanceM: 0, durationS: 0, legDistances: null, violations: [],
      dirty: true,
    });
  }

  /* ─── Salvataggio variante ─── */
  async function saveVariant() {
    if (!editor) return;
    setSaving(true);
    try {
      // 1. Salva sequenza fermate
      await setPsVariantStops(projectId, editor.variantId,
        editor.stops.map(s => ({ stopId: s.stopId })));
      // 2. Salva shape (se ho una geometry)
      if (editor.geometry && editor.geometry.coordinates.length >= 2) {
        await setPsVariantShape(projectId, editor.variantId, {
          mode: editor.shapeMode,
          geometry: editor.geometry,
          waypoints: editor.waypoints,
          distanceM: editor.distanceM ?? undefined,
          durationS: editor.durationS ?? undefined,
        });
      }
      toast.success("✅ Percorso salvato", {
        description: `${editor.stops.length} fermate · ${editor.geometry ? `${(editor.distanceM! / 1000).toFixed(2)} km di percorso` : "nessun tracciato"} — puoi chiudere l'editor.`,
        duration: 5000,
      });
      setVariantSavedAt(Date.now());
      setEditor({ ...editor, dirty: false });
      // Aggiorna flag has_shape sulla lista varianti della route
      const updated = await listPsVariants(projectId, editor.routeId);
      setRouteVariants(prev => ({ ...prev, [editor.routeId]: updated }));
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e?.message });
    } finally { setSaving(false); }
  }

  /* ════════════════════════════════════════════════════════════
   *  Vista percorso: selezione variante → fermate + edit tracciato
   * ════════════════════════════════════════════════════════════ */

  /* Apre la vista percorso per una variante: carica fermate ordinate + shape
   * e inquadra la mappa sul tracciato. */
  async function openRouteView(routeId: string, variantId: string) {
    try {
      const data = await getPsVariant(projectId, variantId);
      const route = routes.find(r => r.id === routeId);
      setShapeEdit(null);
      setShowOtherStops(false);
      setRouteView({
        routeId,
        variantId,
        variantName: data.variant?.name || "",
        direction: data.variant?.direction ?? 0,
        routeShortName: route?.shortName || "",
        routeColor: route?.color || "#10b981",
        stops: data.stops || [],
        shape: data.shape,
      });
      // Inquadra il percorso: shape se presente, altrimenti le fermate
      const coords = data.shape?.geometry?.coordinates?.length
        ? data.shape.geometry.coordinates
        : (data.stops || []).map(s => [s.lon, s.lat] as [number, number]);
      if (coords.length > 0) fitToCoords(coords);
    } catch (e: any) {
      toast.error("Errore caricamento percorso", { description: e?.message });
    }
  }

  function closeRouteView() {
    setRouteView(null);
    setShapeEdit(null);
    setShowOtherStops(false);
  }

  /* Entra in modalità "Edita tracciato": copia di lavoro della LineString.
   * Se la variante non ha ancora uno shape, parte dalla spezzata fermata→fermata. */
  function startShapeEdit() {
    if (!routeView) return;
    const coords: [number, number][] = routeView.shape?.geometry?.coordinates?.length
      ? routeView.shape.geometry.coordinates.map(c => [c[0], c[1]] as [number, number])
      : routeView.stops.map(s => [Number(s.lon), Number(s.lat)] as [number, number]);
    if (coords.length < 2) {
      toast.error("Tracciato non editabile", { description: "Servono almeno 2 punti (shape o fermate)." });
      return;
    }
    setShapeEdit({
      coordinates: coords,
      vertexIdx: sampleVertexIndices(coords.length),
      distanceM: routeView.shape?.distanceM ?? null,
      durationS: routeView.shape?.durationS ?? null,
      dirty: false,
    });
  }

  /* Sposta un vertice campionato. I punti non campionati tra i vertici
   * adiacenti vengono ricostruiti interpolando lo spostamento (peso 1 sul
   * vertice trascinato → 0 sui vertici vicini), così la linea resta continua
   * anche quando mostriamo solo 1 vertice ogni N. */
  function moveShapeVertex(vertexPos: number, lngLat: [number, number]) {
    setShapeEdit(prev => {
      if (!prev) return prev;
      const coords = prev.coordinates.map(c => [c[0], c[1]] as [number, number]);
      const i = prev.vertexIdx[vertexPos];
      const dx = lngLat[0] - coords[i][0];
      const dy = lngLat[1] - coords[i][1];
      coords[i] = [lngLat[0], lngLat[1]];
      // Interpola i segmenti non campionati verso il vertice precedente…
      const p = vertexPos > 0 ? prev.vertexIdx[vertexPos - 1] : i;
      for (let j = p + 1; j < i; j++) {
        const t = (j - p) / (i - p);
        coords[j] = [coords[j][0] + dx * t, coords[j][1] + dy * t];
      }
      // …e verso il successivo
      const n = vertexPos < prev.vertexIdx.length - 1 ? prev.vertexIdx[vertexPos + 1] : i;
      for (let j = i + 1; j < n; j++) {
        const t = (n - j) / (n - i);
        coords[j] = [coords[j][0] + dx * t, coords[j][1] + dy * t];
      }
      // distanceM/durationS OSRM non più validi dopo edit manuale
      return { ...prev, coordinates: coords, distanceM: null, durationS: null, dirty: true };
    });
  }

  /* "Snap OSRM": ricostruisce il tracciato concatenando routeSnap tra coppie
   * consecutive di fermate della variante. */
  async function snapShapeToStops() {
    if (!routeView || !shapeEdit) return;
    if (routeView.stops.length < 2) {
      toast.error("Servono almeno 2 fermate per lo snap OSRM");
      return;
    }
    setShapeEditBusy(true);
    try {
      // UNA chiamata multi-punto: percorso sull'asse strada senza inversioni a U
      // alle fermate intermedie, arrivo lato marciapiede, km dalle legs OSRM.
      const pts: [number, number][] = routeView.stops.map(s => [Number(s.lon), Number(s.lat)]);
      const r = await routeSnap(pts, "driving", {
        curb: false, // opzionale: ON solo dall'editor variante (può creare giri dell'isolato)
        projectId,
      });
      const merged: [number, number][] = (r.geometry?.coordinates ?? []) as [number, number][];
      const dist = r.distanceM || 0;
      const dur = r.durationS || 0;
      if (r.violations && r.violations.length > 0) {
        toast.warning(`Il percorso attraversa ${r.violations.length} zona/e vietata/e`, {
          description: r.violations.map(v => v.name).join(", "),
        });
      }
      if (merged.length < 2) throw new Error("Nessuna geometria restituita da OSRM");
      setShapeEdit(prev => prev ? {
        ...prev,
        coordinates: merged,
        vertexIdx: sampleVertexIndices(merged.length),
        distanceM: dist,
        durationS: dur,
        dirty: true,
      } : prev);
      toast.success("Tracciato ricalcolato via OSRM", {
        description: `${(dist / 1000).toFixed(2)} km · ${routeView.stops.length} fermate`,
      });
    } catch (e: any) {
      toast.error("Errore snap OSRM", { description: e?.message });
    } finally { setShapeEditBusy(false); }
  }

  /* "Salva": persiste la LineString editata con setPsVariantShape. */
  async function saveShapeEdit() {
    if (!routeView || !shapeEdit) return;
    setShapeEditSaving(true);
    try {
      const geometry = { type: "LineString" as const, coordinates: shapeEdit.coordinates };
      // Riusa i waypoint esistenti se presenti, altrimenti derivali dalle fermate
      const waypoints: PsWaypoint[] = routeView.shape?.waypoints?.length
        ? routeView.shape.waypoints
        : routeView.stops.map(s => ({
            lng: Number(s.lon), lat: Number(s.lat), stopId: s.stopId, mode: "snap" as const,
          }));
      const distanceM = shapeEdit.distanceM ?? Math.round(lineLengthM(shapeEdit.coordinates));
      const saved = await setPsVariantShape(projectId, routeView.variantId, {
        mode: routeView.shape?.mode || "snap",
        geometry,
        waypoints,
        distanceM,
        durationS: shapeEdit.durationS ?? undefined,
      });
      setRouteView({ ...routeView, shape: saved });
      setShapeEdit(null);
      setShowOtherStops(false);
      toast.success("Tracciato salvato", { description: `${(distanceM / 1000).toFixed(2)} km` });
      // Aggiorna il flag hasShape nella lista varianti della linea
      const updated = await listPsVariants(projectId, routeView.routeId);
      setRouteVariants(prev => ({ ...prev, [routeView.routeId]: updated }));
    } catch (e: any) {
      toast.error("Errore salvataggio tracciato", { description: e?.message });
    } finally { setShapeEditSaving(false); }
  }

  /* "Annulla": scarta la copia di lavoro → la mappa torna allo shape originale. */
  function cancelShapeEdit() {
    if (shapeEdit?.dirty && !confirm("Annullare le modifiche al tracciato?")) return;
    setShapeEdit(null);
    setShowOtherStops(false);
  }

  /* ─── Toolbar: apre/chiude un pannello dati da una voce di menu ───
   * Stessa logica dei vecchi bottoni piatti: toggle del pannello + effetti
   * collaterali (uscita dal draw cluster, sync overlay depositi, lazy-load
   * dei nodi globali). Chiude sempre il menu a tendina. */
  function togglePanel(p: Exclude<DataPanel, null>) {
    setOpenMenu(null);
    if (activePanel === p) {
      setActivePanel(null);
      if (p === "clusters") setClusterDraw(null);   // esci da eventuale modalità draw/stops in corso
      if (p === "ne-depots") setShowDepots(false);  // spegni anche l'overlay depositi
    } else {
      setActivePanel(p);
      if (p === "ne-depots") setShowDepots(true);   // accendi l'overlay depositi
      if (p === "ne-clusters" && globalClusters.length === 0 && !overlayLoading.clusters) reloadGlobalClusters();
    }
  }

  /* ─── Toolbar: voce unificata "Nodi" (tab Progetto + Globali legacy) ───
   * Un solo pannello: la tab attiva è mappata su activePanel ("clusters" =
   * nodi di progetto, "ne-clusters" = cluster globali legacy) così tutta la
   * logica esistente (layer mappa, visibleStops, draw…) resta invariata.
   * Se il pannello è già aperto su una delle due tab, lo chiude. */
  function toggleNodesPanel() {
    setOpenMenu(null);
    if (activePanel === "clusters" || activePanel === "ne-clusters") {
      setActivePanel(null);
      setClusterDraw(null); // esci da eventuale modalità draw/stops in corso
    } else {
      setActivePanel("clusters"); // tab "Progetto" di default
      // Pre-carica i nodi globali legacy così il conteggio della tab è subito corretto
      if (globalClusters.length === 0 && !overlayLoading.clusters) reloadGlobalClusters();
    }
  }

  /* Cambio tab interna del pannello Nodi (Progetto ⇄ Globali legacy) */
  function switchNodesTab(tab: "clusters" | "ne-clusters") {
    if (activePanel === tab) return;
    if (tab === "ne-clusters") {
      setClusterDraw(null); // il draw ha senso solo sui nodi di progetto
      if (globalClusters.length === 0 && !overlayLoading.clusters) reloadGlobalClusters();
    }
    setActivePanel(tab);
  }

  /* ─── Cursor sulla mappa secondo tool ─── */
  const mapCursor = pickingDepotLocation ? "crosshair"
                  : dragViaPos ? "grabbing"
                  : (clusterDraw && clusterDraw.mode === "draw") ? "crosshair"
                  : (clusterDraw && clusterDraw.mode === "stops") ? "pointer"
                  : (editor && lineHover) ? "grab"
                  : tool === "addStop" ? "crosshair"
                  : tool === "editVariant" ? "crosshair"
                  : "grab";

  /* ─── Import GTFS ─── */
  const isEmpty = !loading && stops.length === 0 && routes.length === 0;

  useEffect(() => {
    if (importOpen) setImportMode(isEmpty ? "replace" : "merge");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importOpen]);

  /** Fase 1 → 2: legge lo zip e mostra l'elenco linee da scegliere. */
  async function handlePreview() {
    if (!importFile) return;
    setPreviewing(true);
    try {
      const r = await previewPsGtfs(projectId, importFile);
      if (r.routes.length === 0) { toast.error("Nessuna linea trovata nel file"); return; }
      setPreviewRoutes(r.routes);
      setSelectedRouteIds(new Set(r.routes.map(x => x.routeId))); // tutte selezionate di default
    } catch (e: any) {
      toast.error("Lettura GTFS fallita", { description: e?.message });
    } finally {
      setPreviewing(false);
    }
  }

  async function handleImport() {
    if (!importFile) return;
    // Se ho letto le linee, importo SOLO quelle spuntate. Senza preview → tutte.
    const routeIds = previewRoutes ? [...selectedRouteIds] : undefined;
    if (previewRoutes && routeIds!.length === 0) { toast.error("Seleziona almeno una linea"); return; }
    setImporting(true);
    try {
      // In modalità Aggiorna il primo passaggio è l'ANTEPRIMA (dryRun): stessi
      // conteggi dell'applicazione reale, zero scritture. Applica al secondo.
      if (importMode === "merge" && !importMergePreview) {
        const prev = await importPsGtfs(projectId, importFile, routeIds, "merge", true);
        if (prev.merge) setImportMergePreview(prev.merge);
        setImporting(false);
        return;
      }
      const r = await importPsGtfs(projectId, importFile, routeIds, importMode);
      if (r.mode === "merge" && r.merge) {
        const m = r.merge;
        toast.success("Aggiornamento completato (merge)", {
          description:
            `Corse: +${m.trips.added} nuove · ${m.trips.updated} aggiornate · ${m.trips.deactivated} disattivate (sparite dal feed)` +
            ` — validità, nodi e UDP conservati.` +
            (m.trips.keptManual > 0 ? ` ${m.trips.keptManual} corse manuali intatte.` : ""),
          duration: 10000,
        });
      } else if (r.counts) {
        setImportResult(r.counts);
        toast.success("Import completato", {
          description: `${r.counts.stops} fermate · ${r.counts.routes} linee · ${r.counts.trips} corse`,
        });
      }
      // Ricarica i dati del progetto
      const results = await Promise.allSettled([
        listPsStops(projectId), listPsRoutes(projectId), listPsCalendars(projectId), listPsClusters(projectId),
      ]);
      const [sR, rrR, cR, clR] = results;
      const s = sR.status === "fulfilled" ? sR.value : stops;
      if (sR.status === "fulfilled") setStops(s); else toast.warning("Fermate non ricaricate");
      if (rrR.status === "fulfilled") setRoutes(rrR.value); else toast.warning("Linee non ricaricate");
      if (cR.status === "fulfilled") setCalendars(cR.value); else toast.warning("Calendari non ricaricati");
      if (clR.status === "fulfilled") setClusters(clR.value); else toast.warning("Nodi non ricaricati");
      // Fit map sulle fermate
      if (s.length > 0) {
        const coords = s.map(x => [x.lon, x.lat] as [number, number]);
        setTimeout(() => fitToCoords(coords), 200);
      }
    } catch (e: any) {
      toast.error("Errore import GTFS", { description: e?.message });
    } finally {
      setImporting(false);
    }
  }
  function closeImport() {
    if (importing || previewing) return;
    setImportOpen(false);
    setImportFile(null);
    setImportResult(null);
    setImportMergePreview(null);
    setPreviewRoutes(null);
    setSelectedRouteIds(new Set());
    setRouteSearch("");
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-300">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Caricamento progetto…
      </div>
    );
  }
  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        Progetto non trovato.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {project?.isOperational && (
        <div className="px-3 pt-3"><OperationalEditWarning isOperational projectName={project?.name} /></div>
      )}
      {/* ─── Toolbar top ─── */}
      {/* Nota: niente overflow-x sulla barra, altrimenti i menu a tendina verrebbero tagliati */}
      <div className="h-14 border-b border-slate-800 bg-slate-950/95 backdrop-blur flex items-center px-3 gap-2 shrink-0 z-30 whitespace-nowrap">
        {/* Back + project info */}
        <button onClick={() => navigate("/planning-studio")}
          className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 max-w-[200px] mr-2">
          <h1 className="text-sm font-semibold truncate">{project.name}</h1>
          <p className="text-[10px] text-slate-500 truncate">
            {project.agencyName || project.myRole}
          </p>
        </div>

        {/* Badge ruolo */}
        <span
          title={`Il tuo ruolo su questo progetto: ${project.myRole}`}
          className={
            "px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 border " +
            (project.myRole === "owner"
              ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
              : project.myRole === "editor"
                ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/30"
                : "bg-slate-500/15 text-slate-300 border-slate-500/30")
          }
        >
          {project.myRole === "owner" ? "Proprietario" : project.myRole === "editor" ? "Editor" : "Sola lettura"}
        </span>

        {/* Contatore corse del progetto (si aggiorna man mano che se ne aggiungono) */}
        <TripCountBadge projectId={projectId} />

        <div className="h-7 w-px bg-slate-800 mx-1" />

        {/* ─── Barra strumenti UNICA (menu a tendina) ───────────────────
         * Qui vivono SOLO gli strumenti dell'editor mappa: pannelli laterali,
         * layer di vista, azioni di progetto. La NAVIGAZIONE tra le sezioni
         * del progetto (Corse, Grafico, Calendario, Validità, UDP, Nodi,
         * Zonizzazione, Depositi, Fuorilinea, Intermodale, Esercizio) sta
         * tutta e solo in PsProjectNav, la barra qui sotto: prima ogni voce
         * era duplicata nei menu e nelle tab, con etichette diverse per la
         * stessa pagina. */}
        <div ref={menuBarRef} className="flex items-center gap-1 shrink-0">
          {/* Pannelli: i dati del progetto consultabili SULLA mappa */}
          <MenuGroup
            label="Pannelli" icon={PanelLeft} accent="emerald"
            active={activePanel !== null}
            open={openMenu === "pannelli"}
            onToggle={() => setOpenMenu(m => m === "pannelli" ? null : "pannelli")}
          >
            <MenuItem icon={MapPin} label="Fermate" count={stops.length} accent="emerald"
              active={activePanel === "stops"} onClick={() => togglePanel("stops")} />
            <MenuItem icon={Bus} label="Linee & Percorsi" count={routes.length} accent="cyan"
              active={activePanel === "routes"} onClick={() => togglePanel("routes")} />
            <MenuItem icon={Layers} label="Nodi"
              desc="di progetto + globali legacy"
              count={(clusters.length + globalClusters.length) || undefined} accent="cyan"
              active={activePanel === "clusters" || activePanel === "ne-clusters"}
              onClick={toggleNodesPanel} />
            <MenuItem icon={Building2} label="Depositi"
              desc="accende anche l'overlay sulla mappa"
              count={depots.length || undefined} accent="orange"
              active={activePanel === "ne-depots"} onClick={() => togglePanel("ne-depots")} />
          </MenuGroup>

          {/* Vista: layer overlay della mappa (il toggle 2D/3D è sulla mappa) */}
          <MenuGroup
            label="Vista" icon={Eye} accent="violet"
            active={showGlobalClusters || showDepots || showNoGo}
            open={openMenu === "vista"}
            onToggle={() => setOpenMenu(m => m === "vista" ? null : "vista")}
          >
            <MenuItem icon={Grip} label="Overlay nodi globali" accent="cyan"
              active={showGlobalClusters} onClick={() => setShowGlobalClusters(v => !v)} />
            <MenuItem icon={Building2} label="Overlay depositi" accent="orange"
              active={showDepots} onClick={() => setShowDepots(v => !v)} />
            <div className="my-1 h-px bg-slate-800" />
            <MenuItem icon={Ban} label="Zone vietate bus" accent="amber"
              desc="mostra i poligoni off-limits"
              count={noGoZones.filter(z => z.active).length || undefined}
              active={showNoGo} onClick={() => setShowNoGo(v => !v)} />
            {(project.myRole === "owner" || project.myRole === "editor") && (
              <MenuItem icon={PenLine} label="Disegna zona vietata" accent="amber"
                desc="clic vertici · doppio clic chiude"
                onClick={() => { setOpenMenu(null); setShowNoGo(true); setZoneDraw({ polygon: [] }); }} />
            )}
          </MenuGroup>

          {/* Progetto: azioni sul progetto (non pagine: quelle sono nelle tab) */}
          <MenuGroup
            label="Progetto" icon={FolderOpen} accent="cyan"
            active={false}
            open={openMenu === "progetto"}
            onToggle={() => setOpenMenu(m => m === "progetto" ? null : "progetto")}
          >
            {(project.myRole === "owner" || project.myRole === "editor") && (
              <MenuItem icon={Upload} label="Importa GTFS" note="aggiorna o sostituisce" accent="cyan"
                onClick={() => { setOpenMenu(null); setImportOpen(true); }} />
            )}
            <MenuItem icon={Share2} label={project.myRole === "owner" ? "Condividi progetto" : "Vedi membri"} accent="cyan"
              onClick={() => { setOpenMenu(null); setShareOpen(true); }} />
          </MenuGroup>
        </div>

        <div className="flex-1" />

        {/* Tools primari: sempre visibili perché usatissimi */}
        <div className="flex items-center gap-1 bg-slate-900/80 rounded-lg p-1 border border-slate-800 shrink-0">
          <ToolBtn label="Seleziona" icon={MousePointer2} active={tool === "select"} onClick={() => setTool("select")} />
          <ToolBtn label="Nuova fermata" icon={Crosshair} active={tool === "addStop"} onClick={() => setTool("addStop")} disabled={!!editor} />
          {editor && (
            <ToolBtn label="Editor variante attivo" icon={PenLine} active={true} onClick={() => {}} />
          )}
        </div>

        {/* CTA primaria: nuovo progetto Scheduling collegato a questo PS */}
        <button
          onClick={() => navigate(`/fucina?ps=${projectId}&new=1`)}
          className="ml-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_15px_rgba(251,146,60,0.4)] transition-shadow shrink-0"
          title="Crea un nuovo progetto Scheduling collegato a questo PS"
        >
          <Plus className="w-3.5 h-3.5" /> Nuovo Scheduling
        </button>
      </div>
      <PsProjectNav projectId={projectId} active="editor" />
      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
      {/* Dialog nome zona vietata (il poligono resta finché non salvi o annulli) */}
      {zoneNameAsk && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
          onClick={() => { if (!zoneSaving) { setZoneNameAsk(null); setZoneNameDraft(""); } }}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-sm text-slate-100"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-800">
              <h2 className="text-sm font-semibold flex items-center gap-2"><Ban className="w-4 h-4 text-red-400" /> Nuova zona vietata</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">{zoneNameAsk.length} vertici · i percorsi che la attraversano verranno segnalati</p>
            </div>
            <div className="px-5 py-4">
              <label className="block text-[11px] text-slate-400 mb-1.5">Nome della zona *</label>
              <input value={zoneNameDraft} onChange={(e) => setZoneNameDraft(e.target.value)} autoFocus
                placeholder="es. ZTL centro storico"
                onKeyDown={(e) => { if (e.key === "Enter") void saveNamedZone(); }}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-red-500" />
            </div>
            <div className="px-5 py-3.5 border-t border-slate-800 flex justify-end gap-2">
              <button onClick={() => { setZoneNameAsk(null); setZoneNameDraft(""); }} disabled={zoneSaving}
                className="px-3.5 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={() => void saveNamedZone()} disabled={!zoneNameDraft.trim() || zoneSaving}
                className="px-3.5 py-1.5 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-500 text-white flex items-center gap-1.5 disabled:opacity-50">
                {zoneSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Crea zona
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Area di lavoro: mappa full + overlays ─── */}
      <div ref={mapContainerRef} className="flex-1 relative overflow-hidden">
        {!MAPBOX_TOKEN && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 text-amber-300 text-sm">
            ⚠️ VITE_MAPBOX_TOKEN non configurato
          </div>
        )}

        {/* Banner istruzioni durante draw/stops cluster */}
        {/* Banner disegno zona vietata */}
        {zoneDraw && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-red-600/95 text-white px-4 py-2 rounded-lg shadow-xl text-xs font-medium flex items-center gap-3 backdrop-blur">
            <Ban className="w-4 h-4" />
            <span><b>Zona vietata bus</b>: clicca i vertici sulla mappa. <b>Doppio click</b> per chiudere e salvare.</span>
            <span className="px-1.5 py-0.5 rounded bg-white/20 text-[10px]">{zoneDraw.polygon.length} vertici</span>
            <button onClick={() => setZoneDraw(null)} className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-[11px]">Annulla</button>
          </div>
        )}

        {clusterDraw && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-violet-600/95 text-white px-4 py-2 rounded-lg shadow-xl text-xs font-medium flex items-center gap-3 backdrop-blur">
            {clusterDraw.mode === "draw" ? (
              <>
                <span>🖊️ <b>Disegna l'area</b>: clicca i vertici. <b>Doppio click</b> per chiudere.</span>
                <span className="px-1.5 py-0.5 rounded bg-white/20 text-[10px]">{clusterDraw.polygon.length} vertici</span>
                {clusterDraw.polygon.length > 0 && (
                  <button onClick={() => setClusterDraw({ ...clusterDraw, polygon: [] })}
                    className="px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-[10px]">↩ Reset</button>
                )}
              </>
            ) : (
              <>
                <span>👆 <b>Clicca le fermate</b> per aggiungerle/rimuoverle dal cluster.</span>
                <span className="px-1.5 py-0.5 rounded bg-white/20 text-[10px]">{clusterDraw.pendingStopIds.size} fermate</span>
                <button onClick={() => setClusterDraw({ ...clusterDraw, mode: "draw", polygon: [] })}
                  className="px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-[10px]">🖊 Ridisegna area</button>
              </>
            )}
            <button onClick={() => setClusterDraw(null)} title="Annulla"
              className="ml-1 p-1 rounded hover:bg-white/20"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={DEFAULT_VIEW}
          mapStyle="mapbox://styles/mapbox/standard"
          onClick={handleMapClick}
          onDblClick={(e) => {
            // Chiusura poligono zona vietata → nome + salvataggio
            if (zoneDraw) {
              e.preventDefault();
              const poly = zoneDraw.polygon;
              if (poly.length < 3) {
                toast.error("Servono almeno 3 vertici per chiudere la zona");
                return;
              }
              // Il nome viene chiesto con un dialog in-app (niente prompt nativo,
              // sopprimibile dal browser: il poligono andava perso in silenzio).
              setZoneDraw(null);
              setZoneNameAsk(poly);
              return;
            }
            // Chiusura poligono in modalità draw cluster
            if (clusterDraw && clusterDraw.mode === "draw") {
              e.preventDefault();
              const poly = clusterDraw.polygon;
              if (poly.length < 3) {
                toast.error("Servono almeno 3 vertici per chiudere l'area");
                return;
              }
              // Auto-include tutte le fermate dentro il poligono
              const inside = new Set<string>(clusterDraw.pendingStopIds);
              for (const s of stops) {
                if (pointInPolygon([Number(s.lon), Number(s.lat)], poly)) {
                  inside.add(s.id);
                }
              }
              setClusterDraw({ ...clusterDraw, mode: "stops", pendingStopIds: inside });
              toast.success(`Area chiusa: ${inside.size} fermate selezionate. Clicca le fermate per modificare.`);
            }
          }}
          onLoad={() => setMapReady(true)}
          onMouseDown={(e) => {
            // Afferra la LINEA del percorso (stile Google Maps): inizia il drag di
            // un nuovo via-point, inserito nel tratto giusto della sequenza.
            if (!editor || editor.waypoints.length < 2) return;
            const f = (e as any).features?.find((ft: any) => ft?.layer?.id === "editor-shape-line");
            if (!f) return;
            e.preventDefault();
            const idx = viaInsertIndex(
              editor.geometry?.coordinates ?? null,
              editor.legDistances,
              editor.waypoints,
              [e.lngLat.lng, e.lngLat.lat],
            );
            dragViaRef.current = { insertIdx: idx };
            setDragViaPos([e.lngLat.lng, e.lngLat.lat]);
            mapRef.current?.getMap()?.dragPan.disable();
          }}
          onMouseUp={(e) => {
            const d = dragViaRef.current;
            if (!d) return;
            dragViaRef.current = null;
            setDragViaPos(null);
            mapRef.current?.getMap()?.dragPan.enable();
            suppressClickRef.current = true; // il click generato al rilascio non deve fare altro
            if (!editor) return;
            pushEditorHistory();
            const wpts = [...editor.waypoints];
            wpts.splice(d.insertIdx, 0, {
              lng: e.lngLat.lng, lat: e.lngLat.lat,
              mode: editor.shapeMode === "manual" ? "manual" : "snap",
            });
            setEditor({ ...editor, waypoints: wpts, dirty: true });
            recomputeShape(wpts, editor.shapeMode);
          }}
          onMouseMove={(e) => {
            // Drag via-point in corso: il segnaposto segue il cursore.
            if (dragViaRef.current) {
              setDragViaPos([e.lngLat.lng, e.lngLat.lat]);
              return;
            }
            // Hover sulla linea del percorso (editor attivo) → cursore "grab".
            if (editor) {
              const lf = e.features?.find(ft => ft.layer?.id === "editor-shape-line");
              setLineHover(!!lf);
            } else if (lineHover) {
              setLineHover(false);
            }
            // Nome fermata al passaggio del cursore: layer fermate base + layer
            // della vista/edit percorso (fermate della variante e "altre" dimmed).
            const HOVER_LAYERS = new Set([
              "ps-stops-circle", "ps-stops-circle-hit",
              "route-view-stops-circle", "route-view-other-stops-circle",
            ]);
            const f = e.features?.find(ft => HOVER_LAYERS.has(ft.layer?.id ?? ""));
            if (f && (f.geometry as any)?.type === "Point") {
              const [lon, lat] = (f.geometry as any).coordinates as [number, number];
              const props: any = f.properties ?? {};
              // Fermate del percorso: prefissa il numero di sequenza (es. "3 · NOME").
              const name = props.seq != null ? `${props.seq} · ${props.name ?? ""}` : String(props.name ?? "");
              if (!hoverStop || hoverStop.lon !== lon || hoverStop.lat !== lat) setHoverStop({ name, lon, lat });
            } else if (hoverStop) {
              setHoverStop(null);
            }
          }}
          onMouseLeave={() => hoverStop && setHoverStop(null)}
          cursor={mapCursor}
          interactiveLayerIds={[
            "ps-stops-circle", "ps-stops-circle-hit",
            "route-view-stops-circle", "route-view-other-stops-circle",
            "ps-nogo-fill", "editor-shape-line",
          ]}
          style={{ width: "100%", height: "100%" }}
        >
          <NavigationControl position="bottom-right" />

          {/* Tooltip nome fermata (hover) — piccolo, non interattivo */}
          {hoverStop && hoverStop.name && (
            <Popup longitude={hoverStop.lon} latitude={hoverStop.lat} anchor="bottom" offset={12}
              closeButton={false} closeOnClick={false} className="ps-stop-hover">
              <span className="text-[10px] font-medium text-slate-800 whitespace-nowrap">{hoverStop.name}</span>
            </Popup>
          )}

          {/* Toggle 2D / 3D ─ overlay in alto a destra */}
          <div className="absolute top-3 right-3 z-10 flex rounded-lg overflow-hidden border border-slate-300 shadow-lg bg-white/95 backdrop-blur">
            <button
              onClick={() => setIs3D(false)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                !is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
              title="Vista 2D"
            >2D</button>
            <button
              onClick={() => setIs3D(true)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
              title="Vista 3D con edifici"
            >3D</button>
          </div>

          {/* I Source/Layer si aggiungono SOLO dopo il caricamento completo dello
              stile: con lo stile "standard" (import async) un addSource anticipato
              lancia "Style is not done loading" e fa crashare la pagina. */}
          {mapReady && (
          <>
          {/* ─── Zone vietate bus: poligoni rossi (visibili in editor/toggle/disegno) ─── */}
          {/* Multi-visualizzazione linee (toggle occhio nel pannello Linee) */}
          {Object.entries(multiShown).map(([rid, m]) => (
            <Source key={`multi-${rid}`} id={`multi-route-${rid}`} type="geojson"
              data={{ type: "FeatureCollection", features: m.features } as any}>
              <Layer id={`multi-route-casing-${rid}`} type="line"
                paint={{ "line-color": "#000", "line-width": 5, "line-opacity": 0.35 }} />
              <Layer id={`multi-route-line-${rid}`} type="line"
                paint={{ "line-color": m.color, "line-width": 3, "line-opacity": 0.85 }} />
            </Source>
          ))}
          {(showNoGo || !!editor || !!zoneDraw) && noGoZonesGeoJSON.features.length > 0 && (
            <Source id="ps-nogo-src" type="geojson" data={noGoZonesGeoJSON}>
              <Layer id="ps-nogo-fill" type="fill"
                paint={{ "fill-color": "#ef4444", "fill-opacity": 0.16 }} />
              <Layer id="ps-nogo-outline" type="line"
                paint={{ "line-color": "#ef4444", "line-width": 2, "line-dasharray": [2, 1.4] }} />
              <Layer id="ps-nogo-label" type="symbol"
                layout={{ "text-field": ["get", "name"], "text-size": 11, "text-allow-overlap": false }}
                paint={{ "text-color": "#b91c1c", "text-halo-color": "#ffffff", "text-halo-width": 1.5 }} />
            </Source>
          )}

          {/* Zona vietata in costruzione (vertici cliccati) */}
          {zoneDraw && zoneDraw.polygon.length >= 2 && (
            <Source id="ps-nogo-draw-src" type="geojson" data={{
              type: "Feature", properties: {},
              geometry: zoneDraw.polygon.length >= 3
                ? { type: "Polygon", coordinates: [[...zoneDraw.polygon, zoneDraw.polygon[0]]] }
                : { type: "LineString", coordinates: zoneDraw.polygon },
            } as any}>
              <Layer id="ps-nogo-draw-fill" type={zoneDraw.polygon.length >= 3 ? "fill" : "line"}
                paint={zoneDraw.polygon.length >= 3
                  ? { "fill-color": "#ef4444", "fill-opacity": 0.25 } as any
                  : { "line-color": "#ef4444", "line-width": 2 } as any} />
            </Source>
          )}
          {zoneDraw && zoneDraw.polygon.map((p, i) => (
            <Marker key={`ngv-${i}`} longitude={p[0]} latitude={p[1]} anchor="center">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 border border-white shadow" />
            </Marker>
          ))}

          {/* Card info zona vietata (click sul poligono) */}
          {zoneInfo && (
            <Popup longitude={zoneInfo.lng} latitude={zoneInfo.lat} anchor="bottom" offset={8}
              closeOnClick={false} onClose={() => setZoneInfo(null)} maxWidth="240px">
              <div className="p-1 space-y-1.5">
                <p className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                  <Ban className="w-3.5 h-3.5 text-red-500" /> {zoneInfo.name}
                </p>
                <p className="text-[10px] text-slate-500">Zona vietata bus: i percorsi che la attraversano vengono segnalati.</p>
                {(project?.myRole === "owner" || project?.myRole === "editor") && (
                  <button
                    onClick={() => setConfirmReq({
                      title: `Eliminare la zona vietata "${zoneInfo.name}"?`,
                      confirmLabel: "Elimina",
                      onConfirm: () => { void (async () => {
                        try {
                          await deletePsNoGoZone(projectId, zoneInfo.id);
                          setZoneInfo(null);
                          toast.success("Zona eliminata");
                          await reloadNoGoZones();
                          if (editor && editor.waypoints.length >= 2) recomputeShape(editor.waypoints, editor.shapeMode);
                        } catch (err: any) { toast.error("Errore", { description: err?.message }); }
                      })(); },
                    })}

                    className="w-full text-[11px] px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-medium"
                  >
                    Elimina zona
                  </button>
                )}
              </div>
            </Popup>
          )}

          {/* ─── Cluster draw: poligono in costruzione (modalità draw) ─── */}
          {clusterDraw && clusterDraw.polygon.length > 0 && (
            <>
              {clusterDraw.polygon.length >= 2 && (
                <Source
                  id="cluster-draw-poly-src"
                  type="geojson"
                  data={{
                    type: "Feature",
                    properties: {},
                    geometry: clusterDraw.polygon.length >= 3
                      ? { type: "Polygon", coordinates: [[...clusterDraw.polygon, clusterDraw.polygon[0]]] }
                      : { type: "LineString", coordinates: clusterDraw.polygon },
                  } as any}
                >
                  <Layer
                    id="cluster-draw-poly-fill"
                    type="fill"
                    filter={["==", ["geometry-type"], "Polygon"]}
                    paint={{ "fill-color": "#a855f7", "fill-opacity": 0.18 }}
                  />
                  <Layer
                    id="cluster-draw-poly-line"
                    type="line"
                    paint={{ "line-color": "#a855f7", "line-width": 2.5, "line-dasharray": [2, 2] }}
                  />
                </Source>
              )}
              {/* Vertici cliccati */}
              <Source
                id="cluster-draw-verts-src"
                type="geojson"
                data={{
                  type: "FeatureCollection",
                  features: clusterDraw.polygon.map((p, i) => ({
                    type: "Feature", properties: { idx: i },
                    geometry: { type: "Point", coordinates: p },
                  })),
                } as any}
              >
                <Layer
                  id="cluster-draw-verts"
                  type="circle"
                  paint={{
                    "circle-radius": 5,
                    "circle-color": "#a855f7",
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 2,
                  }}
                />
              </Source>
            </>
          )}

          {/* ─── Cluster draw: fermate pending (selezionate) evidenziate ─── */}
          {clusterDraw && clusterDraw.pendingStopIds.size > 0 && (
            <Source
              id="cluster-draw-pending-src"
              type="geojson"
              data={{
                type: "FeatureCollection",
                features: stops
                  .filter(s => clusterDraw.pendingStopIds.has(s.id))
                  .map(s => ({
                    type: "Feature",
                    properties: { id: s.id, name: s.name },
                    geometry: { type: "Point", coordinates: [Number(s.lon), Number(s.lat)] },
                  })),
              } as any}
            >
              <Layer
                id="cluster-draw-pending-halo"
                type="circle"
                paint={{
                  "circle-radius": 12,
                  "circle-color": "#a855f7",
                  "circle-opacity": 0.25,
                  "circle-stroke-color": "#a855f7",
                  "circle-stroke-width": 2,
                }}
              />
            </Source>
          )}

          {/* Cluster: cerchi (raggio reale convertito in pixel @ zoom corrente) */}
          {activePanel === "clusters" && clusters.length > 0 && (
            <Source
              id="ps-clusters-src"
              type="geojson"
              data={{
                type: "FeatureCollection",
                features: clusters
                  .filter(c => c.centerLat != null && c.centerLon != null)
                  .map(c => ({
                    type: "Feature",
                    properties: {
                      id: c.id,
                      name: c.name,
                      color: (c.attributes && typeof (c.attributes as any).color === "string"
                              ? (c.attributes as any).color
                              : (c.kind === "interchange" ? "#0ea5e9" : c.kind === "rest" ? "#f59e0b" : "#64748b")),
                      radius: c.radiusM,
                    },
                    geometry: { type: "Point", coordinates: [Number(c.centerLon), Number(c.centerLat)] },
                  })),
              }}
            >
              <Layer
                id="ps-clusters-fill"
                type="circle"
                paint={{
                  "circle-radius": [
                    "interpolate", ["exponential", 2], ["zoom"],
                    10, ["/", ["get", "radius"], 50],
                    16, ["/", ["get", "radius"], 1.2],
                  ],
                  "circle-color": ["get", "color"],
                  "circle-opacity": 0.18,
                  "circle-stroke-color": ["get", "color"],
                  "circle-stroke-width": 2,
                  "circle-stroke-opacity": 0.9,
                }}
              />
              <Layer
                id="ps-clusters-label"
                type="symbol"
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-offset": [0, 1.2],
                  "text-anchor": "top",
                }}
                paint={{
                  "text-color": "#0ea5e9",
                  "text-halo-color": "#ffffff",
                  "text-halo-width": 1.5,
                }}
              />
            </Source>
          )}

          {/* ─── Layer Cluster globali (Network Engine) ─── */}
          {showGlobalClusters && clustersGeoJSON && (
            <Source id="ne-clusters-src" type="geojson" data={clustersGeoJSON}>
              <Layer
                id="ne-clusters-fill"
                type="fill"
                filter={["==", ["geometry-type"], "Polygon"]}
                paint={{
                  "fill-color": ["get", "color"],
                  "fill-opacity": 0.15,
                }}
              />
              <Layer
                id="ne-clusters-outline"
                type="line"
                filter={["==", ["geometry-type"], "Polygon"]}
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": 2,
                  "line-opacity": 0.85,
                }}
              />
              <Layer
                id="ne-clusters-stops"
                type="circle"
                filter={["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "isLabel"], true]]}
                paint={{
                  "circle-radius": 4,
                  "circle-color": ["get", "color"],
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 1.5,
                  "circle-opacity": 0.9,
                }}
              />
              <Layer
                id="ne-clusters-labels"
                type="symbol"
                filter={["==", ["get", "isLabel"], true]}
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 13,
                  "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                  "text-anchor": "center",
                  "text-allow-overlap": false,
                  "text-ignore-placement": false,
                  "symbol-placement": "point",
                }}
                paint={{
                  "text-color": ["get", "color"],
                  "text-halo-color": "#ffffff",
                  "text-halo-width": 2,
                  "text-halo-blur": 0.5,
                }}
              />
            </Source>
          )}

          {/* ─── Layer Depositi (Network Engine) ─── */}
          {showDepots && depots.filter(d => d.lat != null && d.lon != null).map(d => (
            <Marker key={`depot-${d.id}`} longitude={Number(d.lon)} latitude={Number(d.lat)} anchor="bottom"
              onClick={(e) => { e.originalEvent.stopPropagation(); setDepotInfo(d); }}
            >
              <div
                title={`Deposito · ${d.name}${d.capacity ? ` · ${d.capacity} mezzi` : ""} — clic per i dettagli`}
                className="flex flex-col items-center pointer-events-auto cursor-pointer hover:scale-110 transition-transform"
              >
                <div
                  className="w-7 h-7 rounded-md border-2 border-white shadow-lg flex items-center justify-center"
                  style={{ backgroundColor: d.color || "#f97316" }}
                >
                  <Building2 className="w-4 h-4 text-white" />
                </div>
                <div
                  className="w-2 h-2 rotate-45 -mt-1 border-r-2 border-b-2 border-white"
                  style={{ backgroundColor: d.color || "#f97316" }}
                />
                <div
                  className="mt-0.5 px-1.5 py-0.5 rounded bg-white/95 text-[11px] font-semibold whitespace-nowrap shadow"
                  style={{ color: d.color || "#f97316" }}
                >
                  {d.name}
                </div>
              </div>
            </Marker>
          ))}

          {/* Dettaglio deposito in SOLA LETTURA (clic sul marker) */}
          {showDepots && depotInfo && depotInfo.lat != null && depotInfo.lon != null && (
            <Popup longitude={Number(depotInfo.lon)} latitude={Number(depotInfo.lat)} anchor="bottom" offset={34}
              closeOnClick={false} onClose={() => setDepotInfo(null)} maxWidth="260px">
              <div className="p-1 space-y-1.5 text-slate-800">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: depotInfo.color || "#f97316" }}>
                    <Building2 className="w-3.5 h-3.5 text-white" />
                  </span>
                  <span className="text-sm font-bold">{depotInfo.name}</span>
                </div>
                <div className="text-[11px] space-y-0.5">
                  {depotInfo.address && <div><span className="text-slate-500">Indirizzo:</span> {depotInfo.address}</div>}
                  <div><span className="text-slate-500">Coordinate:</span> {Number(depotInfo.lat).toFixed(5)}, {Number(depotInfo.lon).toFixed(5)}</div>
                  <div><span className="text-slate-500">Capacità:</span> {depotInfo.capacity != null ? `${depotInfo.capacity} mezzi` : "—"}</div>
                  {(depotInfo.operatingHoursStart || depotInfo.operatingHoursEnd) && (
                    <div><span className="text-slate-500">Orari:</span> {depotInfo.operatingHoursStart || "—"}–{depotInfo.operatingHoursEnd || "—"}</div>
                  )}
                  <div><span className="text-slate-500">Alimentazioni:</span> {[
                    depotInfo.hasDiesel && "Gasolio", depotInfo.hasMethane && "Metano", depotInfo.hasElectric && "Elettrico",
                  ].filter(Boolean).join(", ") || "—"}</div>
                  {depotInfo.chargingPoints != null && depotInfo.chargingPoints > 0 && <div><span className="text-slate-500">Punti ricarica:</span> {depotInfo.chargingPoints}</div>}
                  {depotInfo.cngPoints != null && depotInfo.cngPoints > 0 && <div><span className="text-slate-500">Punti metano:</span> {depotInfo.cngPoints}</div>}
                  {depotInfo.notes && <div className="text-slate-600 italic pt-0.5">{depotInfo.notes}</div>}
                </div>
                <div className="text-[9px] text-slate-400 pt-0.5">Sola lettura · gestione in Infrastruttura</div>
              </div>
            </Popup>
          )}

          {/* Tutte le fermate del progetto — render via GeoJSON Layer (GPU,
              molto più veloce di N <Marker> React quando N è migliaia).
              Filtrate da `visibleStops` in base allo stopsFilter scelto
              dall'utente nel pannello Fermate. Click gestito in handleMapClick
              tramite interactiveLayerIds. */}
          {visibleStopsGeoJSON.features.length > 0 && (
            <Source id="ps-stops-src" type="geojson" data={visibleStopsGeoJSON}>
              {/* layer "hit" trasparente ma più grande per click facile */}
              <Layer
                id="ps-stops-circle-hit"
                type="circle"
                paint={{
                  "circle-radius": 10,
                  "circle-color": "#000000",
                  "circle-opacity": 0,
                }}
              />
              <Layer
                id="ps-stops-circle"
                type="circle"
                paint={{
                  "circle-radius": [
                    "case",
                    ["==", ["get", "id"], selectedStopId ?? ""], 7,
                    ["==", ["get", "inSeq"], true], 7,
                    5,
                  ],
                  "circle-color": ["get", "color"],
                  "circle-stroke-color": [
                    "case",
                    ["==", ["get", "id"], selectedStopId ?? ""], "#22d3ee",
                    "#1e293b",
                  ],
                  "circle-stroke-width": 1.5,
                }}
              />
            </Source>
          )}
          {/* Marker dedicato per la fermata selezionata: mostra anche il
              nome in tooltip e mantiene il click "selettivo" */}
          {selectedStopId && (() => {
            const s = stops.find(x => x.id === selectedStopId);
            if (!s) return null;
            return (
              <Marker key={`sel-${s.id}`} longitude={s.lon} latitude={s.lat} anchor="bottom">
                <div className="flex flex-col items-center pointer-events-none">
                  <div className="px-1.5 py-0.5 rounded bg-cyan-500 text-white text-[10px] font-medium shadow whitespace-nowrap">
                    {s.name}
                  </div>
                  <div className="w-2 h-2 rotate-45 -mt-1 bg-cyan-500" />
                </div>
              </Marker>
            );
          })()}

          {/* Shape della variante in editing */}
          {editor?.geometry && (
            <Source id="editor-shape" type="geojson" data={{
              type: "Feature", properties: {}, geometry: editor.geometry,
            }}>
              <Layer
                id="editor-shape-line"
                type="line"
                paint={{
                  "line-color": editor.routeColor,
                  "line-width": 5,
                  "line-opacity": 0.85,
                }}
                layout={{ "line-join": "round", "line-cap": "round" }}
              />
            </Source>
          )}

          {/* Via-point in trascinamento (drag della linea, stile Google Maps) */}
          {dragViaPos && (
            <Marker longitude={dragViaPos[0]} latitude={dragViaPos[1]} anchor="center">
              <div className="w-4 h-4 rounded-full bg-white border-[3px] border-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,0.3)]" />
            </Marker>
          )}

          {/* Waypoint draggable */}
          {editor?.waypoints.map((w, idx) => (
            <Marker key={`w-${idx}`} longitude={w.lng} latitude={w.lat}
              draggable
              onDragEnd={(e) => moveWaypoint(idx, [e.lngLat.lng, e.lngLat.lat])}
              anchor="center"
            >
              <div
                onClick={(e) => { e.stopPropagation(); toggleWaypointMode(idx); }}
                onContextMenu={(e) => { e.preventDefault(); removeWaypoint(idx); }}
                title={`Waypoint ${idx + 1} · ${w.mode === "manual" ? "MANUALE (tratti adiacenti forzati in linea retta)" : "snap su strada"}\nClick: alterna snap/manuale (forza corsie riservate) · Click destro: rimuovi`}
              >
                <div className={`w-4 h-4 rounded-full border-2 border-white shadow-lg ${
                  w.stopId ? "bg-emerald-500" : w.mode === "manual" ? "bg-amber-400" : "bg-indigo-500"
                } cursor-grab active:cursor-grabbing`} />
              </div>
            </Marker>
          ))}

          {/* ─── Vista percorso: tracciato + fermate della variante selezionata ─── */}
          {routeView && !editor && (
            <>
              {/* Altre fermate del progetto (dimmed) durante l'edit, per
                  agganciare visivamente il tracciato alle fermate vicine */}
              {routeViewOtherStopsGeoJSON && routeViewOtherStopsGeoJSON.features.length > 0 && (
                <Source id="route-view-other-stops-src" type="geojson" data={routeViewOtherStopsGeoJSON}>
                  <Layer
                    id="route-view-other-stops-circle"
                    type="circle"
                    paint={{
                      "circle-radius": 4,
                      "circle-color": "#94a3b8",
                      "circle-opacity": 0.35,
                      "circle-stroke-color": "#1e293b",
                      "circle-stroke-width": 1,
                      "circle-stroke-opacity": 0.35,
                    }}
                  />
                </Source>
              )}

              {/* Tracciato: in edit usa la copia di lavoro, altrimenti lo shape salvato */}
              {(() => {
                const coords = shapeEdit
                  ? shapeEdit.coordinates
                  : routeView.shape?.geometry?.coordinates;
                if (!coords || coords.length < 2) return null;
                return (
                  <Source
                    id="route-view-shape-src"
                    type="geojson"
                    data={{
                      type: "Feature", properties: {},
                      geometry: { type: "LineString", coordinates: coords },
                    } as any}
                  >
                    <Layer
                      id="route-view-shape-line"
                      type="line"
                      paint={{
                        "line-color": routeView.routeColor,
                        "line-width": shapeEdit ? 4 : 5,
                        "line-opacity": 0.9,
                        ...(shapeEdit ? { "line-dasharray": [2, 1.2] } : {}),
                      }}
                      layout={{ "line-join": "round", "line-cap": "round" }}
                    />
                  </Source>
                );
              })()}

              {/* Fermate del percorso evidenziate con il colore della linea + seq */}
              {routeViewStopsGeoJSON && routeViewStopsGeoJSON.features.length > 0 && (
                <Source id="route-view-stops-src" type="geojson" data={routeViewStopsGeoJSON}>
                  <Layer
                    id="route-view-stops-circle"
                    type="circle"
                    paint={{
                      "circle-radius": 6,
                      "circle-color": routeView.routeColor,
                      "circle-stroke-color": "#ffffff",
                      "circle-stroke-width": 2,
                    }}
                  />
                  <Layer
                    id="route-view-stops-seq"
                    type="symbol"
                    layout={{
                      "text-field": ["to-string", ["get", "seq"]],
                      "text-size": 10,
                      "text-offset": [0, -1.3],
                      "text-anchor": "bottom",
                      "text-allow-overlap": true,
                    }}
                    paint={{
                      "text-color": routeView.routeColor,
                      "text-halo-color": "#ffffff",
                      "text-halo-width": 1.5,
                    }}
                  />
                </Source>
              )}

              {/* Vertici draggabili del tracciato in modalità edit (campionati) */}
              {shapeEdit && shapeEdit.vertexIdx.map((ci, vi) => (
                <Marker
                  key={`shape-v-${vi}`}
                  longitude={shapeEdit.coordinates[ci][0]}
                  latitude={shapeEdit.coordinates[ci][1]}
                  draggable
                  anchor="center"
                  onDragEnd={(e) => moveShapeVertex(vi, [e.lngLat.lng, e.lngLat.lat])}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    title={`Vertice ${vi + 1}/${shapeEdit.vertexIdx.length} · trascina per modificare il tracciato`}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-lg cursor-grab active:cursor-grabbing"
                      style={{ backgroundColor: routeView.routeColor }}
                    />
                  </div>
                </Marker>
              ))}
            </>
          )}

          {/* Pending stop in modalità addStop */}
          {pendingStop && (
            <Popup longitude={pendingStop.lon} latitude={pendingStop.lat} closeOnClick={false} closeButton={false} anchor="bottom" offset={12}>
              <NewStopForm
                lat={pendingStop.lat} lon={pendingStop.lon}
                onCancel={() => setPendingStop(null)}
                onSave={(d) => handleSaveStop(d)}
              />
            </Popup>
          )}

          {/* Editing stop popup */}
          {editingStop && (
            <>
              {/* Segnalino TRASCINABILE: sposta la fermata col cursore; lat/lon
                  del form si aggiornano e "Salva" persiste la nuova posizione. */}
              <Marker
                longitude={editingStop.lon} latitude={editingStop.lat} anchor="center" draggable
                onDragEnd={(e) => setEditingStop(prev => prev ? { ...prev, lat: e.lngLat.lat, lon: e.lngLat.lng } : prev)}
              >
                <div
                  className="w-5 h-5 rounded-full bg-orange-500 border-2 border-white shadow-[0_0_0_4px_rgba(249,115,22,0.35)] cursor-grab active:cursor-grabbing"
                  title="Trascina per spostare la fermata"
                />
              </Marker>
              <Popup longitude={editingStop.lon} latitude={editingStop.lat} closeOnClick={false}
                closeButton={false} anchor="bottom" offset={18}>
                <div>
                  <p className="text-[10px] text-orange-600 font-medium mb-1 px-1">↔ Trascina il segnalino arancione per spostare la fermata</p>
                  <NewStopForm
                    lat={editingStop.lat} lon={editingStop.lon}
                    initialName={editingStop.name} initialCode={editingStop.code || ""}
                    onCancel={() => setEditingStop(null)}
                    onSave={(d) => handleSaveStop(d, editingStop.id)}
                  />
                </div>
              </Popup>
            </>
          )}
          </>
          )}
        </Map>

        {/* ─── Modale modifica/creazione deposito ─── */}
        {editingDepot && (
          <DepotEditModal
            depot={editingDepot}
            projectId={projectId}
            hidden={depotModalHidden}
            onChange={(d) => setEditingDepot(d)}
            onPickLocation={() => { setDepotModalHidden(true); setPickingDepotLocation(true); }}
            onClose={() => { setEditingDepot(null); setDepotModalHidden(false); setPickingDepotLocation(false); }}
            onSaved={async () => { setEditingDepot(null); setDepotModalHidden(false); setPickingDepotLocation(false); await reloadDepots(); }}
          />
        )}

        {/* ─── Banner overlay durante il pick della posizione del deposito ─── */}
        {pickingDepotLocation && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 rounded-full bg-orange-500/95 text-white shadow-xl backdrop-blur border border-orange-300/40">
            <MapPin className="w-4 h-4" />
            <span className="text-sm font-medium">Clicca sulla mappa per posizionare il deposito</span>
            <button
              onClick={() => { setPickingDepotLocation(false); setDepotModalHidden(false); }}
              className="ml-2 px-2 py-0.5 text-xs rounded-full bg-white/20 hover:bg-white/30"
            >
              Annulla
            </button>
          </div>
        )}

        {/* ─── Dialog condivisione progetto ─── */}
        {shareOpen && (
          <SharePsProjectDialog
            projectId={project.id}
            open
            canManage={project.myRole === "owner"}
            onClose={() => setShareOpen(false)}
          />
        )}

        {/* ─── Import KML/KMZ: input nascosto + ANTEPRIMA abbinamento fermate ─── */}
        <input
          ref={kmlInputRef}
          type="file"
          accept=".kml,.kmz,.zip,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) void handleKmlFile(f);
            e.target.value = ""; // consenti di ricaricare lo stesso file
          }}
        />
        {kmlPreview && kmlSel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setKmlPreview(null)}>
            <div className="w-full max-w-3xl mx-4 rounded-xl border border-cyan-500/30 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <FileArchive className="w-4 h-4 text-cyan-400" /> Anteprima import · {kmlPreview.fileName}
                </h3>
                <button onClick={() => setKmlPreview(null)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3 text-xs">
                {/* Scelta del percorso (l'export può contenerne più di uno) + soglia */}
                {kmlPreview.tracks.length > 0 && (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex-1 min-w-[240px]">
                      <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Percorso nel file ({kmlPreview.tracks.length})</label>
                      <select value={kmlTrackIdx} onChange={e => setKmlTrackIdx(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700">
                        {kmlPreview.tracks.map((t, i) => (
                          <option key={i} value={i}>{t.label} — {(t.lengthM / 1000).toFixed(2)} km</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1" title="Una fermata del file è considerata SUL percorso se dista dal tracciato meno di questa soglia">Fermate entro (m)</label>
                      <input type="number" min={5} max={200} value={kmlMaxDist} onChange={e => setKmlMaxDist(e.target.value)}
                        className="w-20 px-2 py-1.5 rounded bg-slate-900 border border-slate-700" />
                    </div>
                  </div>
                )}
                {(() => {
                  const ok = kmlSel.rows.filter(r => r.match).length;
                  const ko = kmlSel.rows.length - ok;
                  const far = kmlSel.rows.filter(r => r.match && (r.distM ?? 0) > 100).length;
                  return (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
                        ✓ {ok}/{kmlSel.rows.length} fermate abbinate
                      </span>
                      {ko > 0 && (
                        <span className="px-2 py-1 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300">
                          ✕ {ko} non trovate (verranno saltate)
                        </span>
                      )}
                      {far > 0 && (
                        <span className="px-2 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">
                          ⚠ {far} a più di 100 m dalla fermata a sistema
                        </span>
                      )}
                      {kmlSel.track ? (
                        <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">
                          tracciato: {(kmlSel.track.lengthM / 1000).toFixed(2)} km
                          {kmlSel.excluded > 0 && <span className="text-slate-500"> · {kmlSel.excluded} fermate del file lontane dal percorso (escluse)</span>}
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">nessun tracciato nel file (spezzata fermata→fermata)</span>
                      )}
                    </div>
                  );
                })()}
                <div className="max-h-[42vh] overflow-auto rounded border border-slate-800">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                      <tr>
                        <th className="text-left px-2 py-1.5 w-8">#</th>
                        {kmlSel.track && <th className="text-right px-2 py-1.5 w-16">Prog.</th>}
                        <th className="text-left px-2 py-1.5">Codice nel file</th>
                        <th className="text-left px-2 py-1.5">Fermata a sistema</th>
                        <th className="text-left px-2 py-1.5 w-20">Abbinata per</th>
                        <th className="text-right px-2 py-1.5 w-16">Dist.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kmlSel.rows.map((r, i) => (
                        <tr key={i} className={`border-t border-slate-800/60 ${!r.match ? "bg-rose-500/10" : (r.distM ?? 0) > 100 ? "bg-amber-500/10" : ""}`}>
                          <td className="px-2 py-1 text-slate-500">{i + 1}</td>
                          {kmlSel.track && <td className="px-2 py-1 text-right font-mono text-slate-400">{r.alongM != null ? `${(r.alongM / 1000).toFixed(2)}` : "—"}</td>}
                          <td className="px-2 py-1 font-mono text-slate-200">{r.code}</td>
                          <td className="px-2 py-1">
                            {r.match
                              ? <span className="text-slate-200">{r.match.name} {r.match.code && <span className="text-slate-500 font-mono">({r.match.code})</span>}</span>
                              : <span className="text-rose-300">— non trovata —</span>}
                          </td>
                          <td className="px-2 py-1">
                            {r.matchBy === "codice" && <span className="text-emerald-300">codice</span>}
                            {r.matchBy === "nome" && <span className="text-cyan-300">nome</span>}
                            {r.matchBy === "vicinanza" && <span className="text-amber-300">vicinanza</span>}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-slate-400">{r.distM != null ? `${r.distM} m` : "—"}</td>
                        </tr>
                      ))}
                      {kmlSel.rows.length === 0 && (
                        <tr><td colSpan={kmlSel.track ? 6 : 5} className="px-2 py-3 text-slate-500">
                          {kmlPreview.points.length > 0
                            ? "Nessuna fermata del file entro la soglia dal percorso scelto: alza la soglia o verifica il verso."
                            : "Nessuna fermata nel file: verrà caricato solo il tracciato (aggiungi poi le fermate dall'editor)."}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-slate-500">
                  {kmlSel.track && "Le fermate sono ordinate per progressiva (km) lungo il percorso scelto. "}
                  Alla conferma la sequenza fermate e il tracciato vengono caricati <strong>nell'editor</strong> (nulla è ancora salvato):
                  puoi spostare fermate, trascinare la linea e correggere prima di premere <strong>Salva</strong>.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
                <button onClick={() => setKmlPreview(null)}
                  className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
                <button onClick={applyKmlImport}
                  disabled={kmlSel.rows.filter(r => r.match).length < 2 && !(kmlSel.track && kmlSel.track.coords.length >= 2)}
                  className="text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" /> Carica nel percorso ({kmlSel.rows.filter(r => r.match).length} fermate)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Pannello dati floating (sx) ─── */}
        <AnimatePresence>
          {activePanel && !editor && (
            <motion.div
              initial={{ x: -360, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -360, opacity: 0 }}
              transition={{ type: "spring", damping: 26, stiffness: 260 }}
              className="absolute top-3 left-3 bottom-3 w-[340px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-slate-800 shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  {activePanel === "stops" && <><MapPin className="w-4 h-4 text-emerald-400" /> Fermate</>}
                  {activePanel === "routes" && <><Bus className="w-4 h-4 text-cyan-400" /> Linee</>}
                  {(activePanel === "clusters" || activePanel === "ne-clusters") && (
                    <><Layers className="w-4 h-4 text-cyan-400" /> Nodi
                      <span className="text-[10px] font-normal text-slate-500">
                        ({clusters.length + globalClusters.length} totali)
                      </span></>
                  )}
                  {activePanel === "ne-depots" && <><Building2 className="w-4 h-4 text-orange-400" /> Depositi aziendali <span className="text-[9px] font-normal text-slate-500">(condivisi tra tutti i progetti)</span></>}
                </h2>
                <button onClick={() => setActivePanel(null)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
              {/* Pannello Nodi unificato: tab Progetto / Globali legacy + mini-legenda.
                  La tab attiva coincide con activePanel, così layer mappa e logica
                  esistente (clusters / ne-clusters) restano invariati. */}
              {(activePanel === "clusters" || activePanel === "ne-clusters") && (
                <div className="px-3 py-2 border-b border-slate-800 shrink-0 space-y-1.5">
                  <div className="flex gap-1 bg-slate-900 rounded p-0.5 border border-slate-800">
                    <button
                      onClick={() => switchNodesTab("clusters")}
                      className={`flex-1 text-[11px] py-1 rounded font-medium transition ${
                        activePanel === "clusters" ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Progetto ({clusters.length})
                    </button>
                    <button
                      onClick={() => switchNodesTab("ne-clusters")}
                      className={`flex-1 text-[11px] py-1 rounded font-medium transition ${
                        activePanel === "ne-clusters" ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Globali legacy ({globalClusters.length})
                    </button>
                  </div>
                  {/* Mini-legenda simbologia mappa: le fermate di un nodo ne ereditano
                      il colore; la forma indica il tipo di nodo */}
                  <p className="text-[10px] text-slate-500 leading-snug">
                    <span className="text-slate-300">●</span> logico · <span className="text-slate-300">▲</span> logico e di cambio — le fermate ereditano il colore del nodo
                  </p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto">
                {activePanel === "stops" && (
                  <StopsPanel
                    stops={stops}
                    routes={routes}
                    selectedId={selectedStopId}
                    onSelect={(s) => {
                      setSelectedStopId(s.id);
                      mapRef.current?.flyTo({ center: [s.lon, s.lat], zoom: 16, duration: 600 });
                    }}
                    onEdit={(s) => setEditingStop(s)}
                    onDelete={askDeleteStop}
                    onAddNew={() => setTool("addStop")}
                    visibility={stopsFilter}
                    onChangeVisibility={setStopsFilter}
                    routeFilterIds={routeFilterIds}
                    onToggleRouteFilter={(rid) => {
                      setRouteFilterIds(prev => {
                        const next = new Set(prev);
                        if (next.has(rid)) next.delete(rid); else next.add(rid);
                        return next;
                      });
                    }}
                    onToggleAllRoutesFilter={(on) => {
                      setRouteFilterIds(on ? new Set(routes.map(r => r.id)) : new Set());
                    }}
                  />
                )}
                {activePanel === "routes" && (
                  <RoutesPanel
                    routes={routes}
                    variantsByRoute={routeVariants}
                    openRouteId={openRouteId}
                    onToggleRoute={async (id) => {
                      const next = openRouteId === id ? null : id;
                      setOpenRouteId(next);
                      if (next) await loadVariants(next);
                    }}
                    onCreateRoute={handleCreateRoute}
                    onUpdateRoute={handleUpdateRoute}
                    onDeleteRoute={(id) => {
                      const r = routes.find(x => x.id === id);
                      setConfirmReq({
                        title: `Eliminare la linea${r ? ` ${r.shortName}` : ""} e tutte le sue varianti?`,
                        message: r?.variantCount
                          ? <>La linea ha <b>{r.variantCount}</b> percorsi: verranno eliminati con lei.</>
                          : "Verranno eliminati anche i percorsi della linea.",
                        confirmLabel: "Elimina linea",
                        onConfirm: async () => {
                          try { await deletePsRoute(projectId, id); setRoutes(rs => rs.filter(x => x.id !== id)); toast.success("Linea eliminata"); }
                          catch (e: any) { toast.error("Errore", { description: e?.message }); throw e; }
                        },
                      });
                    }}
                    onCreateVariant={handleCreateVariant}
                    onSelectVariant={(routeId, variantId) => openRouteView(routeId, variantId)}
                    onEditVariant={(routeId, variantId) => startEditingVariant(routeId, variantId)}
                    onUpdateVariantMeta={handleUpdateVariantMeta}
                    shownRouteIds={new Set(Object.keys(multiShown))}
                    loadingShowRouteId={multiLoading}
                    onToggleShowRoute={toggleShowRoute}
                    onDeleteVariant={(id) => setConfirmReq({
                      title: "Eliminare il percorso (variante)?",
                      message: "La linea resta comunque, anche con 0 percorsi.",
                      confirmLabel: "Elimina percorso",
                      onConfirm: async () => {
                        try {
                          await deletePsVariant(projectId, id);
                          afterVariantDeleted(id);
                        } catch (e: any) {
                          // 409 = il percorso ha corse collegate: SECONDO dialog
                          // esplicito per eliminarle insieme (force).
                          if (e?.status !== 409) { toast.error("Errore", { description: e?.message }); throw e; }
                          const n = e?.body?.tripCount;
                          setTimeout(() => setConfirmReq({
                            title: `Il percorso ha ${n ?? "delle"} corse collegate`,
                            message: "Eliminare ANCHE le corse insieme al percorso? Le corse eliminate spariscono da orari, stampe e matrice di validità.",
                            confirmLabel: "Elimina percorso e corse",
                            onConfirm: async () => {
                              try { await deletePsVariant(projectId, id, { force: true }); afterVariantDeleted(id); }
                              catch (err: any) { toast.error("Errore", { description: err?.message }); throw err; }
                            },
                          }), 0);
                        }
                      },
                    })}
                  />
                )}
                {activePanel === "clusters" && (
                  <ClustersPanel
                    projectId={projectId}
                    stops={stops}
                    clusters={clusters}
                    onChanged={async () => {
                      try { setClusters(await listPsClusters(projectId)); }
                      catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 15, duration: 600 })}
                    clusterDraw={clusterDraw}
                    setClusterDraw={setClusterDraw}
                  />
                )}
                {activePanel === "ne-clusters" && (
                  <NeClustersPanel
                    clusters={globalClusters}
                    loading={overlayLoading.clusters}
                    onReload={reloadGlobalClusters}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 14, duration: 600 })}
                    projectId={projectId}
                  />
                )}
                {activePanel === "ne-depots" && (
                  <NeDepotsPanel
                    depots={depots}
                    loading={overlayLoading.depots}
                    onReload={reloadDepots}
                    onManage={() => navigate(`/planning-studio/${projectId}/depots`)}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 14, duration: 600 })}
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Pannello editor variante (sx) ─── */}
        <AnimatePresence>
          {editor && (
            <motion.div
              initial={{ x: -380, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -380, opacity: 0 }}
              transition={{ type: "spring", damping: 26, stiffness: 260 }}
              className="absolute top-3 left-3 bottom-3 w-[360px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-emerald-500/40 shadow-2xl shadow-emerald-900/20 flex flex-col overflow-hidden"
            >
              <VariantEditorPanel
                editor={editor}
                stopsAll={stops}
                snapBusy={snapBusy}
                saving={saving}
                onAddStop={addStopToSequence}
                onMoveStop={moveStopInSequence}
                onRemoveStop={removeStopFromSequence}
                onRemoveStops={removeStopsFromSequence}
                onReverse={reverseSequence}
                onClear={clearSequence}
                insertAfterIdx={insertAfterIdx}
                onSetInsertAfter={setInsertAfterIdx}
                onFlyToStop={(s) => mapRef.current?.flyTo({ center: [s.lon, s.lat], zoom: 16, duration: 600 })}
                onToggleCurb={toggleCurb}
                onUndo={undoEditor}
                canUndo={editorHistory.length > 0}
                savedAt={variantSavedAt}
                onChangeMode={changeShapeMode}
                onSave={saveVariant}
                onExit={exitEditor}
                onImportKml={() => kmlInputRef.current?.click()}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Pannello vista percorso (dx): fermate variante + edit tracciato ─── */}
        <AnimatePresence>
          {routeView && !editor && (
            <motion.div
              initial={{ x: 360, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 360, opacity: 0 }}
              transition={{ type: "spring", damping: 26, stiffness: 260 }}
              className="absolute top-3 right-3 bottom-3 w-[330px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-slate-800 shadow-2xl flex flex-col overflow-hidden"
              style={{ borderColor: `${routeView.routeColor}66` }}
            >
              <RouteViewPanel
                view={routeView}
                shapeEdit={shapeEdit}
                snapBusy={shapeEditBusy}
                saving={shapeEditSaving}
                showOtherStops={showOtherStops}
                onToggleOtherStops={() => setShowOtherStops(v => !v)}
                onFlyToStop={(s) => mapRef.current?.flyTo({ center: [Number(s.lon), Number(s.lat)], zoom: 16, duration: 600 })}
                onStartEdit={startShapeEdit}
                onSnapOsrm={snapShapeToStops}
                onSave={saveShapeEdit}
                onCancel={cancelShapeEdit}
                onClose={closeRouteView}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Inspector floating (dx) per fermata selezionata ─── */}
        <AnimatePresence>
          {selectedStopId && !editingStop && !editor && !routeView && (() => {
            const s = stops.find(x => x.id === selectedStopId);
            if (!s) return null;
            // Trova varianti che includono questa fermata
            const linkedVariants: { route: PsRoute; variant: PsVariant }[] = [];
            for (const r of routes) {
              const vs = routeVariants[r.id] || [];
              for (const v of vs) {
                // Se non abbiamo ancora caricato i dati dettagliati, skip (il pannello Linee li caricherà)
                // Qui controlliamo solo via name match — best effort
                if ((v as any)._stops?.some?.((x: any) => x.stopId === s.id)) {
                  linkedVariants.push({ route: r, variant: v });
                }
              }
            }
            return (
              <motion.div
                initial={{ x: 360, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 360, opacity: 0 }}
                transition={{ type: "spring", damping: 26, stiffness: 260 }}
                className="absolute top-3 right-3 w-[320px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-cyan-500/40 shadow-2xl"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                  <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-cyan-300 font-semibold">
                    <MapPin className="w-3.5 h-3.5" /> Fermata
                  </span>
                  <button onClick={() => setSelectedStopId(null)}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <h3 className="text-base font-semibold">{s.name}</h3>
                    {s.code && <p className="text-xs text-slate-500">Codice {s.code}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
                      <p className="text-[10px] text-slate-500 uppercase">Lat</p>
                      <p className="font-mono text-slate-200">{s.lat.toFixed(5)}</p>
                    </div>
                    <div className="px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
                      <p className="text-[10px] text-slate-500 uppercase">Lon</p>
                      <p className="font-mono text-slate-200">{s.lon.toFixed(5)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setEditingStop(s)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 text-xs font-medium">
                      <Pencil className="w-3.5 h-3.5" /> Modifica
                    </button>
                    <button onClick={() => askDeleteStop(s.id)}
                      className="px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* Tool hint floating (in basso al centro per non coprire mappa) */}
        {(tool !== "select" || editor) && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-slate-900/95 backdrop-blur border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 shadow-lg max-w-md">
            {tool === "addStop" && (
              <span className="flex items-center gap-1.5 text-cyan-300"><Crosshair className="w-3.5 h-3.5" /> Clic sulla mappa per posizionare una nuova fermata</span>
            )}
            {tool === "editVariant" && editor && (
              <div className="space-y-0.5">
                <p className="flex items-center gap-1.5 text-emerald-300 font-medium">
                  <PenLine className="w-3.5 h-3.5" /> Editor variante
                  {snapBusy && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
                </p>
                <p className="text-[10px] text-slate-400">
                  Clic su fermata = aggiungi · <b>Trascina la linea</b> = devia il percorso ·
                  Clic su un pallino = forza manuale · <b>Ctrl+Z</b> = annulla
                </p>
              </div>
            )}
          </div>
        )}

        {/* ─── Empty state / onboarding GTFS ─── */}
        {isEmpty && !importOpen && !manualMode && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              className="max-w-md mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-8 text-center"
            >
              <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
                <Database className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-lg font-semibold mb-1">Database vuoto</h2>
              <p className="text-sm text-slate-400 mb-6">
                Importa un GTFS completo, oppure carica solo le fermate (stops.txt) e costruisci il resto a mano.
              </p>
              {(project.myRole === "owner" || project.myRole === "editor") ? (
                <div className="space-y-2">
                  <button onClick={() => setImportOpen(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium">
                    <Upload className="w-4 h-4" /> Importa GTFS (.zip)
                  </button>
                  <button onClick={() => stopsTxtRef.current?.click()} disabled={importingStops}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 text-sm font-medium disabled:opacity-50">
                    <Upload className="w-4 h-4" /> {importingStops ? "Importazione fermate…" : "Importa fermate (stops.txt)"}
                  </button>
                  <button onClick={() => { setManualMode(true); setActivePanel("stops"); }}
                    className="w-full px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200">
                    Oppure inizia completamente da zero (a mano)
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Solo owner/editor possono importare dati.</p>
              )}
            </motion.div>
          </div>
        )}

        {/* Input nascosto per l'import fermate da stops.txt (GTFS) */}
        <input
          ref={stopsTxtRef}
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importStopsTxt(f); }}
        />
      </div>

      {/* ─── Dialog Import GTFS ─── */}
      <AnimatePresence>
        {importOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={closeImport}>
            <motion.div
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
            >
              <div className="px-6 py-4 border-b border-slate-800">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-emerald-400" /> Importa GTFS
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Progetto: <span className="text-slate-300">{project.name}</span></p>
              </div>
              <div className="px-6 py-5 space-y-4">
                {!importResult && !previewRoutes && !importMergePreview && (
                  <>
                    {!isEmpty && (
                      <div className="space-y-2">
                        <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                          importMode === "merge" ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 hover:border-slate-700"
                        }`}>
                          <input type="radio" checked={importMode === "merge"} onChange={() => setImportMode("merge")} className="mt-0.5 accent-emerald-500" />
                          <span>
                            <span className="block text-sm font-medium text-slate-100">Aggiorna (consigliato)</span>
                            <span className="block text-xs text-slate-500">
                              Riconosce fermate, linee, percorsi e corse per ID GTFS e le aggiorna CONSERVANDO
                              il lavoro fatto: matrice di validità, categorie, nodi, UDP e tracciati disegnati.
                              Le corse sparite dal feed vengono disattivate (mai cancellate); le corse create a mano restano.
                            </span>
                          </span>
                        </label>
                        <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                          importMode === "replace" ? "border-amber-500/50 bg-amber-500/10" : "border-slate-800 hover:border-slate-700"
                        }`}>
                          <input type="radio" checked={importMode === "replace"} onChange={() => setImportMode("replace")} className="mt-0.5 accent-amber-500" />
                          <span>
                            <span className="block text-sm font-medium text-slate-100">Sostituisci tutto</span>
                            <span className="block text-xs text-amber-300/90">
                              Cancella TUTTI i dati attuali e riparte dal file: si perdono matrice di validità,
                              assegnazioni ai nodi e collegamenti delle UDP (gli ID vengono rigenerati).
                            </span>
                          </span>
                        </label>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">File GTFS (.zip)</label>
                      <label className="block cursor-pointer">
                        <input type="file" accept=".zip,application/zip"
                          onChange={(e) => { setImportFile(e.target.files?.[0] || null); setPreviewRoutes(null); setSelectedRouteIds(new Set()); }}
                          disabled={importing} className="hidden" />
                        <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-dashed transition ${
                          importFile ? "border-emerald-500/50 bg-emerald-500/5" : "border-slate-700 bg-slate-800/40 hover:border-slate-600"
                        }`}>
                          <FileArchive className={`w-5 h-5 ${importFile ? "text-emerald-400" : "text-slate-500"}`} />
                          <div className="flex-1 min-w-0">
                            {importFile ? (
                              <>
                                <p className="text-sm text-slate-100 truncate">{importFile.name}</p>
                                <p className="text-[11px] text-slate-500">{(importFile.size / 1024 / 1024).toFixed(2)} MB</p>
                              </>
                            ) : (
                              <>
                                <p className="text-sm text-slate-400">Seleziona un file .zip</p>
                                <p className="text-[11px] text-slate-600">GTFS standard (stops, routes, trips, stop_times, …)</p>
                              </>
                            )}
                          </div>
                        </div>
                      </label>
                    </div>
                  </>
                )}
                {!importResult && previewRoutes && !importMergePreview && (() => {
                  const filtered = previewRoutes.filter(r => {
                    const q = routeSearch.trim().toLowerCase();
                    if (!q) return true;
                    return r.shortName.toLowerCase().includes(q) || (r.longName || "").toLowerCase().includes(q);
                  });
                  const allSel = filtered.length > 0 && filtered.every(r => selectedRouteIds.has(r.routeId));
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-400">
                          <strong className="text-slate-200">{selectedRouteIds.size}</strong> di {previewRoutes.length} linee selezionate — scegli quali importare.
                        </p>
                        <button
                          onClick={() => setSelectedRouteIds(prev => {
                            const n = new Set(prev);
                            if (allSel) filtered.forEach(r => n.delete(r.routeId));
                            else filtered.forEach(r => n.add(r.routeId));
                            return n;
                          })}
                          className="text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 shrink-0">
                          {allSel ? "Deseleziona" : "Seleziona"} {routeSearch ? "visibili" : "tutte"}
                        </button>
                      </div>
                      <input
                        value={routeSearch} onChange={e => setRouteSearch(e.target.value)}
                        placeholder="Cerca linea per codice o nome…"
                        className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm" />
                      <div className="max-h-[46vh] overflow-auto rounded-lg border border-slate-800 divide-y divide-slate-800/60">
                        {filtered.length === 0 && (
                          <div className="px-3 py-6 text-center text-xs text-slate-500">Nessuna linea corrisponde.</div>
                        )}
                        {filtered.map(r => {
                          const sel = selectedRouteIds.has(r.routeId);
                          return (
                            <label key={r.routeId}
                              className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition ${sel ? "bg-emerald-500/5" : "hover:bg-slate-800/40"}`}>
                              <input type="checkbox" checked={sel}
                                onChange={() => setSelectedRouteIds(prev => {
                                  const n = new Set(prev);
                                  if (n.has(r.routeId)) n.delete(r.routeId); else n.add(r.routeId);
                                  return n;
                                })}
                                className="accent-emerald-500 shrink-0" />
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color || "#64748b" }} />
                              <span className="font-semibold text-slate-100 shrink-0 min-w-[2.5rem]">{r.shortName}</span>
                              <span className="text-xs text-slate-400 truncate flex-1">{r.longName || ""}</span>
                              <span className="text-[11px] text-slate-500 tabular-nums shrink-0">{r.trips.toLocaleString("it-IT")} corse</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                {!importResult && importMergePreview && (() => {
                  const m = importMergePreview;
                  const Row = ({ label, children }: { label: string; children: any }) => (
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs">
                      <span className="text-slate-400">{label}</span>
                      <span className="tabular-nums text-slate-100">{children}</span>
                    </div>
                  );
                  return (
                    <div className="space-y-3">
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs">
                        <Check className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <strong className="block mb-0.5">Anteprima aggiornamento — nessuna modifica applicata</strong>
                          Conteggi esatti calcolati sul file: matrice di validità, nodi, UDP e tracciati disegnati
                          verranno CONSERVATI. Applica per rendere effettivo l'aggiornamento.
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-1.5">
                        <Row label="Fermate">
                          <b className="text-emerald-300">+{m.stops.added}</b> nuove · {m.stops.updated} aggiornate
                        </Row>
                        <Row label="Linee">
                          <b className="text-emerald-300">+{m.routes.added}</b> nuove · {m.routes.updated} aggiornate
                        </Row>
                        <Row label="Percorsi (varianti)">
                          <b className="text-emerald-300">+{m.variants.added}</b> nuovi · {m.variants.matched} riconosciuti (UUID conservato)
                        </Row>
                        <Row label="Calendari">
                          <b className="text-emerald-300">+{m.calendars.added}</b> nuovi · {m.calendars.updated} aggiornati
                        </Row>
                        <Row label="Corse">
                          <b className="text-emerald-300">+{m.trips.added}</b> nuove · {m.trips.updated} aggiornate ·{" "}
                          <b className={m.trips.deactivated > 0 ? "text-amber-300" : ""}>{m.trips.deactivated} disattivate</b> (sparite dal feed)
                        </Row>
                        <Row label="Transiti riscritti">{m.stopTimes.toLocaleString("it-IT")}</Row>
                        {m.trips.keptManual > 0 && (
                          <Row label="Corse manuali (intatte)">{m.trips.keptManual}</Row>
                        )}
                      </div>
                      {m.trips.deactivated > 0 && (
                        <p className="text-[11px] text-amber-300/90">
                          Le corse disattivate restano nel progetto (con la loro validità) e sono riattivabili da Corse.
                        </p>
                      )}
                    </div>
                  );
                })()}
                {importResult && (
                  <div className="space-y-3">
                    <div className="text-center py-2">
                      <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/15 flex items-center justify-center mb-2">
                        <Check className="w-5 h-5 text-emerald-400" />
                      </div>
                      <h3 className="text-base font-semibold text-emerald-300">Import completato</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {([
                        ["Fermate", importResult.stops, MapPin],
                        ["Linee", importResult.routes, Bus],
                        ["Varianti", importResult.variants, RouteIcon],
                        ["Percorsi", importResult.shapes, RouteIcon],
                        ["Calendari", importResult.calendars, CalendarIcon],
                        ["Eccezioni", importResult.calendarDates, CalendarIcon],
                        ["Corse", importResult.trips, Activity],
                        ["Stop times", importResult.stopTimes, Activity],
                      ] as [string, number, any][]).map(([label, val, Icon]) => (
                        <div key={label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                          <span className="flex items-center gap-1.5 text-slate-400">
                            <Icon className="w-3 h-3" /> {label}
                          </span>
                          <span className="font-semibold tabular-nums text-slate-100">{val.toLocaleString("it-IT")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
                {importResult ? (
                  <button onClick={closeImport}
                    className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium">
                    Inizia a lavorare
                  </button>
                ) : importMergePreview ? (
                  <>
                    <button onClick={() => setImportMergePreview(null)} disabled={importing}
                      className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50">
                      Indietro
                    </button>
                    <button onClick={handleImport} disabled={importing}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                      {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                      {importing ? "Applico…" : "Applica aggiornamento"}
                    </button>
                  </>
                ) : previewRoutes ? (
                  <>
                    <button onClick={() => { setPreviewRoutes(null); setSelectedRouteIds(new Set()); setRouteSearch(""); }} disabled={importing}
                      className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50">
                      Indietro
                    </button>
                    <button onClick={handleImport} disabled={importing || selectedRouteIds.size === 0}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                      {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                      {importing
                        ? (importMode === "merge" ? "Calcolo anteprima…" : "Importazione…")
                        : importMode === "merge"
                          ? `Anteprima aggiornamento (${selectedRouteIds.size} ${selectedRouteIds.size === 1 ? "linea" : "linee"})`
                          : `Importa ${selectedRouteIds.size} ${selectedRouteIds.size === 1 ? "linea" : "linee"}`}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={closeImport} disabled={importing || previewing}
                      className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50">
                      Annulla
                    </button>
                    <button onClick={handlePreview} disabled={!importFile || previewing}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                      {previewing && <Loader2 className="w-4 h-4 animate-spin" />}
                      {previewing ? "Lettura…" : "Leggi e scegli le linee"}
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Fermate
 * ════════════════════════════════════════════════════════════ */
function StopsPanel({
  stops, routes, selectedId, onSelect, onEdit, onDelete, onAddNew,
  visibility, onChangeVisibility,
  routeFilterIds, onToggleRouteFilter, onToggleAllRoutesFilter,
}: {
  stops: PsStop[]; routes: PsRoute[]; selectedId: string | null;
  onSelect: (s: PsStop) => void;
  onEdit: (s: PsStop) => void;
  onDelete: (id: string) => void;
  onAddNew: () => void;
  visibility: "all" | "none" | "route";
  onChangeVisibility: (v: "all" | "none" | "route") => void;
  routeFilterIds: Set<string>;
  onToggleRouteFilter: (routeId: string) => void;
  onToggleAllRoutesFilter: (on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return stops;
    return stops.filter(s => s.name.toLowerCase().includes(qq) || (s.code || "").toLowerCase().includes(qq));
  }, [stops, q]);
  const allRoutesSelected = routes.length > 0 && routeFilterIds.size === routes.length;
  return (
    <div className="p-3 space-y-3">
      <button onClick={onAddNew}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-sm font-medium">
        <Plus className="w-4 h-4" /> Nuova fermata (clic mappa)
      </button>

      {/* ── Filtro visibilità sulla mappa ──────────────── */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2 space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-1">
          Visibilità sulla mappa
        </p>
        <div className="grid grid-cols-3 gap-1">
          {([
            { v: "all" as const, label: "Tutte" },
            { v: "none" as const, label: "Nessuna" },
            { v: "route" as const, label: "Per linea" },
          ]).map(opt => (
            <button key={opt.v} onClick={() => onChangeVisibility(opt.v)}
              className={`text-[11px] px-2 py-1.5 rounded transition ${
                visibility === opt.v
                  ? "bg-emerald-500 text-white font-medium"
                  : "bg-slate-800 hover:bg-slate-700 text-slate-300"
              }`}
            >{opt.label}</button>
          ))}
        </div>
        {visibility === "all" && stops.length > 1500 && (
          <p className="text-[10px] text-amber-400 px-1">
            ⚠️ {stops.length} fermate visibili: la mappa potrebbe rallentare. Usa "Per linea".
          </p>
        )}
        {visibility === "route" && (
          <div className="space-y-1 pt-1 border-t border-slate-800">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] text-slate-400">
                {routeFilterIds.size}/{routes.length} linee
              </span>
              <button onClick={() => onToggleAllRoutesFilter(!allRoutesSelected)}
                className="text-[10px] text-emerald-400 hover:text-emerald-300">
                {allRoutesSelected ? "Deseleziona tutto" : "Seleziona tutto"}
              </button>
            </div>
            <div className="max-h-[180px] overflow-y-auto space-y-0.5 pr-1">
              {routes.length === 0 && (
                <p className="text-[11px] text-slate-500 py-2 text-center">Nessuna linea</p>
              )}
              {routes.map(r => (
                <label key={r.id}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800/60 cursor-pointer">
                  <input type="checkbox"
                    checked={routeFilterIds.has(r.id)}
                    onChange={() => onToggleRouteFilter(r.id)}
                    className="w-3 h-3 accent-emerald-500" />
                  <span className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: r.color || "#10b981" }} />
                  <span className="text-[11px] font-bold">{r.shortName}</span>
                  <span className="text-[10px] text-slate-400 truncate flex-1">{r.longName}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Cerca fermata…"
        className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
      <div className="space-y-1">
        {filtered.length === 0 && (
          <p className="text-center text-xs text-slate-500 py-8">Nessuna fermata</p>
        )}
        {filtered.map(s => (
          <div key={s.id}
            className={`group rounded-lg px-3 py-2 cursor-pointer transition border ${
              selectedId === s.id ? "bg-emerald-500/10 border-emerald-500/40" : "border-transparent hover:bg-slate-900"
            }`}
            onClick={() => onSelect(s)}
          >
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                {s.code && <p className="text-[10px] text-slate-500">{s.code}</p>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Linee + varianti
 * ════════════════════════════════════════════════════════════ */
function RoutesPanel({
  routes, variantsByRoute, openRouteId,
  onToggleRoute, onCreateRoute, onUpdateRoute, onDeleteRoute,
  onCreateVariant, onSelectVariant, onEditVariant, onDeleteVariant,
  onUpdateVariantMeta, shownRouteIds, loadingShowRouteId, onToggleShowRoute,
}: {
  routes: PsRoute[];
  variantsByRoute: Record<string, PsVariant[]>;
  openRouteId: string | null;
  onToggleRoute: (id: string) => void;
  onCreateRoute: (input: { shortName: string; longName?: string; color?: string }) => Promise<PsRoute | undefined>;
  onUpdateRoute: (id: string, patch: { shortName?: string; longName?: string | null; color?: string }) => Promise<boolean>;
  onDeleteRoute: (id: string) => void;
  onCreateVariant: (routeId: string, name: string, dir: number) => Promise<PsVariant | undefined>;
  /** Salva codice/nome/verso di una variante (metadati, non tracciato) */
  onUpdateVariantMeta: (routeId: string, variantId: string, patch: { code?: string | null; name?: string; direction?: number }) => Promise<boolean>;
  /** Multi-visualizzazione: linee attualmente mostrate sulla mappa */
  shownRouteIds: Set<string>;
  loadingShowRouteId: string | null;
  onToggleShowRoute: (route: PsRoute) => void;
  /** Selezione percorso: apre la vista con fermate ordinate + tracciato evidenziato */
  onSelectVariant?: (routeId: string, variantId: string) => void;
  onEditVariant: (routeId: string, variantId: string) => void;
  onDeleteVariant: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newColor, setNewColor] = useState("#10b981");

  const [varForm, setVarForm] = useState<{ routeId: string; name: string; direction: number } | null>(null);
  // Modifica metadati variante (matita sulla riga): codice es. "21A", nome, verso
  const [metaForm, setMetaForm] = useState<{ routeId: string; variantId: string; code: string; name: string; direction: number } | null>(null);
  const [metaSaving, setMetaSaving] = useState(false);
  // Ricerca linee: il CODICE linea comanda. Rank: codice esatto → codice che
  // inizia per → codice che contiene → (fallback) nome lungo che contiene.
  const [routeSearch, setRouteSearch] = useState("");
  const q = routeSearch.trim().toLowerCase();
  const searchRank = (r: PsRoute): number => {
    const code = (r.shortName ?? "").toLowerCase();
    if (code === q) return 0;
    if (code.startsWith(q)) return 1;
    if (code.includes(q)) return 2;
    if ((r.longName ?? "").toLowerCase().includes(q)) return 3;
    return -1;
  };
  const shownRoutes = q
    ? routes
        .map(r => ({ r, rank: searchRank(r) }))
        .filter(x => x.rank >= 0)
        .sort((a, b) => a.rank - b.rank || (a.r.shortName ?? "").localeCompare(b.r.shortName ?? "", undefined, { numeric: true }))
        .map(x => x.r)
    : routes;
  // Modifica di una linea esistente (matita sulla riga)
  const [routeForm, setRouteForm] = useState<{ id: string; shortName: string; longName: string; color: string } | null>(null);
  const normColor = (c: string | null | undefined) => {
    const v = (c || "10b981").replace(/^#/, "");
    return /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : "#10b981";
  };

  return (
    <div className="p-3 space-y-3">
      {!creating ? (
        <button onClick={() => setCreating(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-sm font-medium">
          <Plus className="w-4 h-4" /> Nuova linea
        </button>
      ) : (
        <div className="rounded-lg bg-slate-900 border border-slate-800 p-3 space-y-2">
          <input value={newShort} onChange={e => setNewShort(e.target.value)} placeholder="Codice (es. 5)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <input value={newLong} onChange={e => setNewLong(e.target.value)} placeholder="Nome lungo (opzionale)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <div className="flex items-center gap-2">
            <Palette className="w-3.5 h-3.5 text-slate-400" />
            <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
              className="w-8 h-7 rounded border border-slate-700" />
            <span className="text-[11px] text-slate-500">{newColor}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setCreating(false); setNewShort(""); setNewLong(""); }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">Annulla</button>
            <button onClick={async () => {
              if (!newShort.trim()) { toast.error("Codice obbligatorio"); return; }
              const r = await onCreateRoute({ shortName: newShort.trim(), longName: newLong.trim() || undefined, color: newColor });
              if (r) { setCreating(false); setNewShort(""); setNewLong(""); }
            }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-white font-medium">Crea</button>
          </div>
        </div>
      )}

      {/* Ricerca linee */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input value={routeSearch} onChange={e => setRouteSearch(e.target.value)}
          placeholder={`Codice linea (es. 21) — ${routes.length} linee`}
          className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs focus:outline-none focus:border-emerald-500/50" />
      </div>

      <div className="space-y-1">
        {routes.length === 0 && <p className="text-center text-xs text-slate-500 py-8">Nessuna linea</p>}
        {shownRoutes.length === 0 && routes.length > 0 && (
          <p className="text-center text-xs text-slate-500 py-4">Nessuna linea corrisponde a "{routeSearch}"</p>
        )}
        {shownRoutes.map(r => {
          const open = openRouteId === r.id;
          const variants = variantsByRoute[r.id] || [];
          return (
            <div key={r.id} className="rounded-lg border border-slate-800 overflow-hidden">
              {routeForm?.id === r.id ? (
                /* ─── Modifica linea: codice, nome, colore ─── */
                <div className="px-3 py-2.5 space-y-2 bg-slate-900/70">
                  <div className="flex items-center gap-2">
                    <input value={routeForm.shortName} onChange={e => setRouteForm({ ...routeForm, shortName: e.target.value })}
                      placeholder="Codice" autoFocus
                      className="w-20 px-2 py-1.5 rounded bg-slate-800 text-sm font-bold border border-slate-700" />
                    <input value={routeForm.longName} onChange={e => setRouteForm({ ...routeForm, longName: e.target.value })}
                      placeholder="Nome lungo (opzionale)"
                      className="flex-1 px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Palette className="w-3.5 h-3.5 text-slate-400" />
                    <input type="color" value={routeForm.color} onChange={e => setRouteForm({ ...routeForm, color: e.target.value })}
                      className="w-8 h-7 rounded border border-slate-700" />
                    <span className="text-[11px] text-slate-500 font-mono">{routeForm.color}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: routeForm.color, color: "#fff" }}>
                      {routeForm.shortName || "?"}
                    </span>
                    <div className="flex-1" />
                    <button onClick={() => setRouteForm(null)}
                      className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">Annulla</button>
                    <button onClick={async () => {
                      if (!routeForm.shortName.trim()) { toast.error("Codice obbligatorio"); return; }
                      const ok = await onUpdateRoute(r.id, {
                        shortName: routeForm.shortName.trim(),
                        longName: routeForm.longName.trim() || null,
                        color: routeForm.color,
                      });
                      if (ok) setRouteForm(null);
                    }}
                      className="text-xs px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-white font-medium inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> Salva
                    </button>
                  </div>
                </div>
              ) : (
              <div className="group flex items-center gap-2 px-3 py-2 hover:bg-slate-900 cursor-pointer"
                onClick={() => onToggleRoute(r.id)}>
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: r.color || "#10b981" }} />
                <span className="text-sm font-bold">{r.shortName}</span>
                <span className="text-xs text-slate-400 truncate flex-1">{r.longName}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleShowRoute(r); }}
                  title={shownRouteIds.has(r.id) ? "Nascondi i tracciati della linea dalla mappa" : "Mostra i tracciati sulla mappa (puoi mostrare più linee insieme)"}
                  className={`p-1 rounded transition ${shownRouteIds.has(r.id)
                    ? "text-emerald-300 bg-emerald-500/15"
                    : "text-slate-500 hover:text-slate-200 hover:bg-slate-800 opacity-0 group-hover:opacity-100"}`}>
                  {loadingShowRouteId === r.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : shownRouteIds.has(r.id) ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRouteForm({ id: r.id, shortName: r.shortName || "", longName: r.longName || "", color: normColor(r.color) });
                  }}
                  title="Modifica nome e colore della linea"
                  className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 opacity-0 group-hover:opacity-100">
                  <Pencil className="w-3 h-3" />
                </button>
                <span className="text-[10px] text-slate-500">{r.variantCount ?? 0} var.</span>
                <ChevronRight className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`} />
              </div>
              )}
              {open && (
                <div className="px-3 pb-3 space-y-1 border-t border-slate-800/50 bg-slate-900/30">
                  {variants.length === 0 && (
                    <p className="text-[11px] text-slate-500 italic pt-2">
                      Nessun percorso: la linea resta comunque. Creane uno con «+ variante» qui sotto.
                    </p>
                  )}
                  {variants.map(v => metaForm?.variantId === v.id ? (
                    /* ─── Modifica metadati percorso: codice (es. 21A), nome, verso ─── */
                    <div key={v.id} className="py-1.5 px-2 -mx-1 rounded bg-slate-800/70 border border-emerald-500/30 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <input value={metaForm.code} autoFocus
                          onChange={e => setMetaForm({ ...metaForm, code: e.target.value })}
                          placeholder={`es. ${r.shortName}A`}
                          title="Codice del percorso (vuoto = codice automatico)"
                          className="w-16 px-1.5 py-1 rounded bg-slate-900 text-xs font-mono text-emerald-300 border border-slate-700" />
                        <input value={metaForm.name}
                          onChange={e => setMetaForm({ ...metaForm, name: e.target.value })}
                          placeholder="Nome percorso"
                          className="flex-1 min-w-0 px-1.5 py-1 rounded bg-slate-900 text-xs border border-slate-700" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select value={metaForm.direction}
                          onChange={e => setMetaForm({ ...metaForm, direction: Number(e.target.value) })}
                          className="px-1 py-1 rounded bg-slate-900 text-xs border border-slate-700">
                          <option value={0}>→ Andata</option><option value={1}>← Ritorno</option>
                        </select>
                        <div className="flex-1" />
                        <button disabled={metaSaving || !metaForm.name.trim()}
                          onClick={async () => {
                            setMetaSaving(true);
                            const ok = await onUpdateVariantMeta(r.id, v.id, {
                              code: metaForm.code.trim() || null,
                              name: metaForm.name.trim(),
                              direction: metaForm.direction,
                            });
                            setMetaSaving(false);
                            if (ok) setMetaForm(null);
                          }}
                          className="px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-medium disabled:opacity-50 inline-flex items-center gap-1">
                          <Check className="w-3 h-3" /> Salva
                        </button>
                        <button onClick={() => setMetaForm(null)}
                          className="px-1.5 py-1 rounded bg-slate-900 text-slate-400 hover:text-slate-200 text-xs">Annulla</button>
                      </div>
                    </div>
                  ) : (
                    <div key={v.id}
                      className="group flex items-center gap-2 py-1.5 px-1 -mx-1 rounded cursor-pointer hover:bg-slate-800/50"
                      title="Mostra percorso e fermate sulla mappa"
                      onClick={() => onSelectVariant?.(r.id, v.id)}>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${v.direction === 0 ? "bg-blue-500/20 text-blue-300" : "bg-purple-500/20 text-purple-300"}`}>
                        {v.direction === 0 ? "→" : "←"}
                      </span>
                      {v.code && <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono shrink-0">{v.code}</span>}
                      <span className="text-xs flex-1 truncate">{v.name}</span>
                      <span className="text-[10px] text-slate-500">{v.stopCount ?? 0} ferm.</span>
                      {v.hasShape && <span className="text-[10px] text-emerald-400">●</span>}
                      <button onClick={(e) => {
                          e.stopPropagation();
                          setMetaForm({ routeId: r.id, variantId: v.id, code: v.code ?? "", name: v.name, direction: v.direction === 1 ? 1 : 0 });
                        }}
                        title="Modifica codice (es. 21A), nome e verso del percorso"
                        className="p-0.5 rounded text-slate-500 hover:text-emerald-300 opacity-0 group-hover:opacity-100">
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); onEditVariant(r.id, v.id); }}
                        title="Modifica il TRACCIATO del percorso (fermate e shape sulla mappa)"
                        className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/80 hover:bg-emerald-500 text-white opacity-0 group-hover:opacity-100">
                        Tracciato
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); onDeleteVariant(v.id); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {varForm?.routeId === r.id ? (
                    <div className="flex gap-1 pt-1">
                      <input value={varForm.name} onChange={e => setVarForm({ ...varForm, name: e.target.value })}
                        placeholder="Nome variante" autoFocus
                        className="flex-1 px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
                      <select value={varForm.direction} onChange={e => setVarForm({ ...varForm, direction: Number(e.target.value) })}
                        className="px-1 py-1 rounded bg-slate-800 text-xs border border-slate-700">
                        <option value={0}>And.</option><option value={1}>Rit.</option>
                      </select>
                      <button onClick={async () => {
                        if (!varForm.name.trim()) return;
                        const v = await onCreateVariant(r.id, varForm.name.trim(), varForm.direction);
                        if (v) setVarForm(null);
                      }} className="px-2 py-1 rounded bg-emerald-500 text-white text-xs">OK</button>
                      <button onClick={() => setVarForm(null)} className="px-1 text-slate-500"><X className="w-3 h-3" /></button>
                    </div>
                  ) : (
                    <div className="flex gap-1 pt-1">
                      <button onClick={() => setVarForm({ routeId: r.id, name: "", direction: 0 })}
                        className="flex-1 text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center gap-1">
                        <Plus className="w-3 h-3" /> Variante
                      </button>
                      <button onClick={() => onDeleteRoute(r.id)}
                        className="text-[11px] px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Nodi di cambio (interscambi)
 *  Editing interattivo direttamente sulla mappa: il pannello
 *  ospita la lista, il tasto "+" e il pannello di modifica.
 *  Il disegno area + click fermate avviene nello stato `clusterDraw`
 *  gestito dal parent EditorPage (vedi handleMapClick / onDblClick).
 * ════════════════════════════════════════════════════════════ */
type ClusterDrawState = {
  mode: "draw" | "stops";
  clusterId: string | null;
  name: string;
  kind: PsClusterKind;
  isLogical: boolean;
  isInterchange: boolean;
  isRest: boolean;          // nodo di sosta (sosta inoperosa extraurbana)
  hasFacilities: boolean;   // con servizi igienici/strutture → contributo 12% vs 25%
  radiusM: number;
  color: string;
  polygon: [number, number][];
  pendingStopIds: Set<string>;
};

function ClustersPanel({
  projectId, stops, clusters, onChanged, onFlyTo,
  clusterDraw, setClusterDraw,
}: {
  projectId: string;
  stops: PsStop[];
  clusters: PsCluster[];
  onChanged: () => Promise<void>;
  onFlyTo: (lat: number, lon: number) => void;
  clusterDraw: ClusterDrawState | null;
  setClusterDraw: (s: ClusterDrawState | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Suggest dialog state
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestRadius, setSuggestRadius] = useState(150);
  const [suggestMinSize, setSuggestMinSize] = useState(2);
  const [suggestions, setSuggestions] = useState<PsClusterSuggestion[]>([]);
  const [suggestSelected, setSuggestSelected] = useState<Set<number>>(new Set());
  const [suggestLoading, setSuggestLoading] = useState(false);

  const KIND_LABEL: Record<PsClusterKind, string> = {
    interchange: "Punto di cambio",
    rest: "Nodo di sosta",
    none: "Nodo logico",
  };
  const KIND_COLOR: Record<PsClusterKind, string> = {
    interchange: "#0ea5e9",
    rest: "#f59e0b",
    none: "#64748b",
  };

  // Palette di colori predefiniti per il cluster
  const COLOR_PALETTE = [
    "#0ea5e9", // sky
    "#06b6d4", // cyan
    "#10b981", // emerald
    "#84cc16", // lime
    "#eab308", // yellow
    "#f97316", // orange
    "#ef4444", // red
    "#ec4899", // pink
    "#a855f7", // violet
    "#6366f1", // indigo
    "#64748b", // slate
    "#0f172a", // dark
  ];

  // Helper: ricava il colore di un cluster dal suo attributes.color, fallback al kind
  function clusterColor(c: PsCluster): string {
    return (c.attributes && typeof c.attributes.color === "string" ? c.attributes.color : null)
        || KIND_COLOR[c.kind];
  }

  // ── Logico vs Cambio (un cluster può essere entrambi) ────────
  // I flag sono letti dagli helper a livello modulo isInterchangeOf /
  // isLogicalOf (condivisi con la simbologia mappa). Lo Scheduling Engine
  // usa il campo enum `kind = 'interchange'` (mirror su stop_clusters legacy
  // filtra per quello), quindi quando isInterchange=true salviamo
  // sempre kind='interchange', altrimenti kind='none'.
  function clusterTypeLabel(c: PsCluster): string {
    const i = isInterchangeOf(c), l = isLogicalOf(c);
    if (c.kind === "rest") return l ? "Logico + Sosta" : "Nodo di sosta";
    if (i && l) return "Logico + Cambio";
    if (i) return "Punto di cambio";
    if (l) return "Nodo logico";
    return "—";
  }

  // mappa stopId → fermata (per la lista nella card del cluster in modifica)
  const stopById = useMemo(() => {
    const m: Record<string, PsStop> = {};
    for (const s of stops) m[s.id] = s;
    return m;
  }, [stops]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return clusters;
    return clusters.filter(c => c.name.toLowerCase().includes(q));
  }, [clusters, filter]);

  function toggleExpanded(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleHidden(id: string) {
    setHidden(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function showAll() { setHidden(new Set()); }
  function hideAll() { setHidden(new Set(clusters.map(c => c.id))); }

  function startCreate() {
    setClusterDraw({
      mode: "draw",
      clusterId: null,
      name: "",
      kind: "interchange",
      isLogical: false,
      isInterchange: true,
      isRest: false,
      hasFacilities: false,
      radiusM: 150,
      color: COLOR_PALETTE[0],
      polygon: [],
      pendingStopIds: new Set(),
    });
  }

  function startEdit(c: PsCluster) {
    // Carica le fermate attualmente associate al cluster
    const ids = new Set<string>();
    for (const s of stops) if (s.clusterId === c.id) ids.add(s.id);
    setClusterDraw({
      mode: "stops",
      clusterId: c.id,
      name: c.name,
      kind: c.kind,
      isLogical: isLogicalOf(c),
      isInterchange: isInterchangeOf(c),
      isRest: c.kind === "rest",
      hasFacilities: !!(c.attributes as any)?.hasFacilities,
      radiusM: c.radiusM ?? 150,
      color: clusterColor(c),
      polygon: [],
      pendingStopIds: ids,
    });
    if (c.centerLat != null && c.centerLon != null) onFlyTo(Number(c.centerLat), Number(c.centerLon));
  }

  const [panelConfirm, setPanelConfirm] = useState<ConfirmRequest | null>(null);
  function askDelete(c: PsCluster) {
    setPanelConfirm({
      title: `Eliminare il cluster "${c.name}"?`,
      message: "Le fermate verranno scollegate (non cancellate).",
      confirmLabel: "Elimina",
      onConfirm: () => handleDelete(c),
    });
  }
  async function handleDelete(c: PsCluster) {
    setBusyId(c.id);
    try {
      await deletePsCluster(projectId, c.id);
      await onChanged();
      if (clusterDraw?.clusterId === c.id) setClusterDraw(null);
      toast.success("Nodo eliminato");
    } catch (e: any) { toast.error(e?.message || "Errore"); }
    finally { setBusyId(null); }
  }

  function askBulkDelete() {
    if (clusters.length === 0) return;
    setPanelConfirm({
      title: `Eliminare TUTTI i ${clusters.length} cluster del progetto?`,
      message: "Le fermate verranno scollegate (non cancellate). Operazione NON reversibile.",
      confirmLabel: "Elimina tutti",
      onConfirm: () => handleBulkDelete(),
    });
  }
  async function handleBulkDelete() {
    if (clusters.length === 0) return;
    setBulkDeleting(true);
    let ok = 0, ko = 0;
    const POOL = 8;
    const queue = [...clusters];
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (!c) return;
        try { await deletePsCluster(projectId, c.id); ok++; } catch { ko++; }
      }
    }
    await Promise.all(Array.from({ length: POOL }, worker));
    setBulkDeleting(false);
    await onChanged();
    setClusterDraw(null);
    if (ko === 0) toast.success(`Eliminati ${ok} cluster`);
    else toast.warning(`Eliminati ${ok} su ${ok + ko} (${ko} errori)`);
  }

  async function handleSaveDraw() {
    if (!clusterDraw) return;
    if (!clusterDraw.name.trim()) { toast.error("Nome richiesto"); return; }
    if (clusterDraw.pendingStopIds.size === 0 && !confirm("Salvare un cluster senza fermate?")) return;

    // Centroide: media delle coordinate delle fermate selezionate
    let centerLat: number | undefined;
    let centerLon: number | undefined;
    const selectedStops = stops.filter(s => clusterDraw.pendingStopIds.has(s.id));
    if (selectedStops.length > 0) {
      centerLat = selectedStops.reduce((a, s) => a + Number(s.lat), 0) / selectedStops.length;
      centerLon = selectedStops.reduce((a, s) => a + Number(s.lon), 0) / selectedStops.length;
    }

    setSaving(true);
    try {
      let id = clusterDraw.clusterId;
      // kind enum derivato dai flag. Priorità: Cambio (interchange, per il mirror
      // legacy dello Scheduling Engine) → Sosta (rest) → logico/none.
      const derivedKind: PsClusterKind = clusterDraw.isInterchange
        ? "interchange"
        : clusterDraw.isRest ? "rest" : "none";
      const attrPatch = {
        color: clusterDraw.color,
        isLogical: clusterDraw.isLogical,
        isInterchange: clusterDraw.isInterchange,
        isRest: clusterDraw.isRest,
        hasFacilities: clusterDraw.isRest ? clusterDraw.hasFacilities : false,
      };
      if (id) {
        // Preserva eventuali altri attributes esistenti
        const existing = clusters.find(c => c.id === id);
        const mergedAttrs = { ...(existing?.attributes ?? {}), ...attrPatch };
        await updatePsCluster(projectId, id, {
          name: clusterDraw.name.trim(),
          kind: derivedKind,
          radiusM: clusterDraw.radiusM,
          attributes: mergedAttrs,
          ...(centerLat != null ? { centerLat, centerLon } : {}),
        });
      } else {
        const created = await createPsCluster(projectId, {
          name: clusterDraw.name.trim(),
          kind: derivedKind,
          radiusM: clusterDraw.radiusM,
          attributes: attrPatch,
          ...(centerLat != null ? { centerLat, centerLon } : {}),
        });
        id = created.id;
      }
      await setPsClusterStops(projectId, id!, Array.from(clusterDraw.pendingStopIds));
      await onChanged();
      toast.success(clusterDraw.clusterId ? "Cluster aggiornato" : "Cluster creato");
      setClusterDraw(null);
    } catch (e: any) {
      toast.error(e?.message || "Errore salvataggio");
    } finally { setSaving(false); }
  }

  async function handleRunSuggest() {
    setSuggestLoading(true);
    try {
      const r = await suggestPsClusters(projectId, { radius: suggestRadius, minSize: suggestMinSize });
      setSuggestions(r.suggestions);
      setSuggestSelected(new Set(r.suggestions.map((_, i) => i)));
    } catch (e: any) { toast.error(e?.message || "Errore"); }
    finally { setSuggestLoading(false); }
  }

  async function handleApplySuggestions() {
    const picked = suggestions.filter((_, i) => suggestSelected.has(i));
    let ok = 0, ko = 0;
    for (const s of picked) {
      try {
        const c = await createPsCluster(projectId, {
          name: s.suggestedName, kind: "interchange",
          centerLat: s.centerLat, centerLon: s.centerLon, radiusM: suggestRadius,
        });
        await setPsClusterStops(projectId, c.id, s.stops.map(x => x.id));
        ok++;
      } catch { ko++; }
    }
    await onChanged();
    toast.success(`Creati ${ok} cluster${ko ? `, ${ko} errori` : ""}`);
    setSuggestOpen(false); setSuggestions([]);
  }

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog req={panelConfirm} onClose={() => setPanelConfirm(null)} />
      {/* ─── PANNELLO EDIT (creazione o modifica) ─── */}
      {clusterDraw ? (
        <div className="flex-1 flex flex-col bg-slate-900 overflow-hidden">
          <div className="p-3 border-b border-violet-500/30 bg-violet-500/5 shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wider text-violet-300 font-semibold">
                {clusterDraw.clusterId ? "Modifica cluster" : "Nuovo cluster"}
              </span>
              <button onClick={() => setClusterDraw(null)} className="ml-auto p-1 rounded hover:bg-slate-800 text-slate-400">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <input
              autoFocus={!clusterDraw.clusterId}
              value={clusterDraw.name}
              onChange={e => setClusterDraw({ ...clusterDraw, name: e.target.value })}
              placeholder="Nome cluster"
              className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700 text-slate-100 mb-2"
            />
            <div className="flex gap-2 mb-2">
              <div className="flex-1 grid grid-cols-3 gap-1">
                <label
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-[11px] cursor-pointer transition ${
                    clusterDraw.isLogical
                      ? "bg-slate-700 border-slate-500 text-slate-100"
                      : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600"
                  }`}
                  title="Nodo logico: raggruppamento, intermodalità."
                >
                  <input
                    type="checkbox"
                    checked={clusterDraw.isLogical}
                    onChange={e => setClusterDraw({ ...clusterDraw, isLogical: e.target.checked })}
                    className="w-3 h-3 accent-slate-400"
                  />
                  Logico
                </label>
                <label
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-[11px] cursor-pointer transition ${
                    clusterDraw.isInterchange
                      ? "bg-sky-600/30 border-sky-400 text-sky-100"
                      : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600"
                  }`}
                  title="Cambio: punto di cambio vettura, usato dallo Scheduling Engine."
                >
                  <input
                    type="checkbox"
                    checked={clusterDraw.isInterchange}
                    onChange={e => setClusterDraw({ ...clusterDraw, isInterchange: e.target.checked })}
                    className="w-3 h-3 accent-sky-500"
                  />
                  Di Cambio
                </label>
                <label
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-[11px] cursor-pointer transition ${
                    clusterDraw.isRest
                      ? "bg-amber-600/30 border-amber-400 text-amber-100"
                      : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600"
                  }`}
                  title="Sosta: nodo idoneo alla sosta inoperosa extraurbana (deposito/posto con servizi)."
                >
                  <input
                    type="checkbox"
                    checked={clusterDraw.isRest}
                    onChange={e => setClusterDraw({ ...clusterDraw, isRest: e.target.checked })}
                    className="w-3 h-3 accent-amber-500"
                  />
                  Sosta
                </label>
              </div>
              <input
                type="number" min={20} max={2000} step={10}
                value={clusterDraw.radiusM}
                onChange={e => setClusterDraw({ ...clusterDraw, radiusM: parseInt(e.target.value) || 150 })}
                title="Raggio (m)"
                className="w-20 px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700 text-slate-100"
              />
            </div>
            {clusterDraw.isRest && (
              <label className="flex items-center gap-1.5 text-[11px] text-amber-200/90 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clusterDraw.hasFacilities}
                  onChange={e => setClusterDraw({ ...clusterDraw, hasFacilities: e.target.checked })}
                  className="w-3 h-3 accent-amber-500"
                />
                Con servizi igienici / strutture (sosta al 12% anziché 25%)
              </label>
            )}
            {!clusterDraw.isLogical && !clusterDraw.isInterchange && !clusterDraw.isRest && (
              <p className="text-[10px] text-amber-400 -mt-1 mb-2">
                ⚠ Seleziona almeno un tipo (Logico, Cambio o Sosta).
              </p>
            )}
            {/* Color picker */}
            <div className="mb-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider">Colore</span>
                <span
                  className="w-3.5 h-3.5 rounded border border-slate-600"
                  style={{ backgroundColor: clusterDraw.color }}
                />
                <input
                  type="color"
                  value={clusterDraw.color}
                  onChange={e => setClusterDraw({ ...clusterDraw, color: e.target.value })}
                  title="Colore personalizzato"
                  className="ml-auto w-6 h-5 rounded border border-slate-600 bg-transparent cursor-pointer p-0"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {COLOR_PALETTE.map(col => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => setClusterDraw({ ...clusterDraw, color: col })}
                    title={col}
                    className={`w-5 h-5 rounded border-2 transition ${
                      clusterDraw.color.toLowerCase() === col.toLowerCase()
                        ? "border-white scale-110"
                        : "border-slate-700 hover:border-slate-500"
                    }`}
                    style={{ backgroundColor: col }}
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setClusterDraw({ ...clusterDraw, mode: "draw", polygon: [] })}
                className={`flex-1 px-2 py-1 rounded text-[11px] font-medium border inline-flex items-center justify-center gap-1 ${
                  clusterDraw.mode === "draw"
                    ? "bg-violet-500 border-violet-400 text-white"
                    : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
                }`}
                title="Disegna l'area sulla mappa"
              >
                🖊 Disegna area
              </button>
              <button
                onClick={() => setClusterDraw({ ...clusterDraw, mode: "stops" })}
                className={`flex-1 px-2 py-1 rounded text-[11px] font-medium border inline-flex items-center justify-center gap-1 ${
                  clusterDraw.mode === "stops"
                    ? "bg-violet-500 border-violet-400 text-white"
                    : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
                }`}
                title="Clicca le fermate sulla mappa"
              >
                <MapPin className="w-3 h-3" /> Tocca fermate
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 italic">
              {clusterDraw.mode === "draw"
                ? "Clicca i vertici sulla mappa, doppio click per chiudere → le fermate dentro vengono incluse."
                : "Clicca una fermata sulla mappa per aggiungerla/rimuoverla dal cluster."}
            </p>
          </div>

          {/* Lista fermate selezionate */}
          <div className="flex-1 overflow-auto">
            <div className="px-3 py-2 sticky top-0 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">Fermate nel cluster</span>
              <span className="text-violet-300 font-semibold">{clusterDraw.pendingStopIds.size}</span>
            </div>
            {clusterDraw.pendingStopIds.size === 0 ? (
              <p className="text-[11px] text-slate-500 italic px-3 py-3 text-center">
                Nessuna fermata selezionata.<br />Disegna un'area o tocca le fermate sulla mappa.
              </p>
            ) : (
              Array.from(clusterDraw.pendingStopIds).map(sid => {
                const s = stopById[sid];
                if (!s) return null;
                return (
                  <div key={sid} className="flex items-center gap-1.5 px-3 py-1 text-[11px] hover:bg-slate-800/60 group">
                    <MapPin className="w-3 h-3 text-violet-400 shrink-0" />
                    <button
                      onClick={() => onFlyTo(Number(s.lat), Number(s.lon))}
                      className="flex-1 truncate text-left text-slate-200 hover:text-violet-300"
                      title="Centra sulla mappa"
                    >
                      {s.name}
                    </button>
                    <button
                      onClick={() => {
                        const next = new Set(clusterDraw.pendingStopIds);
                        next.delete(sid);
                        setClusterDraw({ ...clusterDraw, pendingStopIds: next });
                      }}
                      title="Rimuovi"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-rose-400 hover:bg-rose-500/10"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer azioni */}
          <div className="p-2 border-t border-slate-800 flex gap-2 shrink-0">
            <button
              onClick={() => setClusterDraw(null)}
              disabled={saving}
              className="flex-1 px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
            >
              Annulla
            </button>
            <button
              onClick={handleSaveDraw}
              disabled={saving || !clusterDraw.name.trim() || (!clusterDraw.isLogical && !clusterDraw.isInterchange && !clusterDraw.isRest)}
              className="flex-1 px-2 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium inline-flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Salva
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ─── HEADER + LISTA ─── */}
          <div className="p-2 border-b border-slate-800 space-y-2 shrink-0">
            <div className="flex gap-1">
              <button
                onClick={startCreate}
                className="flex-1 px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium inline-flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Nuovo cluster
              </button>
              <button
                onClick={() => { setSuggestOpen(true); setSuggestions([]); }}
                title="Suggerisci automaticamente"
                className="px-2 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs inline-flex items-center justify-center gap-1"
              >
                ✨
              </button>
              {clusters.length > 0 && (
                <button
                  onClick={askBulkDelete}
                  disabled={bulkDeleting}
                  title="Elimina tutti i cluster"
                  className="px-2 py-1.5 rounded bg-rose-600/80 hover:bg-rose-500 text-white text-xs inline-flex items-center justify-center disabled:opacity-50"
                >
                  {bulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
            {clusters.length > 0 && (
              <>
                <div className="relative">
                  <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Cerca cluster…"
                    className="w-full pl-6 pr-2 py-1 rounded bg-slate-800 text-[11px] border border-slate-700 text-slate-100" />
                </div>
                <div className="flex gap-1">
                  <button onClick={showAll} className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 inline-flex items-center justify-center gap-1">
                    <Eye className="w-3 h-3" /> Mostra tutti
                  </button>
                  <button onClick={hideAll} className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 inline-flex items-center justify-center gap-1">
                    <EyeOff className="w-3 h-3" /> Nascondi tutti
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex-1 overflow-auto p-2 space-y-1.5">
            {clusters.length === 0 && (
              <div className="p-6 text-center text-slate-500 text-xs">
                Nessun cluster.<br />Crea il primo con <em>Nuovo cluster</em> o usa <em>✨</em>.
              </div>
            )}
            {clusters.length > 0 && filtered.length === 0 && (
              <p className="text-[11px] text-slate-500 text-center py-4">Nessun risultato.</p>
            )}
            {filtered.map(c => {
              const isOpen = expanded.has(c.id);
              const isHidden = hidden.has(c.id);
              const isBusy = busyId === c.id;
              const clusterStops = stops.filter(s => s.clusterId === c.id);
              return (
                <div key={c.id}
                  className={`rounded-lg border ${isHidden ? "border-slate-800 opacity-50" : "border-slate-800 hover:border-cyan-700"} bg-slate-900/60 transition`}>
                  <div className="flex items-center gap-1.5 p-2">
                    <button onClick={() => toggleExpanded(c.id)} className="p-0.5 rounded hover:bg-slate-800 text-slate-400">
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    <div className="w-1.5 h-7 rounded shrink-0" style={{ background: clusterColor(c) }} />
                    <button
                      onClick={() => c.centerLat != null && c.centerLon != null && onFlyTo(Number(c.centerLat), Number(c.centerLon))}
                      className="flex-1 min-w-0 text-left hover:text-cyan-300"
                      title="Centra sulla mappa"
                    >
                      <div className="text-xs font-medium truncate text-slate-200">{c.name}</div>
                      <div className="text-[10px] text-slate-500">
                        {clusterTypeLabel(c)} · {c.stopCount ?? clusterStops.length} fermate · r={c.radiusM}m
                      </div>
                    </button>
                    <div className="flex gap-0.5 shrink-0">
                      <button onClick={() => toggleHidden(c.id)} title={isHidden ? "Mostra" : "Nascondi"}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-300">
                        {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => startEdit(c)} title="Modifica completa"
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-300">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => askDelete(c)} disabled={isBusy} title="Elimina"
                        className="p-1 rounded hover:bg-rose-500/10 text-slate-400 hover:text-rose-400 disabled:opacity-50">
                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t border-slate-800 bg-slate-950/40 max-h-48 overflow-auto">
                      {clusterStops.length === 0 ? (
                        <p className="text-[10px] text-slate-500 italic px-3 py-2">Nessuna fermata associata</p>
                      ) : (
                        clusterStops.map(s => (
                          <button
                            key={s.id}
                            onClick={() => onFlyTo(Number(s.lat), Number(s.lon))}
                            className="w-full flex items-center gap-1.5 px-3 py-1 text-[10px] hover:bg-slate-800/60 text-left"
                          >
                            <MapPin className="w-2.5 h-2.5 text-slate-500 shrink-0" />
                            <span className="flex-1 truncate text-slate-300">{s.name}</span>
                            {s.code && <span className="text-slate-600 text-[9px] shrink-0">#{s.code}</span>}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Modal Suggerisci */}
      {suggestOpen && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSuggestOpen(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 max-w-md w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-cyan-300">Suggerisci cluster</h3>
              <button onClick={() => setSuggestOpen(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="text-[10px] text-slate-400">Raggio (m)
                <input type="number" min={20} max={1000} step={10} value={suggestRadius} onChange={e => setSuggestRadius(parseInt(e.target.value) || 150)}
                  className="mt-0.5 w-full px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
              </label>
              <label className="text-[10px] text-slate-400">Min fermate
                <input type="number" min={2} max={20} value={suggestMinSize} onChange={e => setSuggestMinSize(parseInt(e.target.value) || 2)}
                  className="mt-0.5 w-full px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
              </label>
            </div>
            <button onClick={handleRunSuggest} disabled={suggestLoading}
              className="w-full px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs mb-3 flex items-center justify-center gap-2">
              {suggestLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "✨"}
              {suggestLoading ? "Calcolo…" : "Calcola suggerimenti"}
            </button>
            <div className="flex-1 overflow-auto border border-slate-800 rounded">
              {suggestions.length === 0 && !suggestLoading && <p className="text-center text-xs text-slate-500 p-4">Premi "Calcola" per vedere i suggerimenti</p>}
              {suggestions.map((s, i) => (
                <label key={i} className={`flex items-start gap-2 px-2 py-1.5 border-b border-slate-800 hover:bg-slate-800 cursor-pointer ${suggestSelected.has(i) ? "bg-cyan-500/10" : ""}`}>
                  <input type="checkbox" checked={suggestSelected.has(i)}
                    onChange={() => setSuggestSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                    className="accent-cyan-500 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{s.suggestedName}</p>
                    <p className="text-[10px] text-slate-500">{s.stops.length} fermate</p>
                  </div>
                </label>
              ))}
            </div>
            {suggestions.length > 0 && (
              <button onClick={handleApplySuggestions} className="mt-3 w-full px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs">
                Crea {suggestSelected.size} cluster selezionati
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Editor variante (sostituisce sidebar normale)
 * ════════════════════════════════════════════════════════════ */
function VariantEditorPanel({
  editor, stopsAll, snapBusy, saving,
  onAddStop, onMoveStop, onRemoveStop, onRemoveStops, onReverse, onClear,
  insertAfterIdx, onSetInsertAfter, onFlyToStop, onToggleCurb, onUndo, canUndo, savedAt, onChangeMode, onSave, onExit, onImportKml,
}: {
  editor: VariantEditorState;
  stopsAll: PsStop[];
  snapBusy: boolean;
  saving: boolean;
  onImportKml: () => void;
  onAddStop: (s: PsStop) => void;
  onMoveStop: (from: number, to: number) => void;
  onRemoveStop: (idx: number) => void;
  onRemoveStops: (idxs: number[]) => void;
  onReverse: () => void;
  onClear: () => void;
  insertAfterIdx: number | null;
  onSetInsertAfter: (idx: number | null) => void;
  onFlyToStop: (s: PsVariantStop) => void;
  onToggleCurb: () => void;
  onUndo: () => void;
  canUndo: boolean;
  savedAt: number | null;
  onChangeMode: (m: "driving" | "manual") => void;
  onSave: () => void;
  onExit: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [stopPicker, setStopPicker] = useState("");
  // Selezione multipla di righe della sequenza (per eliminazione in blocco).
  const [selIdx, setSelIdx] = useState<Set<number>>(new Set());
  // Se la sequenza cambia lunghezza, la selezione per indice non è più affidabile.
  useEffect(() => { setSelIdx(new Set()); }, [editor.stops.length]);
  const toggleSel = (idx: number) => setSelIdx(prev => {
    const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const filteredStops = useMemo(() => {
    const qq = stopPicker.trim().toLowerCase();
    if (!qq) return [];
    return stopsAll.filter(s => s.name.toLowerCase().includes(qq) || (s.code || "").toLowerCase().includes(qq)).slice(0, 8);
  }, [stopsAll, stopPicker]);

  // Distanza progressiva (m) per fermata. Se disponibili, usa i km SU STRADA
  // delle legs OSRM (allineate ai waypoint); fallback: linea d'aria.
  const cumDistM = useMemo(() => {
    const legs = editor.legDistances;
    if (legs && editor.waypoints.length >= 2 && legs.length === editor.waypoints.length - 1) {
      // cumulata per waypoint, poi mappata sulle fermate (match per stopId, in ordine)
      const wCum: number[] = [0];
      for (let i = 0; i < legs.length; i++) wCum.push(wCum[i] + (legs[i] || 0));
      const res: number[] = [];
      let w = 0, ok = true;
      for (const s of editor.stops) {
        while (w < editor.waypoints.length && editor.waypoints[w].stopId !== s.stopId) w++;
        if (w >= editor.waypoints.length) { ok = false; break; }
        res.push(wCum[w]); w++;
      }
      if (ok && res.length === editor.stops.length) {
        const base = res[0] ?? 0; // normalizza: prima fermata = 0 (via liberi prima non contano)
        return res.map(v => Math.max(0, v - base));
      }
    }
    // Fallback: cumulata fermata→fermata in linea d'aria.
    const out: number[] = [];
    let acc = 0;
    editor.stops.forEach((s, i) => {
      if (i > 0) {
        const p = editor.stops[i - 1];
        acc += lineLengthM([[p.lon, p.lat], [s.lon, s.lat]]);
      }
      out.push(acc);
    });
    return out;
  }, [editor.stops, editor.waypoints, editor.legDistances]);

  return (
    <div className="flex flex-col h-full">
      {/* Header editor */}
      <div className="px-4 py-3 border-b border-emerald-500/20 bg-emerald-500/5 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-300/80 font-semibold">Editor variante</p>
            <p className="text-sm font-medium text-slate-100 mt-0.5">Tracciato + sequenza</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onUndo} disabled={!canUndo}
              title="Annulla ultima modifica (Ctrl+Z)"
              className="p-1 rounded hover:bg-slate-800 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed">
              <Undo2 className="w-4 h-4" />
            </button>
            <button onClick={onExit} className="p-1 rounded hover:bg-slate-800 text-slate-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Stat */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
            <p className="text-[9px] uppercase text-slate-500">Distanza</p>
            <p className="text-sm font-mono text-slate-200">
              {editor.distanceM != null ? `${(editor.distanceM / 1000).toFixed(2)} km` : "—"}
            </p>
          </div>
          <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
            <p className="text-[9px] uppercase text-slate-500">Durata stim.</p>
            <p className="text-sm font-mono text-slate-200">
              {editor.durationS != null ? `${Math.round(editor.durationS / 60)} min` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Mode toggle */}
      <div className="px-4 py-2 border-b border-slate-800 shrink-0">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Modalità tracciato</p>
        <div className="flex gap-1 bg-slate-900 rounded p-0.5 border border-slate-800">
          <button onClick={() => onChangeMode("driving")}
            className={`flex-1 text-xs py-1.5 rounded font-medium transition ${editor.shapeMode === "driving" ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>
            🚗 Auto (snap strade)
          </button>
          <button onClick={() => onChangeMode("manual")}
            className={`flex-1 text-xs py-1.5 rounded font-medium transition ${editor.shapeMode === "manual" ? "bg-amber-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>
            ✏️ Manuale
          </button>
        </div>
        {/* Import da file: fermate per codice + tracciato */}
        <button onClick={onImportKml}
          title="Carica un file KML/KMZ: le fermate vengono abbinate per codice a quelle a sistema (con anteprima), poi sequenza e tracciato entrano nell'editor — sempre modificabili prima del salvataggio."
          className="w-full mt-2 text-xs py-1.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 font-medium inline-flex items-center justify-center gap-1.5">
          <Upload className="w-3.5 h-3.5" /> Importa da KML/KMZ
        </button>
        {/* Arrivo lato marciapiede: il percorso passa sull'asse strada dal lato
            giusto anche per fermate laterali (OSRM approaches=curb) */}
        <label className="flex items-center gap-2 mt-2 text-[11px] text-slate-300 cursor-pointer select-none"
          title="Il bus arriva con la fermata sul lato marciapiede (guida a destra). ATTENZIONE: se le fermate sono georeferenziate sul lato sbagliato può creare giri dell'isolato — attivalo solo se serve.">
          <input type="checkbox" checked={editor.curb} onChange={onToggleCurb} className="accent-emerald-500" />
          🚏 Arrivo lato fermata (curb) <span className="text-slate-500">— opzionale</span>
        </label>
        {snapBusy && <p className="text-[10px] text-indigo-300 mt-1.5 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Calcolo percorso…</p>}
        {/* Violazioni zone vietate */}
        {editor.violations.length > 0 && (
          <div className="mt-2 rounded border border-red-500/50 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
            ⛔ Il percorso attraversa: <strong>{editor.violations.map(v => v.name).join(", ")}</strong>.
            Forza il tracciato: aggiungi un waypoint (clic sulla mappa) e trascinalo fuori dalla zona,
            oppure rendi manuale un tratto (clic sul waypoint).
          </div>
        )}
      </div>

      {/* Sequenza fermate */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-500">
            Sequenza fermate ({editor.stops.length}
            {editor.stops.length > 1 && ` · ${cumDistM[editor.stops.length - 1] >= 1000 ? `${(cumDistM[editor.stops.length - 1] / 1000).toFixed(1)} km` : `${Math.round(cumDistM[editor.stops.length - 1])} m`}`})
          </p>
          {editor.stops.length > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={onReverse} title="Inverti l'ordine della sequenza (utile per il percorso di ritorno)"
                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">⇅ Inverti</button>
              <button onClick={() => { if (confirm("Svuotare tutta la sequenza fermate?")) onClear(); }} title="Rimuovi tutte le fermate dalla sequenza"
                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-300">Svuota</button>
            </div>
          )}
        </div>
        {insertAfterIdx != null && (
          <div className="flex items-center justify-between gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5">
            <span className="text-[10px] text-emerald-300">
              ⤵ Inserimento attivo: le prossime fermate cliccate entrano <strong>dopo la n. {insertAfterIdx + 1}</strong>
            </span>
            <button onClick={() => onSetInsertAfter(null)} className="text-[10px] text-emerald-300 hover:text-emerald-100 underline shrink-0">torna in coda</button>
          </div>
        )}
        {selIdx.size > 0 && (
          <button onClick={() => { onRemoveStops([...selIdx]); setSelIdx(new Set()); }}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium px-2 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white">
            <Trash2 className="w-3 h-3" /> Elimina {selIdx.size} fermat{selIdx.size === 1 ? "a" : "e"} selezionat{selIdx.size === 1 ? "a" : "e"}
          </button>
        )}
        {editor.stops.length === 0 && (
          <p className="text-xs text-slate-500 text-center py-4 italic">
            Aggiungi le fermate cliccandole sulla mappa o cercandole qui sotto.
          </p>
        )}
        <div className="space-y-1">
          {editor.stops.map((vs, idx) => (
            <div
              key={`${vs.stopId}-${idx}`}
              draggable
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx !== null && dragIdx !== idx) onMoveStop(dragIdx, idx); setDragIdx(null); }}
              className={`group flex items-center gap-1.5 rounded px-2 py-1.5 border cursor-move transition ${
                dragIdx === idx ? "border-emerald-500 bg-emerald-500/10"
                : selIdx.has(idx) ? "border-rose-500/50 bg-rose-500/10"
                : insertAfterIdx === idx ? "border-emerald-500/60 bg-emerald-500/5 border-b-2 border-b-emerald-400"
                : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
              }`}
            >
              <input type="checkbox" checked={selIdx.has(idx)} onChange={() => toggleSel(idx)}
                onClick={(e) => e.stopPropagation()} className="accent-rose-500 shrink-0" title="Seleziona per eliminazione multipla" />
              <GripVertical className="w-3 h-3 text-slate-600 shrink-0" />
              <span className="text-[10px] font-mono text-slate-500 w-5 text-right shrink-0">{vs.seq}</span>
              <button onClick={() => onFlyToStop(vs)} title="Vai alla fermata sulla mappa"
                className="text-xs flex-1 truncate text-left hover:text-emerald-300 transition-colors">
                {vs.stopName}
              </button>
              <span className="text-[9px] font-mono text-emerald-400/80 shrink-0 tabular-nums" title="Distanza progressiva (in linea d'aria fermata→fermata)">
                {idx === 0 ? "0 m" : cumDistM[idx] >= 1000 ? `${(cumDistM[idx] / 1000).toFixed(1)} km` : `${Math.round(cumDistM[idx])} m`}
              </span>
              <span className={`items-center shrink-0 ${insertAfterIdx === idx ? "flex" : "hidden group-hover:flex"}`}>
                <button onClick={() => onSetInsertAfter(insertAfterIdx === idx ? null : idx)}
                  className={`p-0.5 ${insertAfterIdx === idx ? "text-emerald-300" : "text-slate-500 hover:text-emerald-300"}`}
                  title={insertAfterIdx === idx ? "Disattiva inserimento qui (torna in coda)" : "Inserisci le prossime fermate DOPO questa"}>
                  ⤵
                </button>
                <button onClick={() => idx > 0 && onMoveStop(idx, idx - 1)} disabled={idx === 0}
                  className="p-0.5 text-slate-500 hover:text-emerald-300 disabled:opacity-30" title="Sposta su">
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button onClick={() => idx < editor.stops.length - 1 && onMoveStop(idx, idx + 1)} disabled={idx === editor.stops.length - 1}
                  className="p-0.5 text-slate-500 hover:text-emerald-300 disabled:opacity-30" title="Sposta giù">
                  <ChevronDown className="w-3 h-3" />
                </button>
                <button onClick={() => onRemoveStop(idx)}
                  className="p-0.5 text-slate-500 hover:text-red-400" title="Rimuovi dalla sequenza">
                  <X className="w-3 h-3" />
                </button>
              </span>
            </div>
          ))}
        </div>

        {/* Stop picker */}
        <div className="pt-3 border-t border-slate-800">
          <input value={stopPicker} onChange={e => setStopPicker(e.target.value)} placeholder="Cerca e aggiungi fermata…"
            className="w-full px-2 py-1.5 rounded bg-slate-900 text-xs border border-slate-800 focus:outline-none focus:border-emerald-500" />
          {filteredStops.length > 0 && (
            <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
              {filteredStops.map(s => (
                <button key={s.id} onClick={() => { onAddStop(s); setStopPicker(""); }}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-800 flex items-center gap-2">
                  <Plus className="w-3 h-3 text-emerald-400" /> <span className="truncate">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Save button */}
      <div className="p-3 border-t border-slate-800 shrink-0">
        <button onClick={onSave} disabled={saving || !editor.dirty}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            editor.dirty
              ? "bg-emerald-500 hover:bg-emerald-400 text-white"
              : savedAt
                ? "bg-emerald-600/25 text-emerald-300 border border-emerald-500/50 cursor-default"
                : "bg-emerald-500 text-white opacity-50 cursor-not-allowed"
          }`}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" />
            : !editor.dirty && savedAt ? <Check className="w-4 h-4" />
            : <Save className="w-4 h-4" />}
          {editor.dirty
            ? "Salva variante"
            : savedAt
              ? `Percorso salvato ✓ (${new Date(savedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })})`
              : "Nessuna modifica"}
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Pannello vista percorso (dx) — fermate ordinate + edit tracciato
 *  Flusso operatore TPL: selezione percorso → lista fermate (seq, nome,
 *  click → flyTo) → "Edita tracciato" → drag vertici / Snap OSRM →
 *  Salva (setPsVariantShape) o Annulla.
 * ════════════════════════════════════════════════════════════ */
function RouteViewPanel({
  view, shapeEdit, snapBusy, saving, showOtherStops,
  onToggleOtherStops, onFlyToStop, onStartEdit, onSnapOsrm, onSave, onCancel, onClose,
}: {
  view: RouteViewState;
  shapeEdit: ShapeEditState | null;
  snapBusy: boolean;
  saving: boolean;
  showOtherStops: boolean;
  onToggleOtherStops: () => void;
  onFlyToStop: (s: PsVariantStop) => void;
  onStartEdit: () => void;
  onSnapOsrm: () => void;
  onSave: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const editing = shapeEdit !== null;
  // Distanza mostrata: dallo snap OSRM se appena ricalcolata, altrimenti dallo shape salvato
  const distanceM = shapeEdit?.distanceM ?? view.shape?.distanceM ?? null;
  const canEdit = view.stops.length >= 2 || (view.shape?.geometry?.coordinates?.length ?? 0) >= 2;
  // Distanza progressiva per fermata (haversine fermata→fermata)
  const cumDistM = useMemo(() => {
    const out: number[] = []; let acc = 0;
    view.stops.forEach((s, i) => {
      if (i > 0) { const p = view.stops[i - 1]; acc += lineLengthM([[p.lon, p.lat], [s.lon, s.lat]]); }
      out.push(acc);
    });
    return out;
  }, [view.stops]);

  return (
    <div className="flex flex-col h-full">
      {/* Header: linea + variante */}
      <div className="px-4 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="px-2 py-0.5 rounded text-xs font-bold text-white shrink-0"
              style={{ backgroundColor: view.routeColor }}
            >
              {view.routeShortName || "—"}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{view.variantName}</p>
              <p className="text-[10px] text-slate-500">
                {view.direction === 0 ? "Andata" : "Ritorno"} · {view.stops.length} fermate
                {distanceM != null && ` · ${(distanceM / 1000).toFixed(2)} km`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Azioni: vista normale → "Edita tracciato"; edit → Snap/Salva/Annulla */}
      <div className="px-3 py-2.5 border-b border-slate-800 shrink-0 space-y-2">
        {!editing ? (
          <>
            <button
              onClick={onStartEdit}
              disabled={!canEdit}
              title={canEdit ? "Modifica il tracciato trascinando i vertici" : "Servono almeno 2 punti (shape o fermate)"}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium"
            >
              <PenLine className="w-4 h-4" /> Edita tracciato
            </button>
            {!view.shape && (
              <p className="text-[10px] text-amber-400/90 text-center">
                Nessun tracciato salvato: partirà dalla spezzata tra le fermate.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[10px] text-slate-400 leading-snug">
              Trascina i <span className="font-semibold" style={{ color: view.routeColor }}>vertici</span> sulla
              mappa per modificare il tracciato
              {shapeEdit!.vertexIdx.length < shapeEdit!.coordinates.length &&
                ` (${shapeEdit!.vertexIdx.length} vertici campionati su ${shapeEdit!.coordinates.length} punti)`}.
            </p>
            <button
              onClick={onSnapOsrm}
              disabled={snapBusy || saving || view.stops.length < 2}
              title="Ricostruisce il tracciato concatenando i percorsi OSRM tra fermate consecutive"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/90 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium"
            >
              {snapBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RouteIcon className="w-3.5 h-3.5" />}
              {snapBusy ? "Calcolo percorso…" : "Snap OSRM (fermata → fermata)"}
            </button>
            {/* Toggle "Mostra altre fermate" per agganciare il tracciato */}
            <button
              onClick={onToggleOtherStops}
              className={`w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                showOtherStops
                  ? "border-slate-500 bg-slate-700/60 text-slate-100"
                  : "border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200"
              }`}
            >
              {showOtherStops ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              Mostra altre fermate
            </button>
            <div className="flex gap-2 pt-0.5">
              <button
                onClick={onCancel}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs font-medium"
              >
                <X className="w-3.5 h-3.5" /> Annulla
              </button>
              <button
                onClick={onSave}
                disabled={saving || !shapeEdit!.dirty}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Salva
              </button>
            </div>
          </>
        )}
      </div>

      {/* Lista ordinata delle fermate della variante (seq, nome) */}
      <div className="flex-1 overflow-y-auto p-3">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
          Fermate del percorso ({view.stops.length})
        </p>
        {view.stops.length === 0 && (
          <p className="text-xs text-slate-500 text-center py-6 italic">
            Nessuna fermata associata a questa variante.
          </p>
        )}
        <div className="space-y-0.5">
          {view.stops.map((s, idx) => (
            <button
              key={`${s.stopId}-${s.seq}`}
              onClick={() => onFlyToStop(s)}
              title="Vai alla fermata sulla mappa"
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-800/60 transition group"
            >
              <span
                className="w-5 h-5 rounded-full text-[10px] font-bold text-white flex items-center justify-center shrink-0"
                style={{ backgroundColor: view.routeColor }}
              >
                {s.seq}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs truncate text-slate-200">{s.stopName}</p>
                {s.stopCode && <p className="text-[10px] text-slate-500">{s.stopCode}</p>}
              </div>
              <span className="text-[9px] font-mono text-emerald-400/80 shrink-0 tabular-nums" title="Distanza progressiva (in linea d'aria fermata→fermata)">
                {idx === 0 ? "0 m" : cumDistM[idx] >= 1000 ? `${(cumDistM[idx] / 1000).toFixed(1)} km` : `${Math.round(cumDistM[idx])} m`}
              </span>
              <MapPin className="w-3 h-3 text-slate-600 group-hover:text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Helpers UI
 * ════════════════════════════════════════════════════════════ */
function ToolBtn({
  label, icon: Icon, active, onClick, disabled,
}: { label: string; icon: any; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={label} disabled={disabled}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
        active ? "bg-emerald-500 text-white shadow"
               : disabled ? "text-slate-600 cursor-not-allowed"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
      }`}>
      <Icon className="w-3.5 h-3.5" /> <span>{label}</span>
    </button>
  );
}

/* ─── Toolbar a menu: accenti colore condivisi tra trigger e voci ─── */
type MenuAccent = "emerald" | "cyan" | "indigo" | "orange" | "violet" | "amber";
const MENU_ACCENT_TEXT: Record<MenuAccent, string> = {
  emerald: "text-emerald-300",
  cyan:    "text-cyan-300",
  indigo:  "text-indigo-300",
  orange:  "text-orange-300",
  violet:  "text-violet-300",
  amber:   "text-amber-300",
};

/* Gruppo della toolbar: bottone trigger + menu a tendina assoluto.
 * La chiusura con click fuori è gestita dal contenitore (menuBarRef). */
function MenuGroup({
  label, icon: Icon, accent, active, open, onToggle, children,
}: {
  label: string; icon: any; accent: MenuAccent; active: boolean; open: boolean;
  onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="relative shrink-0">
      <button onClick={onToggle} title={label}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition ${
          open ? "bg-slate-800 text-slate-100 border-slate-700"
               : active ? `border-transparent bg-slate-900 ${MENU_ACCENT_TEXT[accent]}`
                        : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900"
        }`}>
        <Icon className="w-3.5 h-3.5" />
        <span>{label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 min-w-[230px] rounded-lg border border-slate-800 bg-slate-900 shadow-2xl py-1 z-50">
          {children}
        </div>
      )}
    </div>
  );
}

/* Voce di sottomenu: icona + label; evidenziata (accent + check) se attiva.
 * `count` mostra il numero di elementi, `note` un'etichetta secondaria,
 * `desc` una nota descrittiva su una seconda riga sotto la label. */
function MenuItem({
  icon: Icon, label, note, desc, count, accent, active, onClick,
}: {
  icon: any; label: string; note?: string; desc?: string; count?: number;
  accent: MenuAccent; active?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} title={desc ? `${label} — ${desc}` : label}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
        active ? `bg-slate-800 ${MENU_ACCENT_TEXT[accent]}`
               : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
      }`}>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? "" : "text-slate-500"}`} />
      <span className="flex-1 min-w-0">
        <span className="block truncate font-medium">{label}</span>
        {desc && <span className="block truncate text-[9px] font-normal text-slate-500">{desc}</span>}
      </span>
      {note && <span className="text-[9px] text-slate-500">{note}</span>}
      {count != null && <span className="text-[10px] tabular-nums text-slate-500">{count}</span>}
      {active && <Check className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}

function SidebarTabBtn({
  label, icon: Icon, count, active, onClick,
}: { label: string; icon: any; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[11px] border-b-2 transition ${
        active ? "border-emerald-500 text-emerald-300 bg-emerald-500/5"
               : "border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-900/50"
      }`}>
      <Icon className="w-4 h-4" />
      <span className="font-medium">{label}</span>
      <span className="text-[9px] text-slate-600">{count}</span>
    </button>
  );}

/* ════════════════════════════════════════════════════════════
 *  Mini-form: nuova fermata (popup mappa)
 * ════════════════════════════════════════════════════════════ */
function NewStopForm({
  lat, lon, initialName = "", initialCode = "", onCancel, onSave,
}: {
  lat: number; lon: number;
  initialName?: string; initialCode?: string;
  onCancel: () => void;
  onSave: (data: { name: string; code?: string; lat: number; lon: number }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  return (
    <div className="p-1 min-w-[220px]" onClick={e => e.stopPropagation()}>
      <p className="text-[11px] text-slate-500 mb-2">{lat.toFixed(5)}, {lon.toFixed(5)}</p>
      <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Nome fermata *"
        className="w-full px-2 py-1.5 mb-1.5 rounded bg-slate-100 text-sm text-slate-900 border border-slate-300 focus:outline-none focus:border-emerald-500" />
      <input value={code} onChange={e => setCode(e.target.value)} placeholder="Codice (opzionale)"
        className="w-full px-2 py-1.5 mb-2 rounded bg-slate-100 text-sm text-slate-900 border border-slate-300 focus:outline-none focus:border-emerald-500" />
      <div className="flex gap-1">
        <button onClick={onCancel}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700">Annulla</button>
        <button onClick={() => { if (!name.trim()) { toast.error("Nome obbligatorio"); return; } onSave({ name: name.trim(), code: code.trim() || undefined, lat, lon }); }}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-white font-medium">Salva</button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Pannello Cluster (Network Engine) — sola lettura + apertura editor
 * ════════════════════════════════════════════════════════════ */
function NeClustersPanel({
  clusters, loading, onReload, onFlyTo, projectId,
}: {
  clusters: GlobalCluster[];
  loading?: boolean;
  onReload: () => Promise<void> | void;
  onFlyTo: (lat: number, lon: number) => void;
  projectId: string;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return clusters;
    return clusters.filter(c => c.name.toLowerCase().includes(q));
  }, [clusters, filter]);

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function toggleHidden(id: string) {
    setHidden(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function showAll() { setHidden(new Set()); }
  function hideAll() { setHidden(new Set(clusters.map(c => c.id))); }

  const [panelConfirm, setPanelConfirm] = useState<ConfirmRequest | null>(null);
  function askDelete(c: GlobalCluster) {
    setPanelConfirm({
      title: `Eliminare il cluster "${c.name}"?`,
      message: "Le fermate associate verranno scollegate.",
      confirmLabel: "Elimina",
      onConfirm: () => handleDelete(c),
    });
  }
  async function handleDelete(c: GlobalCluster) {
    setBusyId(c.id);
    try {
      const r = await fetch(`${getApiBase()}/api/clusters/${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Nodo eliminato");
      await onReload();
    } catch (e: any) {
      toast.error("Errore eliminazione", { description: e?.message });
    } finally { setBusyId(null); }
  }

  async function handleSaveName(c: GlobalCluster) {
    if (!editName.trim()) { toast.error("Nome richiesto"); return; }
    setBusyId(c.id);
    try {
      const r = await fetch(`${getApiBase()}/api/clusters/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Nome aggiornato");
      setEditingId(null);
      await onReload();
    } catch (e: any) {
      toast.error("Errore aggiornamento", { description: e?.message });
    } finally { setBusyId(null); }
  }

  function askBulkDelete() {
    if (clusters.length === 0) return;
    setPanelConfirm({
      title: `Eliminare TUTTI i ${clusters.length} cluster?`,
      message: "Le fermate associate verranno scollegate (ma non cancellate). Operazione NON reversibile.",
      confirmLabel: "Elimina tutti",
      onConfirm: () => handleBulkDelete(),
    });
  }
  async function handleBulkDelete() {
    if (clusters.length === 0) return;
    setBulkDeleting(true);
    let ok = 0, ko = 0;
    const POOL = 8;
    const queue = [...clusters];
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (!c) return;
        try {
          const r = await fetch(`${getApiBase()}/api/clusters/${c.id}`, { method: "DELETE" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          ok++;
        } catch { ko++; }
      }
    }
    await Promise.all(Array.from({ length: POOL }, worker));
    setBulkDeleting(false);
    await onReload();
    if (ko === 0) toast.success(`Eliminati ${ok} cluster`);
    else toast.warning(`Eliminati ${ok} su ${ok + ko} (${ko} errori)`);
  }

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog req={panelConfirm} onClose={() => setPanelConfirm(null)} />
      {/* Header con toolbar */}
      <div className="p-2 border-b border-slate-800 space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-slate-500">{clusters.length} cluster · sorgente Network Engine</p>
          <div className="flex gap-1">
            <button onClick={() => onReload()} title="Ricarica"
              className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">↻</button>
          </div>
        </div>
        <div className="flex gap-1">
          <Link href={`/planning-studio/${projectId}/clusters`}
            className="flex-1 text-[11px] px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white inline-flex items-center justify-center gap-1">
            <Pencil className="w-3 h-3" /> Editor avanzato
          </Link>
          {clusters.length > 0 && (
            <button onClick={askBulkDelete} disabled={bulkDeleting} title="Elimina tutti"
              className="text-[11px] px-2 py-1.5 rounded bg-rose-600/80 hover:bg-rose-500 text-white inline-flex items-center gap-1 disabled:opacity-50">
              {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </button>
          )}
        </div>
        {clusters.length > 0 && (
          <>
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Cerca cluster…"
                className="w-full pl-6 pr-2 py-1 rounded bg-slate-800 text-[11px] border border-slate-700" />
            </div>
            <div className="flex gap-1">
              <button onClick={showAll} className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 inline-flex items-center justify-center gap-1">
                <Eye className="w-3 h-3" /> Mostra tutti
              </button>
              <button onClick={hideAll} className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 inline-flex items-center justify-center gap-1">
                <EyeOff className="w-3 h-3" /> Nascondi tutti
              </button>
            </div>
          </>
        )}
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-auto p-2 space-y-1.5">
        {loading && <p className="text-[11px] text-slate-500 text-center py-4">Caricamento…</p>}
        {!loading && clusters.length === 0 && (
          <p className="text-[11px] text-slate-500 text-center py-6">
            Nessun cluster definito.<br />Apri "Editor avanzato" per crearne uno.
          </p>
        )}
        {!loading && clusters.length > 0 && filtered.length === 0 && (
          <p className="text-[11px] text-slate-500 text-center py-4">Nessun risultato.</p>
        )}
        {filtered.map(c => {
          const valid = (c.stops || []).filter(s => Number.isFinite(s.stopLat) && Number.isFinite(s.stopLon));
          const center = valid.length
            ? {
                lat: valid.reduce((a, s) => a + s.stopLat, 0) / valid.length,
                lon: valid.reduce((a, s) => a + s.stopLon, 0) / valid.length,
              }
            : null;
          const isOpen = expanded.has(c.id);
          const isHidden = hidden.has(c.id);
          const isEditing = editingId === c.id;
          const isBusy = busyId === c.id;
          return (
            <div key={c.id}
              className={`rounded-lg border ${isHidden ? "border-slate-800 opacity-50" : "border-slate-800 hover:border-cyan-700"} bg-slate-900/60 transition`}>
              {/* Riga principale */}
              <div className="flex items-center gap-1.5 p-2">
                <button onClick={() => toggleExpanded(c.id)}
                  className="p-0.5 rounded hover:bg-slate-800 text-slate-400">
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: c.color || "#0ea5e9" }} />
                {isEditing ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") handleSaveName(c);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => handleSaveName(c)}
                    className="flex-1 px-1.5 py-0.5 rounded bg-slate-800 text-xs border border-cyan-500 text-slate-100"
                  />
                ) : (
                  <button onClick={() => center && onFlyTo(center.lat, center.lon)}
                    className="flex-1 min-w-0 text-left text-xs font-medium text-slate-200 truncate hover:text-cyan-300"
                    title={center ? "Centra sulla mappa" : c.name}>
                    {c.name}
                  </button>
                )}
                <span className="text-[10px] text-slate-500 shrink-0">{(c.stops || []).length}</span>
                <div className="flex gap-0.5 shrink-0">
                  <button onClick={() => toggleHidden(c.id)} title={isHidden ? "Mostra" : "Nascondi"}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-300">
                    {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                    title="Rinomina"
                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-300">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => askDelete(c)} disabled={isBusy} title="Elimina"
                    className="p-1 rounded hover:bg-rose-500/10 text-slate-400 hover:text-rose-400 disabled:opacity-50">
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Tags */}
              {(c.isInterchange || c.isLogical) && (
                <div className="flex gap-1 px-2 pb-1.5">
                  {c.isInterchange && <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">CAMBIO</span>}
                  {c.isLogical && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-300">LOGICO</span>}
                </div>
              )}

              {/* Accordion fermate */}
              {isOpen && (
                <div className="border-t border-slate-800 bg-slate-950/40 max-h-48 overflow-auto">
                  {(c.stops || []).length === 0 ? (
                    <p className="text-[10px] text-slate-500 italic px-3 py-2">Nessuna fermata associata</p>
                  ) : (
                    (c.stops || []).map((s, i) => (
                      <button
                        key={`${c.id}-${s.gtfsStopId}-${i}`}
                        onClick={() => Number.isFinite(s.stopLat) && Number.isFinite(s.stopLon) && onFlyTo(s.stopLat, s.stopLon)}
                        className="w-full flex items-center gap-1.5 px-3 py-1 text-[10px] hover:bg-slate-800/60 text-left">
                        <MapPin className="w-2.5 h-2.5 text-slate-500 shrink-0" />
                        <span className="flex-1 truncate text-slate-300">{s.stopName}</span>
                        {s.gtfsStopId && <span className="text-slate-600 text-[9px] shrink-0">#{s.gtfsStopId}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Pannello Depositi (Network Engine) — lista + crea + edita
 * ════════════════════════════════════════════════════════════ */
function NeDepotsPanel({
  depots, loading, onReload, onManage, onFlyTo,
}: {
  depots: GlobalDepot[];
  loading?: boolean;
  onReload: () => Promise<void> | void;
  onManage: () => void;
  onFlyTo: (lat: number, lon: number) => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] text-slate-500">{depots.length} depositi</p>
        <button onClick={() => onReload()} title="Ricarica"
          className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">↻</button>
      </div>
      {/* Sola lettura: i depositi sono strutturali e si gestiscono in Infrastruttura. */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2 text-[10px] text-slate-400 flex items-start gap-1.5">
        <Building2 className="w-3 h-3 shrink-0 mt-0.5 text-orange-400/70" />
        <span>Vista globali + di progetto. I depositi si gestiscono in <button onClick={onManage} className="text-orange-300 hover:underline font-medium">Infrastruttura →</button></span>
      </div>
      {loading && <p className="text-[11px] text-slate-500">Caricamento…</p>}
      {!loading && depots.length === 0 && (
        <p className="text-[11px] text-slate-500">Nessun deposito. Aggiungili in Infrastruttura.</p>
      )}
      {depots.map(d => (
        <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-7 h-7 rounded-md shrink-0 flex items-center justify-center border border-slate-700"
              style={{ backgroundColor: d.color || "#f97316" }}>
              <Building2 className="w-3.5 h-3.5 text-white" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 truncate flex items-center gap-1.5">
                {d.name}
                {d.psProjectId && (
                  <span className="text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 shrink-0"
                    title="Deposito visibile solo in questo progetto">progetto</span>
                )}
              </p>
              <p className="text-[10px] text-slate-500 truncate">
                {d.address || (d.lat != null && d.lon != null ? `${Number(d.lat).toFixed(4)}, ${Number(d.lon).toFixed(4)}` : "—")}
                {d.capacity != null && ` · cap ${d.capacity}`}
              </p>
            </div>
          </div>
          {d.lat != null && d.lon != null && (
            <div className="flex gap-1 mt-1.5">
              <button onClick={() => onFlyTo(Number(d.lat), Number(d.lon))}
                className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">Centra sulla mappa</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Modale modifica/creazione deposito (overlay full-screen)
 * ════════════════════════════════════════════════════════════ */
function DepotEditModal({
  depot, projectId, hidden, onChange, onPickLocation, onClose, onSaved,
}: {
  depot: GlobalDepot;
  /** progetto PS corrente: abilita lo scope "solo questo progetto" */
  projectId?: string;
  hidden?: boolean;
  onChange?: (d: GlobalDepot) => void;
  onPickLocation?: () => void;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const isNew = !depot.id;
  // Scope: nuovo deposito creato DENTRO un progetto → solo progetto di default
  // (un layout sperimentale non deve comparire nello scheduling degli altri).
  const [onlyProject, setOnlyProject] = useState<boolean>(isNew ? !!projectId : !!depot.psProjectId);
  const [name, setName] = useState(depot.name || "");
  const [address, setAddress] = useState(depot.address || "");
  const [color, setColor] = useState(depot.color || "#f97316");
  const [lat, setLat] = useState<string>(depot.lat != null ? String(depot.lat) : "");
  const [lon, setLon] = useState<string>(depot.lon != null ? String(depot.lon) : "");
  const [capacity, setCapacity] = useState<string>(depot.capacity != null ? String(depot.capacity) : "");
  const [saving, setSaving] = useState(false);

  // Sync lat/lon dal parent (es. dopo pick dalla mappa)
  useEffect(() => {
    if (depot.lat != null) setLat(String(depot.lat));
    if (depot.lon != null) setLon(String(depot.lon));
  }, [depot.lat, depot.lon]);

  // Snapshot dei campi nel parent prima di nascondere il modale per il pick
  function handlePickClick() {
    onChange?.({
      ...depot,
      name: name.trim(),
      address: address.trim() || null,
      color,
      capacity: capacity.trim() === "" ? null : Number(capacity),
      lat: lat.trim() === "" ? null : Number(lat),
      lon: lon.trim() === "" ? null : Number(lon),
    });
    onPickLocation?.();
  }

  if (hidden) return null;

  async function save() {
    if (!name.trim()) { toast.error("Nome obbligatorio"); return; }
    const latN = lat.trim() === "" ? null : Number(lat);
    const lonN = lon.trim() === "" ? null : Number(lon);
    if (lat.trim() && (latN == null || !Number.isFinite(latN))) { toast.error("Latitudine non valida"); return; }
    if (lon.trim() && (lonN == null || !Number.isFinite(lonN))) { toast.error("Longitudine non valida"); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        address: address.trim() || null,
        color,
        lat: latN, lon: lonN,
        capacity: capacity.trim() === "" ? null : Number(capacity),
        ...(projectId ? { psProjectId: onlyProject ? projectId : null } : {}),
      };
      // URL assoluto verso l'API: i path relativi in prod finiscono sul dominio web (405)
      const r = await fetch(isNew ? `${getApiBase()}/api/depots` : `${getApiBase()}/api/depots/${depot.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success(isNew ? "Deposito creato" : "Deposito aggiornato");
      await onSaved();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setSaving(false); }
  }

  const [removeConfirm, setRemoveConfirm] = useState<ConfirmRequest | null>(null);
  function askRemove() {
    setRemoveConfirm({
      title: `Eliminare il deposito "${name}"?`,
      message: "Il deposito è condiviso da tutto il sistema (scheduling incluso), non solo da questo progetto.",
      confirmLabel: "Elimina",
      onConfirm: () => remove(),
    });
  }
  async function remove() {
    setSaving(true);
    try {
      const r = await fetch(`${getApiBase()}/api/depots/${depot.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Deposito eliminato");
      await onSaved();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setSaving(false); }
  }

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <ConfirmDialog req={removeConfirm} onClose={() => setRemoveConfirm(null)} />
      <div className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl w-[420px] max-w-[90vw] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-orange-400" />
            {isNew ? "Nuovo deposito" : "Modifica deposito"}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Nome *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Indirizzo</label>
            <input value={address} onChange={e => setAddress(e.target.value)}
              className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Latitudine</label>
              <input value={lat} onChange={e => setLat(e.target.value)} placeholder="41.9028"
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Longitudine</label>
              <input value={lon} onChange={e => setLon(e.target.value)} placeholder="12.4964"
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
          </div>
          {onPickLocation && (
            <button
              type="button"
              onClick={handlePickClick}
              className="w-full px-3 py-2 rounded bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/40 text-orange-300 text-xs font-medium inline-flex items-center justify-center gap-2"
            >
              <MapPin className="w-3.5 h-3.5" />
              Scegli posizione sulla mappa
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Capacità mezzi</label>
              <input value={capacity} onChange={e => setCapacity(e.target.value)} type="number" min={0}
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Colore</label>
              <input value={color} onChange={e => setColor(e.target.value)} type="color"
                className="w-full h-9 rounded bg-slate-900 border border-slate-700 cursor-pointer" />
            </div>
          </div>
          {projectId && (
            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer pt-1">
              <input type="checkbox" checked={onlyProject} onChange={e => setOnlyProject(e.target.checked)}
                className="mt-0.5 accent-orange-500" />
              <span>
                <span className="font-medium">Solo questo progetto</span>
                <span className="block text-[10px] text-slate-500">
                  Spuntato: il deposito è visibile solo qui (layout sperimentale, non compare
                  nello scheduling degli altri progetti). Deselezionato: deposito GLOBALE.
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-2 mt-5">
          {!isNew && (
            <button onClick={askRemove} disabled={saving}
              className="px-3 py-2 rounded bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs font-medium inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Elimina
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={saving}
            className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">Annulla</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-medium inline-flex items-center gap-1">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Salva
          </button>
        </div>
      </div>
    </div>
  );
}
