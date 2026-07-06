/**
 * PlannerStudio — Gestione Corse (Trips Manager).
 *
 * Schema vista:
 *   - filtri top: Linea / Variante / Calendario / Solo attive
 *   - tabella corse con colonne: orari, calendario, validità, label, attivo, azioni
 *   - selezione multi-row per operazioni bulk (calendar, validità, attivo)
 *   - drawer dx per dettaglio corsa: validità individuale + eccezioni date
 *
 * Le corse vengono modificate con PATCH per singola riga (validità, label,
 * isActive) o in bulk via /trips/bulk-update.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import TripCountBadge from "@/components/planning-studio/TripCountBadge";
import {
  ArrowLeft, Bus, Filter, Trash2, X, Loader2, Check, Calendar as CalendarIcon,
  Power, PowerOff, CalendarPlus, CalendarMinus, Save, Eye, EyeOff, Timer, Plus,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsVariants, type PsVariant,
  listPsCalendars, type PsCalendar,
  listPsTrips, deletePsTrip, updatePsTrip, bulkUpdatePsTrips, bulkDeletePsTrips, type PsTrip,
  getPsStopTimes, type PsStopTime,
  batchCreatePsTrips, type PsBatchTripInput,
  getPsVariant, type PsVariantStop,
  listPsTripExceptions, addPsTripException, deletePsTripException, type PsTripException,
} from "@/lib/planning-studio-api";
import { listPsDayTypes, postPsValidityBulk, getPsTripValidity, getPsTripsValidityBulk, type PsDayType } from "@/lib/planning-studio-validity-api";
import { listPsValidityCategories, type PsValidityCategory } from "@/lib/planning-studio-validity-units-api";

/** Distanze progressive (m) tra le fermate di una variante: shape_dist se
 * monotona, altrimenti cumulata haversine. */
