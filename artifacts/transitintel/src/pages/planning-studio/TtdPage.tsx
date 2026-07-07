/**
 * PlannerStudio — Orario Grafico (TTD, diagramma tempo-distanza / Marey).
 *
 * Strumento di progettazione corse di una linea:
 *   - asse X = tempo (default 04:00–26:00, zoom con rotella / pan con drag sullo sfondo)
 *   - asse Y = distanza progressiva lungo la variante di riferimento
 *     (shape_dist_traveled se disponibile e coerente, altrimenti haversine cumulata)
 *   - corse esistenti come polilinee tempo-distanza (un punto per fermata,
 *     arrivo+partenza per visualizzare le soste)
 *   - hover → tooltip con corsa e orari
 *   - "Moltiplica corsa": cadenzamento da una corsa base → anteprima + creazione batch
 *   - drag orizzontale di una corsa → trasla tutti gli orari di ±N minuti (persistito)
 *   - overlay di altre varianti che condividono ≥2 fermate, proiettate sull'asse
 *     distanza tramite le fermate condivise (segmenti solo dove proiettabili)
 *
 * Tutto SVG custom, nessuna libreria grafica aggiuntiva.
 * Gli orari supportano valori > 24:00 (corse dopo mezzanotte).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import TripCountBadge from "@/components/planning-studio/TripCountBadge";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft, Loader2, ZoomIn, ZoomOut, Maximize2, Minimize2, CopyPlus, Layers,
  X, Check, GitCommitHorizontal, CircleDot, Shuffle,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsVariants, type PsVariant,
  getPsVariant, type PsVariantStop,
  listPsVariantsWithStops,
  listPsStops,
  listPsTrips, type PsTrip,
  getPsStopTimesBulk, type PsStopTime,
  shiftPsTripTimes,
  setPsStopTimes,
  deletePsTrip,
  batchCreatePsTrips, type PsBatchTripInput,
} from "@/lib/planning-studio-api";
import { listPsValidityCategories } from "@/lib/planning-studio-validity-units-api";

/* ════════════════ Helper tempo / distanza ════════════════ */

/** "HH:MM:SS" (anche >24h) → secondi dalla mezzanotte. */
function hmsToSec(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}
const pad2 = (n: number) => String(n).padStart(2, "0");
/** secondi → "HH:MM:SS" (consente >24h). */
function secToHms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
/** secondi → "HH:MM" per etichette. */
function secToHm(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}
/** "HH:MM" → secondi (input utente finestra cadenzamento). */
function hmToSec(t: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/** Distanza haversine in metri tra due coordinate. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Colore GTFS (senza '#') → CSS, con fallback. */
function routeColor(c: string | null | undefined, fallback: string): string {
  if (!c) return fallback;
  return c.startsWith("#") ? c : `#${c}`;
}

/* ════════════════ Tipi interni ════════════════ */

type Pt = { sec: number; dist: number };

interface TripGeom {
  trip: PsTrip;
  sts: PsStopTime[];
  segs: Pt[][];           // segmenti disegnabili (overlay può essere spezzato)
  color: string;
  label: string;          // es. "12 → Stazione"
  isOverlay: boolean;
}

/** Costruisce i segmenti tempo-distanza di una corsa proiettata sulla variante base.
 *  Spezza il segmento quando una fermata intermedia non è proiettabile. */
function buildSegments(sts: PsStopTime[], byStop: Map<string, number>, shiftSec = 0): Pt[][] {
  const segs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const st of sts) {
    const d = byStop.get(st.stopId);
    if (d == null) {
      if (cur.length >= 2) segs.push(cur);
      cur = [];
      continue;
    }
    const a = hmsToSec(st.arrivalTime) + shiftSec;
    const p = hmsToSec(st.departureTime) + shiftSec;
    cur.push({ sec: a, dist: d });
    if (p !== a) cur.push({ sec: p, dist: d });
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

/** Passo dei tick orari in base allo span visibile. */
function tickStep(spanSec: number): number {
  if (spanSec > 10 * 3600) return 3600;
  if (spanSec > 4 * 3600) return 1800;
  if (spanSec > 1.5 * 3600) return 600;
  return 300;
}

/** Pulsante della barra strumenti verticale (icona + etichetta + badge). */
function RailButton({ icon, label, active, disabled, badge, activeCls, onClick, title }: {
  icon: React.ReactNode; label: string; active: boolean; disabled?: boolean;
  badge?: string | null; activeCls: string; onClick: () => void; title?: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`relative flex flex-col items-center gap-1 px-1 py-2 rounded-lg border text-[9px] font-semibold leading-none transition-colors disabled:opacity-30 ${
        active ? activeCls : "border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      }`}>
      {icon}
      <span>{label}</span>
      {badge != null && badge !== "" && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-slate-700 border border-slate-600 text-slate-100 text-[9px] flex items-center justify-center font-mono">
          {badge}
        </span>
      )}
    </button>
  );
}

/* Margini del grafico */
const ML = 150, MT = 26, MR = 16, MB = 8;
const T_MIN = 0, T_MAX = 30 * 3600;          // limiti assoluti del dominio tempo
const DEFAULT_T0 = 4 * 3600, DEFAULT_T1 = 26 * 3600;

/* ════════════════ Pagina ════════════════ */

