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
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Loader2, ZoomIn, ZoomOut, Maximize2, CopyPlus, Layers,
  X, Check, GitCommitHorizontal,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsVariants, type PsVariant,
  getPsVariant, type PsVariantStop,
  listPsStops,
  listPsCalendars,
  listPsTrips, type PsTrip,
  getPsStopTimesBulk, type PsStopTime,
  shiftPsTripTimes,
  batchCreatePsTrips, type PsBatchTripInput,
} from "@/lib/planning-studio-api";

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

/* Margini del grafico */
const ML = 150, MT = 26, MR = 16, MB = 8;
const T_MIN = 0, T_MAX = 30 * 3600;          // limiti assoluti del dominio tempo
const DEFAULT_T0 = 4 * 3600, DEFAULT_T1 = 26 * 3600;

/* ════════════════ Pagina ════════════════ */

export default function PlanningStudioTtdPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  /* ─── Selettori: linea / variante / calendario ─── */
  const [routeId, setRouteId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [calendarFilter, setCalendarFilter] = useState("");

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
  const calendarsQ = useQuery({
    queryKey: ["ps", projectId, "calendars"],
    queryFn: () => listPsCalendars(projectId),
    enabled: !!projectId,
  });
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
      const all: { route: PsRoute; variant: PsVariant }[] = [];
      for (const r of routesQ.data ?? []) {
        const vs = await listPsVariants(projectId, r.id);
        for (const v of vs) if (v.id !== variantId) all.push({ route: r, variant: v });
      }
      const out: { route: PsRoute; variant: PsVariant; stops: PsVariantStop[]; shared: number }[] = [];
      const list = all.slice(0, 200); // cap difensivo su reti grandi
      for (let i = 0; i < list.length; i += 6) {
        const chunk = list.slice(i, i + 6);
        const res = await Promise.all(chunk.map(async c => {
          try {
            const d = await getPsVariant(projectId, c.variant.id);
            const shared = d.stops.filter(s => baseStopIds.has(s.stopId)).length;
            // NIENTE filtro: si possono accendere anche linee SENZA fermate in
            // comune (il conteggio resta come indicatore di coincidenza).
            return { ...c, stops: d.stops, shared };
          } catch { return null; }
        }));
        for (const r of res) if (r) out.push(r);
      }
      out.sort((x, y) => y.shared - x.shared);
      return out;
    },
  });

  const [overlayOn, setOverlayOn] = useState<Set<string>>(new Set());
  const [overlayData, setOverlayData] = useState<Record<string, { trips: PsTrip[]; st: Record<string, PsStopTime[]> }>>({});
  const [overlayPanelOpen, setOverlayPanelOpen] = useState(false);
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
  const yOf = (dist: number) => MT + (dist / (baseAxis?.total || 1)) * innerH;

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
    | null
  >(null);
  const [tripDrag, setTripDrag] = useState<{ tripId: string; deltaSec: number } | null>(null);
  const tripDragRef = useRef(tripDrag);
  tripDragRef.current = tripDrag;

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

  function svgPos(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const pos = svgPos(e);
    const tripEl = (e.target as Element).closest?.("[data-trip]");
    const tripId = tripEl?.getAttribute("data-trip");
    if (tripId && stMap[tripId]) {
      dragRef.current = { mode: "trip", tripId, startX: pos.x };
    } else {
      dragRef.current = { mode: "pan", startX: pos.x, t0: tDomain.t0, t1: tDomain.t1 };
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const pos = svgPos(e);
    if (d.mode === "pan") {
      const span = d.t1 - d.t0;
      const dSec = ((d.startX - pos.x) / innerW) * span;
      setDomainClamped(d.t0 + dSec, d.t1 + dSec);
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
    shiftMut.mutate({ tripId: d.tripId, deltaMinutes });
  }

  /* ─── Moltiplica corsa (cadenzamento) ─── */
  const [multOpen, setMultOpen] = useState(false);
  const [multBaseTripId, setMultBaseTripId] = useState("");
  const [multHeadway, setMultHeadway] = useState(15);
  const [multFrom, setMultFrom] = useState("06:00");
  const [multTo, setMultTo] = useState("09:00");
  useEffect(() => { setMultBaseTripId(""); }, [variantId]);

  // Corse base visibili (filtrate per calendario)
  const visibleTrips = useMemo(() => {
    let trips = tripsQ.data ?? [];
    if (calendarFilter) trips = trips.filter(t => t.calendarId === calendarFilter);
    return trips;
  }, [tripsQ.data, calendarFilter]);

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
      setMultOpen(false);
    },
    onError: (e: any) => toast.error(e?.message || "Errore nella creazione delle corse"),
  });

  function createMultiplied() {
    if (!multPreview || multPreview.runs.length === 0) return;
    const bt = multPreview.baseTrip;
    createMut.mutate(multPreview.runs.map(run => ({
      routeId: bt.routeId,
      variantId: bt.variantId,
      calendarId: bt.calendarId ?? (calendarFilter || null),
      headsign: bt.headsign ?? null,
      direction: bt.direction,
      serviceLabel: bt.serviceLabel ?? null,
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
    if (!baseAxis) return [];
    const out: TripGeom[] = [];
    for (const t of visibleTrips) {
      const sts = stMap[t.id];
      if (!sts || sts.length < 2) continue;
      const shift = tripDrag?.tripId === t.id ? tripDrag.deltaSec : 0;
      const segs = buildSegments(sts, baseAxis.byStop, shift);
      if (segs.length === 0) continue;
      out.push({
        trip: t, sts, segs, color: baseColor, isOverlay: false,
        label: `${baseRoute?.shortName ?? ""} ${t.shortName || t.headsign || t.id.slice(0, 8)}`.trim(),
      });
    }
    return out;
  }, [visibleTrips, stMap, baseAxis, tripDrag, baseColor, baseRoute]);

  const overlayGeoms: TripGeom[] = useMemo(() => {
    if (!baseAxis) return [];
    const out: TripGeom[] = [];
    for (const cand of candidatesQ.data ?? []) {
      if (!overlayOn.has(cand.variant.id)) continue;
      const data = overlayData[cand.variant.id];
      if (!data) continue;
      const color = colorByRoute.get(cand.route.id) ?? routeColor(cand.route.color, "#22d3ee");
      let trips = data.trips;
      if (calendarFilter) trips = trips.filter(t => t.calendarId === calendarFilter);
      for (const t of trips) {
        const sts = data.st[t.id];
        if (!sts || sts.length < 2) continue;
        const segs = buildSegments(sts, baseAxis.byStop);
        if (segs.length === 0) continue;
        out.push({
          trip: t, sts, segs, color, isOverlay: true,
          label: `${cand.route.shortName} ${t.shortName || t.headsign || t.id.slice(0, 8)}`.trim(),
        });
      }
    }
    return out;
  }, [candidatesQ.data, overlayOn, overlayData, baseAxis, calendarFilter, colorByRoute]);

  // Anteprima cadenzamento come geometrie tratteggiate
  const previewGeoms: Pt[][][] = useMemo(() => {
    if (!baseAxis || !multPreview) return [];
    return multPreview.runs.map(run =>
      buildSegments(
        run.stopTimes.map(s => ({ ...s, tripId: "", stopSeq: 0, stopName: "", pickupType: 0, dropOffType: 0, shapeDistTraveled: null })) as PsStopTime[],
        baseAxis.byStop,
      ),
    );
  }, [baseAxis, multPreview]);

  /* ─── Coincidenze ai nodi condivisi (stesso cluster O stessa fermata) ───
     Direzioni: base arriva → altra linea parte, e viceversa, con attesa in
     [connMin, connMax] minuti. Z = numero di coincidenze realizzate. ─── */
  type ConnPt = { t: number; dist: number; wait: number; label: string };
  const connections = useMemo<{ pts: ConnPt[]; z: number }>(() => {
    if (!showConn || !baseAxis || overlayGeoms.length === 0 || baseGeoms.length === 0) return { pts: [], z: 0 };
    const minW = Math.max(0, Number(connMin) || 0) * 60;
    const maxW = Math.max(minW, (Number(connMax) || 10) * 60);
    // nodo → posizione y sulla base (prima fermata base del nodo)
    const nodeDist = new Map<string, number>();
    for (const st of baseAxis.stops) {
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
  }, [showConn, baseAxis, baseGeoms, overlayGeoms, nodeOfStop, connMin, connMax]);

  /* ─── C4 · Sincronizzatore coincidenze: trova lo shift Δ della variante scelta
     che MASSIMIZZA Z (attese in finestra), entro ±maxShift minuti. ─── */
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncVariantId, setSyncVariantId] = useState("");
  const [syncMaxShift, setSyncMaxShift] = useState("15");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<{ best: number; zNow: number; zBest: number; top: { delta: number; z: number }[] } | null>(null);
  useEffect(() => { setSyncResult(null); }, [syncVariantId, overlayOn, connMin, connMax]);

  function computeConnForShift(vid: string, deltaSec: number, collect = false): { z: number; pts: ConnPt[] } {
    if (!baseAxis) return { z: 0, pts: [] };
    const minW = Math.max(0, Number(connMin) || 0) * 60;
    const maxW = Math.max(minW, (Number(connMax) || 10) * 60);
    const nodeDist = new Map<string, number>();
    for (const st of baseAxis.stops) {
      const n = nodeOfStop.get(st.stopId) ?? st.stopId;
      if (!nodeDist.has(n)) nodeDist.set(n, st.dist);
    }
    const baseArr = new Map<string, number[]>();
    const baseDep = new Map<string, number[]>();
    for (const g of baseGeoms) for (const st of g.sts) {
      const n = nodeOfStop.get(st.stopId) ?? st.stopId;
      if (!nodeDist.has(n)) continue;
      if (!baseArr.has(n)) { baseArr.set(n, []); baseDep.set(n, []); }
      baseArr.get(n)!.push(hmsToSec(st.arrivalTime));
      baseDep.get(n)!.push(hmsToSec(st.departureTime));
    }
    const data = overlayData[vid];
    if (!data) return { z: 0, pts: [] };
    let trips = data.trips;
    if (calendarFilter) trips = trips.filter(t => t.calendarId === calendarFilter);
    let z = 0;
    const pts: ConnPt[] = [];
    for (const t of trips) {
      for (const st of data.st[t.id] ?? []) {
        const n = nodeOfStop.get(st.stopId) ?? st.stopId;
        const dd = nodeDist.get(n);
        if (dd == null) continue;
        const oArr = hmsToSec(st.arrivalTime) + deltaSec;
        const oDep = hmsToSec(st.departureTime) + deltaSec;
        for (const a2 of baseArr.get(n) ?? []) {
          const w = oDep - a2;
          if (w >= minW && w <= maxW) { z++; if (collect) pts.push({ t: oDep, dist: dd, wait: w, label: `attesa ${Math.round(w / 60)}′ · ${st.stopName}` }); }
        }
        for (const p2 of baseDep.get(n) ?? []) {
          const w = p2 - oArr;
          if (w >= minW && w <= maxW) { z++; if (collect) pts.push({ t: p2, dist: dd, wait: w, label: `attesa ${Math.round(w / 60)}′ · ${st.stopName}` }); }
        }
      }
    }
    return { z, pts };
  }
  const computeZForShift = (vid: string, deltaSec: number) => computeConnForShift(vid, deltaSec).z;

  /* ─── Anteprima sync: la linea scelta TRASLATA di Δbest, tratteggiata,
     con le coincidenze previste — l'utente VEDE lo spostamento prima di
     confermare. ─── */
  const syncPreview = useMemo(() => {
    if (!syncOpen || !syncResult || syncResult.best === 0 || !syncVariantId || !baseAxis) return null;
    const data = overlayData[syncVariantId];
    if (!data) return null;
    const deltaSec = syncResult.best * 60;
    let trips = data.trips;
    if (calendarFilter) trips = trips.filter(t => t.calendarId === calendarFilter);
    const geoms: Pt[][][] = [];
    for (const t of trips) {
      const sts = data.st[t.id];
      if (!sts || sts.length < 2) continue;
      const segs = buildSegments(sts, baseAxis.byStop, deltaSec);
      if (segs.length) geoms.push(segs);
    }
    const conn = computeConnForShift(syncVariantId, deltaSec, true);
    return { geoms, pts: conn.pts, delta: syncResult.best };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOpen, syncResult, syncVariantId, overlayData, baseAxis, calendarFilter, connMin, connMax, baseGeoms, nodeOfStop]);

  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);

  function runSyncSearch() {
    if (!syncVariantId || !overlayData[syncVariantId]) { toast.error("Accendi e scegli la linea da sincronizzare"); return; }
    const M = Math.min(60, Math.max(1, Math.round(Number(syncMaxShift) || 15)));
    const table: { delta: number; z: number }[] = [];
    for (let d = -M; d <= M; d++) table.push({ delta: d, z: computeZForShift(syncVariantId, d * 60) });
    const zNow = table.find(r => r.delta === 0)?.z ?? 0;
    const best = [...table].sort((x, y) => y.z - x.z || Math.abs(x.delta) - Math.abs(y.delta))[0];
    const top = [...table].sort((x, y) => y.z - x.z || Math.abs(x.delta) - Math.abs(y.delta)).slice(0, 5);
    setSyncResult({ best: best.delta, zNow, zBest: best.z, top });
  }

  async function applySyncShift(deltaMin: number) {
    const data = overlayData[syncVariantId];
    if (!data || deltaMin === 0) return;
    // guardia: nessun orario negativo
    for (const t of data.trips) {
      const sts = data.st[t.id] ?? [];
      if (sts.length && Math.min(...sts.map(x => hmsToSec(x.arrivalTime))) + deltaMin * 60 < 0) {
        toast.error("Lo shift porterebbe orari prima di 00:00"); return;
      }
    }
    setSyncBusy(true);
    try {
      let done = 0;
      for (const t of data.trips) {
        await shiftPsTripTimes(projectId, t.id, deltaMin);
        done++;
      }
      // aggiorna in locale gli orari della variante spostata
      setOverlayData(prev => {
        const cur = prev[syncVariantId];
        if (!cur) return prev;
        const st: Record<string, PsStopTime[]> = {};
        for (const [tid, sts] of Object.entries(cur.st)) {
          st[tid] = sts.map(x => ({
            ...x,
            arrivalTime: secToHms(hmsToSec(x.arrivalTime) + deltaMin * 60),
            departureTime: secToHms(hmsToSec(x.departureTime) + deltaMin * 60),
          }));
        }
        return { ...prev, [syncVariantId]: { ...cur, st } };
      });
      toast.success(`✅ Sincronizzato: ${done} corse traslate di ${deltaMin > 0 ? "+" : ""}${deltaMin} min`, {
        description: "Le coincidenze sul grafico sono aggiornate.",
      });
      setSyncResult(null);
    } catch (e: any) {
      toast.error("Errore durante lo shift", { description: e?.message });
    } finally { setSyncBusy(false); }
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
    if (!baseAxis) return [];
    const out: { name: string; y: number; dist: number }[] = [];
    let lastY = -Infinity;
    for (const s of baseAxis.stops) {
      const y = MT + (s.dist / baseAxis.total) * innerH;
      if (y - lastY >= 12) {
        out.push({ name: s.stopName, y, dist: s.dist });
        lastY = y;
      }
    }
    return out;
  }, [baseAxis, innerH]);

  const stLoading = !!variantId && (tripsQ.data ?? []).some(t => !(t.id in stMap));
  const project = projectQ.data;
  const calendars = calendarsQ.data ?? [];
  const variants = variantsQ.data ?? [];
  const sharedCandidates = candidatesQ.data ?? [];

  /* ════════════════ Render ════════════════ */
  return (
    <div ref={pageRef} className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100">
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
        <div className="flex-1" />
        {stLoading && (
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> orari…
          </span>
        )}
      </div>

      {/* Toolbar: selettori + zoom + strumenti */}
      <div className="h-12 border-b border-slate-800 bg-slate-900/40 px-4 flex items-center gap-3 text-xs shrink-0">
        <select
          value={routeId} onChange={e => setRouteId(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[150px]"
        >
          <option value="">Linea…</option>
          {routes.map(r => (
            <option key={r.id} value={r.id}>{r.shortName} {r.longName ? `· ${r.longName}` : ""}</option>
          ))}
        </select>
        <select
          value={variantId} onChange={e => setVariantId(e.target.value)}
          disabled={!routeId}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[170px] disabled:opacity-40"
        >
          <option value="">Variante…</option>
          {variants.map(v => (
            <option key={v.id} value={v.id}>{v.name} ({v.direction === 0 ? "andata" : "ritorno"})</option>
          ))}
        </select>
        <select
          value={calendarFilter} onChange={e => setCalendarFilter(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[150px]"
        >
          <option value="">Tutti i giorni/calendari</option>
          {calendars.map(c => (
            <option key={c.id} value={c.id}>{c.code} {c.name ? `· ${c.name}` : ""}</option>
          ))}
        </select>

        <div className="flex items-center gap-1 ml-2">
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

        <div className="flex-1" />

        {/* Toggle pannello overlay altre linee */}
        <div className="relative">
          <button
            onClick={() => setOverlayPanelOpen(o => !o)}
            disabled={!variantId}
            className={`px-2.5 py-1.5 rounded flex items-center gap-1.5 border disabled:opacity-40 ${
              overlayOn.size > 0
                ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Altre linee{overlayOn.size > 0 ? ` (${overlayOn.size})` : ""}
          </button>
          {overlayPanelOpen && (
            <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-1.5 z-30 min-w-[260px] max-h-72 overflow-auto shadow-xl">
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
                const byRoute = new Map<string, { route: PsRoute; items: typeof sharedCandidates }>();
                for (const c of sharedCandidates) {
                  if (!byRoute.has(c.route.id)) byRoute.set(c.route.id, { route: c.route, items: [] as any });
                  byRoute.get(c.route.id)!.items.push(c);
                }
                return [...byRoute.values()].map(grp => {
                  const ids = grp.items.map(c => c.variant.id);
                  const onCount = ids.filter(id => overlayOn.has(id)).length;
                  const groupColor = colorByRoute.get(grp.route.id) ?? routeColor(grp.route.color, "#475569");
                  return (
                    <div key={grp.route.id} className="mb-0.5">
                      <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700 cursor-pointer font-semibold">
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
                        <label key={c.variant.id} className="flex items-center gap-2 pl-8 pr-2 py-1 rounded hover:bg-slate-700 cursor-pointer">
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
                          <span className="flex-1 truncate text-slate-300">{c.variant.name} ({c.variant.direction === 0 ? "→" : "←"})</span>
                          <span className="text-[10px] text-slate-500">{c.shared} ferm. comuni</span>
                        </label>
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        {/* Toggle pannello cadenzamento */}
        <button
          onClick={() => setMultOpen(o => !o)}
          disabled={!variantId}
          className={`px-2.5 py-1.5 rounded flex items-center gap-1.5 border disabled:opacity-40 ${
            multOpen
              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
              : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
          }`}
        >
          <CopyPlus className="w-3.5 h-3.5" />
          Moltiplica corsa
        </button>

        {/* Sincronizzatore coincidenze */}
        <button
          onClick={() => setSyncOpen(o => !o)}
          disabled={!variantId}
          className={`px-2.5 py-1.5 rounded flex items-center gap-1.5 border disabled:opacity-40 ${
            syncOpen
              ? "bg-purple-500/15 border-purple-500/40 text-purple-300"
              : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
          }`}
          title="Trova lo shift che massimizza le coincidenze con un'altra linea"
        >
          ⇆ Sincronizza
        </button>
      </div>

      {/* Toolbar 2: fascia oraria · asse Y · coincidenze · schermo intero */}
      <div className="min-h-10 border-b border-slate-800 bg-slate-900/30 px-4 py-1.5 flex items-center gap-3 text-xs shrink-0 flex-wrap">
        <span className="text-slate-500">Fascia:</span>
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

        <div className="h-4 w-px bg-slate-800" />
        <span className="text-slate-500">Asse fermate:</span>
        <button onClick={() => setYMode(m => m === "equidistante" ? "distanza" : "equidistante")}
          className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
          title="Equidistante = fermate a passo uniforme (più vicine e leggibili) · Distanze = proporzionale ai km reali">
          {yMode === "equidistante" ? "≡ Equidistante" : "⇕ Distanze reali"}
        </button>

        <div className="h-4 w-px bg-slate-800" />
        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={showConn} onChange={e => setShowConn(e.target.checked)} className="accent-emerald-500" />
          Coincidenze
        </label>
        <span className="text-slate-500">attesa</span>
        <input type="number" min={0} max={60} value={connMin} onChange={e => setConnMin(e.target.value)}
          className="w-12 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
        <span className="text-slate-600">–</span>
        <input type="number" min={0} max={120} value={connMax} onChange={e => setConnMax(e.target.value)}
          className="w-12 px-1.5 py-1 rounded bg-slate-800 border border-slate-700" />
        <span className="text-slate-500">min</span>
        {showConn && overlayOn.size > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono">
            Z = {connections.z}
          </span>
        )}

        <div className="flex-1" />
        {/* Diagnostica corse visibili */}
        {variantId && (tripsQ.data ?? []).length > 0 && (
          <span className="text-slate-500">
            {visibleTrips.length} corse
            {baseGeoms.length < visibleTrips.length && (
              <span className="text-amber-400"> · {visibleTrips.length - baseGeoms.length} senza orari (non disegnabili)</span>
            )}
          </span>
        )}
        <button onClick={toggleFullscreen}
          className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
          title="Schermo intero">
          {isFullscreen ? "🗗 Esci da schermo intero" : "⛶ Schermo intero"}
        </button>
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

              {/* Griglia orizzontale: fermate della variante base */}
              {baseAxis.stops.map((s, i) => (
                <line key={`${s.stopId}-${i}`}
                  x1={ML} y1={yOf(s.dist)} x2={ML + innerW} y2={yOf(s.dist)}
                  stroke="#1e293b" strokeWidth={1} />
              ))}
              {stopLabels.map((l, i) => (
                <text key={i} x={ML - 6} y={l.y + 3} textAnchor="end" fill="#94a3b8" fontSize={9}>
                  {l.name.length > 24 ? l.name.slice(0, 23) + "…" : l.name}
                </text>
              ))}
              {/* Distanza totale in km in basso a sinistra */}
              <text x={ML - 6} y={MT + innerH + 4} textAnchor="end" fill="#475569" fontSize={9} fontFamily="monospace">
                {(baseAxis.total / 1000).toFixed(1)} km
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
                  return (
                    <g key={g.trip.id} opacity={g.trip.isActive ? 1 : 0.35}>
                      {g.segs.map((seg, i) => (
                        <polyline key={i}
                          points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                          fill="none"
                          stroke={dragging ? "#fbbf24" : isMultBase ? "#34d399" : g.color}
                          strokeWidth={dragging || isMultBase ? 2.5 : 1.6}
                          strokeLinejoin="round" />
                      ))}
                      {/* punti fermata (solo se zoom sufficiente) */}
                      {(tDomain.t1 - tDomain.t0) < 4 * 3600 && g.segs.map((seg, i) => (
                        <g key={`pts${i}`}>
                          {seg.map((p, j) => (
                            <circle key={j} cx={xOf(p.sec)} cy={yOf(p.dist)} r={1.8} fill={g.color} />
                          ))}
                        </g>
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
                      {/* etichetta delta durante il drag */}
                      {dragging && tripDrag && (
                        <text
                          x={xOf(g.segs[0][0].sec)} y={yOf(g.segs[0][0].dist) - 8}
                          fill="#fbbf24" fontSize={11} fontFamily="monospace" fontWeight="bold">
                          {Math.round(tripDrag.deltaSec / 60) > 0 ? "+" : ""}{Math.round(tripDrag.deltaSec / 60)} min
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

                {/* Anteprima SYNC: linea scelta traslata di Δbest (tratteggiata viola) */}
                {syncPreview && syncPreview.geoms.map((segs, k) => (
                  <g key={`sy-${k}`} opacity={0.9}>
                    {segs.map((seg, i) => (
                      <polyline key={i}
                        points={seg.map(p => `${xOf(p.sec)},${yOf(p.dist)}`).join(" ")}
                        fill="none" stroke="#c084fc" strokeWidth={1.8}
                        strokeDasharray="6 4" strokeLinejoin="round" />
                    ))}
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
                  <span className="text-purple-300">anteprima Δ {syncPreview.delta > 0 ? "+" : ""}{syncPreview.delta}′</span>
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

          {/* Legenda interazioni */}
          {baseAxis && (
            <div className="absolute bottom-2 right-3 text-[10px] text-slate-600 bg-slate-950/70 px-2 py-1 rounded">
              rotella = zoom · drag sfondo = pan · drag corsa = trasla orari
            </div>
          )}
        </div>

        {/* Pannello cadenzamento ("Moltiplica corsa") */}
        {/* ─── Pannello Sincronizzatore coincidenze (C4) ─── */}
        {syncOpen && (
          <div className="w-[300px] border-l border-slate-800 bg-slate-900/60 p-3 space-y-3 overflow-y-auto shrink-0 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-purple-300">⇆ Sincronizza coincidenze</h3>
              <button onClick={() => setSyncOpen(false)} className="text-slate-500 hover:text-slate-200">✕</button>
            </div>
            <p className="text-[11px] text-slate-400">
              Trova lo <strong>shift Δ</strong> (minuti) della linea scelta che <strong>massimizza le coincidenze Z</strong> con
              la linea base ai nodi condivisi, con attesa {connMin}–{connMax} min.
            </p>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Linea da spostare (accesa in "Altre linee")</label>
              <select value={syncVariantId} onChange={e => setSyncVariantId(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700">
                <option value="">— scegli —</option>
                {sharedCandidates.filter(c => overlayOn.has(c.variant.id)).map(c => (
                  <option key={c.variant.id} value={c.variant.id}>
                    {c.route.shortName} · {c.variant.name}
                  </option>
                ))}
              </select>
              {overlayOn.size === 0 && (
                <p className="text-[10px] text-amber-400 mt-1">Prima accendi almeno una linea dal pannello "Altre linee".</p>
              )}
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Shift massimo (± min)</label>
              <input type="number" min={1} max={60} value={syncMaxShift} onChange={e => setSyncMaxShift(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700" />
            </div>
            <button onClick={runSyncSearch} disabled={!syncVariantId || syncBusy}
              className="w-full px-2 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 font-medium">
              Calcola shift ottimale
            </button>
            {syncResult && (
              <div className="rounded border border-purple-500/30 bg-purple-500/10 p-2 space-y-1.5">
                <p>Ora: <strong className="font-mono">Z = {syncResult.zNow}</strong></p>
                <p>Migliore: <strong className="font-mono">Δ = {syncResult.best > 0 ? "+" : ""}{syncResult.best} min → Z = {syncResult.zBest}</strong></p>
                <div className="text-[10px] text-slate-400">
                  Alternative: {syncResult.top.map(r => `${r.delta > 0 ? "+" : ""}${r.delta}′→${r.z}`).join(" · ")}
                </div>
                {syncResult.zBest > syncResult.zNow && syncResult.best !== 0 ? (
                  <>
                    <p className="text-[10px] text-purple-300">
                      👁 Sul grafico vedi la linea <strong>tratteggiata viola</strong>: è dove finirebbero le corse
                      con Δ {syncResult.best > 0 ? "+" : ""}{syncResult.best}′ (cerchi = coincidenze previste).
                    </p>
                    <button onClick={() => setSyncConfirmOpen(true)} disabled={syncBusy}
                      className="w-full px-2 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 font-medium inline-flex items-center justify-center gap-1.5">
                      Applica Δ {syncResult.best > 0 ? "+" : ""}{syncResult.best} min…
                    </button>
                  </>
                ) : (
                  <p className="text-[10px] text-emerald-300">Gli orari attuali sono già ottimali nella finestra scelta.</p>
                )}
                <p className="text-[9px] text-slate-500">Lo shift trasla TUTTE le corse della linea scelta (l'headway interno resta invariato). Annullabile riapplicando Δ opposto.</p>
              </div>
            )}
          </div>
        )}

        {multOpen && (
          <div className="w-80 border-l border-slate-800 bg-slate-900 flex flex-col shrink-0">
            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
              <CopyPlus className="w-4 h-4 text-emerald-400" />
              <h3 className="font-semibold text-sm">Moltiplica corsa</h3>
              <div className="flex-1" />
              <button onClick={() => setMultOpen(false)} className="p-1 rounded hover:bg-slate-800">
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
      </div>

      {/* ─── Conferma variazione sync (dopo l'anteprima sul grafico) ─── */}
      {syncConfirmOpen && syncResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !syncBusy && setSyncConfirmOpen(false)}>
          <div className="w-full max-w-sm mx-4 rounded-xl border border-purple-500/30 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100">⇆ Confermi la variazione?</h3>
            </div>
            <div className="p-4 space-y-2 text-xs text-slate-300">
              <p>
                Linea: <strong>{(() => { const c = sharedCandidates.find(x => x.variant.id === syncVariantId); return c ? `${c.route.shortName} · ${c.variant.name}` : "—"; })()}</strong>
              </p>
              <p>Shift: <strong className="font-mono">Δ {syncResult.best > 0 ? "+" : ""}{syncResult.best} min</strong> su <strong>{(overlayData[syncVariantId]?.trips.length ?? 0)} corse</strong> (headway interno invariato).</p>
              <p>Coincidenze: <strong className="font-mono">Z {syncResult.zNow} → {syncResult.zBest}</strong> (attesa {connMin}–{connMax} min).</p>
              <p className="text-[10px] text-slate-500">Gli orari vengono aggiornati sul database. Reversibile riapplicando il Δ opposto.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setSyncConfirmOpen(false)} disabled={syncBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button
                onClick={async () => { await applySyncShift(syncResult.best); setSyncConfirmOpen(false); }}
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