function cumDistsOf(vStops: PsVariantStop[]): number[] {
  const sdt = vStops.map(st => st.shapeDistTraveled);
  const ok = vStops.length >= 2 &&
    sdt.every(d => d != null && Number.isFinite(d)) &&
    sdt.every((d, i) => i === 0 || (d as number) >= (sdt[i - 1] as number)) &&
    (sdt[sdt.length - 1] as number) > 0;
  if (ok) { const base = sdt[0] as number; return sdt.map(d => (d as number) - base); }
  const out = [0];
  for (let i = 1; i < vStops.length; i++) {
    const a2 = vStops[i - 1], b2 = vStops[i];
    const R = 6371000, dLat = (b2.lat - a2.lat) * Math.PI / 180, dLon = (b2.lon - a2.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a2.lat * Math.PI / 180) * Math.cos(b2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    out.push(out[i - 1] + 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  }
  return out;
}

function fmtTime(t?: string | null) {
  if (!t) return "—";
  return t.length >= 5 ? t.slice(0, 5) : t;
}
function fmtDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
/* ─── Giorni di validità L…D: helper condivisi tra riga tabella e drawer ─── */
const WD_LABELS_ROW = ["L", "M", "M", "G", "V", "S", "D"];
const WD_NAMES = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const wdTypicalCode = (i: number) => (i <= 4 ? "feriale" : i === 5 ? "sabato" : "festivo");
/** Pattern settimanale L…D di un calendario (per il fallback della maschera).
 *  Usa `effectiveWeekdays` se presente (deduce i giorni dai calendar_dates per i
 *  calendari senza flag settimanali), altrimenti i flag monday…sunday. */
function calWeekdays(c: PsCalendar | undefined | null): boolean[] | null {
  if (!c) return null;
  if (Array.isArray(c.effectiveWeekdays) && c.effectiveWeekdays.length === 7) return c.effectiveWeekdays.map(Boolean);
  return [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday];
}
/** Maschera settimanale EFFETTIVA della corsa:
 *  1) `attributes.weekdays` esplicita, se presente; altrimenti
 *  2) il pattern del calendario collegato (`fallback`, es. dopo import GTFS);
 *  3) tutti i giorni attivi.
 *  Così i bollini "Giorni validità" si accendono in base ai giorni reali di
 *  circolazione anche prima di toccare la Matrice di validità. */
function wdMaskOf(trip: PsTrip, fallback?: boolean[] | null): boolean[] {
  const w = (trip.attributes as any)?.weekdays;
  if (Array.isArray(w) && w.length === 7) return w.map((x: any) => x !== false);
  if (fallback && fallback.length === 7) return fallback.map(Boolean);
  return [true, true, true, true, true, true, true];
}
/** Classifica i tipi giorno per prefisso: feriale/FER, sabato/SAB, festivo/FES|DOM. */
function classifyDayTypes(dayTypes: PsDayType[]): Record<string, PsDayType> {
  const m: Record<string, PsDayType> = {};
  for (const dt of dayTypes) {
    const c = `${dt.code || dt.name || ""}`.toLowerCase();
    if (/^fer/.test(c) && !m.feriale) m.feriale = dt;
    else if (/^sab/.test(c) && !m.sabato) m.sabato = dt;
    else if (/^fes|^dom/.test(c) && !m.festivo) m.festivo = dt;
  }
  return m;
}

/* Conversioni orario GTFS (consentono >24:00 per corse dopo mezzanotte) */
function genToSec(t: string): number {
  const q = t.split(":").map(Number);
  return (q[0] || 0) * 3600 + (q[1] || 0) * 60 + (q[2] || 0);
}
function genSecToHms(x: number): string {
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.round(x % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function PlanningStudioTripsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  /* ─── Queries ─── */
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

  /* ─── Filtri ─── */
  const [routeId, setRouteId] = useState<string>("");
  const [variantId, setVariantId] = useState<string>("");
  // Filtro per categoria del Calendario Aziendale (validità), non più per
  // calendario GTFS: coerente con il resto del flusso di validità.
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [onlyActive, setOnlyActive] = useState(false);

  // varianti dipendenti dalla route selezionata
  const variantsQ = useQuery({
    queryKey: ["ps", projectId, "variants", routeId],
    queryFn: () => listPsVariants(projectId, routeId),
    enabled: !!projectId && !!routeId,
  });
  // reset variant quando cambia route
  useEffect(() => { setVariantId(""); }, [routeId]);

  /* ─── Trips ─── */
  const tripsQ = useQuery({
    queryKey: ["ps", projectId, "trips", routeId, variantId, categoryFilter],
    queryFn: () => listPsTrips(projectId, {
      routeId: routeId || undefined,
      variantId: variantId || undefined,
      categoryId: categoryFilter || undefined,
    }),
    enabled: !!projectId,
  });

  // first stop time per ogni trip → orario di partenza (per ordinamento e display)
  // Strategia: caricamento lazy via getPsStopTimes solo se filtrato a una variante
  // (altrimenti sarebbe pesante). Mostriamo il primo arrivo solo se variantId è set.
  const [firstTimes, setFirstTimes] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setFirstTimes({});
    if (!variantId || !tripsQ.data) return;
    const trips = tripsQ.data;
    let cancelled = false;
    (async () => {
      const acc: Record<string, string | null> = {};
      // batch sequenziale (limitiamo per non DDoS)
      for (const t of trips.slice(0, 200)) {
        if (cancelled) return;
        try {
          const sts = await getPsStopTimes(projectId, t.id);
          acc[t.id] = sts.length > 0 ? sts[0].departureTime : null;
        } catch { acc[t.id] = null; }
      }
      if (!cancelled) setFirstTimes(acc);
    })();
    return () => { cancelled = true; };
  }, [projectId, variantId, tripsQ.data]);

  const filteredTrips = useMemo(() => {
    let trips = tripsQ.data ?? [];
    // route/variant/categoria sono filtrati server-side (tripsQ); qui resta solo "solo attive".
    if (onlyActive) trips = trips.filter(t => t.isActive);
    // ordina per orario partenza se disponibile (firstDeparture arriva già
    // dalla lista; firstTimes resta come fallback lazy), poi shortName/headsign
    return [...trips].sort((a, b) => {
      const ta = a.firstDeparture ?? firstTimes[a.id], tb = b.firstDeparture ?? firstTimes[b.id];
      if (ta && tb) return ta.localeCompare(tb);
      if (ta) return -1;
      if (tb) return 1;
      return (a.shortName || a.headsign || "").localeCompare(b.shortName || b.headsign || "");
    });
  }, [tripsQ.data, onlyActive, firstTimes]);

  /* ─── Selezione bulk ─── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  function toggleSel(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    if (selected.size === filteredTrips.length) setSelected(new Set());
    else setSelected(new Set(filteredTrips.map(t => t.id)));
  }
  useEffect(() => { setSelected(new Set()); }, [routeId, variantId, categoryFilter, onlyActive]);

  const [genOpen, setGenOpen] = useState(false);
  const [genTemplateId, setGenTemplateId] = useState("");
  const [genFrom, setGenFrom] = useState("06:00");
  const [genTo, setGenTo] = useState("20:00");
  const [genEvery, setGenEvery] = useState("15");
  const [genBusy, setGenBusy] = useState(false);
  // ── F3 · Anteprima pre-salvataggio con variazione traffico ──
  const [genStep, setGenStep] = useState<"params" | "preview">("params");
  const [genProfile, setGenProfile] = useState<null | {
    tpl: PsTrip; stopIds: string[]; stopNames: string[];
    relArr: number[]; relDep: number[]; deps: number[];
  }>(null);
  const [genCoeff, setGenCoeff] = useState<Record<number, number>>({});
  const [genApplyTraffic, setGenApplyTraffic] = useState(true);
  useEffect(() => { if (!genOpen) { setGenStep("params"); setGenProfile(null); } }, [genOpen]);
  /** Profilo di default dei coefficienti di rallentamento per fascia oraria
   * (proposta modificabile; agganciabile ai dati Analytics quando disponibili). */
  function defaultCoeffForHour(h: number): number {
    const hh = ((h % 24) + 24) % 24;
    if (hh === 7 || hh === 8) return 1.25;
    if (hh === 18) return 1.3;
    if (hh === 17) return 1.2;
    if (hh === 9 || hh === 13) return 1.15;
    if (hh === 12 || hh === 14 || hh === 19) return 1.1;
    return 1.0;
  }

  const [newOpen, setNewOpen] = useState(false);
  const [newStart, setNewStart] = useState("07:00");
  const [newSpeed, setNewSpeed] = useState("18");   // km/h commerciale
  const [newDwell, setNewDwell] = useState("0");    // secondi di sosta per fermata
  const [newCalendarId, setNewCalendarId] = useState("");
  const [newDayTypeIds, setNewDayTypeIds] = useState<Set<string>>(new Set());
  const [newBusy, setNewBusy] = useState(false);

  /* ─── F1 · Corsa PROTOTIPO: grafo della linea con tempi per ARCO
   * (auto-calcolati e sovrascrivibili) e SOSTA per fermata. ─── */
  const newVariantQ = useQuery({
    queryKey: ["ps", projectId, "variant-proto", variantId],
    queryFn: () => getPsVariant(projectId, variantId),
    enabled: !!projectId && !!variantId,
    staleTime: 30_000,
  });
  const [newArcMin, setNewArcMin] = useState<number[]>([]);   // minuti per arco (editabili)
  const [newDwellS, setNewDwellS] = useState<number[]>([]);   // sosta in secondi per fermata

  /** Ricalcola i tempi d'arco dai km e dalla velocità di default. */
  function recalcArcDefaults(vStops: PsVariantStop[], speedKmh: number, dwellSec: number) {
    const cum = cumDistsOf(vStops);
    const mps = Math.max(1, speedKmh) * 1000 / 3600;
    const arcs: number[] = [];
    for (let i = 0; i < vStops.length - 1; i++) {
      const sec = (cum[i + 1] - cum[i]) / mps;
      arcs.push(Math.max(0.5, Math.round((sec / 60) * 10) / 10)); // ≥ 30s, precisione 0.1 min
    }
    setNewArcMin(arcs);
    setNewDwellS(vStops.map((_, i) => (i === 0 || i === vStops.length - 1 ? 0 : dwellSec)));
  }
  // Inizializza il grafo all'apertura del dialog (o al cambio variante)
  useEffect(() => {
    if (!newOpen) return;
    const vStops = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2) return;
    if (newArcMin.length !== vStops.length - 1) {
      recalcArcDefaults(vStops, Number(newSpeed) || 18, Math.max(0, Math.round(Number(newDwell) || 0)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOpen, newVariantQ.data]);
  useEffect(() => { setNewArcMin([]); setNewDwellS([]); }, [variantId]);

  // Orari live del prototipo (arrivo/partenza per fermata)
  const protoTimes = useMemo(() => {
    const vStops = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2 || newArcMin.length !== vStops.length - 1) return null;
    const start = genToSec(newStart + ":00");
    const arr: number[] = [start], dep: number[] = [start];
    for (let i = 1; i < vStops.length; i++) {
      arr.push(dep[i - 1] + Math.round((newArcMin[i - 1] || 0) * 60));
      dep.push(i === vStops.length - 1 ? arr[i] : arr[i] + Math.max(0, Math.round(newDwellS[i] || 0)));
    }
    return { arr, dep, totalMin: Math.round((arr[arr.length - 1] - start) / 60) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newVariantQ.data, newArcMin, newDwellS, newStart]);

  /* ─── Nuova corsa (la PRIMA della variante): orari calcolati da distanza
   * e velocità commerciale, poi diventa il template per "Genera a cadenza".
   * Imposta anche i GIORNI di validità (trip-row-set nella matrice). ─── */
  const dayTypesQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
    enabled: !!projectId, // servono anche alle azioni bulk (proroga giorni)
  });
  // Validità del CALENDARIO AZIENDALE (categorie globali: Scuole Aperte/Chiuse, Festività…)
  const categoriesQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    enabled: true, // servono anche alle azioni bulk (proroga categorie)
    staleTime: 60_000,
  });
  const [newCategoryIds, setNewCategoryIds] = useState<Set<string>>(new Set());
  const [genDayTypeIds, setGenDayTypeIds] = useState<Set<string>>(new Set());
  const [genCategoryIds, setGenCategoryIds] = useState<Set<string>>(new Set());
  // preseleziona "feriale" anche per il generatore
  useEffect(() => {
    if (!genOpen || !dayTypesQ.data || genDayTypeIds.size > 0) return;
    const fer = dayTypesQ.data.find(d => d.code === "feriale");
    if (fer) setGenDayTypeIds(new Set([fer.id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genOpen, dayTypesQ.data]);
  // preseleziona "feriale" alla prima apertura
  useEffect(() => {
    if (!newOpen || !dayTypesQ.data || newDayTypeIds.size > 0) return;
    const fer = dayTypesQ.data.find(d => d.code === "feriale");
    if (fer) setNewDayTypeIds(new Set([fer.id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOpen, dayTypesQ.data]);

  async function runCreateFirstTrip() {
    if (!routeId || !variantId) { toast.error("Seleziona linea e variante"); return; }
    const vStops: PsVariantStop[] = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2) { toast.error("La variante ha meno di 2 fermate: completa prima il percorso nell'editor"); return; }
    if (!protoTimes) { toast.error("Tempi del grafo non pronti"); return; }
    setNewBusy(true);
    try {
      // CORSA ZERO: nessun orario reale — i tempi del grafo vengono salvati
      // ANCORATI a 00:00 (solo tempi per arco + soste). Le corse vere nascono
      // con "Genera a cadenza" a partire da questo prototipo.
      const t0 = protoTimes.arr[0];
      const stopTimes = vStops.map((st, i) => ({
        stopId: st.stopId,
        arrivalTime: genSecToHms(protoTimes.arr[i] - t0),
        departureTime: genSecToHms(protoTimes.dep[i] - t0),
        timepoint: st.timepoint ?? 1,
      }));
      const r = await batchCreatePsTrips(projectId, [{
        routeId, variantId,
        calendarId: newCalendarId || null,
        headsign: null, direction: 0,
        attributes: { prototype: true }, // corsa ZERO: non genera km, esclusa dalle UDP
        stopTimes,
      }]);
      // Giorni di validità (matrice): best-effort, non blocca la creazione.
      const tripId = r.tripIds?.[0];
      if (tripId) {
        try {
          if (newDayTypeIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-row-set", tripId, dayTypeIds: [...newDayTypeIds], isValid: true });
          }
          if (newCategoryIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [tripId], categoryIds: [...newCategoryIds] });
          }
        } catch {
          toast.warning("Corsa creata, ma validità non impostate del tutto", { description: "Completa dalla Matrice di validità." });
        }
      }
      toast.success("✅ Corsa ZERO (prototipo) creata", {
        description: `${vStops.length} fermate · giro ${protoTimes.totalMin} min. È solo un PROTOTIPO senza orario e non genera km: crea le corse reali con "Genera a cadenza".`,
        duration: 8000,
      });
      setNewOpen(false);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Creazione corsa fallita", { description: e?.message });
    } finally { setNewBusy(false); }
  }

  /* ─── C1 · Genera corse a cadenza (even headway, Ceder §4.3) ───
   * Corsa template + fascia oraria + headway → partenze t_k = t0 + k·H,
   * orari propagati su tutte le fermate clonando gli stop_times traslati. */

  const genPreviewCount = useMemo(() => {
    const H = Math.round(Number(genEvery));
    const a = genToSec(genFrom + ":00"), b = genToSec(genTo + ":00");
    if (!Number.isFinite(H) || H < 1 || b <= a) return 0;
    return Math.floor((b - a) / (H * 60)) + 1;
  }, [genFrom, genTo, genEvery]);

  /** Step 1 → 2: prepara il profilo (archi del template + partenze) e apre l'ANTEPRIMA. */
  async function prepareGenerate() {
    const tpl = (tripsQ.data ?? []).find(t => t.id === genTemplateId);
    if (!tpl) { toast.error("Scegli la corsa template"); return; }
    const H = Math.round(Number(genEvery));
    if (!Number.isFinite(H) || H < 1) { toast.error("Cadenza non valida (minuti ≥ 1)"); return; }
    const winFrom = genToSec(genFrom + ":00"), winTo = genToSec(genTo + ":00");
    if (winTo <= winFrom) { toast.error("Fascia oraria non valida (fine dopo inizio)"); return; }
    setGenBusy(true);
    try {
      const sts = await getPsStopTimes(projectId, tpl.id);
      if (sts.length < 2) throw new Error("La corsa template non ha orari alle fermate (stop_times)");
      const baseDep = genToSec(sts[0].departureTime);
      const relArr = sts.map(st => genToSec(st.arrivalTime) - baseDep);
      const relDep = sts.map(st => genToSec(st.departureTime) - baseDep);
      const minOff = Math.min(...relArr);
      const deps: number[] = [];
      for (let t = winFrom; t <= winTo; t += H * 60) {
        if (Math.abs(t - baseDep) < 30) continue;
        if (t + minOff < 0) continue;
        deps.push(t);
      }
      if (deps.length === 0) throw new Error("Nessuna partenza da generare nella fascia");
      if (deps.length > 200) throw new Error(`${deps.length} corse superano il limite di 200 per batch: restringi la fascia o allunga la cadenza`);
      // coefficienti: inizializza le fasce coperte con il profilo di default
      const h0 = Math.floor((deps[0]) / 3600);
      const h1 = Math.floor((deps[deps.length - 1] + relArr[relArr.length - 1]) / 3600);
      setGenCoeff(prev => {
        const next: Record<number, number> = { ...prev };
        for (let h = h0; h <= h1; h++) if (next[h] == null) next[h] = defaultCoeffForHour(h);
        return next;
      });
      setGenProfile({
        tpl,
        stopIds: sts.map(st => st.stopId),
        stopNames: sts.map(st => st.stopName),
        relArr, relDep, deps,
      });
      setGenStep("preview");
    } catch (e: any) {
      toast.error("Anteprima non disponibile", { description: e?.message });
    } finally { setGenBusy(false); }
  }

  /** Orari finali di una corsa: archi del template scalati per il coefficiente
   * della fascia oraria in cui il bus ENTRA nell'arco (se attivo). */
  function buildRunTimes(dep: number, p2: NonNullable<typeof genProfile>): { arr: number[]; dep: number[] } {
    const n = p2.relArr.length;
    const arr: number[] = new Array(n), depT: number[] = new Array(n);
    arr[0] = dep + p2.relArr[0];
    depT[0] = dep + p2.relDep[0];
    for (let i = 1; i < n; i++) {
      const arcSec = p2.relArr[i] - p2.relDep[i - 1];
      const dwell = p2.relDep[i] - p2.relArr[i];
      const c = genApplyTraffic ? (genCoeff[Math.floor(depT[i - 1] / 3600)] ?? 1) : 1;
      arr[i] = depT[i - 1] + Math.round(arcSec * c);
      depT[i] = arr[i] + dwell;
    }
    return { arr, dep: depT };
  }

  /** Step 2 → salvataggio definitivo (con o senza variazione traffico). */
  async function finalizeGenerate() {
    if (!genProfile) return;
    const tpl = genProfile.tpl;
    setGenBusy(true);
    try {
      const payload: PsBatchTripInput[] = genProfile.deps.map(dep => {
        const times = buildRunTimes(dep, genProfile);
        return {
          routeId: tpl.routeId,
          variantId: tpl.variantId,
          calendarId: tpl.calendarId ?? null,
          headsign: tpl.headsign ?? null,
          direction: tpl.direction ?? 0,
          serviceLabel: tpl.serviceLabel ?? null,
          stopTimes: genProfile.stopIds.map((stopId, i) => ({
            stopId,
            arrivalTime: genSecToHms(times.arr[i]),
            departureTime: genSecToHms(times.dep[i]),
            timepoint: 1,
          })),
        };
      });
      const r = await batchCreatePsTrips(projectId, payload);
      // Validità per TUTTE le corse generate: giorni (matrice) + categorie (calendario aziendale)
      if (r.tripIds?.length) {
        try {
          if (genDayTypeIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: r.tripIds, dayTypeIds: [...genDayTypeIds], isValid: true });
          }
          if (genCategoryIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: r.tripIds, categoryIds: [...genCategoryIds] });
          }
        } catch {
          toast.warning("Corse generate, ma validità non impostate del tutto", { description: "Completa dalla Matrice di validità." });
        }
      }
      // Il PROTOTIPO ha esaurito il suo scopo: una volta generate le corse
      // reali viene eliminato (con le sue validità, in cascata).
      let protoRemoved = false;
      if (tpl.attributes?.prototype) {
        try { await deletePsTrip(projectId, tpl.id); protoRemoved = true; }
        catch { toast.warning("Corse create, ma il prototipo non è stato rimosso", { description: "Eliminalo manualmente dall'elenco corse." }); }
      }
      toast.success(`✅ ${r.count} corse generate e salvate`, {
        description: `${genFrom}–${genTo} · una ogni ${genEvery} min · ${genApplyTraffic ? "variazione traffico applicata" : "senza variazione traffico"}${protoRemoved ? " · prototipo rimosso" : ""}`,
        duration: 6000,
      });
      setGenOpen(false);
      setGenStep("params");
      setGenProfile(null);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Generazione fallita", { description: e?.message });
    } finally { setGenBusy(false); }
  }

  /* ─── Mutations ─── */
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PsTrip> & { attributesMerge?: Record<string, any> } }) =>
      updatePsTrip(projectId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] }),
    onError: (e: any) => toast.error(e?.message || "Errore aggiornamento"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePsTrip(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success("Corsa eliminata");
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });
  const bulkMut = useMutation({
    mutationFn: ({ patch }: { patch: any }) => bulkUpdatePsTrips(projectId, Array.from(selected), patch),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success(`${r.count} corse aggiornate`);
      setSelected(new Set());
    },
    onError: (e: any) => toast.error(e?.message || "Errore bulk"),
  });
  // Eliminazione in blocco delle corse selezionate (doppia conferma via modal)
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDelArmed, setBulkDelArmed] = useState(false);
  useEffect(() => { if (!bulkDelOpen) setBulkDelArmed(false); }, [bulkDelOpen]);
  const bulkDeleteMut = useMutation({
    mutationFn: () => bulkDeletePsTrips(projectId, Array.from(selected)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success(`🗑 ${r.count} corse eliminate`);
      setSelected(new Set());
      setBulkDelOpen(false);
    },
    onError: (e: any) => toast.error(e?.message || "Errore eliminazione"),
  });

  /* ─── Giorni + categorie di TUTTE le corse visibili (colonne di riga) ─── */
  const tripsValQ = useQuery({
    queryKey: ["ps", projectId, "trips", "validity-bulk", filteredTrips.map(t => t.id).join(",")],
    queryFn: () => getPsTripsValidityBulk(projectId, filteredTrips.map(t => t.id)),
    enabled: filteredTrips.length > 0,
    staleTime: 15_000,
  });
  const dtKinds = useMemo(() => classifyDayTypes(dayTypesQ.data ?? []), [dayTypesQ.data]);
  const catById = useMemo(() => {
    const m = new Map<string, PsValidityCategory>();
    for (const c of categoriesQ.data ?? []) m.set(c.id, c);
    return m;
  }, [categoriesQ.data]);
  /** calendarId → pattern settimanale L…D (fallback per la maschera corsa). */
  const calWdById = useMemo(() => {
    const m = new Map<string, boolean[]>();
    for (const c of calendarsQ.data ?? []) m.set(c.id, calWeekdays(c)!);
    return m;
  }, [calendarsQ.data]);
  const rowMask = (trip: PsTrip): boolean[] =>
    wdMaskOf(trip, trip.calendarId ? calWdById.get(trip.calendarId) : null);
  /** Il giorno i è attivo per la corsa?
   *  Se la Matrice di validità non ha ancora righe per la corsa (tipico dopo
   *  un import GTFS) si mostra direttamente la circolazione settimanale
   *  (maschera esplicita o pattern del calendario). Con la matrice popolata si
   *  interseca tipo-giorno valido × maschera. */
  function rowDayOn(trip: PsTrip, i: number): boolean {
    const mask = rowMask(trip);
    if (!mask[i]) return false;                       // la corsa non circola quel giorno
    const dv = tripsValQ.data?.dayValidity?.[trip.id];
    if (!dv) return true;                             // nessuna riga in Matrice → circola
    const dt = dtKinds[wdTypicalCode(i)];
    if (!dt) return true;                             // tipo-giorno non classificabile → circola
    return dv[dt.id] !== false;                       // spento SOLO se esplicitamente non valido
  }
  const [rowWdBusy, setRowWdBusy] = useState(false);
  /** Toggle di un giorno direttamente dalla riga (stessa logica del drawer). */
  async function toggleRowWeekday(trip: PsTrip, i: number) {
    if (rowWdBusy || !tripsValQ.data || !dayTypesQ.data) return;
    setRowWdBusy(true);
    try {
      const mask = rowMask(trip);
      const newWd = [...mask];
      if (rowDayOn(trip, i)) {
        newWd[i] = false; // spegni SOLO questo giorno
      } else {
        newWd[i] = true;
        const dt = dtKinds[wdTypicalCode(i)];
        const dv = tripsValQ.data.dayValidity?.[trip.id] ?? {};
        if (dt && !dv[dt.id]) {
          for (let j = 0; j < 7; j++) {
            if (j !== i && wdTypicalCode(j) === wdTypicalCode(i) && !rowDayOn(trip, j)) newWd[j] = false;
          }
          await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [trip.id], dayTypeIds: [dt.id], isValid: true });
        }
      }
      await updatePsTrip(projectId, trip.id, { attributesMerge: { weekdays: newWd } });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
    } catch (e: any) {
      toast.error("Errore aggiornamento giorni", { description: e?.message });
    } finally { setRowWdBusy(false); }
  }

  /* ─── Drawer dettaglio corsa ─── */
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const detailTrip = useMemo(
    () => filteredTrips.find(t => t.id === detailTripId) ?? null,
    [detailTripId, filteredTrips],
  );

  /* ─── Render ─── */
  const project = projectQ.data;
  const routes = routesQ.data ?? [];
  const variants = variantsQ.data ?? [];
  const calendars = calendarsQ.data ?? [];

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
          <Bus className="w-5 h-5 text-amber-400" />
          <h1 className="font-semibold text-sm">Corse</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name} ·{" "}
            <span className="text-slate-400">
              {filteredTrips.length} corse {tripsQ.data && filteredTrips.length !== tripsQ.data.length && `(di ${tripsQ.data.length})`}
            </span>
          </span>
        )}
        <span className="ml-2"><TripCountBadge projectId={projectId} /></span>
      </div>

      {/* Filtri (flex-wrap: con le azioni bulk attive va a capo invece di uscire dallo schermo) */}
      <div className="min-h-12 border-b border-slate-800 bg-slate-900/40 px-4 py-1.5 flex items-center gap-3 text-xs flex-wrap">
        <Filter className="w-3.5 h-3.5 text-slate-500" />
        <select
          value={routeId} onChange={e => setRouteId(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[160px]"
        >
          <option value="">Tutte le linee</option>
          {routes.map(r => (
            <option key={r.id} value={r.id}>{r.shortName} {r.longName ? `· ${r.longName}` : ""}</option>
          ))}
        </select>

        <select
          value={variantId} onChange={e => setVariantId(e.target.value)}
          disabled={!routeId}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[160px] disabled:opacity-40"
        >
          <option value="">Tutte le varianti</option>
          {variants.map(v => (
            <option key={v.id} value={v.id}>{v.name} ({v.direction === 0 ? "→" : "←"})</option>
          ))}
        </select>

        <select
          value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          title="Filtra le corse per categoria del Calendario Aziendale (es. Scuole Aperte, Scuole Chiuse Estivo…)"
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[180px]"
        >
          <option value="">Tutte le categorie (Cal. Aziendale)</option>
          {(categoriesQ.data ?? []).map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-slate-400">
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)}
            className="accent-amber-500" />
          Solo attive
        </label>

        <button
          onClick={() => {
            if (!variantId) { toast.info("Seleziona linea e variante", { description: "La corsa si crea sul percorso (variante) scelto." }); return; }
            setNewOpen(true);
          }}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
          title="Crea la prima corsa della variante: orari alle fermate calcolati da distanza e velocità commerciale"
        >
          <Plus className="w-3.5 h-3.5" /> Nuova corsa
        </button>
        <button
          onClick={() => {
            // Via rapida: basta SPUNTARE una corsa (es. il prototipo) — niente
            // filtro linea/variante obbligatorio. Con più spunte vince il
            // prototipo, altrimenti serve una selezione univoca.
            if (selected.size > 0) {
              const sel = filteredTrips.filter(t => selected.has(t.id));
              const tpl = sel.find(t => t.attributes?.prototype) ?? (sel.length === 1 ? sel[0] : null);
              if (tpl) { setGenTemplateId(tpl.id); setGenOpen(true); return; }
              toast.info("Selezione ambigua", { description: "Spunta UNA corsa (o un prototipo) da usare come template." });
              return;
            }
            if (!variantId) { toast.info("Spunta una corsa oppure seleziona linea e variante", { description: "La cadenza si genera da una corsa template: basta la spunta sul prototipo." }); return; }
            if (filteredTrips.length === 0) { toast.info("Prima crea una corsa", { description: "Usa ➕ Nuova corsa: sarà il template per la cadenza." }); return; }
            const proto = filteredTrips.find(t => t.attributes?.prototype);
            setGenTemplateId((proto ?? filteredTrips[0])?.id ?? "");
            setGenOpen(true);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-500 transition-colors"
          title="Genera corse a cadenza costante da una corsa template (even headway)"
        >
          <Timer className="w-3.5 h-3.5" /> Genera a cadenza
        </button>

        <div className="flex-1" />

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-500/10 border border-amber-500/30">
            <span className="text-amber-300 font-medium">{selected.size} selezionate</span>
            <button
              onClick={() => bulkMut.mutate({ patch: { isActive: true } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1"
              title="Attiva selezionate"
            >
              <Power className="w-3 h-3" /> Attiva
            </button>
            <button
              onClick={() => bulkMut.mutate({ patch: { isActive: false } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center gap-1"
              title="Disattiva selezionate"
            >
              <PowerOff className="w-3 h-3" /> Disattiva
            </button>
            <BulkValiditySetter
              onApply={(vf, vt) => bulkMut.mutate({ patch: { validFrom: vf || null, validTo: vt || null } })}
              disabled={bulkMut.isPending}
            />
            <BulkCalendarSetter
              calendars={calendars}
              onApply={(cid) => bulkMut.mutate({ patch: { calendarId: cid || null } })}
              disabled={bulkMut.isPending}
            />
            <BulkDaysCatsSetter
              dayTypes={dayTypesQ.data ?? []}
              categories={categoriesQ.data ?? []}
              disabled={bulkMut.isPending}
              onApplyDays={async (dayTypeIds, isValid) => {
                try {
                  await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [...selected], dayTypeIds, isValid });
                  toast.success(isValid ? "Giorni aggiunti alle corse selezionate" : "Giorni tolti dalle corse selezionate");
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
                } catch (e: any) { toast.error("Errore", { description: e?.message }); }
              }}
              onApplyCats={async (categoryIds, mode) => {
                try {
                  await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [...selected], categoryIds, mode });
                  toast.success(mode === "add" ? "Categorie aggiunte (proroga)" : "Categorie sostituite");
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
                } catch (e: any) { toast.error("Errore", { description: e?.message }); }
              }}
            />
            <button
              onClick={() => bulkMut.mutate({ patch: { attributesMerge: { onDemand: true } } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white flex items-center gap-1"
              title="Segna le corse selezionate come A CHIAMATA (su prenotazione)"
            >
              📞 A chiamata
            </button>
            <button
              onClick={() => bulkMut.mutate({ patch: { attributesMerge: { onDemand: false } } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded border border-purple-500/40 text-purple-300 hover:bg-purple-500/10 flex items-center gap-1"
              title="Rendi ordinarie le corse selezionate (toglie A chiamata)"
            >
              ordinaria
            </button>
            <button
              onClick={() => setBulkDelOpen(true)}
              disabled={bulkDeleteMut.isPending}
              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1"
              title="Elimina le corse selezionate"
            >
              <Trash2 className="w-3 h-3" /> Elimina
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="p-1 rounded hover:bg-slate-700 text-slate-400"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Tabella */}
      <div className="flex-1 overflow-auto">
        {tripsQ.isLoading && (
          <div className="p-6 text-slate-500 text-sm flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Caricamento corse…
          </div>
        )}
        {!tripsQ.isLoading && filteredTrips.length === 0 && (
          <div className="p-12 text-center text-slate-500 text-sm">
            {variantId
              ? <>Nessuna corsa per questa variante. <strong>Creane una con «➕ Nuova corsa»</strong> (orari calcolati automaticamente), poi moltiplicala con «⏱ Genera a cadenza» e imposta i giorni nella Matrice di validità.</>
              : <>Nessuna corsa trovata con i filtri attuali. Seleziona una linea e una variante per creare corse.</>}
          </div>
        )}
        {filteredTrips.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 z-10">
              <tr className="text-slate-400">
                <th className="p-2 w-8 text-left">
                  <input type="checkbox"
                    checked={selected.size === filteredTrips.length && filteredTrips.length > 0}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filteredTrips.length; }}
                    onChange={toggleAll}
                    className="accent-amber-500" />
                </th>
                <th className="p-2 text-left">Partenza</th>
                <th className="p-2 text-left">Linea / Variante</th>
                <th className="p-2 text-left">Headsign</th>
                <th className="p-2 text-left" title="Giorni della settimana in cui la corsa è valida: clic sul giorno per accendere/spegnere">Giorni validità</th>
                <th className="p-2 text-left" title="Categorie del calendario aziendale attive sulla corsa (nessuna = vale sempre)">Categorie</th>
                <th className="p-2 text-left" title="Periodo di esistenza della corsa (vuoto = illimitata)">Periodo</th>
                <th className="p-2 text-left">Etichetta</th>
                <th className="p-2 text-center w-16" title="Corsa effettuata solo su prenotazione (servizio a chiamata / DRT)">A chiam.</th>
                <th className="p-2 text-center w-16">Stato</th>
                <th className="p-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filteredTrips.map(t => {
                const route = routes.find(r => r.id === t.routeId);
                const variant = variants.find(v => v.id === t.variantId);
                const isSel = selected.has(t.id);
                const tripCats = tripsValQ.data?.categories?.[t.id] ?? [];
                return (
                  <tr key={t.id} className={`border-b border-slate-800/60 hover:bg-slate-900/50 ${
                    isSel ? "bg-amber-500/5" : ""
                  } ${t.attributes?.prototype ? "bg-amber-500/10" : ""} ${!t.isActive ? "opacity-50" : ""}`}>
                    <td className="p-2">
                      <input type="checkbox" checked={isSel} onChange={() => toggleSel(t.id)}
                        className="accent-amber-500" />
                    </td>
                    <td className="p-2 font-mono text-slate-300">
                      {t.attributes?.prototype ? (
                        <span
                          title="CORSA ZERO (prototipo): nessun orario, solo tempi per arco, durata e validità. Non genera km e NON entra nelle UDP. Crea le corse reali con «Genera a cadenza»."
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold not-italic">
                          ⚠ PROTO
                        </span>
                      ) : fmtTime(t.firstDeparture ?? firstTimes[t.id])}
                    </td>
                    <td className="p-2">
                      <div className="font-medium text-slate-200">{route?.shortName || "?"}</div>
                      <div className="text-[10px] text-slate-500">{variant?.name || ""}</div>
                    </td>
                    <td className="p-2 text-slate-300">{t.headsign || variant?.headsign || "—"}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-[3px]">
                        {WD_LABELS_ROW.map((l, i) => {
                          const on = rowDayOn(t, i);
                          return (
                            <button key={i}
                              onClick={() => toggleRowWeekday(t, i)}
                              disabled={rowWdBusy || tripsValQ.isLoading}
                              title={`${WD_NAMES[i]} — ${on ? "attivo (clic per spegnere)" : "spento (clic per accendere)"}`}
                              className={`w-[18px] h-[18px] rounded-full text-[9px] font-bold border leading-none transition-colors disabled:opacity-50 ${
                                on
                                  ? "bg-emerald-500/25 border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/40"
                                  : "bg-slate-800 border-slate-700 text-slate-600 hover:bg-slate-700"
                              }`}>
                              {l}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-2">
                      {tripCats.length === 0
                        ? <span className="text-[10px] text-slate-600" title="Nessuna categoria: la corsa vale in ogni periodo del calendario aziendale">tutte</span>
                        : (
                          <div className="flex flex-wrap gap-1 max-w-[160px]">
                            {tripCats.map(cid => {
                              const c = catById.get(cid);
                              if (!c) return null;
                              return (
                                <span key={cid} title={c.name}
                                  className="px-1.5 py-0.5 rounded text-[9px] font-medium border whitespace-nowrap"
                                  style={{ borderColor: c.color || "#3b82f6", background: `${c.color || "#3b82f6"}22`, color: undefined }}>
                                  {c.name.length > 14 ? c.name.slice(0, 13) + "…" : c.name}
                                </span>
                              );
                            })}
                          </div>
                        )}
                    </td>
                    <td className="p-2 text-slate-400">
                      {t.validFrom || t.validTo
                        ? <span className="whitespace-nowrap">{fmtDate(t.validFrom)} → {fmtDate(t.validTo)}</span>
                        : <span className="text-slate-600">illimitato</span>}
                    </td>
                    <td className="p-2">
                      <input
                        defaultValue={t.serviceLabel || ""}
                        onBlur={(e) => {
                          if (e.target.value !== (t.serviceLabel || "")) {
                            updateMut.mutate({ id: t.id, patch: { serviceLabel: e.target.value || null } });
                          }
                        }}
                        placeholder="—"
                        className="w-full bg-transparent text-slate-300 text-xs px-1.5 py-0.5 rounded hover:bg-slate-800 focus:bg-slate-800 outline-none border border-transparent focus:border-slate-700"
                      />
                    </td>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={!!t.attributes?.onDemand}
                        onChange={e => updateMut.mutate({ id: t.id, patch: { attributesMerge: { onDemand: e.target.checked } } })}
                        title={t.attributes?.onDemand ? "Corsa A CHIAMATA (clic per renderla ordinaria)" : "Segna come corsa a chiamata"}
                        className="accent-purple-500 cursor-pointer"
                      />
                      {!!t.attributes?.onDemand && <span className="block text-[9px] text-purple-300 leading-none mt-0.5">📞</span>}
                    </td>
                    <td className="p-2 text-center">
                      <button
                        onClick={() => updateMut.mutate({ id: t.id, patch: { isActive: !t.isActive } })}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          t.isActive
                            ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                            : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                        }`}
                      >
                        {t.isActive ? "ATTIVA" : "OFF"}
                      </button>
                    </td>
                    <td className="p-2 text-right">
                      <button
                        onClick={() => setDetailTripId(t.id)}
                        className="p-1 rounded text-cyan-400 hover:bg-cyan-500/10"
                        title="Dettaglio + eccezioni"
                      >
                        <CalendarIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm("Eliminare questa corsa?")) deleteMut.mutate(t.id);
                        }}
                        className="p-1 rounded text-rose-400 hover:bg-rose-500/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer dettaglio (validità + eccezioni) */}
      {detailTrip && (
        <TripDetailDrawer
          projectId={projectId}
          trip={detailTrip}
          onClose={() => setDetailTripId(null)}
          onChange={() => qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] })}
        />
      )}

      {/* ─── Dialog: Nuova corsa (la prima della variante) ─── */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !newBusy && setNewOpen(false)}>
          <div className="w-full max-w-2xl mx-4 rounded-xl border border-emerald-500/30 bg-slate-950 shadow-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-400" /> Corsa ZERO (prototipo)
              </h3>
              <button onClick={() => !newBusy && setNewOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <p className="text-[11px] text-slate-400">
                Il <strong>grafo della linea</strong>: i tempi di percorrenza per <strong>arco</strong> sono calcolati
                automaticamente (dai km e dalla velocità di default) e <strong>sovrascrivibili</strong>; su ogni fermata
                imposti la <strong>sosta</strong>. Gli orari si aggiornano in tempo reale.
              </p>
              <div className="grid grid-cols-4 gap-2 items-end">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Partenza</label>
                  <input type="time" value={newStart} onChange={e => setNewStart(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1" title="Usata per il calcolo automatico dei tempi d'arco">Vel. default (km/h)</label>
                  <input type="number" min={3} max={80} value={newSpeed} onChange={e => setNewSpeed(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Sosta default (s)</label>
                  <input type="number" min={0} max={300} value={newDwell} onChange={e => setNewDwell(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <button
                  onClick={() => {
                    const vs = newVariantQ.data?.stops ?? [];
                    if (vs.length >= 2) recalcArcDefaults(vs, Number(newSpeed) || 18, Math.max(0, Math.round(Number(newDwell) || 0)));
                  }}
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:bg-slate-700"
                  title="Ricalcola tutti gli archi e le soste dai valori di default (sovrascrive le modifiche manuali)">
                  ↻ Ricalcola grafo
                </button>
              </div>

              {/* ── Grafo della linea: nodi (fermate+sosta) e archi (tempo) ── */}
              {newVariantQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento percorso…</p>}
              {(newVariantQ.data?.stops?.length ?? 0) >= 2 && protoTimes && (() => {
                const vs = newVariantQ.data!.stops;
                const cum = cumDistsOf(vs);
                return (
                  <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40 p-2 space-y-0">
                    {vs.map((st, i) => (
                      <div key={`${st.stopId}-${i}`}>
                        <div className="flex items-center gap-2 py-1">
                          <span className={`w-3 h-3 rounded-full shrink-0 border-2 ${i === 0 || i === vs.length - 1 ? "bg-emerald-400 border-emerald-200" : "bg-slate-700 border-slate-500"}`} />
                          <span className="text-xs flex-1 truncate" title={st.stopName}>
                            <span className="text-slate-500 font-mono">{i + 1}.</span> {st.stopName}
                          </span>
                          <span className="text-[10px] font-mono text-emerald-300/90 shrink-0 tabular-nums">
                            {genSecToHms(protoTimes.arr[i]).slice(0, 5)}
                            {protoTimes.dep[i] !== protoTimes.arr[i] && <span className="text-slate-500"> →{genSecToHms(protoTimes.dep[i]).slice(0, 5)}</span>}
                          </span>
                          {i > 0 && i < vs.length - 1 ? (
                            <span className="flex items-center gap-1 shrink-0">
                              <input type="number" min={0} max={600} value={newDwellS[i] ?? 0}
                                onChange={e => setNewDwellS(prev => prev.map((x, k) => (k === i ? Math.max(0, Number(e.target.value) || 0) : x)))}
                                className="w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-[10px] text-right" />
                              <span className="text-[9px] text-slate-500 w-10">s sosta</span>
                            </span>
                          ) : <span className="w-[100px] shrink-0" />}
                        </div>
                        {i < vs.length - 1 && (
                          <div className="flex items-center gap-2 py-0.5">
                            <span className="w-0.5 h-5 bg-gradient-to-b from-slate-500 to-slate-700 ml-[5px] shrink-0 rounded" />
                            <span className="text-[9px] text-slate-500 flex-1 pl-1">↓ {((cum[i + 1] - cum[i]) / 1000).toFixed(2)} km</span>
                            <input type="number" min={0} step={0.5} value={newArcMin[i] ?? 0}
                              onChange={e => setNewArcMin(prev => prev.map((x, k) => (k === i ? Math.max(0, Number(e.target.value) || 0) : x)))}
                              className="w-16 px-1 py-0.5 rounded bg-slate-950 border border-amber-600/60 text-[10px] text-right text-amber-200 font-mono" />
                            <span className="text-[9px] text-slate-500 w-24 shrink-0">min percorrenza</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {protoTimes && (
                <p className="text-[10px] text-emerald-300">
                  Giro completo: <strong>{protoTimes.totalMin} min</strong> · arrivo capolinea <strong className="font-mono">{genSecToHms(protoTimes.arr[protoTimes.arr.length - 1]).slice(0, 5)}</strong>
                </p>
              )}
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Giorni di circolazione (calendario)</label>
                <select value={newCalendarId} onChange={e => setNewCalendarId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs">
                  <option value="">— nessun calendario —</option>
                  {calendars.map(c => <option key={c.id} value={c.id}>{c.code} {c.name ? `· ${c.name}` : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (calendario aziendale) — anche più di una</label>
                {categoriesQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento validità…</p>}
                {!categoriesQ.isLoading && (categoriesQ.data ?? []).length === 0 && (
                  <p className="text-[11px] text-slate-500">Nessuna validità definita nel Calendario aziendale.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(categoriesQ.data ?? []).map(c => (
                    <label key={c.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                      style={{ borderColor: newCategoryIds.has(c.id) ? (c.color || "#3b82f6") : "#334155", background: newCategoryIds.has(c.id) ? `${c.color || "#3b82f6"}22` : "transparent" }}>
                      <input type="checkbox" className="hidden" checked={newCategoryIds.has(c.id)}
                        onChange={() => setNewCategoryIds(prev => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
                      {c.name}
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">Se ne selezioni ≥1, la corsa vale SOLO nei giorni di quei periodi (es. Scuole Aperte). Nessuna = vale in tutti i periodi.</p>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (tipi giorno — matrice)</label>
                {dayTypesQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento tipi giorno…</p>}
                <div className="flex flex-wrap gap-2">
                  {(dayTypesQ.data ?? []).map(dt => (
                    <label key={dt.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                      style={{ borderColor: newDayTypeIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: newDayTypeIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                      <input type="checkbox" className="hidden" checked={newDayTypeIds.has(dt.id)}
                        onChange={() => setNewDayTypeIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                      {dt.name}
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">I bollini verdi nella Matrice di validità si accendono su questi giorni.</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setNewOpen(false)} disabled={newBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={runCreateFirstTrip} disabled={newBusy}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                {newBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Crea corsa prototipo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Dialog: elimina corse selezionate (doppia conferma) ─── */}
      {bulkDelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !bulkDeleteMut.isPending && setBulkDelOpen(false)}>
          <div className="w-full max-w-sm mx-4 rounded-xl border border-rose-500/40 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-rose-300 flex items-center gap-2">
                <Trash2 className="w-4 h-4" /> Elimina {selected.size} corse
              </h3>
              <button onClick={() => !bulkDeleteMut.isPending && setBulkDelOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <p className="text-slate-300">
                Stai per eliminare <strong className="text-rose-300">{selected.size} corse</strong> in modo <strong>definitivo</strong>.
              </p>
              <p className="text-[11px] text-slate-500">
                Vengono rimossi anche gli orari alle fermate, la riga nella Matrice di validità, le eccezioni e le categorie di calendario aziendale collegate. L'azione non è annullabile.
              </p>
              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                <input type="checkbox" checked={bulkDelArmed} onChange={e => setBulkDelArmed(e.target.checked)} className="accent-rose-500" />
                Confermo di voler eliminare queste {selected.size} corse
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setBulkDelOpen(false)} disabled={bulkDeleteMut.isPending}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={() => bulkDeleteMut.mutate()} disabled={!bulkDelArmed || bulkDeleteMut.isPending}
                className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {bulkDeleteMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Elimina definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Dialog: Genera corse a cadenza (C1 — even headway) ─── */}
      {genOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !genBusy && setGenOpen(false)}>
          <div className={`w-full ${genStep === "preview" ? "max-w-4xl" : "max-w-md"} mx-4 rounded-xl border border-amber-500/30 bg-slate-950 shadow-2xl`} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Timer className="w-4 h-4 text-amber-400" />
                {genStep === "params" ? "Genera corse a cadenza" : "Anteprima · variazione traffico"}
                <span className="text-[10px] text-slate-500 font-normal">— passo {genStep === "params" ? "1" : "2"} di 2</span>
              </h3>
              <button onClick={() => !genBusy && setGenOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            {genStep === "params" && (
            <div className="p-4 space-y-3 text-sm">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Corsa template</label>
                <select value={genTemplateId} onChange={e => setGenTemplateId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs">
                  <option value="">— scegli la corsa da replicare —</option>
                  {filteredTrips.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.attributes?.prototype ? "★ PROTOTIPO" : fmtTime(firstTimes[t.id])} · {t.shortName || t.headsign || t.id.slice(0, 8)}
                      {t.serviceLabel ? ` · ${t.serviceLabel}` : ""}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500 mt-1">Gli orari di transito a ogni fermata vengono ricalcolati traslando quelli del template.</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Dalle</label>
                  <input type="time" value={genFrom} onChange={e => setGenFrom(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Alle</label>
                  <input type="time" value={genTo} onChange={e => setGenTo(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Ogni (min)</label>
                  <input type="number" min={1} max={240} value={genEvery} onChange={e => setGenEvery(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (calendario aziendale) — anche più di una</label>
                <div className="flex flex-wrap gap-2">
                  {(categoriesQ.data ?? []).map(c => (
                    <label key={c.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                      style={{ borderColor: genCategoryIds.has(c.id) ? (c.color || "#3b82f6") : "#334155", background: genCategoryIds.has(c.id) ? `${c.color || "#3b82f6"}22` : "transparent" }}>
                      <input type="checkbox" className="hidden" checked={genCategoryIds.has(c.id)}
                        onChange={() => setGenCategoryIds(prev => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (tipi giorno)</label>
                <div className="flex flex-wrap gap-2">
                  {(dayTypesQ.data ?? []).map(dt => (
                    <label key={dt.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                      style={{ borderColor: genDayTypeIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: genDayTypeIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                      <input type="checkbox" className="hidden" checked={genDayTypeIds.has(dt.id)}
                        onChange={() => setGenDayTypeIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                      {dt.name}
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">Giorni e periodi vengono applicati a TUTTE le corse generate.</p>
              </div>
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                ≈ <strong>{genPreviewCount}</strong> partenze nella fascia {genFrom}–{genTo} (headway costante).
                {genPreviewCount > 200 && <span className="text-red-300"> Oltre il limite di 200: restringi la fascia.</span>}
              </div>
            </div>
            )}
            {genStep === "preview" && genProfile && (() => {
              const nArcs = genProfile.stopIds.length - 1;
              const h0 = Math.floor(genProfile.deps[0] / 3600);
              const h1 = Math.floor((genProfile.deps[genProfile.deps.length - 1] + genProfile.relArr[genProfile.relArr.length - 1]) / 3600);
              const hours: number[] = [];
              for (let h = h0; h <= h1; h++) hours.push(h);
              // transiti per cella: corse che ENTRANO nell'arco a nella fascia h (orari template)
              const transits: number[][] = Array.from({ length: nArcs }, (_, a) =>
                hours.map(h => genProfile.deps.filter(dep => Math.floor((dep + genProfile.relDep[a]) / 3600) === h).length));
              const heat = (c: number) => c <= 1 ? "transparent"
                : c <= 1.1 ? "rgba(245,158,11,0.12)" : c <= 1.2 ? "rgba(245,158,11,0.25)"
                : c <= 1.3 ? "rgba(239,68,68,0.25)" : "rgba(239,68,68,0.4)";
              const fmtH = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
              // durata giro prima/dopo (prima e ultima partenza)
              const giroBase = genProfile.relArr[genProfile.relArr.length - 1];
              const giroOf = (dep: number) => { const t = buildRunTimes(dep, genProfile); return t.arr[t.arr.length - 1] - dep; };
              return (
                <div className="p-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-slate-400">
                      Coefficienti di rallentamento per <strong className="text-slate-200">fascia oraria</strong> (proposta dal profilo traffico, modificabile).
                      Ogni cella mostra il tempo dell'arco <span className="text-amber-300">adattato</span> e il n° di transiti previsti.
                    </p>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none shrink-0">
                      <input type="checkbox" checked={genApplyTraffic} onChange={e => setGenApplyTraffic(e.target.checked)} className="accent-amber-500" />
                      Applica variazione traffico
                    </label>
                  </div>
                  <div className="overflow-auto max-h-[52vh] rounded border border-slate-800">
                    <table className="text-[11px] border-collapse w-full">
                      <thead className="sticky top-0 bg-slate-900 z-10">
                        <tr>
                          <th className="text-left px-2 py-1.5 text-slate-400 font-medium border-b border-slate-800 min-w-[180px]">Arco del percorso</th>
                          {hours.map(h => (
                            <th key={h} className="px-1.5 py-1.5 border-b border-l border-slate-800 text-slate-300 font-medium whitespace-nowrap">
                              <div>{fmtH(h)}–{fmtH(h + 1)}</div>
                              <div className="mt-1 flex items-center justify-center gap-0.5">
                                <span className="text-slate-500">×</span>
                                <input type="number" step={0.05} min={0.5} max={3}
                                  value={genCoeff[h] ?? 1}
                                  onChange={e => { const v = Number(e.target.value); setGenCoeff(prev => ({ ...prev, [h]: Number.isFinite(v) && v > 0 ? v : 1 })); }}
                                  disabled={!genApplyTraffic}
                                  className="w-12 px-1 py-0.5 rounded bg-slate-950 border border-amber-500/40 text-amber-300 text-center disabled:opacity-40" />
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: nArcs }, (_, a) => {
                          const baseSec = genProfile.relArr[a + 1] - genProfile.relDep[a];
                          return (
                            <tr key={a} className="border-b border-slate-800/60">
                              <td className="px-2 py-1 text-slate-300 whitespace-nowrap overflow-hidden text-ellipsis max-w-[220px]">
                                <span className="text-slate-500">{a + 1}.</span> {genProfile.stopNames[a]} <span className="text-slate-600">→</span> {genProfile.stopNames[a + 1]}
                                <span className="text-slate-500 ml-1">({Math.round(baseSec / 6) / 10}′)</span>
                              </td>
                              {hours.map((h, hi) => {
                                const c = genApplyTraffic ? (genCoeff[h] ?? 1) : 1;
                                const adj = Math.round((baseSec * c) / 6) / 10;
                                const n = transits[a][hi];
                                return (
                                  <td key={h} className="px-1.5 py-1 border-l border-slate-800/60 text-center whitespace-nowrap"
                                    style={{ background: n > 0 ? heat(c) : "transparent", opacity: n > 0 ? 1 : 0.25 }}>
                                    {n > 0 ? (
                                      <>
                                        <span className={c > 1 ? "text-amber-200 font-medium" : "text-slate-300"}>{adj}′</span>
                                        <span className="text-slate-500 ml-1">·{n}</span>
                                      </>
                                    ) : <span className="text-slate-700">—</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap gap-x-4 gap-y-1">
                    <span><strong>{genProfile.deps.length}</strong> corse da salvare</span>
                    <span>giro template: <strong>{Math.round(giroBase / 60)}′</strong></span>
                    <span>giro adattato: <strong>{Math.round(giroOf(genProfile.deps[0]) / 60)}′</strong> (prima) → <strong>{Math.round(giroOf(genProfile.deps[genProfile.deps.length - 1]) / 60)}′</strong> (ultima)</span>
                  </div>
                </div>
              );
            })()}
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              {genStep === "preview" && (
                <button onClick={() => setGenStep("params")} disabled={genBusy}
                  className="mr-auto text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">← Indietro</button>
              )}
              <button onClick={() => setGenOpen(false)} disabled={genBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              {genStep === "params" ? (
                <button onClick={prepareGenerate} disabled={genBusy || !genTemplateId || genPreviewCount === 0 || genPreviewCount > 200}
                  className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                  {genBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Timer className="w-3.5 h-3.5" />}
                  Continua → Anteprima traffico
                </button>
              ) : (
                <button onClick={finalizeGenerate} disabled={genBusy || !genProfile}
                  className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                  {genBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Salva {genProfile?.deps.length ?? 0} corse
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Bulk validity setter (popover-ish) ─── */
function BulkValiditySetter({ onApply, disabled }: {
  onApply: (vf: string, vt: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [vf, setVf] = useState("");
  const [vt, setVt] = useState("");
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Periodo di esistenza della corsa nel calendario (es. orario estivo)"
        className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Periodo
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-3 z-20 w-72 space-y-2">
          <p className="text-[11px] text-slate-300 font-medium">Periodo di validità della corsa</p>
          <p className="text-[10px] text-slate-400 leading-snug">
            La corsa circola SOLO tra queste due date (poi valgono comunque giorni e
            categorie della Matrice). Serve per orari stagionali: es. una corsa estiva
            dal 15/06 al 10/09. Se lasci vuoto, la corsa non ha limiti di periodo.
          </p>
          <div className="flex items-center gap-2">
            <input type="date" value={vf} onChange={e => setVf(e.target.value)}
              className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs flex-1" />
            <span className="text-slate-500">→</span>
            <input type="date" value={vt} onChange={e => setVt(e.target.value)}
              className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs flex-1" />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => { onApply("", ""); setOpen(false); }}
              title="Toglie il periodo: la corsa torna valida senza limiti di date"
              className="px-2 py-1 rounded border border-slate-600 text-slate-300 hover:bg-slate-700 text-[11px]"
            >
              Illimitata
            </button>
            <button
              onClick={() => { onApply(vf, vt); setOpen(false); }}
              className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] inline-flex items-center gap-1"
            >
              <Check className="w-3 h-3" /> Applica
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Bulk: proroga GIORNI (tipi giorno) e CATEGORIE (calendario aziendale) ───
 * Per estendere corse esistenti: es. nate "feriale · scuole chiuse", prorogate
 * anche a "sabato" o ad altre categorie SENZA rifarle. */
function BulkDaysCatsSetter({ dayTypes, categories, disabled, onApplyDays, onApplyCats }: {
  dayTypes: PsDayType[];
  categories: PsValidityCategory[];
  disabled?: boolean;
  onApplyDays: (dayTypeIds: string[], isValid: boolean) => Promise<void>;
  onApplyCats: (categoryIds: string[], mode: "add" | "replace") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [dayIds, setDayIds] = useState<Set<string>>(new Set());
  const [catIds, setCatIds] = useState<Set<string>>(new Set());
  const [catMode, setCatMode] = useState<"add" | "replace">("add");
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Proroga/estendi le corse selezionate: aggiungi o togli giorni (feriale, sabato, festivo) e categorie del calendario aziendale (scuole aperte/chiuse…)"
        className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Giorni/Categorie
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-3 z-20 w-80 space-y-3">
          <div>
            <p className="text-[11px] text-slate-300 font-medium mb-1">Giorni (tipi giorno)</p>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {dayTypes.map(dt => (
                <label key={dt.id} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border cursor-pointer select-none"
                  style={{ borderColor: dayIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: dayIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                  <input type="checkbox" className="hidden" checked={dayIds.has(dt.id)}
                    onChange={() => setDayIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                  {dt.name}
                </label>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={async () => { if (dayIds.size === 0) return; await onApplyDays([...dayIds], true); setOpen(false); }}
                disabled={dayIds.size === 0}
                title="Le corse selezionate diventano valide ANCHE in questi giorni (quelli già attivi restano)"
                className="flex-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] disabled:opacity-40"
              >
                ➕ Aggiungi giorni
              </button>
              <button
                onClick={async () => { if (dayIds.size === 0) return; await onApplyDays([...dayIds], false); setOpen(false); }}
                disabled={dayIds.size === 0}
                title="Le corse selezionate NON valgono più in questi giorni (gli altri restano)"
                className="flex-1 px-2 py-1 rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 text-[11px] disabled:opacity-40"
              >
                ➖ Togli giorni
              </button>
            </div>
          </div>
          <div className="border-t border-slate-700 pt-2">
            <p className="text-[11px] text-slate-300 font-medium mb-1">Categorie (calendario aziendale)</p>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {categories.map(c => (
                <label key={c.id} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border cursor-pointer select-none"
                  style={{ borderColor: catIds.has(c.id) ? (c.color || "#3b82f6") : "#334155", background: catIds.has(c.id) ? `${c.color || "#3b82f6"}22` : "transparent" }}>
                  <input type="checkbox" className="hidden" checked={catIds.has(c.id)}
                    onChange={() => setCatIds(prev => { const n = new Set(prev); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 mb-1.5 text-[10px] text-slate-400">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="catmode" checked={catMode === "add"} onChange={() => setCatMode("add")} className="accent-emerald-500" />
                Aggiungi alle esistenti (proroga)
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="catmode" checked={catMode === "replace"} onChange={() => setCatMode("replace")} className="accent-amber-500" />
                Sostituisci
              </label>
            </div>
            <button
              onClick={async () => { await onApplyCats([...catIds], catMode); setOpen(false); }}
              disabled={catMode === "add" && catIds.size === 0}
              title={catMode === "replace" && catIds.size === 0 ? "Sostituisci con nessuna categoria = la corsa vale in ogni periodo del calendario aziendale" : undefined}
              className="w-full px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] disabled:opacity-40"
            >
              Applica categorie {catMode === "replace" && catIds.size === 0 ? "(nessun vincolo)" : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Bulk calendar setter ─── */
function BulkCalendarSetter({ calendars, onApply, disabled }: {
  calendars: PsCalendar[];
  onApply: (calendarId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Calendario
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-1 z-20 min-w-[180px]">
          <button
            onClick={() => { onApply(""); setOpen(false); }}
            className="w-full text-left px-2 py-1 text-xs rounded hover:bg-slate-700 text-slate-400"
          >
            (rimuovi calendario)
          </button>
          {calendars.map(c => (
            <button key={c.id}
              onClick={() => { onApply(c.id); setOpen(false); }}
              className="w-full text-left px-2 py-1 text-xs rounded hover:bg-slate-700"
            >
              {c.code} {c.name ? `· ${c.name}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Drawer dettaglio corsa con validità + eccezioni ─── */
function TripDetailDrawer({ projectId, trip, onClose, onChange }: {
  projectId: string;
  trip: PsTrip;
  onClose: () => void;
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const exQ = useQuery({
    queryKey: ["ps", projectId, "trip-exceptions", trip.id],
    queryFn: () => listPsTripExceptions(projectId, trip.id),
  });

  const [vf, setVf] = useState(trip.validFrom || "");
  const [vt, setVt] = useState(trip.validTo || "");
  useEffect(() => {
    setVf(trip.validFrom || "");
    setVt(trip.validTo || "");
  }, [trip.id]);

  /* ─── Giorni validità (L…D), categorie e A chiamata ───
   * I 7 giorni combinano: validità del TIPO GIORNO (feriale/sabato/festivo)
   * + maschera per-corsa attributes.weekdays. Spegnere il giovedì di una
   * corsa feriale spegne SOLO il giovedì; accendere un giorno di un tipo
   * spento accende il tipo e preserva lo stato degli altri giorni. Tutto
   * si riflette sulla Matrice di validità (stessa regola condivisa). */
  const dayTypesDrawerQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
  });
  const categoriesDrawerQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    staleTime: 60_000,
  });
  const tripValQ = useQuery({
    queryKey: ["ps", projectId, "trip-validity", trip.id],
    queryFn: () => getPsTripValidity(projectId, trip.id),
  });
  const calendarsDrawerQ = useQuery({
    queryKey: ["ps", projectId, "calendars"],
    queryFn: () => listPsCalendars(projectId),
    staleTime: 60_000,
  });
  const [wdBusy, setWdBusy] = useState(false);
  const WD_LABELS = WD_LABELS_ROW;
  // Fallback: pattern del calendario collegato (per corse importate da GTFS
  // senza maschera esplicita), così i bollini riflettono la circolazione reale.
  const calMask = useMemo(
    () => calWeekdays((calendarsDrawerQ.data ?? []).find(c => c.id === trip.calendarId)),
    [calendarsDrawerQ.data, trip.calendarId],
  );
  const wdMask: boolean[] = wdMaskOf(trip, calMask);
  const typicalCode = wdTypicalCode;
  const dtByCode = useMemo(() => classifyDayTypes(dayTypesDrawerQ.data ?? []), [dayTypesDrawerQ.data]);
  const dayValidity = tripValQ.data?.dayValidity ?? {};
  const dayOn = (i: number): boolean => {
    if (!wdMask[i]) return false;                      // la corsa non circola quel giorno
    // Nessuna riga in Matrice di validità → mostra la circolazione settimanale.
    if (!dayValidity || Object.keys(dayValidity).length === 0) return true;
    const dt = dtByCode[typicalCode(i)];
    if (!dt) return true;                              // tipo-giorno non classificabile → circola
    return dayValidity[dt.id] !== false;               // spento SOLO se esplicitamente non valido
  };
  async function toggleWeekday(i: number) {
    if (wdBusy || !dayTypesDrawerQ.data || !tripValQ.data) return;
    setWdBusy(true);
    try {
      const newWd = [...wdMask];
      if (dayOn(i)) {
        newWd[i] = false; // spegni SOLO questo giorno
      } else {
        newWd[i] = true;
        const dt = dtByCode[typicalCode(i)];
        if (dt && !dayValidity[dt.id]) {
          // il tipo giorno era spento: accendilo, preservando lo stato
          // (spento) degli altri giorni dello stesso tipo
          for (let j = 0; j < 7; j++) {
            if (j !== i && typicalCode(j) === typicalCode(i) && !dayOn(j)) newWd[j] = false;
          }
          await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [trip.id], dayTypeIds: [dt.id], isValid: true });
        }
      }
      await updatePsTrip(projectId, trip.id, { attributesMerge: { weekdays: newWd } });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-validity", trip.id] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore aggiornamento giorni", { description: e?.message });
    } finally { setWdBusy(false); }
  }
  async function toggleCategory(catId: string) {
    if (wdBusy || !tripValQ.data) return;
    setWdBusy(true);
    try {
      const cur = new Set(tripValQ.data.categoryIds);
      cur.has(catId) ? cur.delete(catId) : cur.add(catId);
      await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [trip.id], categoryIds: [...cur], mode: "replace" });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-validity", trip.id] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore categorie", { description: e?.message });
    } finally { setWdBusy(false); }
  }
  async function toggleOnDemand() {
    if (wdBusy) return;
    setWdBusy(true);
    try {
      await updatePsTrip(projectId, trip.id, { attributesMerge: { onDemand: !trip.attributes?.onDemand } });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setWdBusy(false); }
  }

  const saveValidity = useMutation({
    mutationFn: () => updatePsTrip(projectId, trip.id, {
      validFrom: vf || null, validTo: vt || null,
    }),
    onSuccess: () => {
      toast.success("Validità aggiornata");
      onChange();
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });

  const [newDate, setNewDate] = useState("");
  const [newType, setNewType] = useState<1 | 2>(2);
  const [newReason, setNewReason] = useState("");
  const addExc = useMutation({
    mutationFn: () => addPsTripException(projectId, trip.id, {
      date: newDate, exceptionType: newType, reason: newReason || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-exceptions", trip.id] });
      setNewDate(""); setNewReason("");
      toast.success("Eccezione aggiunta");
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });
  const delExc = useMutation({
    mutationFn: (date: string) => deletePsTripException(projectId, trip.id, date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-exceptions", trip.id] }),
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[420px] h-full bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="p-4 border-b border-slate-800 flex items-center gap-2">
          <CalendarIcon className="w-4 h-4 text-cyan-400" />
          <h3 className="font-semibold text-sm">Dettaglio corsa</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-slate-800 space-y-1 text-xs">
          <div className="text-slate-400">{trip.headsign || trip.shortName || "—"}</div>
          <div className="text-slate-600 font-mono">{trip.id.slice(0, 8)}…</div>
          {!!trip.attributes?.prototype && (
            <div className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200 leading-snug">
              ⚠ <strong>CORSA ZERO (prototipo)</strong> — nessun orario di partenza/arrivo:
              contiene solo i tempi per arco, la durata del giro e la validità.
              Non genera km e NON entra nelle Unità di Progettazione.
              Crea le corse reali con <strong>«Genera a cadenza»</strong> usando questo prototipo come template.
            </div>
          )}
        </div>

        {/* Validità */}
        <div className="p-4 border-b border-slate-800 space-y-2">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Validità corsa</div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-[10px] text-slate-500 block">Da</label>
              <input type="date" value={vf} onChange={e => setVf(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-slate-500 block">A</label>
              <input type="date" value={vt} onChange={e => setVt(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
            </div>
            <button
              onClick={() => saveValidity.mutate()}
              disabled={saveValidity.isPending}
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1"
            >
              {saveValidity.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Salva
            </button>
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">
            Restringe il periodo di attività della corsa rispetto al calendario.
            Vuoto = nessun limite.
          </p>
        </div>

        {/* Giorni validità (L…D) + categorie + a chiamata */}
        <div className="p-4 border-b border-slate-800 space-y-3">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Giorni di validità</div>
          {tripValQ.isLoading ? (
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> caricamento…</div>
          ) : (
            <div className="flex items-center gap-1.5">
              {WD_LABELS.map((l, i) => {
                const on = dayOn(i);
                return (
                  <button key={i} onClick={() => toggleWeekday(i)} disabled={wdBusy}
                    title={`${["Lunedì","Martedì","Mercoledì","Giovedì","Venerdì","Sabato","Domenica"][i]} — ${on ? "attivo (clic per spegnere)" : "spento (clic per accendere)"}`}
                    className={`w-8 h-8 rounded-full text-xs font-bold border transition-colors disabled:opacity-50 ${
                      on
                        ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/30"
                        : "bg-slate-800 border-slate-700 text-slate-500 hover:bg-slate-700"
                    }`}>
                    {l}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-slate-500 leading-tight">
            Accendi/spegni i singoli giorni: es. corsa feriale (L–V) senza il giovedì.
            La modifica si riflette subito sulla <strong>Matrice di validità</strong>.
          </p>

          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide pt-1">Categorie calendario aziendale</div>
          <div className="flex flex-wrap gap-1.5">
            {(categoriesDrawerQ.data ?? []).map(c => {
              const on = (tripValQ.data?.categoryIds ?? []).includes(c.id);
              return (
                <button key={c.id} onClick={() => toggleCategory(c.id)} disabled={wdBusy || tripValQ.isLoading}
                  className="text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50"
                  style={{ borderColor: on ? (c.color || "#3b82f6") : "#334155", background: on ? `${c.color || "#3b82f6"}22` : "transparent", color: on ? undefined : "#94a3b8" }}>
                  {c.name}
                </button>
              );
            })}
            {(categoriesDrawerQ.data ?? []).length === 0 && <span className="text-[11px] text-slate-500">Nessuna categoria definita.</span>}
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">
            Nessuna categoria accesa = la corsa vale in ogni periodo; con ≥1 accese vale SOLO nei giorni di quelle categorie.
          </p>

          <label className="flex items-center gap-2 pt-1 cursor-pointer select-none text-xs text-slate-200">
            <input type="checkbox" checked={!!trip.attributes?.onDemand} onChange={toggleOnDemand} disabled={wdBusy}
              className="accent-purple-500" />
            📞 Corsa a chiamata (su prenotazione)
          </label>
        </div>

        {/* Eccezioni */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Eccezioni date</div>
            <div className="flex gap-1.5 items-end">
              <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
              <select value={newType} onChange={e => setNewType(Number(e.target.value) as 1 | 2)}
                className="px-1.5 py-1.5 rounded bg-slate-800 text-xs border border-slate-700">
                <option value={2}>Sopprimi</option>
                <option value={1}>Aggiungi</option>
              </select>
              <button
                onClick={() => { if (newDate) addExc.mutate(); }}
                disabled={!newDate || addExc.isPending}
                className="px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs"
              >
                <Check className="w-3 h-3" />
              </button>
            </div>
            <input type="text" value={newReason} onChange={e => setNewReason(e.target.value)}
              placeholder="Motivo (opz.)"
              className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
          </div>

          <div className="flex-1 overflow-auto">
            {(exQ.data ?? []).length === 0 && (
              <div className="p-6 text-center text-slate-600 text-xs">Nessuna eccezione.</div>
            )}
            {(exQ.data ?? []).map(e => (
              <div key={e.date} className="px-3 py-2 border-b border-slate-800 flex items-center gap-2 text-xs">
                {e.exceptionType === 1
                  ? <CalendarPlus className="w-3.5 h-3.5 text-emerald-400" />
                  : <CalendarMinus className="w-3.5 h-3.5 text-rose-400" />
                }
                <div className="flex-1">
                  <div className="font-medium text-slate-300">{fmtDate(e.date)}</div>
                  {e.reason && <div className="text-[10px] text-slate-500">{e.reason}</div>}
                </div>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                  e.exceptionType === 1 ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                }`}>
                  {e.exceptionType === 1 ? "AGGIUNTA" : "SOPPR."}
                </span>
                <button onClick={() => delExc.mutate(e.date)}
                  className="p-1 rounded text-rose-400 hover:bg-rose-500/10">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