export default function PlanningStudioTtdPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  const { user } = useAuth();

  /* ─── Selettori: linea / variante / calendario ─── */
  const [routeId, setRouteId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [calendarFilter, setCalendarFilter] = useState("");
  /* filtro per GIORNO dal calendario aziendale: feriale / sabato / festivo.
   * Le corse senza validità configurata restano sempre visibili. */
  const [dayFilter, setDayFilter] = useState<"" | "feriale" | "sabato" | "festivo">("");
  const dayMatch = useCallback((t: { dayTypeCodes?: string[] }) =>
    !dayFilter || !(t.dayTypeCodes?.length) || t.dayTypeCodes.includes(dayFilter), [dayFilter]);

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const routesQ = useQuery({
    queryKey: ["ps", projectId, "routes"],
    queryFn: () => listPsRoutes(projectId),
    enabled: !!projectId,
  });
  // Calendario AZIENDALE (categorie di validità: feriale, festivo, scolastico…)
  // — NON i service_id del GTFS: dopo l'import il filtro deve parlare la
  // lingua dell'azienda, e l'appartenenza vive in ps_trip_category_validity.
  const calendarsQ = useQuery({
    queryKey: ["ps", "validity-categories"],
    queryFn: () => listPsValidityCategories(),
    enabled: !!projectId,
  });
  // Corse appartenenti alla categoria selezionata (set di tripId)
  const catTripsQ = useQuery({
    queryKey: ["ps", projectId, "trips", "by-category", calendarFilter],
    queryFn: () => listPsTrips(projectId, { categoryId: calendarFilter }),
    enabled: !!projectId && !!calendarFilter,
  });
  const catTripSet = useMemo(() => new Set((catTripsQ.data ?? []).map(t => t.id)), [catTripsQ.data]);
  const variantsQ = useQuery({
    queryKey: ["ps", projectId, "variants", routeId],
    queryFn: () => listPsVariants(projectId, routeId),
    enabled: !!projectId && !!routeId,
  });
  useEffect(() => { setVariantId(""); }, [routeId]);

  /* ─── Variante base: fermate ordinate → asse distanza ─── */
  const baseVariantQ = useQuery({
    queryKey: ["ps", projectId, "variant", variantId],
    queryFn: () => getPsVariant(projectId, variantId),
    enabled: !!projectId && !!variantId,
  });

  // Asse Y: due modalità.
  //  - "equidistante" (default): fermate a passo uniforme → asse compatto e leggibile;
  //  - "distanza": proporzionale ai km reali (shape_dist_traveled se monotona,
  //    altrimenti cumulata haversine).
  const [yMode, setYMode] = useState<"equidistante" | "distanza">("equidistante");
  const baseAxis = useMemo(() => {
    const stops = baseVariantQ.data?.stops ?? [];
    if (stops.length < 2) return null;
    let dists: number[];
    if (yMode === "equidistante") {
      dists = stops.map((_, i) => i);
    } else {
      const sdt = stops.map(s => s.shapeDistTraveled);
      const sdtOk =
        sdt.every(d => d != null && Number.isFinite(d)) &&
        sdt.every((d, i) => i === 0 || (d as number) >= (sdt[i - 1] as number)) &&
        (sdt[sdt.length - 1] as number) > 0;
      if (sdtOk) {
        dists = sdt.map(d => d as number);
      } else {
        dists = [0];
        for (let i = 1; i < stops.length; i++) {
          dists.push(dists[i - 1] + haversineM(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon));
        }
      }
    }
    const byStop = new Map<string, number>();
    stops.forEach((s, i) => { if (!byStop.has(s.stopId)) byStop.set(s.stopId, dists[i]); });
    return {
      stops: stops.map((s, i) => ({ ...s, dist: dists[i] })),
      byStop,
      total: dists[dists.length - 1] || 1,
    };
  }, [baseVariantQ.data, yMode]);


  /* ─── Corse della variante base + stop times (caricamento a lotti) ─── */
  const tripsQ = useQuery({
    queryKey: ["ps", projectId, "trips", "", variantId],
    queryFn: () => listPsTrips(projectId, { variantId }),
    enabled: !!projectId && !!variantId,
  });

  const [stMap, setStMap] = useState<Record<string, PsStopTime[]>>({});
  useEffect(() => { setStMap({}); }, [variantId]);
  useEffect(() => {
    const trips = tripsQ.data ?? [];
    const missing = trips.filter(t => !(t.id in stMap)).map(t => t.id).slice(0, 400);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      // una sola chiamata bulk: la versione corsa-per-corsa faceva 429
      try {
        const byTrip = await getPsStopTimesBulk(projectId, missing);
        if (cancelled) return;
        setStMap(prev => {
          const next = { ...prev };
          for (const id of missing) next[id] = byTrip[id] ?? [];
          return next;
        });
      } catch { /* riproverà al prossimo render */ }
    })();
    return () => { cancelled = true; };
    // NB: stMap nelle deps → carica i lotti successivi finché tutte le corse
    // hanno gli orari (prima si fermava al primo lotto: corse "invisibili").
  }, [tripsQ.data, projectId, stMap]);

  /* ─── Overlay: TUTTE le altre varianti (con conteggio fermate in comune) ─── */
  const candidatesQ = useQuery({
    queryKey: ["ps", projectId, "ttd-candidates", variantId],
    enabled: !!projectId && !!variantId && !!baseVariantQ.data && !!routesQ.data,
    staleTime: 60_000,
    queryFn: async () => {
      const baseStopIds = new Set((baseVariantQ.data?.stops ?? []).map(s => s.stopId));
      const routesById = new Map((routesQ.data ?? []).map(r => [r.id, r]));
      // UNA sola chiamata bulk: la versione linea-per-linea + variante-per-
      // variante generava centinaia di richieste al mount → 429 su tutta l'API.
      const all = await listPsVariantsWithStops(projectId);
      const out: { route: PsRoute; variant: PsVariant; stops: PsVariantStop[]; shared: number }[] = [];
      for (const { variant, stops } of all) {
        if (variant.id === variantId) continue;
        const route = routesById.get(variant.routeId);
        if (!route) continue;
        // NIENTE filtro: si possono accendere anche linee SENZA fermate in
        // comune (il conteggio resta come indicatore di coincidenza).
        const shared = stops.filter(s => baseStopIds.has(s.stopId)).length;
        out.push({ route, variant, stops, shared });
      }
      out.sort((x, y) => y.shared - x.shared);
      return out;
    },
  });

  const [overlayOn, setOverlayOn] = useState<Set<string>>(new Set());
  const [overlayData, setOverlayData] = useState<Record<string, { trips: PsTrip[]; st: Record<string, PsStopTime[]> }>>({});
  /* ─── Area di lavoro: strumento attivo nella barra laterale (un pannello alla volta) ─── */
  const [activeTool, setActiveTool] = useState<null | "layers" | "conn" | "sync" | "mult">(null);
  /* ricerca nel pannello Linee (codice linea o codice percorso) */
  const [lineSearch, setLineSearch] = useState("");
  const toggleTool = (t: NonNullable<typeof activeTool>) => setActiveTool(cur => (cur === t ? null : t));
  useEffect(() => { setOverlayOn(new Set()); setOverlayData({}); }, [variantId]);
  useEffect(() => {
    const missing = Array.from(overlayOn).filter(id => !(id in overlayData));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const vid of missing) {
        try {
          const trips = (await listPsTrips(projectId, { variantId: vid })).slice(0, 80);
          // una sola chiamata bulk per variante (niente fan-out → niente 429)
          const st = await getPsStopTimesBulk(projectId, trips.map(t => t.id));
          if (cancelled) return;
          setOverlayData(prev => ({ ...prev, [vid]: { trips, st } }));
        } catch { /* variante non caricabile: la ignoriamo */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayOn, projectId]);

  /* ─── F4: asse UNIONE — con altre linee attive l'asse Y elenca TUTTE le
     fermate (base + overlay, inserite dopo l'ultima fermata condivisa nella
     sequenza), e le fermate COMUNI a ≥2 linee sono marcate come interscambi.
     Attivo in modalità equidistante (in "distanze reali" resta l'asse base). ─── */
  const unionAxis = useMemo(() => {
    if (!baseAxis || yMode !== "equidistante") return null;
    const activeCands = (candidatesQ.data ?? []).filter(c => overlayOn.has(c.variant.id));
    if (activeCands.length === 0) return null;
    const order: { stopId: string; stopName: string }[] =
      baseAxis.stops.map(s => ({ stopId: s.stopId, stopName: s.stopName }));
    const pos = new Map<string, number>();
    order.forEach((s2, i) => pos.set(s2.stopId, i));
    const lineHits = new Map<string, number>();
    for (const s2 of order) lineHits.set(s2.stopId, 1);
    for (const cand of activeCands) {
      const seen = new Set<string>();
      let insertAfter = -1;
      for (const st of cand.stops) {
        if (pos.has(st.stopId)) {
          insertAfter = pos.get(st.stopId)!;
          if (!seen.has(st.stopId)) lineHits.set(st.stopId, (lineHits.get(st.stopId) ?? 1) + 1);
        } else {
          const at = insertAfter + 1;
          order.splice(at, 0, { stopId: st.stopId, stopName: st.stopName });
          pos.clear();
          order.forEach((s3, i) => pos.set(s3.stopId, i));
          lineHits.set(st.stopId, 1);
          insertAfter = at;
        }
        seen.add(st.stopId);
      }
    }
    const byStop = new Map<string, number>();
    order.forEach((s2, i) => byStop.set(s2.stopId, i));
    const shared = new Set(
      [...lineHits.entries()].filter(([, c2]) => c2 >= 2).map(([id]) => id),
    );
    return {
      stops: order.map((s2, i) => ({ stopId: s2.stopId, stopName: s2.stopName, dist: i })),
      byStop,
      total: Math.max(1, order.length - 1),
      shared,
    };
  }, [baseAxis, yMode, candidatesQ.data, overlayOn]);
  // Asse attivo per il disegno: unione se disponibile, altrimenti base.
  const axis = unionAxis ?? (baseAxis ? { ...baseAxis, shared: new Set<string>() } : null);


  /* ─── Fascia oraria esplicita (filtro vista) ─── */
  const [winFrom, setWinFrom] = useState("04:00");
  const [winTo, setWinTo] = useState("26:00");

  /* ─── Fullscreen ─── */
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void pageRef.current?.requestFullscreen();
  }

  /* ─── Nodi: fermata → nodo (cluster se assegnato, altrimenti la fermata stessa).
     Le coincidenze valgono su QUALSIASI nodo condiviso, di cambio o meno. ─── */
  const stopsQ = useQuery({
    queryKey: ["ps", projectId, "stops"],
    queryFn: () => listPsStops(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  const nodeOfStop = useMemo(() => {
    const m = new Map<string, string>();
    for (const st of stopsQ.data ?? []) m.set(st.id, (st as any).clusterId || st.id);
    return m;
  }, [stopsQ.data]);

  /* ─── Coincidenze: parametri ─── */
  const [showConn, setShowConn] = useState(true);
  const [connMin, setConnMin] = useState("2");
  const [connMax, setConnMax] = useState("10");

  /* ─── Viewport (dominio tempo) + dimensioni ─── */
  const [tDomain, setTDomain] = useState<{ t0: number; t1: number }>({ t0: DEFAULT_T0, t1: DEFAULT_T1 });
  const domainRef = useRef(tDomain);
  domainRef.current = tDomain;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.max(320, r.width), h: Math.max(240, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = Math.max(50, size.w - ML - MR);
  const innerH = Math.max(50, size.h - MT - MB);
  const xOf = (sec: number) => ML + ((sec - tDomain.t0) / (tDomain.t1 - tDomain.t0)) * innerW;
  const yOf = (dist: number) => MT + (dist / (axis?.total || 1)) * innerH;

  /** Imposta il dominio tempo con clamp su limiti e span min/max. */
  function setDomainClamped(t0: number, t1: number) {
    let span = t1 - t0;
    span = Math.min(Math.max(span, 900), T_MAX - T_MIN); // 15 min .. 30 h
    if (t0 < T_MIN) { t0 = T_MIN; }
    if (t0 + span > T_MAX) { t0 = T_MAX - span; }
    setTDomain({ t0, t1: t0 + span });
  }
  function zoomAt(factor: number, centerSec?: number) {
    const { t0, t1 } = domainRef.current;
    const c = centerSec ?? (t0 + t1) / 2;
    setDomainClamped(c - (c - t0) * factor, c + (t1 - c) * factor);
  }

  // Zoom con rotella: listener nativo non-passive (React registra wheel passive)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const { t0, t1 } = domainRef.current;
      const sec = t0 + ((px - ML) / Math.max(1, rect.width - ML - MR)) * (t1 - t0);
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, sec);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRef.current]);

  /* ─── Drag: pan sfondo / trasla corsa ─── */
  const dragRef = useRef<
    | { mode: "pan"; startX: number; t0: number; t1: number }
    | { mode: "trip"; tripId: string; startX: number }
    | { mode: "node"; tripId: string; stIdx: number; startX: number }
    | null
  >(null);
  const [tripDrag, setTripDrag] = useState<{ tripId: string; deltaSec: number } | null>(null);
  const tripDragRef = useRef(tripDrag);
  tripDragRef.current = tripDrag;
  /* corsa selezionata col DOPPIO CLICK: evidenziata + azioni elimina/moltiplica */
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  /* ── EDITING LOCALE: le modifiche (trasla corsa, sposta nodo, elimina,
   *    copia) restano in memoria; "Annulla" le ripercorre a ritroso e
   *    "Salva modifiche" le applica al server in un colpo. ── */
  type TtdOp =
    | { kind: "shift"; tripId: string; deltaMin: number }
    | { kind: "node"; tripId: string; stIdx: number; deltaMin: number }
    | { kind: "delete"; tripId: string }
    | { kind: "copy"; tempId: string; baseTripId: string };
  const [pendingOps, setPendingOps] = useState<TtdOp[]>([]);
  const [deletedTripIds, setDeletedTripIds] = useState<Set<string>>(new Set());
  const [localCopies, setLocalCopies] = useState<PsTrip[]>([]);
  const [clipboardTripId, setClipboardTripId] = useState<string | null>(null);
  const [savingOps, setSavingOps] = useState(false);
  const lastPointerSecRef = useRef<number | null>(null);
  /* doppio click manuale (tempo+posizione): e.detail non è affidabile sui pointer events */
  const lastClickRef = useRef<{ t: number; x: number; y: number; key: string } | null>(null);

  /* corse con modifiche locali NON salvate: disegnate tratteggiate */
  const modifiedTripIds = useMemo(() => {
    const s = new Set<string>();
    for (const op of pendingOps) {
      if (op.kind === "shift" || op.kind === "node") s.add(op.tripId);
      else if (op.kind === "copy") s.add(op.tempId);
    }
    return s;
  }, [pendingOps]);

  const shiftStMapLocal = (tripId: string, deltaMin: number) => {
    setStMap(prev => {
      const sts = prev[tripId];
      if (!sts) return prev;
      return { ...prev, [tripId]: sts.map(st => ({
        ...st,
        arrivalTime: secToHms(hmsToSec(st.arrivalTime) + deltaMin * 60),
        departureTime: secToHms(hmsToSec(st.departureTime) + deltaMin * 60),
      })) };
    });
  };
  const shiftNodeLocal = (tripId: string, stIdx: number, deltaMin: number) => {
    setStMap(prev => {
      const sts = prev[tripId];
      if (!sts) return prev;
      return { ...prev, [tripId]: sts.map((st, i) => i === stIdx ? {
        ...st,
        arrivalTime: secToHms(hmsToSec(st.arrivalTime) + deltaMin * 60),
        departureTime: secToHms(hmsToSec(st.departureTime) + deltaMin * 60),
      } : st) };
    });
  };

  const undoLast = useCallback(() => {
    setPendingOps(prev => {
      const op = prev[prev.length - 1];
      if (!op) return prev;
      if (op.kind === "shift") shiftStMapLocal(op.tripId, -op.deltaMin);
      else if (op.kind === "node") shiftNodeLocal(op.tripId, op.stIdx, -op.deltaMin);
      else if (op.kind === "delete") setDeletedTripIds(d => { const n = new Set(d); n.delete(op.tripId); return n; });
      else if (op.kind === "copy") {
        setLocalCopies(c => c.filter(t => t.id !== op.tempId));
        setStMap(m => { const n = { ...m }; delete n[op.tempId]; return n; });
        setSelectedTripId(cur => (cur === op.tempId ? null : cur));
      }
      return prev.slice(0, -1);
    });
  }, []);
  /* drag di un SINGOLO nodo (fermata × orario): sposta l'orario di transito */
  const [nodeDrag, setNodeDrag] = useState<{ tripId: string; stIdx: number; deltaSec: number } | null>(null);
  const nodeDragRef = useRef(nodeDrag);
  nodeDragRef.current = nodeDrag;

  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  const shiftMut = useMutation({
    mutationFn: ({ tripId, deltaMinutes }: { tripId: string; deltaMinutes: number }) =>
      shiftPsTripTimes(projectId, tripId, deltaMinutes),
    onSuccess: (_r, vars) => {
      // Applica lo shift in locale senza ricaricare tutti gli stop times
      setStMap(prev => {
        const sts = prev[vars.tripId];
        if (!sts) return prev;
        return {
          ...prev,
          [vars.tripId]: sts.map(s => ({
            ...s,
            arrivalTime: secToHms(hmsToSec(s.arrivalTime) + vars.deltaMinutes * 60),
            departureTime: secToHms(hmsToSec(s.departureTime) + vars.deltaMinutes * 60),
          })),
        };
      });
      setTripDrag(null);
      toast.success(`Corsa traslata di ${vars.deltaMinutes > 0 ? "+" : ""}${vars.deltaMinutes} min`);
    },
    onError: (e: any) => {
      setTripDrag(null);
      toast.error(e?.message || "Errore nello shift della corsa");
    },
  });

  /* 💾 Salva TUTTE le modifiche locali (elimina, copie, orari) in un colpo */
  const saveAllOps = useCallback(async () => {
    if (pendingOps.length === 0) return;
    setSavingOps(true);
    try {
      // 1. eliminazioni
      for (const id of deletedTripIds) await deletePsTrip(projectId, id);
      // 2. copie → batch create con gli orari locali; baseTripId = corsa
      //    d'origine così la copia EREDITA validità (day-type + categorie)
      const baseByTemp = new Map<string, string>();
      for (const op of pendingOps) if (op.kind === "copy") baseByTemp.set(op.tempId, op.baseTripId);
      const copies = localCopies.filter(t => !deletedTripIds.has(t.id));
      if (copies.length > 0) {
        await batchCreatePsTrips(projectId, copies.map(t => ({
          routeId: (t as any).routeId, variantId: (t as any).variantId,
          calendarId: (t as any).calendarId ?? null,
          headsign: t.headsign ?? null, shortName: t.shortName ?? null,
          direction: (t as any).direction ?? 0,
          baseTripId: baseByTemp.get(t.id),
          stopTimes: (stMap[t.id] ?? []).map(st => ({
            stopId: st.stopId, arrivalTime: st.arrivalTime, departureTime: st.departureTime,
          })),
        })));
      }
      // 3. orari modificati (corse reali toccate da shift/node, non eliminate)
      const touched = new Set<string>();
      for (const op of pendingOps) {
        if ((op.kind === "shift" || op.kind === "node")
            && !deletedTripIds.has(op.tripId)
            && !localCopies.some(c => c.id === op.tripId)) touched.add(op.tripId);
      }
      for (const id of touched) {
        const sts = stMap[id] ?? [];
        if (sts.length) await setPsStopTimes(projectId, id, sts.map(st => ({
          stopId: st.stopId, arrivalTime: st.arrivalTime, departureTime: st.departureTime,
        })));
      }
      setPendingOps([]); setDeletedTripIds(new Set()); setLocalCopies([]); setSelectedTripId(null);
      // invalidate AMPIA: aggiorna anche la sezione Corse (chiavi con routeId/
      // categoria) e il filtro per categoria del TTD, non solo questa variante
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success("Modifiche salvate", {
        description: `${touched.size} corse aggiornate · ${copies.length} copie create · ${deletedTripIds.size} eliminate`,
      });
    } catch (e: any) {
      toast.error("Errore nel salvataggio", { description: e?.message });
    } finally {
      setSavingOps(false);
    }
  }, [pendingOps, deletedTripIds, localCopies, stMap, projectId, variantId, qc]);



  function svgPos(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const pos = svgPos(e);
    const nodeEl = (e.target as Element).closest?.("[data-node]");
    const nodeAttr = nodeEl?.getAttribute("data-node");
    const tripEl = (e.target as Element).closest?.("[data-trip]");
    const tripId = tripEl?.getAttribute("data-trip");
    // DOPPIO CLICK: seleziona la corsa, niente drag. Rilevato A MANO
    // (tempo+posizione): sui pointerdown e.detail è sempre 0 in Chromium,
    // quindi e.detail>=2 non scattava mai.
    const clickKey = nodeAttr?.split("|")[0] || tripId || "";
    const prevClick = lastClickRef.current;
    lastClickRef.current = { t: Date.now(), x: pos.x, y: pos.y, key: clickKey };
    const isDouble = !!clickKey && !!prevClick && prevClick.key === clickKey
      && Date.now() - prevClick.t < 450
      && Math.hypot(pos.x - prevClick.x, pos.y - prevClick.y) < 8;
    if (isDouble || e.detail >= 2) {
      const id = clickKey || null;
      setSelectedTripId(cur => (id && id !== cur ? id : null));
      dragRef.current = null;
      lastClickRef.current = null;
      return;
    }
    if (nodeAttr) {
      const [nTrip, nIdx] = nodeAttr.split("|");
      if (stMap[nTrip]) dragRef.current = { mode: "node", tripId: nTrip, stIdx: Number(nIdx), startX: pos.x };
    } else if (tripId && stMap[tripId]) {
      dragRef.current = { mode: "trip", tripId, startX: pos.x };
    } else {
      dragRef.current = { mode: "pan", startX: pos.x, t0: tDomain.t0, t1: tDomain.t1 };
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    {
      const p = svgPos(e);
      const span = tDomain.t1 - tDomain.t0;
      lastPointerSecRef.current = tDomain.t0 + ((p.x - ML) / innerW) * span;
    }
    const d = dragRef.current;
    if (!d) return;
    const pos = svgPos(e);
    if (d.mode === "pan") {
      const span = d.t1 - d.t0;
      const dSec = ((d.startX - pos.x) / innerW) * span;
      setDomainClamped(d.t0 + dSec, d.t1 + dSec);
    } else if (d.mode === "node") {
      const span = tDomain.t1 - tDomain.t0;
      const deltaSec = ((pos.x - d.startX) / innerW) * span;
      setNodeDrag({ tripId: d.tripId, stIdx: d.stIdx, deltaSec });
      setHover(null);
    } else {
      const span = tDomain.t1 - tDomain.t0;
      const deltaSec = ((pos.x - d.startX) / innerW) * span;
      setTripDrag({ tripId: d.tripId, deltaSec });
      setHover(null);
    }
  }
  function onPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.mode === "node") {
      const preview = nodeDragRef.current;
      const deltaMin = Math.round((preview?.deltaSec ?? 0) / 60);
      if (!preview || deltaMin === 0) { setNodeDrag(null); return; }
      const sts = stMap[d.tripId] ?? [];
      const st = sts[d.stIdx];
      if (!st) { setNodeDrag(null); return; }
      const newArr = hmsToSec(st.arrivalTime) + deltaMin * 60;
      const newDep = hmsToSec(st.departureTime) + deltaMin * 60;
      const prevDep = d.stIdx > 0 ? hmsToSec(sts[d.stIdx - 1].departureTime) : -1;
      const nextArr = d.stIdx < sts.length - 1 ? hmsToSec(sts[d.stIdx + 1].arrivalTime) : Infinity;
      if (newArr < 0) { setNodeDrag(null); toast.error("Orario prima di 00:00"); return; }
      if (newArr <= prevDep || newDep >= nextArr) {
        setNodeDrag(null);
        toast.error("Ordine fermate violato", { description: "L'orario deve restare tra la fermata precedente e la successiva." });
        return;
      }
      shiftNodeLocal(d.tripId, d.stIdx, deltaMin);
      setPendingOps(prev => [...prev, { kind: "node", tripId: d.tripId, stIdx: d.stIdx, deltaMin }]);
      setNodeDrag(null);
      return;
    }
    if (d?.mode !== "trip") return;
    const preview = tripDragRef.current;
    const deltaMinutes = Math.round((preview?.deltaSec ?? 0) / 60);
    if (!preview || deltaMinutes === 0) { setTripDrag(null); return; }
    const sts = stMap[d.tripId] ?? [];
    const minSec = Math.min(...sts.map(s => hmsToSec(s.arrivalTime)));
    if (minSec + deltaMinutes * 60 < 0) {
      setTripDrag(null);
      toast.error("Lo shift porterebbe orari prima di 00:00");
      return;
    }
    shiftStMapLocal(d.tripId, deltaMinutes);
    setPendingOps(prev => [...prev, { kind: "shift", tripId: d.tripId, deltaMin: deltaMinutes }]);
    setTripDrag(null);
  }

  /* ─── Moltiplica corsa (cadenzamento) ─── */
  const multOpen = activeTool === "mult";
  const [multBaseTripId, setMultBaseTripId] = useState("");
  const [multHeadway, setMultHeadway] = useState(15);
  const [multFrom, setMultFrom] = useState("06:00");
  const [multTo, setMultTo] = useState("09:00");
  useEffect(() => { setMultBaseTripId(""); }, [variantId]);

  // Corse base visibili (filtrate per calendario)
  const visibleTrips = useMemo(() => {
    let trips = tripsQ.data ?? [];
    if (calendarFilter) trips = trips.filter(t => catTripSet.has(t.id));
    if (dayFilter) trips = trips.filter(dayMatch);
    trips = trips.filter(t => !deletedTripIds.has(t.id));
    return [...trips, ...localCopies.filter(t => !deletedTripIds.has(t.id))];
  }, [tripsQ.data, calendarFilter, catTripSet, dayMatch, deletedTripIds, localCopies]);

  /* Ctrl+C copia la corsa selezionata · Ctrl+V la incolla alla posizione del
   * mouse (o +60') come COPIA LOCALE · Ctrl+Z annulla l'ultima modifica */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z") { e.preventDefault(); undoLast(); return; }
      if (e.key.toLowerCase() === "c" && selectedTripId) {
        e.preventDefault();
        setClipboardTripId(selectedTripId);
        toast.info("Corsa copiata", { description: "Ctrl+V per incollarla dove si trova il mouse." });
        return;
      }
      if (e.key.toLowerCase() === "v" && clipboardTripId) {
        e.preventDefault();
        const base = visibleTrips.find(t => t.id === clipboardTripId);
        const sts = stMap[clipboardTripId];
        if (!base || !sts || sts.length === 0) { toast.error("Niente da incollare"); return; }
        const firstDep = hmsToSec(sts[0].departureTime);
        const target = lastPointerSecRef.current;
        const deltaMin = target != null ? Math.round((target - firstDep) / 60) : 60;
        if (firstDep + deltaMin * 60 < 0) { toast.error("Orario prima di 00:00"); return; }
        const tempId = `copy-${Date.now()}`;
        const copy: PsTrip = { ...base, id: tempId } as PsTrip;
        setLocalCopies(prev => [...prev, copy]);
        setStMap(prev => ({ ...prev, [tempId]: sts.map(st => ({
          ...st, tripId: tempId,
          arrivalTime: secToHms(hmsToSec(st.arrivalTime) + deltaMin * 60),
          departureTime: secToHms(hmsToSec(st.departureTime) + deltaMin * 60),
        })) }));
        setPendingOps(prev => [...prev, { kind: "copy", tempId, baseTripId: clipboardTripId }]);
        setSelectedTripId(tempId);
        toast.success(`Corsa incollata (${deltaMin > 0 ? "+" : ""}${deltaMin} min)`, { description: "Copia locale: Salva modifiche per confermarla." });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTripId, clipboardTripId, visibleTrips, stMap, undoLast]);

  // Ordinate per prima partenza (per il selettore della corsa base)
  const tripsSorted = useMemo(() => {
    return [...visibleTrips].sort((a, b) => {
      const fa = stMap[a.id]?.[0]?.departureTime ?? "99:99:99";
      const fb = stMap[b.id]?.[0]?.departureTime ?? "99:99:99";
      return fa.localeCompare(fb);
    });
  }, [visibleTrips, stMap]);

  // Anteprima cadenzamento: profilo tempi relativo della corsa base traslato su N partenze
  const multPreview = useMemo(() => {
    if (!multOpen || !multBaseTripId) return null;
    const baseSts = stMap[multBaseTripId];
    const baseTrip = (tripsQ.data ?? []).find(t => t.id === multBaseTripId);
    if (!baseSts || baseSts.length < 2 || !baseTrip) return null;
    const from = hmToSec(multFrom), to = hmToSec(multTo);
    if (from == null || to == null || to < from) return null;
    const headway = Math.round(multHeadway);
    if (!Number.isFinite(headway) || headway < 1) return null;
    const t0 = hmsToSec(baseSts[0].departureTime);
    const rel = baseSts.map(s => ({
      stopId: s.stopId,
      relArr: hmsToSec(s.arrivalTime) - t0,
      relDep: hmsToSec(s.departureTime) - t0,
      timepoint: s.timepoint,
    }));
    const runs: { startSec: number; stopTimes: { stopId: string; arrivalTime: string; departureTime: string; timepoint: number }[] }[] = [];
    for (let start = from; start <= to && runs.length < 200; start += headway * 60) {
      if (start === t0) continue; // evita un duplicato esatto della corsa base
      runs.push({
        startSec: start,
        stopTimes: rel.map(r => ({
          stopId: r.stopId,
          arrivalTime: secToHms(start + r.relArr),
          departureTime: secToHms(start + r.relDep),
          timepoint: r.timepoint,
        })),
      });
    }
    return { baseTrip, runs };
  }, [multOpen, multBaseTripId, multHeadway, multFrom, multTo, stMap, tripsQ.data]);

  const createMut = useMutation({
    mutationFn: (trips: PsBatchTripInput[]) => batchCreatePsTrips(projectId, trips),
    onSuccess: (r) => {
      toast.success(`${r.count} corse create`);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      setActiveTool(null);
    },
    onError: (e: any) => toast.error(e?.message || "Errore nella creazione delle corse"),
  });

  function createMultiplied() {
    if (!multPreview || multPreview.runs.length === 0) return;
    const bt = multPreview.baseTrip;
    createMut.mutate(multPreview.runs.map(run => ({
      routeId: bt.routeId,
      variantId: bt.variantId,
      calendarId: bt.calendarId ?? null,
      headsign: bt.headsign ?? null,
      direction: bt.direction,
      serviceLabel: bt.serviceLabel ?? null,
      baseTripId: bt.id, // eredita validità (day-type + categorie) dalla corsa base
      stopTimes: run.stopTimes,
    })));
  }

  /* ─── Geometrie da disegnare ─── */
  const routes = routesQ.data ?? [];
  const baseRoute = routes.find(r => r.id === routeId) ?? null;
  const baseColor = routeColor(baseRoute?.color, "#f59e0b"); // amber di default

  // Un colore DISTINTO per ogni linea attiva: usa il colore della linea se
  // definito e non in conflitto, altrimenti pesca dalla palette.
  const OVERLAY_PALETTE = ["#22d3ee", "#a78bfa", "#f472b6", "#4ade80", "#fb923c", "#f87171", "#facc15", "#38bdf8", "#c084fc", "#34d399"];
  const colorByRoute = useMemo(() => {
    const used = new Set<string>([baseColor.toLowerCase()]);
    const m = new Map<string, string>();
    let pi = 0;
    const activeRouteIds: string[] = [];
    for (const c of candidatesQ.data ?? []) {
      if (!overlayOn.has(c.variant.id)) continue;
      if (!activeRouteIds.includes(c.route.id)) activeRouteIds.push(c.route.id);
    }
    for (const rid of activeRouteIds) {
      const r = (routesQ.data ?? []).find(x => x.id === rid);
      let col = routeColor(r?.color, "");
      if (!col || used.has(col.toLowerCase())) {
        while (pi < OVERLAY_PALETTE.length && used.has(OVERLAY_PALETTE[pi].toLowerCase())) pi++;
        col = OVERLAY_PALETTE[pi % OVERLAY_PALETTE.length];
        pi++;
      }
      used.add(col.toLowerCase());
      m.set(rid, col);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesQ.data, overlayOn, routesQ.data, baseColor]);

  const baseGeoms: TripGeom[] = useMemo(() => {
    if (!axis) return [];
    const out: TripGeom[] = [];
    const seen = new Set<string>();
    for (const t of visibleTrips) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const sts = stMap[t.id];
      if (!sts || sts.length < 2) continue;
      // durante il drag la corsa ORIGINALE resta ferma: la posizione nuova è
      // mostrata da un'anteprima tratteggiata (vedi render)
      const segs = buildSegments(sts, axis.byStop);
      if (segs.length === 0) continue;
      out.push({
        trip: t, sts, segs, color: baseColor, isOverlay: false,
        label: `${baseRoute?.shortName ?? ""} ${t.shortName || t.headsign || t.id.slice(0, 8)}`.trim(),
      });
    }
    return out;
  }, [visibleTrips, stMap, axis, baseColor, baseRoute]);

  const overlayGeoms: TripGeom[] = useMemo(() => {
    if (!axis) return [];
    const out: TripGeom[] = [];
    for (const cand of candidatesQ.data ?? []) {
      if (!overlayOn.has(cand.variant.id)) continue;
      const data = overlayData[cand.variant.id];
      if (!data) continue;
      const color = colorByRoute.get(cand.route.id) ?? routeColor(cand.route.color, "#22d3ee");
      let trips = data.trips;
      if (calendarFilter) trips = trips.filter(t => catTripSet.has(t.id));
    if (dayFilter) trips = trips.filter(dayMatch);
      for (const t of trips) {
        const sts = data.st[t.id];
        if (!sts || sts.length < 2) continue;
        const segs = buildSegments(sts, axis.byStop);
        if (segs.length === 0) continue;
        out.push({
          trip: t, sts, segs, color, isOverlay: true,
          label: `${cand.route.shortName} ${t.shortName || t.headsign || t.id.slice(0, 8)}`.trim(),
        });
      }
    }
    return out;
  }, [candidatesQ.data, overlayOn, overlayData, axis, calendarFilter, catTripSet, dayMatch, colorByRoute]);

  // Anteprima cadenzamento come geometrie tratteggiate
  const previewGeoms: Pt[][][] = useMemo(() => {
    if (!axis || !multPreview) return [];
    return multPreview.runs.map(run =>
      buildSegments(
        run.stopTimes.map(s => ({ ...s, tripId: "", stopSeq: 0, stopName: "", pickupType: 0, dropOffType: 0, shapeDistTraveled: null })) as PsStopTime[],
        axis.byStop,
      ),
    );
  }, [axis, multPreview]);

  /* ─── Coincidenze ai nodi condivisi (stesso cluster O stessa fermata) ───
     Direzioni: base arriva → altra linea parte, e viceversa, con attesa in
     [connMin, connMax] minuti. Z = numero di coincidenze realizzate. ─── */
  type ConnPt = { t: number; dist: number; wait: number; label: string };
  const connections = useMemo<{ pts: ConnPt[]; z: number }>(() => {
    if (!showConn || !axis || overlayGeoms.length === 0 || baseGeoms.length === 0) return { pts: [], z: 0 };
    const minW = Math.max(0, Number(connMin) || 0) * 60;
    const maxW = Math.max(minW, (Number(connMax) || 10) * 60);
    // nodo → posizione y sulla base (prima fermata base del nodo)
    const nodeDist = new Map<string, number>();
    for (const st of axis.stops) {
      const n = nodeOfStop.get(st.stopId) ?? st.stopId;
      if (!nodeDist.has(n)) nodeDist.set(n, st.dist);
    }
    // eventi base per nodo
    const baseArr = new Map<string, { t: number; label: string }[]>();
    const baseDep = new Map<string, { t: number; label: string }[]>();
    for (const g of baseGeoms) {
      for (const st of g.sts) {
        const n = nodeOfStop.get(st.stopId) ?? st.stopId;
        if (!nodeDist.has(n)) continue;
        if (!baseArr.has(n)) baseArr.set(n, []);
        if (!baseDep.has(n)) baseDep.set(n, []);
        baseArr.get(n)!.push({ t: hmsToSec(st.arrivalTime), label: g.label });
        baseDep.get(n)!.push({ t: hmsToSec(st.departureTime), label: g.label });
      }
    }
    const pts: ConnPt[] = [];
    for (const g of overlayGeoms) {
      for (const st of g.sts) {
        const n = nodeOfStop.get(st.stopId) ?? st.stopId;
        const d = nodeDist.get(n);
        if (d == null) continue;
        const oArr = hmsToSec(st.arrivalTime), oDep = hmsToSec(st.departureTime);
        for (const a2 of baseArr.get(n) ?? []) {
          const w = oDep - a2.t;
          if (w >= minW && w <= maxW) pts.push({ t: oDep, dist: d, wait: w, label: `${a2.label} → ${g.label} · attesa ${Math.round(w / 60)}′ · ${st.stopName}` });
        }
        for (const p2 of baseDep.get(n) ?? []) {
          const w = p2.t - oArr;
          if (w >= minW && w <= maxW) pts.push({ t: p2.t, dist: d, wait: w, label: `${g.label} → ${p2.label} · attesa ${Math.round(w / 60)}′ · ${st.stopName}` });
        }
        if (pts.length > 1500) break; // cap difensivo render
      }
    }
    return { pts, z: pts.length };
  }, [showConn, axis, baseGeoms, overlayGeoms, nodeOfStop, connMin, connMax]);

  const sharedCandidates = candidatesQ.data ?? [];

  /* ─── C4 · Sincronizzatore MULTI-LINEA: CATENA di coincidenze ordinata.
     L'operatore mette in fila le linee per ORDINE DI ARRIVO al nodo:
     la prima arriva, la seconda parte Δ dopo, la terza parte Δ dopo la
     seconda, ecc. La linea BASE è l'ancora (non si sposta mai): le linee
     DOPO la base vengono traslate in cascata in avanti, quelle PRIMA
     all'indietro. Ogni linea partecipa con una selezione PARZIALE di
     corse (finestra oraria + spunta singola). ─── */
  type ChainItem = { kind: "base" } | { kind: "variant"; variantId: string };
  const syncOpen = activeTool === "sync";
  const [syncChain, setSyncChain] = useState<ChainItem[]>([{ kind: "base" }]);
  const [syncSel, setSyncSel] = useState<Record<string, Set<string>>>({});
  const [syncExpand, setSyncExpand] = useState<string | null>(null);
  const [syncWinFrom, setSyncWinFrom] = useState("06:00");
  const [syncWinTo, setSyncWinTo] = useState("09:00");
  const [syncMaxShift, setSyncMaxShift] = useState("15");
  const [syncBusy, setSyncBusy] = useState(false);
  type SyncPlanItem = { variantId: string; delta: number; zNow: number; zBest: number; moved: number; name: string };
  const [syncPlan, setSyncPlan] = useState<SyncPlanItem[] | null>(null);
  useEffect(() => { setSyncPlan(null); }, [syncChain, syncSel, connMin, connMax, calendarFilter]);
  useEffect(() => { setSyncChain([{ kind: "base" }]); setSyncSel({}); setSyncPlan(null); }, [variantId]);
  // se una linea viene spenta dal pannello Linee, esce anche dalla catena
  useEffect(() => {
    setSyncChain(prev => {
      const next = prev.filter(it => it.kind === "base" || overlayOn.has(it.variantId));
      return next.length === prev.length ? prev : next;
    });
  }, [overlayOn]);

  /** Corse di una linea della catena, ordinate per prima partenza. */
  function syncLineTrips(vid: string): { trip: PsTrip; dep: number }[] {
    const data = overlayData[vid];
    if (!data) return [];
    let trips = data.trips;
    if (calendarFilter) trips = trips.filter(t => catTripSet.has(t.id));
    if (dayFilter) trips = trips.filter(dayMatch);
    return trips
      .map(t => ({ trip: t, dep: data.st[t.id]?.length ? hmsToSec(data.st[t.id][0].departureTime) : Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.dep - b.dep);
  }
  const chainName = (it: ChainItem) =>
    it.kind === "base"
      ? `${baseRoute?.shortName ?? "base"} (riferimento)`
      : (() => { const c = sharedCandidates.find(x => x.variant.id === it.variantId); return c ? `${c.route.shortName} · ${(c.variant as any).code ? `${(c.variant as any).code} · ` : ""}${c.variant.name}` : "?"; })();
  const chainColor = (it: ChainItem) =>
    it.kind === "base"
      ? baseColor
      : (() => { const c = sharedCandidates.find(x => x.variant.id === it.variantId); return c ? (colorByRoute.get(c.route.id) ?? routeColor(c.route.color, "#c084fc")) : "#c084fc"; })();

  function addLineToChain(vid: string) {
    setSyncChain(prev => prev.some(it => it.kind === "variant" && it.variantId === vid) ? prev : [...prev, { kind: "variant", variantId: vid }]);
  }
  function moveChainItem(idx: number, dir: -1 | 1) {
    setSyncChain(prev => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }
  // seed/prune della selezione corse per ogni linea in catena (default: TUTTE)
  useEffect(() => {
    setSyncSel(prev => {
      let changed = false;
      const next = { ...prev };
      for (const it of syncChain) {
        if (it.kind !== "variant") continue;
        const ids = syncLineTrips(it.variantId).map(x => x.trip.id);
        if (ids.length === 0) continue;
        const idSet = new Set(ids);
        const cur = prev[it.variantId];
        if (!cur) { next[it.variantId] = idSet; changed = true; continue; }
        const kept = [...cur].filter(id => idSet.has(id));
        if (kept.length !== cur.size) { next[it.variantId] = kept.length ? new Set(kept) : idSet; changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncChain, overlayData, calendarFilter, catTripSet, dayMatch]);
  /** Applica la finestra oraria alla selezione di TUTTE le linee della catena. */
  function applySyncWindow() {
    const a = hmToSec(syncWinFrom), b = hmToSec(syncWinTo);
    if (a == null || b == null || b < a) { toast.error("Finestra non valida (HH:MM)"); return; }
    setSyncSel(prev => {
      const next = { ...prev };
      for (const it of syncChain) {
        if (it.kind !== "variant") continue;
        next[it.variantId] = new Set(syncLineTrips(it.variantId).filter(x => x.dep >= a && x.dep <= b).map(x => x.trip.id));
      }
      return next;
    });
  }

  /** Eventi (arrivi/partenze) ai nodi dell'asse per un elemento della catena,
   *  con eventuale shift. Base = tutte le corse visibili; linea = solo selezionate. */
  function chainNodeEvents(it: ChainItem, deltaSec: number): Map<string, { arr: number[]; dep: number[]; name: string }> {
    const m = new Map<string, { arr: number[]; dep: number[]; name: string }>();
    const push = (stopId: string, stopName: string, a: number, d: number) => {
      const n = nodeOfStop.get(stopId) ?? stopId;
      if (!m.has(n)) m.set(n, { arr: [], dep: [], name: stopName });
      const e = m.get(n)!;
      e.arr.push(a); e.dep.push(d);
    };
    if (it.kind === "base") {
      for (const g of baseGeoms) for (const st of g.sts) push(st.stopId, st.stopName, hmsToSec(st.arrivalTime), hmsToSec(st.departureTime));
    } else {
      const data = overlayData[it.variantId];
      if (!data) return m;
      const sel = syncSel[it.variantId] ?? new Set<string>();
      let trips = data.trips.filter(t => sel.has(t.id));
      if (calendarFilter) trips = trips.filter(t => catTripSet.has(t.id));
    if (dayFilter) trips = trips.filter(dayMatch);
      for (const t of trips) for (const st of data.st[t.id] ?? [])
        push(st.stopId, st.stopName, hmsToSec(st.arrivalTime) + deltaSec, hmsToSec(st.departureTime) + deltaSec);
    }
    return m;
  }
  /** Coincidenze realizzate tra due elementi consecutivi della catena:
   *  il PRIMO arriva al nodo → il SECONDO parte con attesa in [min,max]. */
  function chainPairConn(prevEv: Map<string, { arr: number[]; dep: number[]; name: string }>,
                         nextEv: Map<string, { arr: number[]; dep: number[]; name: string }>,
                         collect = false): { z: number; pts: ConnPt[] } {
    if (!axis) return { z: 0, pts: [] };
    const minW = Math.max(0, Number(connMin) || 0) * 60;
    const maxW = Math.max(minW, (Number(connMax) || 10) * 60);
    const nodeDist = new Map<string, number>();
    for (const st of axis.stops) {
      const n = nodeOfStop.get(st.stopId) ?? st.stopId;
      if (!nodeDist.has(n)) nodeDist.set(n, st.dist);
    }
    let z = 0;
    const pts: ConnPt[] = [];
    for (const [n, nx] of nextEv) {
      const pv = prevEv.get(n);
      const dd = nodeDist.get(n);
      if (!pv || dd == null) continue;
      for (const dep of nx.dep) for (const arr of pv.arr) {
        const w = dep - arr;
        if (w >= minW && w <= maxW) {
          z++;
          if (collect && pts.length < 800) pts.push({ t: dep, dist: dd, wait: w, label: `attesa ${Math.round(w / 60)}′ · ${nx.name}` });
        }
      }
    }
    return { z, pts };
  }

  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);

  /** Ricerca a cascata: per ogni linea (dalla base verso l'esterno) trova il
   *  Δ che massimizza le coincidenze con l'elemento adiacente già definitivo. */
  function runSyncSearch() {
    const movers = syncChain.filter(it => it.kind === "variant") as { kind: "variant"; variantId: string }[];
    if (movers.length === 0) { toast.error("Aggiungi alla catena almeno una linea da spostare"); return; }
    for (const mv of movers) {
      if (!overlayData[mv.variantId]) { toast.error("Orari della linea in caricamento: riprova tra un attimo"); return; }
      if ((syncSel[mv.variantId]?.size ?? 0) === 0) { toast.error(`Seleziona almeno una corsa per ${chainName(mv)}`); return; }
    }
    const M = Math.min(60, Math.max(1, Math.round(Number(syncMaxShift) || 15)));
    const k = syncChain.findIndex(it => it.kind === "base");
    const deltas = new Map<string, number>();
    const results = new Map<string, SyncPlanItem>();
    const finalEv = (i: number) => {
      const it = syncChain[i];
      return chainNodeEvents(it, it.kind === "variant" ? (deltas.get(it.variantId) ?? 0) * 60 : 0);
    };
    const searchBest = (evalZ: (deltaSec: number) => number) => {
      let best = { delta: 0, z: -1 }, zNow = 0;
      for (let d = -M; d <= M; d++) {
        const z = evalZ(d * 60);
        if (d === 0) zNow = z;
        if (z > best.z || (z === best.z && Math.abs(d) < Math.abs(best.delta))) best = { delta: d, z };
      }
      return { best, zNow };
    };
    // a valle della base: chi viene DOPO parte Δ dopo l'arrivo del precedente
    for (let i = k + 1; i < syncChain.length; i++) {
      const it = syncChain[i];
      if (it.kind !== "variant") continue;
      const prevEv = finalEv(i - 1);
      const { best, zNow } = searchBest(ds => chainPairConn(prevEv, chainNodeEvents(it, ds)).z);
      deltas.set(it.variantId, best.delta);
      results.set(it.variantId, { variantId: it.variantId, delta: best.delta, zNow, zBest: best.z, moved: syncSel[it.variantId]?.size ?? 0, name: chainName(it) });
    }
    // a monte della base: chi viene PRIMA arriva Δ prima della partenza del successivo
    for (let i = k - 1; i >= 0; i--) {
      const it = syncChain[i];
      if (it.kind !== "variant") continue;
      const nextEv = finalEv(i + 1);
      const { best, zNow } = searchBest(ds => chainPairConn(chainNodeEvents(it, ds), nextEv).z);
      deltas.set(it.variantId, best.delta);
      results.set(it.variantId, { variantId: it.variantId, delta: best.delta, zNow, zBest: best.z, moved: syncSel[it.variantId]?.size ?? 0, name: chainName(it) });
    }
    // piano in ordine di catena
    const plan: SyncPlanItem[] = [];
    for (const it of syncChain) if (it.kind === "variant") { const r = results.get(it.variantId); if (r) plan.push(r); }
    setSyncPlan(plan);
    if (plan.every(p => p.delta === 0)) toast.info("Gli orari attuali sono già ottimali per la catena scelta.");
  }

  /* ─── Anteprima sync: ogni linea traslata (Δ≠0) tratteggiata nel SUO colore,
     con le coincidenze previste lungo TUTTA la catena. ─── */
  const syncPreview = useMemo(() => {
    if (!syncOpen || !syncPlan || syncPlan.length === 0 || !axis) return null;
    if (syncPlan.every(p => p.delta === 0)) return null;
    const deltas = new Map(syncPlan.map(p => [p.variantId, p.delta]));
    const lines: { color: string; geoms: Pt[][][] }[] = [];
    for (const p of syncPlan) {
      if (p.delta === 0) continue;
      const data = overlayData[p.variantId];
      if (!data) continue;
      const sel = syncSel[p.variantId] ?? new Set<string>();
      let trips = data.trips.filter(t => sel.has(t.id));
      if (calendarFilter) trips = trips.filter(t => catTripSet.has(t.id));
    if (dayFilter) trips = trips.filter(dayMatch);
      const geoms: Pt[][][] = [];
      for (const t of trips) {
        const sts = data.st[t.id];
        if (!sts || sts.length < 2) continue;
        const segs = buildSegments(sts, axis.byStop, p.delta * 60);
        if (segs.length) geoms.push(segs);
      }
      lines.push({ color: chainColor({ kind: "variant", variantId: p.variantId }), geoms });
    }
    // coincidenze previste tra ogni coppia consecutiva della catena
    const evOf = (i: number) => {
      const it = syncChain[i];
      return chainNodeEvents(it, it.kind === "variant" ? (deltas.get(it.variantId) ?? 0) * 60 : 0);
    };
    const pts: ConnPt[] = [];
    let totalZ = 0;
    for (let i = 1; i < syncChain.length; i++) {
      const c = chainPairConn(evOf(i - 1), evOf(i), true);
      totalZ += c.z;
      pts.push(...c.pts);
    }
    return { lines, pts, totalZ, movedLines: lines.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOpen, syncPlan, syncChain, syncSel, overlayData, axis, calendarFilter, catTripSet, dayMatch, connMin, connMax, baseGeoms, nodeOfStop]);

  /** Applica il piano: trasla in sequenza le corse selezionate di ogni linea. */
  async function applySyncPlan() {
    if (!syncPlan) return;
    const work = syncPlan.filter(p => p.delta !== 0);
    if (work.length === 0) return;
    // guardia: nessun orario negativo
    for (const p of work) {
      const data = overlayData[p.variantId];
      if (!data) continue;
      const sel = syncSel[p.variantId] ?? new Set<string>();
      for (const t of data.trips.filter(x => sel.has(x.id))) {
        const sts = data.st[t.id] ?? [];
        if (sts.length && Math.min(...sts.map(x => hmsToSec(x.arrivalTime))) + p.delta * 60 < 0) {
          toast.error(`Lo shift di ${p.name} porterebbe orari prima di 00:00`); return;
        }
      }
    }
    // genera il report PRIMA di scrivere (fotografa prima→dopo), lo scarica a successo
    const reportHtml = buildSyncReportHtml("applicata");
    setSyncBusy(true);
    try {
      let done = 0;
      for (const p of work) {
        const data = overlayData[p.variantId];
        if (!data) continue;
        const sel = syncSel[p.variantId] ?? new Set<string>();
        const targets = data.trips.filter(t => sel.has(t.id));
        for (const t of targets) {
          await shiftPsTripTimes(projectId, t.id, p.delta);
          done++;
        }
        const shifted = new Set(targets.map(t => t.id));
        setOverlayData(prev => {
          const cur = prev[p.variantId];
          if (!cur) return prev;
          const st: Record<string, PsStopTime[]> = {};
          for (const [tid, sts] of Object.entries(cur.st)) {
            st[tid] = shifted.has(tid)
              ? sts.map(x => ({
                  ...x,
                  arrivalTime: secToHms(hmsToSec(x.arrivalTime) + p.delta * 60),
                  departureTime: secToHms(hmsToSec(x.departureTime) + p.delta * 60),
                }))
              : sts;
          }
          return { ...prev, [p.variantId]: { ...cur, st } };
        });
      }
      toast.success(`✅ Catena sincronizzata: ${done} corse traslate su ${work.length} linee`, {
        description: "Le corse non selezionate NON sono state toccate.",
      });
      downloadSyncReport("applicata", reportHtml); // documentazione che certifica la variazione
      setSyncPlan(null);
    } catch (e: any) {
      toast.error("Errore durante lo shift", { description: e?.message });
    } finally { setSyncBusy(false); }
  }

  /* ─── Report esportabile: certifica il lavoro di sincronizzazione ───
   * HTML autocontenuto (stampabile/convertibile in PDF dal browser) con:
   * parametri, catena in ordine di arrivo, piano Δ per linea, dettaglio
   * delle corse traslate, elenco delle coincidenze e snapshot del grafico. */
  function buildSyncReportHtml(status: "proposta" | "applicata"): string | null {
    if (!syncPlan || syncPlan.length === 0) return null;
    const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const now = new Date();
    const deltas = new globalThis.Map(syncPlan.map(p2 => [p2.variantId, p2.delta]));
    const calLabel = calendarFilter
      ? (calendars.find(c => c.id === calendarFilter)?.code ?? calendarFilter)
      : "tutte le categorie (cal. aziendale)";
    const chainNames = syncChain.map(it => chainName(it));

    // dettaglio corse traslate per linea (prima partenza prima → dopo)
    const movedDetail = syncPlan.map(p2 => {
      const data = overlayData[p2.variantId];
      const sel = syncSel[p2.variantId] ?? new Set<string>();
      const rows = (data?.trips ?? [])
        .filter(t => sel.has(t.id))
        .map(t => {
          const dep = data!.st[t.id]?.length ? hmsToSec(data!.st[t.id][0].departureTime) : null;
          return dep == null ? null : {
            label: t.shortName || t.headsign || t.id.slice(0, 8),
            before: secToHm(dep),
            after: secToHm(dep + p2.delta * 60),
          };
        })
        .filter(Boolean) as { label: string; before: string; after: string }[];
      rows.sort((a, b) => a.before.localeCompare(b.before));
      return { plan: p2, rows };
    });

    // coincidenze per coppia consecutiva della catena (con i Δ del piano)
    const evOf = (i: number) => {
      const it = syncChain[i];
      return chainNodeEvents(it, it.kind === "variant" ? (deltas.get(it.variantId) ?? 0) * 60 : 0);
    };
    const pairSections: { title: string; pts: ConnPt[] }[] = [];
    let totalZ = 0;
    for (let i = 1; i < syncChain.length; i++) {
      const c = chainPairConn(evOf(i - 1), evOf(i), true);
      totalZ += c.z;
      pairSections.push({
        title: `${chainNames[i - 1]} → ${chainNames[i]}`,
        pts: c.pts.sort((a, b) => a.t - b.t),
      });
    }

    const svgSnapshot = svgRef.current ? svgRef.current.outerHTML : "";

    return `<!DOCTYPE html>
<html lang="it"><head><meta charset="utf-8">
<title>Report coincidenze · ${esc(project?.name ?? "")}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; margin: 32px auto; max-width: 960px; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 14px; margin: 24px 0 6px; border-bottom: 2px solid #e2e8f0; padding-bottom: 3px; }
  .muted { color: #64748b; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .badge.applicata { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
  .badge.proposta { background: #fef9c3; color: #854d0e; border: 1px solid #fde047; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 6px 0 10px; }
  th, td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; }
  th { background: #f8fafc; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .chain { font-size: 14px; font-weight: 600; margin: 6px 0; }
  .chain .arrow { color: #7c3aed; padding: 0 6px; }
  .chart { background: #0b1220; border-radius: 8px; padding: 8px; margin-top: 8px; overflow: auto; }
  .chart svg { max-width: 100%; height: auto; }
  .foot { margin-top: 28px; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { .chart { break-inside: avoid; } h2 { break-after: avoid; } }
</style></head><body>
<h1>Report sincronizzazione coincidenze <span class="badge ${status}">${status === "applicata" ? "Variazione applicata" : "Piano proposto"}</span></h1>
<p class="muted">Progetto <strong>${esc(project?.name ?? "")}</strong> · Orario grafico (TTD) · generato il ${now.toLocaleDateString("it-IT")} alle ${now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}${user ? ` · operatore ${esc(user.fullName || user.email)}` : ""}</p>

<h2>Parametri</h2>
<table><tbody>
  <tr><th style="width:220px">Linea di riferimento (non traslata)</th><td>${esc(baseRoute?.shortName ?? "")} ${esc(baseRoute?.longName ?? "")}</td></tr>
  <tr><th>Calendario / giorni</th><td>${esc(calLabel)}</td></tr>
  <tr><th>Attesa al nodo Δ</th><td>${esc(connMin)}–${esc(connMax)} minuti</td></tr>
  <tr><th>Shift massimo per linea</th><td>±${esc(syncMaxShift)} minuti</td></tr>
  <tr><th>Coincidenze totali della catena</th><td><strong>Z = ${totalZ}</strong></td></tr>
</tbody></table>

<h2>Catena di coincidenze (ordine di arrivo al nodo)</h2>
<p class="chain">${chainNames.map(esc).join('<span class="arrow">→</span>')}</p>
<p class="muted">Ogni linea parte ${esc(connMin)}–${esc(connMax)} minuti dopo l'arrivo della precedente al nodo comune.</p>

<h2>Piano di traslazione per linea</h2>
<table><thead><tr><th>Linea</th><th class="num">Δ (min)</th><th class="num">Corse traslate</th><th class="num">Z prima</th><th class="num">Z dopo</th></tr></thead><tbody>
${syncPlan.map(p2 => `<tr><td>${esc(p2.name)}</td><td class="num">${p2.delta > 0 ? "+" : ""}${p2.delta}</td><td class="num">${p2.moved}</td><td class="num">${p2.zNow}</td><td class="num"><strong>${p2.zBest}</strong></td></tr>`).join("")}
</tbody></table>

${movedDetail.map(md => md.plan.delta === 0 ? "" : `
<h2>Corse traslate · ${esc(md.plan.name)} (Δ ${md.plan.delta > 0 ? "+" : ""}${md.plan.delta}′)</h2>
<table><thead><tr><th>Corsa</th><th class="num">Partenza prima</th><th class="num">Partenza dopo</th></tr></thead><tbody>
${md.rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.before}</td><td class="num"><strong>${r.after}</strong></td></tr>`).join("")}
</tbody></table>`).join("")}

<h2>Coincidenze realizzate (${totalZ})</h2>
${pairSections.map(sec => `
<h3 style="font-size:12px;margin:10px 0 4px">${esc(sec.title)} — ${sec.pts.length} coincidenze</h3>
<table><thead><tr><th class="num" style="width:90px">Orario</th><th>Dettaglio (fermata · attesa)</th></tr></thead><tbody>
${sec.pts.slice(0, 400).map(pt => `<tr><td class="num">${secToHm(pt.t)}</td><td>${esc(pt.label)}</td></tr>`).join("")}
${sec.pts.length === 0 ? '<tr><td colspan="2" class="muted">nessuna coincidenza in finestra per questa coppia</td></tr>' : ""}
</tbody></table>`).join("")}

${svgSnapshot ? `<h2>Orario grafico (snapshot al momento del report)</h2><div class="chart">${svgSnapshot}</div>` : ""}

<div class="foot">Documento generato automaticamente da Cerbero · Planner Studio — Orario grafico (TTD). ${status === "applicata" ? "Gli orari indicati come «dopo» sono stati scritti sul database." : "Piano NON ancora applicato: gli orari «dopo» sono una proposta."}</div>
</body></html>`;
  }

  function downloadSyncReport(status: "proposta" | "applicata", html?: string | null) {
    const doc = html ?? buildSyncReportHtml(status);
    if (!doc) { toast.error("Calcola prima il piano della catena"); return; }
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `report-coincidenze_${(project?.name ?? "progetto").replace(/[^a-z0-9]+/gi, "-")}_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}.html`;
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast.success("📄 Report coincidenze scaricato", { description: name });
  }

  /* ─── Hover tooltip su una corsa ─── */
  function onTripHover(e: React.PointerEvent, g: TripGeom) {
    if (dragRef.current) return;
    const pos = svgPos(e);
    const sec = tDomain.t0 + ((pos.x - ML) / innerW) * (tDomain.t1 - tDomain.t0);
    // fermata più vicina nel tempo al cursore
    let best: PsStopTime | null = null, bestD = Infinity;
    for (const st of g.sts) {
      const d = Math.abs(hmsToSec(st.departureTime) - sec);
      if (d < bestD) { bestD = d; best = st; }
    }
    const first = g.sts[0], last = g.sts[g.sts.length - 1];
    const lines = [
      g.label + (g.trip.isActive ? "" : " (disattivata)"),
      `Partenza ${secToHm(hmsToSec(first.departureTime))} → Arrivo ${secToHm(hmsToSec(last.arrivalTime))} · ${g.sts.length} fermate`,
    ];
    if (best) {
      lines.push(`${best.stopName}: arr ${secToHm(hmsToSec(best.arrivalTime))} · part ${secToHm(hmsToSec(best.departureTime))}`);
    }
    setHover({ x: pos.x, y: pos.y, lines });
  }

  /* ─── Tick orari ─── */
  const ticks = useMemo(() => {
    const step = tickStep(tDomain.t1 - tDomain.t0);
    const out: number[] = [];
    for (let s = Math.ceil(tDomain.t0 / step) * step; s <= tDomain.t1; s += step) out.push(s);
    return { step, list: out };
  }, [tDomain]);

  // Etichette fermate diradate per evitare sovrapposizioni
  const stopLabels = useMemo(() => {
    if (!axis) return [];
    const out: { name: string; y: number; dist: number; shared: boolean }[] = [];
    let lastY = -Infinity;
    for (const s of axis.stops) {
      const y = MT + (s.dist / axis.total) * innerH;
      const shared = (axis as any).shared?.has(s.stopId) ?? false;
      // gli interscambi hanno SEMPRE l'etichetta, anche se fitti
      if (shared || y - lastY >= 12) {
        out.push({ name: s.stopName, y, dist: s.dist, shared });
        lastY = y;
      }
    }
    return out;
  }, [axis, innerH]);

  const stLoading = !!variantId && (tripsQ.data ?? []).some(t => !(t.id in stMap));
  const project = projectQ.data;
  const calendars = calendarsQ.data ?? [];
  const variants = variantsQ.data ?? [];

  /* ════════════════ Render ════════════════ */
  return (
    <div ref={pageRef} className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100">
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300" title="Torna al progetto">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <GitCommitHorizontal className="w-5 h-5 text-amber-400" />
          <h1 className="font-semibold text-sm">Orario grafico</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name}
            {baseRoute && <span className="text-slate-400"> · linea {baseRoute.shortName}</span>}
          </span>
        )}
        <span className="ml-2"><TripCountBadge projectId={projectId} /></span>
        <div className="flex-1" />
        {stLoading && (
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> orari…
          </span>
        )}
        <button onClick={toggleFullscreen}
          className="p-2 rounded hover:bg-slate-800 text-slate-300"
          title={isFullscreen ? "Esci da schermo intero" : "Schermo intero"}>
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Toolbar: linea di riferimento + controlli vista (gli STRUMENTI stanno
          nella barra verticale a destra, un pannello alla volta) */}
      <div className="border-b border-slate-800 bg-slate-900/40 px-3 py-1.5 flex items-center gap-2 text-xs shrink-0 flex-wrap">
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Riferimento</span>
        <select
          value={routeId} onChange={e => setRouteId(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[140px]"
          title="Linea di riferimento"
        >
          <option value="">Linea…</option>
          {routes.map(r => (
            <option key={r.id} value={r.id}>{r.shortName} {r.longName ? `· ${r.longName}` : ""}</option>
          ))}
        </select>
        <select
          value={variantId} onChange={e => setVariantId(e.target.value)}
          disabled={!routeId}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[150px] disabled:opacity-40"
          title="Variante (percorso) di riferimento"
        >
          <option value="">Variante…</option>
          {variants.map(v => (
            <option key={v.id} value={v.id}>{(v as any).code ? `${(v as any).code} · ` : ""}{v.name} ({v.direction === 0 ? "andata" : "ritorno"})</option>
          ))}
        </select>
        <select
          value={calendarFilter} onChange={e => setCalendarFilter(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[140px]"
          title="Filtro CALENDARIO AZIENDALE (categorie di validità: feriale, festivo, scolastico…)"
        >
          <option value="">Tutte le categorie (cal. aziendale)</option>
          {calendars.map(c => (
            <option key={c.id} value={c.id}>{c.code} {c.name ? `· ${c.name}` : ""}</option>
          ))}
        </select>
        <select
          value={dayFilter} onChange={e => setDayFilter(e.target.value as typeof dayFilter)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
          title="Filtro per GIORNO (validità dal calendario aziendale). Le corse senza validità configurata restano visibili."
        >
          <option value="">Tutti i giorni</option>
          <option value="feriale">Feriale</option>
          <option value="sabato">Sabato</option>
          <option value="festivo">Domenica / Festivo</option>
        </select>

        <div className="h-5 w-px bg-slate-800 mx-1" />
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Fascia</span>
        <input type="text" value={winFrom} onChange={e => setWinFrom(e.target.value)} placeholder="04:00"
          className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 font-mono text-center" title="HH:MM (anche oltre 24, es. 25:30)" />
        <span className="text-slate-600">–</span>
        <input type="text" value={winTo} onChange={e => setWinTo(e.target.value)} placeholder="26:00"
          className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700 font-mono text-center" title="HH:MM (anche oltre 24, es. 26:00)" />
        <button
          onClick={() => {
            const a2 = hmToSec(winFrom), b2 = hmToSec(winTo);
            if (a2 == null || b2 == null || b2 <= a2) { toast.error("Fascia non valida"); return; }
            setDomainClamped(a2, b2);
          }}
          className="px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 font-medium">Applica</button>

        <div className="h-5 w-px bg-slate-800 mx-1" />
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Zoom</span>
        <div className="flex items-center gap-1">
          <button onClick={() => zoomAt(1 / 1.4)} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Zoom +">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={() => zoomAt(1.4)} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Zoom −">
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setTDomain({ t0: DEFAULT_T0, t1: DEFAULT_T1 })}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Reset vista 04:00–26:00"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <span className="text-slate-500 font-mono ml-1">
            {secToHm(tDomain.t0)}–{secToHm(tDomain.t1)}
          </span>
        </div>

        <div className="h-5 w-px bg-slate-800 mx-1" />
        <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Asse</span>
        <button onClick={() => setYMode(m => m === "equidistante" ? "distanza" : "equidistante")}
          className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
          title="Equidistante = fermate a passo uniforme (più leggibile) · Distanze = proporzionale ai km reali">
          {yMode === "equidistante" ? "≡ Equidistante" : "⇕ Distanze reali"}
        </button>
        <div className="flex-1" />
      </div>


      {/* Corpo: grafico + pannello cadenzamento opzionale */}
      <div className="flex-1 flex overflow-hidden">
        <div ref={containerRef} className="flex-1 relative overflow-hidden select-none">
          {!variantId && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              Seleziona linea e variante di riferimento per disegnare l'orario grafico.
            </div>
          )}
          {variantId && baseVariantQ.isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Caricamento variante…
            </div>
          )}
          {variantId && baseVariantQ.data && !baseAxis && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              La variante ha meno di 2 fermate: impossibile costruire l'asse distanza.
            </div>
          )}

          {pendingOps.length > 0 && baseAxis && (
            <div className="absolute top-2 right-3 z-20 flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-slate-900/95 px-2.5 py-1.5 text-xs shadow-xl">
              <span className="text-emerald-300 font-semibold">{pendingOps.length} modific{pendingOps.length === 1 ? "a" : "he"}</span>
              <button onClick={undoLast} disabled={savingOps}
                title="Annulla l'ultima modifica (Ctrl+Z)"
                className="px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 disabled:opacity-40">
                ↶ Annulla
              </button>
              <button onClick={saveAllOps} disabled={savingOps}
                title="Applica TUTTE le modifiche locali al progetto"
                className="px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:opacity-50">
                {savingOps ? "Salvataggio…" : "💾 Salva modifiche"}
              </button>
            </div>
          )}
          {selectedTripId && baseAxis && (() => {
            const g = baseGeoms.find(x => x.trip.id === selectedTripId);
            return (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-lg border border-amber-500/50 bg-slate-900/95 px-3 py-1.5 text-xs shadow-xl">
                <span className="text-amber-300 font-semibold">Corsa: {g?.label ?? selectedTripId.slice(0, 8)}</span>
                <span className="text-[10px] text-slate-500">Ctrl+C copia · Ctrl+V incolla</span>
                <button
                  onClick={() => { setActiveTool("mult"); setMultBaseTripId(selectedTripId); }}
                  title="Copia questa corsa più volte (cadenzamento): scegli intervallo e fascia"
                  className="px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">
                  ⧉ Copia più volte
                </button>
                <button
                  onClick={() => {
                    setDeletedTripIds(d => new Set(d).add(selectedTripId));
                    setPendingOps(prev => [...prev, { kind: "delete", tripId: selectedTripId }]);
                    setSelectedTripId(null);
                    toast.info("Corsa eliminata (in locale)", { description: "Annulla per ripristinarla · Salva modifiche per confermare." });
                  }}
                  title="Elimina la corsa (modifica locale: si conferma con Salva modifiche)"
                  className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/10">
                  🗑 Elimina
                </button>
                <button onClick={() => setSelectedTripId(null)}
                  className="px-1.5 py-0.5 rounded text-slate-400 hover:text-slate-100">✕</button>
              </div>
            );
          })()}
          {/* NB: niente onDoubleClick nativo: col pointer capture l'evento
              arriva retargettato sull'svg (target senza data-trip) e
              annullava la selezione fatta dal rilevatore manuale in
              onPointerDown. */}
          {baseAxis && (
            <svg
              ref={svgRef}
              width={size.w} height={size.h}
              className="block touch-none"
              style={{ cursor: dragRef.current?.mode === "trip" ? "ew-resize" : "default" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                <clipPath id="ttd-clip">
                  <rect x={ML} y={MT} width={innerW} height={innerH + MB} />
                </clipPath>
              </defs>

              {/* Sfondo area grafico */}
              <rect x={ML} y={MT} width={innerW} height={innerH} fill="#0f172a" />

              {/* Griglia verticale: tick orari */}
              {ticks.list.map(s => {
                const x = xOf(s);
                const isHour = s % 3600 === 0;
                return (
                  <g key={s}>
                    <line x1={x} y1={MT} x2={x} y2={MT + innerH}
                      stroke={isHour ? "#334155" : "#1e293b"} strokeWidth={1} />
                    {(isHour || ticks.step < 1800) && (
                      <text x={x} y={MT - 8} textAnchor="middle" fill="#64748b" fontSize={10} fontFamily="monospace">
                        {secToHm(s)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Griglia orizzontale: fermate dell'asse attivo (unione con overlay).
                  Le fermate COMUNI a più linee (interscambi) hanno riga più marcata. */}
              {axis!.stops.map((s, i) => {
                const isShared = (axis as any).shared?.has(s.stopId) ?? false;
                return (
                  <line key={`${s.stopId}-${i}`}
                    x1={ML} y1={yOf(s.dist)} x2={ML + innerW} y2={yOf(s.dist)}
                    stroke={isShared ? "#78350f" : "#1e293b"} strokeWidth={isShared ? 1.5 : 1} />
                );
              })}
              {stopLabels.map((l, i) => (
                <g key={i}>
                  {l.shared && (
                    <rect x={ML - 4} y={l.y - 3} width={6} height={6} transform={`rotate(45 ${ML - 1} ${l.y})`}
                      fill="#f59e0b" stroke="#78350f" strokeWidth={0.5} />
                  )}
                  <text x={ML - (l.shared ? 10 : 6)} y={l.y + 3} textAnchor="end"
                    fill={l.shared ? "#fbbf24" : "#94a3b8"} fontSize={9} fontWeight={l.shared ? 700 : 400}>
                    {l.name.length > 24 ? l.name.slice(0, 23) + "…" : l.name}
                  </text>
                </g>
              ))}
              {/* Riepilogo asse in basso a sinistra */}
              <text x={ML - 6} y={MT + innerH + 4} textAnchor="end" fill="#475569" fontSize={9} fontFamily="monospace">
                {yMode === "distanza" ? `${(axis!.total / 1000).toFixed(1)} km` : `${axis!.stops.length} fermate${(axis as any).shared?.size ? ` · ◆ ${(axis as any).shared.size} interscambi` : ""}`}
              </text>

              <g clipPath="url(#ttd-clip)">
                {/* Overlay altre linee (sotto le corse base) */}
                {overlayGeoms.map(g => (
                  <g key={`ov-${g.trip.id}`} opacity={g.trip.isActive ? 0.75 : 0.3}>
                    {g.segs.map((seg, i) => (
                      <polyline key={i}
                        points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                        fill="none" stroke={g.color} strokeWidth={1.2} strokeLinejoin="round" />
                    ))}
                    {/* fascia invisibile più larga per hover */}
                    {g.segs.map((seg, i) => (
                      <polyline key={`h${i}`}
                        points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                        fill="none" stroke="transparent" strokeWidth={8}
                        onPointerMove={e => onTripHover(e, g)}
                        onPointerLeave={() => setHover(null)} />
                    ))}
                  </g>
                ))}

                {/* Corse della variante base */}
                {baseGeoms.map(g => {
                  const dragging = tripDrag?.tripId === g.trip.id;
                  const isMultBase = multOpen && multBaseTripId === g.trip.id;
                  /* modifiche locali non salvate → linea tratteggiata */
                  const unsaved = modifiedTripIds.has(g.trip.id);
                  return (
                    <g key={g.trip.id} opacity={g.trip.isActive ? 1 : 0.35}>
                      {g.segs.map((seg, i) => (
                        <polyline key={i}
                          points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                          fill="none"
                          stroke={dragging ? "#fbbf24" : isMultBase ? "#34d399" : g.color}
                          strokeWidth={dragging || isMultBase ? 2.5 : 1.6}
                          strokeDasharray={unsaved ? "6 4" : undefined}
                          strokeLinejoin="round" />
                      ))}
                      {/* anteprima TRASLAZIONE corsa: tratteggiata alla nuova posizione,
                          l'originale resta ferma finché non rilasci */}
                      {dragging && tripDrag && g.segs.map((seg, i) => (
                        <polyline key={`drag${i}`}
                          points={seg.map(p => `${xOf(p.sec + tripDrag.deltaSec)},${yOf(p.dist)}`).join(" ")}
                          fill="none" stroke="#fbbf24" strokeWidth={2}
                          strokeDasharray="5 4" strokeLinejoin="round" pointerEvents="none" />
                      ))}
                      {/* anteprima SPOSTAMENTO nodo: tratto variato tratteggiato
                          (fermata prima → nodo trascinato → fermata dopo) */}
                      {nodeDrag?.tripId === g.trip.id && (() => {
                        const si = nodeDrag.stIdx;
                        const pts: string[] = [];
                        for (const [idx, off] of [[si - 1, 0], [si, nodeDrag.deltaSec], [si + 1, 0]] as const) {
                          const st = g.sts[idx];
                          if (!st) continue;
                          const dd = axis!.byStop.get(st.stopId);
                          if (dd == null) continue;
                          pts.push(`${xOf(hmsToSec(st.arrivalTime) + off)},${yOf(dd)}`);
                          if (st.departureTime !== st.arrivalTime) pts.push(`${xOf(hmsToSec(st.departureTime) + off)},${yOf(dd)}`);
                        }
                        return pts.length >= 2 ? (
                          <polyline points={pts.join(" ")} fill="none" stroke="#fbbf24"
                            strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" pointerEvents="none" />
                        ) : null;
                      })()}
                      {/* evidenzia la corsa SELEZIONATA (doppio click) */}
                      {selectedTripId === g.trip.id && g.segs.map((seg, i) => (
                        <polyline key={`sel${i}`}
                          points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                          fill="none" stroke="#fbbf24" strokeWidth={3.5} opacity={0.55}
                          strokeLinejoin="round" pointerEvents="none" />
                      ))}
                      {/* fascia invisibile larga: hover + drag handle */}
                      {g.segs.map((seg, i) => (
                        <polyline key={`h${i}`}
                          data-trip={g.trip.id}
                          points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                          fill="none" stroke="transparent" strokeWidth={10}
                          style={{ cursor: "ew-resize" }}
                          onPointerMove={e => onTripHover(e, g)}
                          onPointerLeave={() => setHover(null)} />
                      ))}
                      {/* PUNTINI interattivi fermata×orario: hover = orario+nodo,
                          drag orizzontale = modifica l'orario di transito */}
                      {(tDomain.t1 - tDomain.t0) < 6 * 3600 && g.sts.map((st, si) => {
                        const dd = axis!.byStop.get(st.stopId);
                        if (dd == null) return null;
                        const extra = nodeDrag?.tripId === g.trip.id && nodeDrag.stIdx === si ? nodeDrag.deltaSec : 0;
                        const sec = hmsToSec(st.departureTime) + extra;
                        const nodeName = (axis!.stops.find(x => x.stopId === st.stopId) as any)?.stopName
                          ?? (axis!.stops.find(x => x.stopId === st.stopId) as any)?.name ?? st.stopId;
                        const isDraggingNode = nodeDrag?.tripId === g.trip.id && nodeDrag.stIdx === si;
                        return (
                          <g key={`nd${si}`}>
                            <circle cx={xOf(sec)} cy={yOf(dd)} r={isDraggingNode ? 5 : 3.5}
                              fill={isDraggingNode ? "#fbbf24" : g.color} stroke="#0f172a" strokeWidth={1}
                              data-node={`${g.trip.id}|${si}`}
                              style={{ cursor: "ew-resize" }}>
                              <title>{`${nodeName}\narr ${st.arrivalTime.slice(0, 5)} · part ${st.departureTime.slice(0, 5)}\n(trascina ←→ per spostare l'orario di transito)`}</title>
                            </circle>
                            {isDraggingNode && (
                              <text x={xOf(sec) + 8} y={yOf(dd) - 8}
                                fill="#fbbf24" fontSize={11} fontFamily="monospace" fontWeight="bold">
                                {Math.round(nodeDrag!.deltaSec / 60) > 0 ? "+" : ""}{Math.round(nodeDrag!.deltaSec / 60)} min · {secToHm(sec)}
                              </text>
                            )}
                          </g>
                        );
                      })}
                      {/* etichetta delta + NUOVO orario di partenza durante il drag */}
                      {dragging && tripDrag && (
                        <text
                          x={xOf(g.segs[0][0].sec + tripDrag.deltaSec)} y={yOf(g.segs[0][0].dist) - 8}
                          fill="#fbbf24" fontSize={11} fontFamily="monospace" fontWeight="bold">
                          {Math.round(tripDrag.deltaSec / 60) > 0 ? "+" : ""}{Math.round(tripDrag.deltaSec / 60)} min · parte {secToHm(hmsToSec(g.sts[0].departureTime) + tripDrag.deltaSec)}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Coincidenze ai nodi condivisi */}
                {showConn && connections.pts.slice(0, 800).map((c2, i) => (
                  <circle key={`cn-${i}`} cx={xOf(c2.t)} cy={yOf(c2.dist)} r={3.5}
                    fill="#10b981" stroke="#022c22" strokeWidth={1} opacity={0.95}>
                    <title>{c2.label}</title>
                  </circle>
                ))}

                {/* Anteprima SYNC: ogni linea traslata, tratteggiata nel SUO colore */}
                {syncPreview && syncPreview.lines.map((ln, k) => (
                  <g key={`sy-${k}`} opacity={0.9}>
                    {ln.geoms.map((segs, j) => segs.map((seg, i) => (
                      <polyline key={`${j}-${i}`}
                        points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                        fill="none" stroke={ln.color} strokeWidth={1.8}
                        strokeDasharray="6 4" strokeLinejoin="round" />
                    )))}
                  </g>
                ))}
                {syncPreview && syncPreview.pts.slice(0, 400).map((c2, i) => (
                  <circle key={`syc-${i}`} cx={xOf(c2.t)} cy={yOf(c2.dist)} r={4}
                    fill="none" stroke="#c084fc" strokeWidth={2}>
                    <title>Coincidenza prevista · {c2.label}</title>
                  </circle>
                ))}

                {/* Anteprima cadenzamento (tratteggiata) */}
                {previewGeoms.map((segs, k) => (
                  <g key={`prev-${k}`} opacity={0.85}>
                    {segs.map((seg, i) => (
                      <polyline key={i}
                        points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                        fill="none" stroke="#34d399" strokeWidth={1.4}
                        strokeDasharray="5 4" strokeLinejoin="round" />
                    ))}
                  </g>
                ))}
              </g>

              {/* Bordo area grafico */}
              <rect x={ML} y={MT} width={innerW} height={innerH} fill="none" stroke="#334155" strokeWidth={1} />
            </svg>
          )}

          {/* Tooltip hover */}
          {/* Legenda: un colore per ogni linea attiva */}
          {baseAxis && (
            <div className="absolute top-2 right-2 flex flex-col gap-1 items-end pointer-events-none">
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-900/85 border border-slate-700 text-[10px]">
                <span className="w-4 h-1 rounded-full" style={{ background: baseColor }} />
                <span className="text-slate-200 font-semibold">{baseRoute?.shortName ?? "base"}</span>
                <span className="text-slate-500">base</span>
              </span>
              {[...colorByRoute.entries()].map(([rid, col]) => {
                const r = routes.find(x => x.id === rid);
                return (
                  <span key={rid} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-900/85 border border-slate-700 text-[10px]">
                    <span className="w-4 h-1 rounded-full" style={{ background: col }} />
                    <span className="text-slate-200 font-semibold">{r?.shortName ?? "?"}</span>
                  </span>
                );
              })}
              {syncPreview && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-900/85 border border-purple-500/50 text-[10px]">
                  <span className="w-4 h-0 border-t-2 border-dashed border-purple-400" />
                  <span className="text-purple-300">anteprima catena · {syncPreview.movedLines} linee · Z {syncPreview.totalZ}</span>
                </span>
              )}
            </div>
          )}

          {hover && (
            <div
              className="absolute z-20 pointer-events-none bg-slate-800/95 border border-slate-600 rounded px-2.5 py-1.5 text-[11px] shadow-xl max-w-[280px]"
              style={{
                left: Math.min(hover.x + 14, size.w - 290),
                top: Math.min(hover.y + 12, size.h - 70),
              }}
            >
              {hover.lines.map((l, i) => (
                <div key={i} className={i === 0 ? "font-semibold text-slate-100" : "text-slate-400"}>{l}</div>
              ))}
            </div>
          )}

        </div>

        {/* ─── Pannello: LINEE (overlay altre linee, un colore per linea) ─── */}
        {activeTool === "layers" && (
          <div className="w-[320px] border-l border-slate-800 bg-slate-900 flex flex-col shrink-0">
            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <h3 className="font-semibold text-sm text-cyan-300">Linee sul grafico</h3>
              <div className="flex-1" />
              <button onClick={() => setActiveTool(null)} className="p-1 rounded hover:bg-slate-800"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-2 overflow-y-auto text-xs flex-1">
              <p className="px-2 pb-2 text-[10px] text-slate-500">
                Accendi altre linee per confrontarle con la <strong>{baseRoute?.shortName ?? "base"}</strong>: ogni linea ha un colore, le fermate comuni diventano interscambi ◆ sull'asse.
              </p>
              <div className="px-2 pb-2">
                <input value={lineSearch} onChange={e => setLineSearch(e.target.value)}
                  placeholder="Cerca codice linea o percorso…"
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-[11px] focus:outline-none focus:border-purple-500/50" />
              </div>
              {candidatesQ.isLoading && (
                <div className="px-2 py-2 text-slate-500 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Ricerca varianti compatibili…
                </div>
              )}
              {!candidatesQ.isLoading && sharedCandidates.length === 0 && (
                <div className="px-2 py-2 text-slate-500">Nessun'altra variante nel progetto.</div>
              )}
              {(() => {
                // Raggruppa per LINEA: checkbox di linea (tutte le varianti) + varianti singole
                const q = lineSearch.trim().toLowerCase();
                const visCand = q
                  ? sharedCandidates.filter(c =>
                      (c.route.shortName ?? "").toLowerCase().includes(q)
                      || String((c.variant as any).code ?? "").toLowerCase().includes(q)
                      || (c.variant.name ?? "").toLowerCase().includes(q))
                  : sharedCandidates;
                const byRoute = new Map<string, { route: PsRoute; items: typeof sharedCandidates }>();
                for (const c of visCand) {
                  if (!byRoute.has(c.route.id)) byRoute.set(c.route.id, { route: c.route, items: [] as any });
                  byRoute.get(c.route.id)!.items.push(c);
                }
                return [...byRoute.values()].map(grp => {
                  const ids = grp.items.map(c => c.variant.id);
                  const onCount = ids.filter(id => overlayOn.has(id)).length;
                  const groupColor = colorByRoute.get(grp.route.id) ?? routeColor(grp.route.color, "#475569");
                  return (
                    <div key={grp.route.id} className="mb-0.5">
                      <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer font-semibold">
                        <input
                          type="checkbox"
                          checked={onCount === ids.length && ids.length > 0}
                          ref={el => { if (el) el.indeterminate = onCount > 0 && onCount < ids.length; }}
                          onChange={() => setOverlayOn(prev => {
                            const n = new Set(prev);
                            if (onCount > 0) ids.forEach(id => n.delete(id));
                            else ids.forEach(id => n.add(id));
                            return n;
                          })}
                          className="accent-cyan-500"
                        />
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: onCount > 0 ? groupColor : "#475569" }} />
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                          style={{ backgroundColor: routeColor(grp.route.color, "#475569"), color: routeColor(grp.route.textColor, "#fff") }}
                        >
                          {grp.route.shortName}
                        </span>
                        <span className="flex-1 truncate text-slate-200">{grp.route.longName || "Linea"}</span>
                        <span className="text-[10px] text-slate-500">{onCount}/{ids.length}</span>
                      </label>
                      {grp.items.map(c => (
                        <label key={c.variant.id} className="flex items-center gap-2 pl-8 pr-2 py-1 rounded hover:bg-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={overlayOn.has(c.variant.id)}
                            onChange={() => setOverlayOn(prev => {
                              const n = new Set(prev);
                              if (n.has(c.variant.id)) n.delete(c.variant.id); else n.add(c.variant.id);
                              return n;
                            })}
                            className="accent-cyan-500"
                          />
                          <span className="flex-1 truncate text-slate-300">{(c.variant as any).code ? `${(c.variant as any).code} · ` : ""}{c.variant.name} ({c.variant.direction === 0 ? "→" : "←"})</span>
                          <span className="text-[10px] text-slate-500">{c.shared} ferm. comuni</span>
                        </label>
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* ─── Pannello: COINCIDENZE (vista + parametri attesa) ─── */}
        {activeTool === "conn" && (
          <div className="w-[300px] border-l border-slate-800 bg-slate-900 flex flex-col shrink-0">
            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
              <CircleDot className="w-4 h-4 text-emerald-400" />
              <h3 className="font-semibold text-sm text-emerald-300">Coincidenze</h3>
              <div className="flex-1" />
              <button onClick={() => setActiveTool(null)} className="p-1 rounded hover:bg-slate-800"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-3 space-y-3 text-xs overflow-y-auto">
              <label className="flex items-center gap-2 text-slate-200 cursor-pointer select-none rounded border border-slate-700 bg-slate-800/60 px-2.5 py-2">
                <input type="checkbox" checked={showConn} onChange={e => setShowConn(e.target.checked)} className="accent-emerald-500" />
                Mostra le coincidenze sul grafico (pallini verdi)
              </label>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Attesa al nodo di cambio (min)</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={60} value={connMin} onChange={e => setConnMin(e.target.value)}
                    className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
                  <span className="text-slate-600">–</span>
                  <input type="number" min={0} max={120} value={connMax} onChange={e => setConnMax(e.target.value)}
                    className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
                  <span className="text-slate-500">min</span>
                </div>
              </div>
              {overlayOn.size > 0 ? (
                <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                  <span className="font-mono text-emerald-300 text-sm font-semibold">Z = {connections.z}</span>
                  <span className="text-emerald-200/70"> coincidenze realizzate con attesa {connMin}–{connMax}′</span>
                </div>
              ) : (
                <p className="text-[10px] text-amber-400">Accendi almeno un'altra linea dal pannello <strong>Linee</strong> per vedere le coincidenze.</p>
              )}
              <p className="text-[10px] text-slate-500 leading-snug">
                Una coincidenza si realizza quando due linee condividono un <strong>nodo</strong> (stessa fermata o stesso cluster) e la seconda passa entro la finestra di attesa dopo l'arrivo della prima. Qui la vista conta <strong>entrambe le direzioni</strong>; per orientare e correggere gli orari usa lo strumento <strong>Sincronizza</strong>.
              </p>
            </div>
          </div>
        )}

        {/* ─── Pannello: SINCRONIZZA (catena multi-linea in ordine di arrivo) ─── */}
        {syncOpen && (
          <div className="w-[340px] border-l border-slate-800 bg-slate-900 flex flex-col shrink-0">
            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
              <Shuffle className="w-4 h-4 text-purple-400" />
              <h3 className="font-semibold text-sm text-purple-300">Sincronizza coincidenze</h3>
              <div className="flex-1" />
              <button onClick={() => setActiveTool(null)} className="p-1 rounded hover:bg-slate-800"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-3 space-y-3 text-xs overflow-y-auto flex-1">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  1 · Catena di coincidenze — <span className="text-purple-300">in alto chi ARRIVA prima</span>
                </label>
                <div className="rounded border border-slate-800 divide-y divide-slate-800/60">
                  {syncChain.map((it, idx) => (
                    <div key={it.kind === "base" ? "base" : it.variantId}
                      className={`flex items-center gap-2 px-2 py-1.5 ${it.kind === "base" ? "bg-slate-800/40" : ""}`}>
                      <span className="w-4 text-center font-mono text-slate-500">{idx + 1}</span>
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: chainColor(it) }} />
                      <span className="flex-1 truncate text-slate-200">{chainName(it)}</span>
                      {it.kind === "base" && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">non si sposta</span>}
                      <button onClick={() => moveChainItem(idx, -1)} disabled={idx === 0}
                        className="px-1 rounded hover:bg-slate-800 text-slate-400 disabled:opacity-20" title="Arriva prima">▲</button>
                      <button onClick={() => moveChainItem(idx, 1)} disabled={idx === syncChain.length - 1}
                        className="px-1 rounded hover:bg-slate-800 text-slate-400 disabled:opacity-20" title="Arriva dopo">▼</button>
                      {it.kind === "variant" && (
                        <button onClick={() => setSyncChain(prev => prev.filter(x => x.kind === "base" || x.variantId !== it.variantId))}
                          className="px-1 rounded hover:bg-slate-800 text-rose-400" title="Togli dalla catena">✕</button>
                      )}
                    </div>
                  ))}
                </div>
                {(() => {
                  const inChain = new Set(syncChain.filter(x => x.kind === "variant").map((x: any) => x.variantId));
                  const addable = sharedCandidates.filter(c => overlayOn.has(c.variant.id) && !inChain.has(c.variant.id));
                  return (
                    <div className="mt-1.5">
                      <select value="" onChange={e => { if (e.target.value) addLineToChain(e.target.value); }}
                        className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700">
                        <option value="">+ aggiungi una linea accesa alla catena…</option>
                        {addable.map(c => (
                          <option key={c.variant.id} value={c.variant.id}>{c.route.shortName} · {(c.variant as any).code ? `${(c.variant as any).code} · ` : ""}{c.variant.name}</option>
                        ))}
                      </select>
                      {overlayOn.size === 0 && (
                        <p className="text-[10px] text-amber-400 mt-1">Prima accendi le linee dal pannello <strong>Linee</strong>.</p>
                      )}
                    </div>
                  );
                })()}
                <p className="text-[10px] text-slate-500 mt-1">
                  Ogni linea parte {connMin}–{connMax}′ dopo l'arrivo della precedente al nodo comune.
                  La <strong>{baseRoute?.shortName ?? "base"}</strong> resta ferma: le altre traslano a cascata.
                  Es. mattina: 44 → 2 (la 2 parte dopo la 44); pomeriggio: 2 → 44.
                </p>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">2 · Attesa al nodo Δ (min)</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={60} value={connMin} onChange={e => setConnMin(e.target.value)}
                    className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
                  <span className="text-slate-600">–</span>
                  <input type="number" min={0} max={120} value={connMax} onChange={e => setConnMax(e.target.value)}
                    className="w-16 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
                  <span className="text-slate-500">min</span>
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">3 · Corse da spostare (per ogni linea della catena)</label>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input type="text" value={syncWinFrom} onChange={e => setSyncWinFrom(e.target.value)} placeholder="06:00"
                    className="w-14 px-1 py-1 rounded bg-slate-800 border border-slate-700 font-mono text-center" />
                  <span className="text-slate-600">–</span>
                  <input type="text" value={syncWinTo} onChange={e => setSyncWinTo(e.target.value)} placeholder="09:00"
                    className="w-14 px-1 py-1 rounded bg-slate-800 border border-slate-700 font-mono text-center" />
                  <button onClick={applySyncWindow}
                    className="px-2 py-1 rounded bg-purple-600/80 text-white hover:bg-purple-500">Applica finestra a tutte</button>
                </div>
                {syncChain.filter(it => it.kind === "variant").length === 0 && (
                  <p className="text-[10px] text-slate-500">Aggiungi linee alla catena per selezionarne le corse.</p>
                )}
                {syncChain.map(it => {
                  if (it.kind !== "variant") return null;
                  const trips = syncLineTrips(it.variantId);
                  const sel = syncSel[it.variantId] ?? new Set<string>();
                  const open = syncExpand === it.variantId;
                  return (
                    <div key={it.variantId} className="rounded border border-slate-800 mb-1.5">
                      <button onClick={() => setSyncExpand(open ? null : it.variantId)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-slate-800/60">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: chainColor(it) }} />
                        <span className="flex-1 truncate text-left text-slate-200">{chainName(it)}</span>
                        <span className="text-purple-300 font-semibold">{sel.size}/{trips.length}</span>
                        <span className="text-slate-500">{open ? "▾" : "▸"}</span>
                      </button>
                      {open && (
                        <div className="border-t border-slate-800">
                          <div className="flex items-center gap-1.5 px-2 py-1">
                            <button onClick={() => setSyncSel(prev => ({ ...prev, [it.variantId]: new Set(trips.map(x => x.trip.id)) }))}
                              className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">Tutte</button>
                            <button onClick={() => setSyncSel(prev => ({ ...prev, [it.variantId]: new Set() }))}
                              className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">Nessuna</button>
                          </div>
                          <div className="max-h-36 overflow-y-auto divide-y divide-slate-800/60">
                            {trips.map(({ trip, dep }) => (
                              <label key={trip.id} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-slate-800/60">
                                <input type="checkbox" checked={sel.has(trip.id)}
                                  onChange={() => setSyncSel(prev => {
                                    const n = new Set(prev[it.variantId] ?? []);
                                    n.has(trip.id) ? n.delete(trip.id) : n.add(trip.id);
                                    return { ...prev, [it.variantId]: n };
                                  })}
                                  className="accent-purple-500" />
                                <span className="font-mono text-slate-200">{Number.isFinite(dep) ? secToHm(dep) : "—"}</span>
                                <span className="flex-1 truncate text-slate-400">{trip.shortName || trip.headsign || trip.id.slice(0, 8)}</span>
                              </label>
                            ))}
                            {trips.length === 0 && <div className="px-2 py-2 text-slate-500">Corse in caricamento…</div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="text-[10px] text-slate-500">Le corse NON selezionate restano ferme: sincronizza la fascia del mattino, poi riordina la catena e fai quella del pomeriggio.</p>
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">4 · Shift massimo per linea (± min)</label>
                <input type="number" min={1} max={60} value={syncMaxShift} onChange={e => setSyncMaxShift(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700" />
              </div>
              <button onClick={runSyncSearch} disabled={syncBusy || syncChain.filter(it => it.kind === "variant").length === 0}
                className="w-full px-2 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 font-medium">
                Calcola shift ottimali della catena
              </button>
              {/* Export SEMPRE visibile: attivo dopo il calcolo del piano */}
              <button onClick={() => downloadSyncReport("proposta")} disabled={syncBusy || !syncPlan}
                title={syncPlan ? "Scarica il report HTML (stampabile) che certifica il lavoro sulle coincidenze" : "Prima calcola il piano della catena: il report certifica parametri, Δ e coincidenze"}
                className="w-full px-2 py-1.5 rounded border border-purple-500/40 text-purple-300 hover:bg-purple-500/10 disabled:opacity-40 disabled:cursor-not-allowed font-medium">
                📄 Esporta report coincidenze (HTML)
              </button>
              {syncPlan && (
                <div className="rounded border border-purple-500/30 bg-purple-500/10 p-2 space-y-1.5">
                  {syncPlan.map(p2 => (
                    <p key={p2.variantId} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: chainColor({ kind: "variant", variantId: p2.variantId }) }} />
                      <span className="flex-1 truncate">{p2.name}</span>
                      <strong className="font-mono">Δ {p2.delta > 0 ? "+" : ""}{p2.delta}′</strong>
                      <span className="font-mono text-slate-400">Z {p2.zNow}→{p2.zBest}</span>
                    </p>
                  ))}
                  {syncPlan.some(p2 => p2.delta !== 0) ? (
                    <>
                      <p className="text-[10px] text-purple-300">
                        👁 Sul grafico le linee traslate sono <strong>tratteggiate</strong> nel loro colore (cerchi = coincidenze previste lungo la catena).
                      </p>
                      <button onClick={() => setSyncConfirmOpen(true)} disabled={syncBusy}
                        className="w-full px-2 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 font-medium inline-flex items-center justify-center gap-1.5">
                        Applica la catena…
                      </button>
                    </>
                  ) : (
                    <p className="text-[10px] text-emerald-300">Gli orari attuali sono già ottimali per la catena scelta.</p>
                  )}
                  <p className="text-[9px] text-slate-500">Ogni linea trasla SOLO le corse selezionate (headway interno invariato). Annullabile riapplicando i Δ opposti. All'applicazione il report definitivo viene scaricato automaticamente.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {multOpen && (
          <div className="w-80 border-l border-slate-800 bg-slate-900 flex flex-col shrink-0">
            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
              <CopyPlus className="w-4 h-4 text-emerald-400" />
              <h3 className="font-semibold text-sm">Moltiplica corsa</h3>
              <div className="flex-1" />
              <button onClick={() => setActiveTool(null)} className="p-1 rounded hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 space-y-3 text-xs overflow-auto">
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">Corsa base (profilo tempi di percorrenza)</label>
                <select
                  value={multBaseTripId} onChange={e => setMultBaseTripId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
                >
                  <option value="">Seleziona corsa…</option>
                  {tripsSorted.map(t => {
                    const first = stMap[t.id]?.[0]?.departureTime;
                    return (
                      <option key={t.id} value={t.id}>
                        {first ? secToHm(hmsToSec(first)) : "—"} · {t.shortName || t.headsign || t.id.slice(0, 8)}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-slate-500 block mb-1">Cadenza (minuti)</label>
                <input
                  type="number" min={1} max={240} value={multHeadway}
                  onChange={e => setMultHeadway(Number(e.target.value))}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500 block mb-1">Dalle (prima partenza)</label>
                  <input
                    type="text" value={multFrom} onChange={e => setMultFrom(e.target.value)}
                    placeholder="06:00"
                    className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 font-mono"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500 block mb-1">Alle (ultima partenza)</label>
                  <input
                    type="text" value={multTo} onChange={e => setMultTo(e.target.value)}
                    placeholder="09:00"
                    className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 font-mono"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-500 leading-snug">
                Genera corse copiando i tempi di percorrenza della corsa base, con prima
                partenza a cadenza fissa nella finestra. Formato orari HH:MM (anche &gt;24:00,
                es. 25:30 per le corse dopo mezzanotte). L'anteprima appare tratteggiata in
                verde nel grafico.
              </p>

              {multBaseTripId && !multPreview && (
                <div className="px-2 py-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300">
                  Parametri non validi (controlla cadenza e finestra oraria).
                </div>
              )}
              {multPreview && (
                <div className="px-2 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                  {multPreview.runs.length} corse in anteprima
                  {multPreview.runs.length > 0 && (
                    <span className="text-emerald-400/70">
                      {" "}({secToHm(multPreview.runs[0].startSec)} → {secToHm(multPreview.runs[multPreview.runs.length - 1].startSec)})
                    </span>
                  )}
                </div>
              )}

              <button
                onClick={createMultiplied}
                disabled={!multPreview || multPreview.runs.length === 0 || createMut.isPending}
                className="w-full px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium flex items-center justify-center gap-1.5"
              >
                {createMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Crea {multPreview?.runs.length ?? 0} corse
              </button>
            </div>
          </div>
        )}

        {/* ─── Barra STRUMENTI verticale (sempre visibile, un pannello alla volta) ─── */}
        <div className="w-[68px] border-l border-slate-800 bg-slate-900 flex flex-col items-stretch py-2 px-1.5 gap-1.5 shrink-0">
          <span className="text-center text-[8px] uppercase tracking-widest text-slate-600 font-semibold pb-0.5">Strumenti</span>
          <RailButton
            icon={<Layers className="w-4 h-4" />} label="Linee"
            active={activeTool === "layers"} disabled={!variantId}
            badge={overlayOn.size > 0 ? String(overlayOn.size) : null}
            activeCls="bg-cyan-500/15 border-cyan-500/50 text-cyan-300"
            onClick={() => toggleTool("layers")}
            title="Accendi altre linee sul grafico (un colore per linea)" />
          <RailButton
            icon={<CircleDot className="w-4 h-4" />} label="Coincid."
            active={activeTool === "conn"} disabled={!variantId}
            badge={showConn && overlayOn.size > 0 ? String(connections.z) : null}
            activeCls="bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
            onClick={() => toggleTool("conn")}
            title="Coincidenze ai nodi di cambio: mostra/nascondi e finestra di attesa" />
          <RailButton
            icon={<Shuffle className="w-4 h-4" />} label="Sincron."
            active={activeTool === "sync"} disabled={!variantId}
            badge={null}
            activeCls="bg-purple-500/15 border-purple-500/50 text-purple-300"
            onClick={() => toggleTool("sync")}
            title="Sincronizza le coincidenze: scegli senso, corse da spostare e Δ ottimale" />
          <RailButton
            icon={<CopyPlus className="w-4 h-4" />} label="Moltipl."
            active={activeTool === "mult"} disabled={!variantId}
            badge={null}
            activeCls="bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
            onClick={() => toggleTool("mult")}
            title="Moltiplica una corsa a cadenza costante" />
        </div>
      </div>

      {/* ─── Barra di stato ─── */}
      <div className="h-7 border-t border-slate-800 bg-slate-900 px-3 flex items-center gap-3 text-[10px] text-slate-500 shrink-0">
        {variantId ? (
          <>
            <span><strong className="text-slate-300">{visibleTrips.length}</strong> corse · linea <strong className="text-slate-300">{baseRoute?.shortName}</strong></span>
            {baseGeoms.length < visibleTrips.length && (
              <span className="text-amber-400">{visibleTrips.length - baseGeoms.length} senza orari (non disegnabili)</span>
            )}
            {overlayOn.size > 0 && (
              <span><strong className="text-cyan-300">{overlayOn.size}</strong> varianti sovrapposte</span>
            )}
            {showConn && overlayOn.size > 0 && (
              <span className="px-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono">Z = {connections.z}</span>
            )}
            {((axis as any)?.shared?.size ?? 0) > 0 && (
              <span className="text-amber-300">◆ {(axis as any).shared.size} interscambi</span>
            )}
          </>
        ) : (
          <span>Seleziona una linea e una variante di riferimento per iniziare.</span>
        )}
        <div className="flex-1" />
        <span className="text-slate-600">rotella = zoom · drag sfondo = pan · drag corsa = trasla orari</span>
      </div>

      {/* ─── Conferma variazione sync (dopo l'anteprima sul grafico) ─── */}
      {syncConfirmOpen && syncPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !syncBusy && setSyncConfirmOpen(false)}>
          <div className="w-full max-w-sm mx-4 rounded-xl border border-purple-500/30 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100">⇆ Confermi la sincronizzazione della catena?</h3>
            </div>
            <div className="p-4 space-y-2 text-xs text-slate-300">
              <p>
                Ordine di arrivo al nodo: <strong>{syncChain.map(it => it.kind === "base" ? (baseRoute?.shortName ?? "base") : (sharedCandidates.find(c => c.variant.id === it.variantId)?.route.shortName ?? "?")).join(" → ")}</strong>
                {" "}(attesa {connMin}–{connMax}′ a ogni passaggio; la {baseRoute?.shortName ?? "base"} non si sposta).
              </p>
              <div className="rounded border border-slate-800 divide-y divide-slate-800/60">
                {syncPlan.map(p2 => (
                  <p key={p2.variantId} className="flex items-center gap-2 px-2 py-1.5">
                    <span className="flex-1 truncate">{p2.name}</span>
                    <strong className="font-mono">Δ {p2.delta > 0 ? "+" : ""}{p2.delta}′</strong>
                    <span className="text-slate-500">{p2.moved} corse</span>
                    <span className="font-mono text-slate-400">Z {p2.zNow}→{p2.zBest}</span>
                  </p>
                ))}
              </div>
              <p className="text-[10px] text-slate-500">Traslano SOLO le corse selezionate di ogni linea; le altre restano ferme. Gli orari vengono aggiornati sul database. Reversibile riapplicando i Δ opposti alle stesse selezioni.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setSyncConfirmOpen(false)} disabled={syncBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button
                onClick={async () => { await applySyncPlan(); setSyncConfirmOpen(false); }}
                disabled={syncBusy}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                {syncBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Conferma variazione
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
