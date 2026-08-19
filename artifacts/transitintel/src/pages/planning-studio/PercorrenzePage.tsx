/**
 * PlannerStudio — PERCORRENZE: la zona dedicata allo sviluppo dei tempi di
 * percorrenza in base ai dati reali di traffico. Due applicazioni:
 *
 *  A · MOLTIPLICA CORSA BASE — da una corsa template si genera la cadenza
 *      (even headway) nella fascia scelta, con gli archi scalati per i
 *      coefficienti di traffico della fascia oraria d'ingresso (anteprima
 *      arco × ora, modificabile). Era il dialog «Genera a cadenza» dentro
 *      la sezione Corse: ora vive qui.
 *
 *  B · RICALCOLA ESISTENTI — un percorso ha GIÀ la sua cadenza: si rifanno
 *      le percorrenze dai dati di traffico senza toccare le partenze. Il
 *      profilo per arco viene da una corsa di RIFERIMENTO (che resta
 *      invariata: profilo neutro, ricalcolo ripetibile), ogni corsa resta
 *      ancorata alla sua partenza attuale. Anteprima per corsa con Δ.
 *
 * Stessa matematica del server (trips/generate e trips/retime).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import CategoryChips from "@/components/planning-studio/CategoryChips";
import OperationalEditWarning from "@/components/planning-studio/OperationalEditWarning";
import {
  ArrowLeft, Loader2, Timer, Gauge, RefreshCw, Plus, CopyPlus,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes,
  listPsVariants,
  listPsTrips, type PsTrip,
  getPsStopTimesBulk, type PsStopTime,
  generatePsTripsHeadway,
  retimePsTripsTraffic,
} from "@/lib/planning-studio-api";
import { listPsDayTypes } from "@/lib/planning-studio-validity-api";
import { listPsValidityCategories } from "@/lib/planning-studio-validity-units-api";
import {
  type TrafficGroup, TRAFFIC_GROUP_LABEL, defaultCoeffForHour,
  ttToSec, ttSecToHms, scaleRunTimes,
} from "@/lib/traffic-profile";

const fmtHm = (sec: number) => ttSecToHms(sec).slice(0, 5);

/** Selettore del gruppo-giorno + nota: il traffico è molto diverso tra
 * feriale, sabato e domenica. Applicarlo RIPRISTINA i coefficienti di default
 * del gruppo su tutte le fasce coperte (scelta esplicita dell'utente). */
function TrafficGroupBar({ group, onApply, disabled }: {
  group: TrafficGroup; onApply: (g: TrafficGroup) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-slate-400">Dati di traffico:</span>
      <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
        {(["feriale", "sabato", "domenica"] as TrafficGroup[]).map(g => (
          <button key={g}
            onClick={() => onApply(g)}
            disabled={disabled}
            className={`px-2.5 py-1 transition-colors disabled:opacity-40 ${group === g ? "bg-amber-600 text-white font-semibold" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
            title={`Applica il profilo traffico ${TRAFFIC_GROUP_LABEL[g]}`}>
            {TRAFFIC_GROUP_LABEL[g]}
          </button>
        ))}
      </div>
      <span className="text-slate-500">— scegli in base ai giorni in cui circolano le corse.</span>
    </div>
  );
}

export default function PlanningStudioPercorrenzePage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  // Preselezione via query string (?route=&variant=&template=): la sezione
  // Corse arriva qui con linea/variante già scelte.
  const [preset] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return { route: q.get("route") ?? "", variant: q.get("variant") ?? "", template: q.get("template") ?? "" };
  });
  const [routeId, setRouteId] = useState(preset.route);
  const [variantId, setVariantId] = useState(preset.variant);
  const [mode, setMode] = useState<"moltiplica" | "ricalcola">("moltiplica");

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
  const variantsQ = useQuery({
    queryKey: ["ps", projectId, "variants", routeId],
    queryFn: () => listPsVariants(projectId, routeId),
    enabled: !!projectId && !!routeId,
  });
  useEffect(() => { if (routeId !== preset.route) setVariantId(""); /* cambio linea manuale */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const tripsQ = useQuery({
    queryKey: ["ps", projectId, "trips", "", variantId],
    queryFn: () => listPsTrips(projectId, { variantId }),
    enabled: !!projectId && !!variantId,
  });
  const dayTypesQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
    enabled: !!projectId,
  });
  const categoriesQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  /* Orari delle corse della variante (bulk, a lotti come nel Grafico) */
  const [stMap, setStMap] = useState<Record<string, PsStopTime[]>>({});
  useEffect(() => { setStMap({}); }, [variantId]);
  useEffect(() => {
    const trips = tripsQ.data ?? [];
    const missing = trips.filter(t => !(t.id in stMap)).map(t => t.id).slice(0, 400);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
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
  }, [tripsQ.data, projectId, stMap]);
  const stLoading = !!variantId && (tripsQ.data ?? []).some(t => !(t.id in stMap));

  const trips = tripsQ.data ?? [];
  const firstDep = (id: string) => { const s = stMap[id]; return s?.length ? ttToSec(s[0].departureTime) : null; };
  const lastArr = (id: string) => { const s = stMap[id]; return s?.length ? ttToSec(s[s.length - 1].arrivalTime) : null; };
  const tripLabel = (t: PsTrip) => {
    const d = firstDep(t.id);
    const proto = t.attributes?.prototype ? (t.attributes?.prototypeReady ? "★ MADRE · " : "⚠ ZERO · ") : "";
    return `${proto}${d != null ? fmtHm(d) : "—"} · ${t.shortName || t.headsign || t.id.slice(0, 8)}${t.serviceLabel ? ` · ${t.serviceLabel}` : ""}`;
  };
  const tripsByDep = useMemo(() =>
    [...trips].sort((a, b) => (firstDep(a.id) ?? Infinity) - (firstDep(b.id) ?? Infinity)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trips, stMap]);

  /* ══════════ A · MOLTIPLICA corsa base ══════════ */
  const [mTemplateId, setMTemplateId] = useState(preset.template);
  const [mFrom, setMFrom] = useState("06:00");
  const [mTo, setMTo] = useState("20:00");
  const [mEvery, setMEvery] = useState("15");
  const [mDayTypeIds, setMDayTypeIds] = useState<Set<string>>(new Set());
  const [mCategoryIds, setMCategoryIds] = useState<Set<string>>(new Set());
  const [mStep, setMStep] = useState<"params" | "preview">("params");
  const [mProfile, setMProfile] = useState<null | {
    tpl: PsTrip; stopNames: string[]; relArr: number[]; relDep: number[]; deps: number[];
  }>(null);
  const [mCoeff, setMCoeff] = useState<Record<number, number>>({});
  const [mApplyTraffic, setMApplyTraffic] = useState(true);
  const [mGroup, setMGroup] = useState<TrafficGroup>("feriale");
  const [mBusy, setMBusy] = useState(false);
  useEffect(() => {
    setMStep("params"); setMProfile(null); setMGroup("feriale"); setMCoeff({});
    if (variantId !== preset.variant) setMTemplateId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId]);
  // preseleziona "feriale" tra i tipi giorno
  useEffect(() => {
    if (!dayTypesQ.data || mDayTypeIds.size > 0) return;
    const fer = dayTypesQ.data.find(d => d.code === "feriale");
    if (fer) setMDayTypeIds(new Set([fer.id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayTypesQ.data]);

  const mPreviewCount = useMemo(() => {
    const H = Math.round(Number(mEvery));
    const a = ttToSec(mFrom + ":00"), b = ttToSec(mTo + ":00");
    if (!Number.isFinite(H) || H < 1 || b <= a) return 0;
    return Math.floor((b - a) / (H * 60)) + 1;
  }, [mFrom, mTo, mEvery]);

  function mPrepare() {
    const tpl = trips.find(t => t.id === mTemplateId);
    if (!tpl) { toast.error("Scegli la corsa base"); return; }
    const H = Math.round(Number(mEvery));
    if (!Number.isFinite(H) || H < 1) { toast.error("Cadenza non valida (minuti ≥ 1)"); return; }
    const winFrom = ttToSec(mFrom + ":00"), winTo = ttToSec(mTo + ":00");
    if (winTo <= winFrom) { toast.error("Fascia oraria non valida (fine dopo inizio)"); return; }
    const sts = stMap[tpl.id] ?? [];
    if (sts.length < 2) { toast.error("La corsa base non ha orari alle fermate (stop_times)"); return; }
    const baseDep = ttToSec(sts[0].departureTime);
    const relArr = sts.map(st => ttToSec(st.arrivalTime) - baseDep);
    const relDep = sts.map(st => ttToSec(st.departureTime) - baseDep);
    const minOff = Math.min(...relArr);
    const deps: number[] = [];
    for (let t = winFrom; t <= winTo; t += H * 60) {
      if (Math.abs(t - baseDep) < 30) continue;
      if (t + minOff < 0) continue;
      deps.push(t);
    }
    if (deps.length === 0) { toast.error("Nessuna partenza da generare nella fascia"); return; }
    if (deps.length > 200) { toast.error(`${deps.length} corse superano il limite di 200: restringi la fascia o allunga la cadenza`); return; }
    const h0 = Math.floor(deps[0] / 3600);
    const h1 = Math.floor((deps[deps.length - 1] + relArr[relArr.length - 1]) / 3600);
    setMCoeff(prev => {
      const next: Record<number, number> = { ...prev };
      for (let h = h0; h <= h1; h++) if (next[h] == null) next[h] = defaultCoeffForHour(h, mGroup);
      return next;
    });
    setMProfile({ tpl, stopNames: sts.map(st => st.stopName), relArr, relDep, deps });
    setMStep("preview");
  }

  function mApplyGroup(g: TrafficGroup) {
    setMGroup(g);
    if (!mProfile) return;
    const h0 = Math.floor(mProfile.deps[0] / 3600);
    const h1 = Math.floor((mProfile.deps[mProfile.deps.length - 1] + mProfile.relArr[mProfile.relArr.length - 1]) / 3600);
    setMCoeff(() => {
      const next: Record<number, number> = {};
      for (let h = h0; h <= h1; h++) next[h] = defaultCoeffForHour(h, g);
      return next;
    });
  }

  async function mFinalize() {
    if (!mProfile) return;
    const tpl = mProfile.tpl;
    setMBusy(true);
    try {
      const r = await generatePsTripsHeadway(projectId, {
        baseTripId: tpl.id,
        from: mFrom,
        to: mTo,
        headwayMin: Math.round(Number(mEvery)),
        applyTraffic: mApplyTraffic,
        coeffByHour: mApplyTraffic ? mCoeff : undefined,
        dayTypeIds: [...mDayTypeIds],
        categoryIds: [...mCategoryIds],
        removeTemplate: !!tpl.attributes?.prototype,
      });
      toast.success(`✅ ${r.count} corse generate e salvate`, {
        description: `${mFrom}–${mTo} · una ogni ${mEvery} min · ${mApplyTraffic ? `traffico ${TRAFFIC_GROUP_LABEL[mGroup]}` : "senza variazione traffico"}${r.templateRemoved ? " · prototipo rimosso" : ""}`,
        duration: 6000,
      });
      setMStep("params"); setMProfile(null); setStMap({});
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Generazione fallita", { description: e?.message });
    } finally { setMBusy(false); }
  }

  /* ══════════ B · RICALCOLA percorrenze esistenti ══════════ */
  const [rReferenceId, setRReferenceId] = useState("");
  const [rCoeff, setRCoeff] = useState<Record<number, number>>({});
  const [rGroup, setRGroup] = useState<TrafficGroup>("feriale");
  const [rExcluded, setRExcluded] = useState<Set<string>>(new Set());
  const [rBusy, setRBusy] = useState(false);
  useEffect(() => { setRReferenceId(""); setRCoeff({}); setRGroup("feriale"); setRExcluded(new Set()); }, [variantId]);

  // Riferimento di default: la corsa più VELOCE (giro minimo) = profilo neutro
  useEffect(() => {
    if (rReferenceId || stLoading || tripsByDep.length === 0) return;
    let best: { id: string; giro: number } | null = null;
    for (const t of tripsByDep) {
      const d = firstDep(t.id), a = lastArr(t.id);
      if (d == null || a == null || a <= d) continue;
      if (!best || a - d < best.giro) best = { id: t.id, giro: a - d };
    }
    if (best) setRReferenceId(best.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stLoading, tripsByDep, rReferenceId]);

  const rRef = trips.find(t => t.id === rReferenceId) ?? null;
  const rRefSts = rRef ? (stMap[rRef.id] ?? []) : [];
  const rRel = useMemo(() => {
    if (rRefSts.length < 2) return null;
    const baseDep = ttToSec(rRefSts[0].departureTime);
    return {
      relArr: rRefSts.map(st => ttToSec(st.arrivalTime) - baseDep),
      relDep: rRefSts.map(st => ttToSec(st.departureTime) - baseDep),
    };
  }, [rRefSts]);

  // Fasce orarie coperte dalle corse della variante → seed dei coefficienti
  const rHours = useMemo(() => {
    let h0 = Infinity, h1 = -Infinity;
    for (const t of tripsByDep) {
      const d = firstDep(t.id), a = lastArr(t.id);
      if (d == null || a == null) continue;
      h0 = Math.min(h0, Math.floor(d / 3600));
      h1 = Math.max(h1, Math.floor(a / 3600) + 1); // margine: il ricalcolo può allungare
    }
    if (!Number.isFinite(h0) || h1 < h0) return [];
    const out: number[] = [];
    for (let h = h0; h <= Math.min(h1, 30); h++) out.push(h);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripsByDep, stMap]);
  useEffect(() => {
    if (rHours.length === 0 || Object.keys(rCoeff).length > 0) return;
    const next: Record<number, number> = {};
    for (const h of rHours) next[h] = defaultCoeffForHour(h, rGroup);
    setRCoeff(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rHours]);
  function rApplyGroup(g: TrafficGroup) {
    setRGroup(g);
    const next: Record<number, number> = {};
    for (const h of rHours) next[h] = defaultCoeffForHour(h, g);
    setRCoeff(next);
  }

  /** Anteprima del ricalcolo: per ogni corsa (salvo riferimento), nuovo arrivo
   * = partenza attuale + archi del riferimento scalati per fascia. */
  const rRows = useMemo(() => {
    if (!rRel || !rReferenceId) return [];
    const out: {
      trip: PsTrip; dep0: number; arrNow: number; arrNew: number; deltaMin: number;
      skipped: boolean;
    }[] = [];
    for (const t of tripsByDep) {
      if (t.id === rReferenceId) continue;
      const sts = stMap[t.id];
      if (!sts || sts.length < 2) continue;
      const dep0 = ttToSec(sts[0].departureTime);
      const arrNow = ttToSec(sts[sts.length - 1].arrivalTime);
      if (sts.length !== rRefSts.length) {
        out.push({ trip: t, dep0, arrNow, arrNew: arrNow, deltaMin: 0, skipped: true });
        continue;
      }
      const times = scaleRunTimes(dep0, rRel.relArr, rRel.relDep, rCoeff);
      const arrNew = times.arr[times.arr.length - 1];
      out.push({ trip: t, dep0, arrNow, arrNew, deltaMin: Math.round((arrNew - arrNow) / 60), skipped: false });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripsByDep, stMap, rRel, rReferenceId, rCoeff, rRefSts.length]);
  const rSelectable = rRows.filter(r => !r.skipped);
  const rSelected = rSelectable.filter(r => !rExcluded.has(r.trip.id));
  const rChanged = rSelected.filter(r => r.deltaMin !== 0);

  async function rApply() {
    if (!rReferenceId || rSelected.length === 0) return;
    setRBusy(true);
    try {
      const r = await retimePsTripsTraffic(projectId, {
        variantId,
        referenceTripId: rReferenceId,
        coeffByHour: rCoeff,
        tripIds: rSelected.map(x => x.trip.id),
      });
      toast.success(`✅ Percorrenze ricalcolate su ${r.count} corse`, {
        description: `${r.skippedTripIds.length > 0 ? `${r.skippedTripIds.length} saltate (pattern fermate diverso) · ` : ""}riferimento invariato: ${rRef ? tripLabel(rRef) : ""}`,
        duration: 6000,
      });
      setStMap({});
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Ricalcolo fallito", { description: e?.message });
    } finally { setRBusy(false); }
  }

  /* ══════════ Render ══════════ */
  const project = projectQ.data;
  const routes = routesQ.data ?? [];
  const variants = variantsQ.data ?? [];

  const coeffInputs = (hours: number[], coeff: Record<number, number>, setCoeff: (u: (p: Record<number, number>) => Record<number, number>) => void, disabled: boolean) => (
    <div className="flex flex-wrap gap-1.5">
      {hours.map(h => (
        <label key={h} className="flex flex-col items-center gap-0.5 text-[10px] text-slate-400">
          <span>{String(h % 24).padStart(2, "0")}:00</span>
          <input type="number" step={0.05} min={0.5} max={3}
            value={coeff[h] ?? 1}
            onChange={e => { const v = Number(e.target.value); setCoeff(prev => ({ ...prev, [h]: Number.isFinite(v) && v > 0 ? v : 1 })); }}
            disabled={disabled}
            className="w-14 px-1 py-0.5 rounded bg-slate-950 border border-amber-500/40 text-amber-300 text-center text-[11px] disabled:opacity-40" />
        </label>
      ))}
    </div>
  );

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {project?.isOperational && (
        <div className="px-3 pt-3"><OperationalEditWarning isOperational projectName={project?.name} /></div>
      )}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300" title="Torna al progetto">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-amber-400" />
          <h1 className="font-semibold text-sm">Percorrenze</h1>
        </div>
        {project && <span className="text-xs text-slate-500 ml-2">{project.name}</span>}
        <div className="flex-1" />
        <span className="text-[11px] text-slate-500">tempi di percorrenza dai dati di traffico</span>
      </div>
      <PsProjectNav projectId={projectId} active="percorrenze" />

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Selettori linea/variante + modalità */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select value={routeId} onChange={e => setRouteId(e.target.value)}
            className="px-2 py-1.5 rounded bg-slate-900 border border-slate-700">
            <option value="">— linea —</option>
            {routes.map(r => <option key={r.id} value={r.id}>{r.shortName} · {r.longName || ""}</option>)}
          </select>
          <select value={variantId} onChange={e => setVariantId(e.target.value)} disabled={!routeId}
            className="px-2 py-1.5 rounded bg-slate-900 border border-slate-700 disabled:opacity-40">
            <option value="">— percorso (variante) —</option>
            {variants.map(v => <option key={v.id} value={v.id}>{(v as any).code ? `${(v as any).code} · ` : ""}{v.name}</option>)}
          </select>
          {stLoading && <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 className="w-3 h-3 animate-spin" /> orari…</span>}
          <div className="flex-1" />
          <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
            <button onClick={() => setMode("moltiplica")}
              className={`px-3 py-1.5 inline-flex items-center gap-1.5 transition-colors ${mode === "moltiplica" ? "bg-amber-600 text-white font-semibold" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
              <CopyPlus className="w-3.5 h-3.5" /> Moltiplica corsa base
            </button>
            <button onClick={() => setMode("ricalcola")}
              className={`px-3 py-1.5 inline-flex items-center gap-1.5 transition-colors ${mode === "ricalcola" ? "bg-emerald-600 text-white font-semibold" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
              <RefreshCw className="w-3.5 h-3.5" /> Ricalcola esistenti
            </button>
          </div>
        </div>

        {!variantId && (
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
            Seleziona <strong className="text-slate-200">linea</strong> e <strong className="text-slate-200">percorso</strong> per iniziare.
            <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
              <strong className="text-amber-300">Moltiplica corsa base</strong>: da una corsa template generi la cadenza nella fascia scelta, con le percorrenze adattate al traffico.<br />
              <strong className="text-emerald-300">Ricalcola esistenti</strong>: il percorso ha già la cadenza — rifai le percorrenze dai dati di traffico senza toccare le partenze.
            </div>
          </div>
        )}

        {/* ════════ A · MOLTIPLICA ════════ */}
        {variantId && mode === "moltiplica" && mStep === "params" && (
          <div className="rounded-lg border border-amber-500/30 bg-slate-900/60 p-4 space-y-3 text-sm max-w-2xl">
            <h3 className="text-sm font-semibold text-amber-300 flex items-center gap-2"><Timer className="w-4 h-4" /> Genera corse a cadenza — passo 1 di 2</h3>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Corsa base (template)</label>
              <select value={mTemplateId} onChange={e => setMTemplateId(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs">
                <option value="">— scegli la corsa da replicare —</option>
                {tripsByDep.map(t => <option key={t.id} value={t.id}>{tripLabel(t)}</option>)}
              </select>
              <p className="text-[10px] text-slate-500 mt-1">Gli orari di transito a ogni fermata vengono ricalcolati traslando quelli della corsa base.</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Dalle</label>
                <input type="time" value={mFrom} onChange={e => setMFrom(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Alle</label>
                <input type="time" value={mTo} onChange={e => setMTo(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Ogni (min)</label>
                <input type="number" min={1} max={240} value={mEvery} onChange={e => setMEvery(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
              </div>
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (calendario aziendale) — anche più di una</label>
              <CategoryChips categories={categoriesQ.data ?? []} selected={mCategoryIds} onChange={setMCategoryIds} />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (tipi giorno)</label>
              <div className="flex flex-wrap gap-2">
                {(dayTypesQ.data ?? []).map(dt => (
                  <label key={dt.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                    style={{ borderColor: mDayTypeIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: mDayTypeIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                    <input type="checkbox" className="hidden" checked={mDayTypeIds.has(dt.id)}
                      onChange={() => setMDayTypeIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                    {dt.name}
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-slate-500 mt-1">Giorni e periodi vengono applicati a TUTTE le corse generate.</p>
            </div>
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              ≈ <strong>{mPreviewCount}</strong> partenze nella fascia {mFrom}–{mTo} (headway costante).
              {mPreviewCount > 200 && <span className="text-red-300"> Oltre il limite di 200: restringi la fascia.</span>}
            </div>
            <div className="flex justify-end">
              <button onClick={mPrepare} disabled={mBusy || stLoading || !mTemplateId || mPreviewCount === 0 || mPreviewCount > 200}
                className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {mBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Timer className="w-3.5 h-3.5" />}
                Continua → Anteprima traffico
              </button>
            </div>
          </div>
        )}

        {variantId && mode === "moltiplica" && mStep === "preview" && mProfile && (() => {
          const nArcs = mProfile.stopNames.length - 1;
          const h0 = Math.floor(mProfile.deps[0] / 3600);
          const h1 = Math.floor((mProfile.deps[mProfile.deps.length - 1] + mProfile.relArr[mProfile.relArr.length - 1]) / 3600);
          const hours: number[] = [];
          for (let h = h0; h <= h1; h++) hours.push(h);
          const transits: number[][] = Array.from({ length: nArcs }, (_, a) =>
            hours.map(h => mProfile.deps.filter(dep => Math.floor((dep + mProfile.relDep[a]) / 3600) === h).length));
          const heat = (c: number) => c <= 1 ? "transparent"
            : c <= 1.1 ? "rgba(245,158,11,0.12)" : c <= 1.2 ? "rgba(245,158,11,0.25)"
            : c <= 1.3 ? "rgba(239,68,68,0.25)" : "rgba(239,68,68,0.4)";
          const fmtH = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
          const giroBase = mProfile.relArr[mProfile.relArr.length - 1];
          const giroOf = (dep: number) => {
            const t = scaleRunTimes(dep, mProfile.relArr, mProfile.relDep, mApplyTraffic ? mCoeff : null);
            return t.arr[t.arr.length - 1] - dep;
          };
          return (
            <div className="rounded-lg border border-amber-500/30 bg-slate-900/60 p-4 space-y-3 text-sm">
              <h3 className="text-sm font-semibold text-amber-300 flex items-center gap-2"><Timer className="w-4 h-4" /> Anteprima · variazione traffico — passo 2 di 2</h3>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-slate-400">
                  Coefficienti di rallentamento per <strong className="text-slate-200">fascia oraria</strong> (proposta dal profilo traffico, modificabile).
                  Ogni cella mostra il tempo dell'arco <span className="text-amber-300">adattato</span> e il n° di transiti previsti.
                </p>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none shrink-0">
                  <input type="checkbox" checked={mApplyTraffic} onChange={e => setMApplyTraffic(e.target.checked)} className="accent-amber-500" />
                  Applica variazione traffico
                </label>
              </div>
              <TrafficGroupBar group={mGroup} onApply={mApplyGroup} disabled={!mApplyTraffic} />
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
                              value={mCoeff[h] ?? 1}
                              onChange={e => { const v = Number(e.target.value); setMCoeff(prev => ({ ...prev, [h]: Number.isFinite(v) && v > 0 ? v : 1 })); }}
                              disabled={!mApplyTraffic}
                              className="w-12 px-1 py-0.5 rounded bg-slate-950 border border-amber-500/40 text-amber-300 text-center disabled:opacity-40" />
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: nArcs }, (_, a) => {
                      const baseSec = mProfile.relArr[a + 1] - mProfile.relDep[a];
                      return (
                        <tr key={a} className="border-b border-slate-800/60">
                          <td className="px-2 py-1 text-slate-300 whitespace-nowrap overflow-hidden text-ellipsis max-w-[220px]">
                            <span className="text-slate-500">{a + 1}.</span> {mProfile.stopNames[a]} <span className="text-slate-600">→</span> {mProfile.stopNames[a + 1]}
                            <span className="text-slate-500 ml-1">({Math.round(baseSec / 6) / 10}′)</span>
                          </td>
                          {hours.map((h, hi) => {
                            const c = mApplyTraffic ? (mCoeff[h] ?? 1) : 1;
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
                <span><strong>{mProfile.deps.length}</strong> corse da salvare</span>
                <span>giro base: <strong>{Math.round(giroBase / 60)}′</strong></span>
                <span>giro adattato: <strong>{Math.round(giroOf(mProfile.deps[0]) / 60)}′</strong> (prima) → <strong>{Math.round(giroOf(mProfile.deps[mProfile.deps.length - 1]) / 60)}′</strong> (ultima)</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setMStep("params")} disabled={mBusy}
                  className="mr-auto text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">← Indietro</button>
                <button onClick={mFinalize} disabled={mBusy}
                  className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                  {mBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Salva {mProfile.deps.length} corse
                </button>
              </div>
            </div>
          );
        })()}

        {/* ════════ B · RICALCOLA ════════ */}
        {variantId && mode === "ricalcola" && (
          <div className="rounded-lg border border-emerald-500/30 bg-slate-900/60 p-4 space-y-3 text-sm">
            <h3 className="text-sm font-semibold text-emerald-300 flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Ricalcola le percorrenze della cadenza esistente</h3>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Le partenze NON si toccano: per ogni corsa gli archi della <strong className="text-slate-200">corsa di riferimento</strong> vengono
              scalati per il coefficiente della fascia oraria in cui il bus entra nell'arco. La corsa di riferimento resta invariata
              (è il profilo neutro): puoi ripetere il ricalcolo con coefficienti diversi senza effetti cumulativi.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] uppercase tracking-wider text-slate-500">Corsa di riferimento</label>
              <select value={rReferenceId} onChange={e => setRReferenceId(e.target.value)}
                className="px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs min-w-[260px]">
                <option value="">— scegli —</option>
                {tripsByDep.map(t => <option key={t.id} value={t.id}>{tripLabel(t)}</option>)}
              </select>
              <span className="text-[10px] text-slate-500">default: la corsa col giro più veloce</span>
            </div>
            <TrafficGroupBar group={rGroup} onApply={rApplyGroup} />
            {rHours.length > 0 && (
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Coefficienti per fascia oraria (× tempo d'arco)</label>
                {coeffInputs(rHours, rCoeff, setRCoeff, false)}
              </div>
            )}
            {rRel && rRows.length > 0 && (
              <div className="overflow-auto max-h-[46vh] rounded border border-slate-800">
                <table className="text-[11px] border-collapse w-full">
                  <thead className="sticky top-0 bg-slate-900 z-10">
                    <tr className="text-slate-400">
                      <th className="px-2 py-1.5 border-b border-slate-800 text-center">
                        <input type="checkbox"
                          checked={rSelectable.length > 0 && rSelected.length === rSelectable.length}
                          onChange={() => setRExcluded(rSelected.length === rSelectable.length ? new Set(rSelectable.map(x => x.trip.id)) : new Set())}
                          className="accent-emerald-500" />
                      </th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-left">Corsa</th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-right">Partenza</th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-right">Arrivo attuale</th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-right">Arrivo nuovo</th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-right">Giro</th>
                      <th className="px-2 py-1.5 border-b border-slate-800 text-right">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rRows.map(row => {
                      const excluded = rExcluded.has(row.trip.id);
                      return (
                        <tr key={row.trip.id} className={`border-b border-slate-800/60 ${row.skipped || excluded ? "opacity-45" : ""}`}>
                          <td className="px-2 py-1 text-center">
                            {row.skipped ? <span title="Pattern fermate diverso dal riferimento: esclusa" className="text-slate-500">—</span> : (
                              <input type="checkbox" checked={!excluded}
                                onChange={() => setRExcluded(prev => { const n = new Set(prev); n.has(row.trip.id) ? n.delete(row.trip.id) : n.add(row.trip.id); return n; })}
                                className="accent-emerald-500" />
                            )}
                          </td>
                          <td className="px-2 py-1 text-slate-300">{row.trip.shortName || row.trip.headsign || row.trip.id.slice(0, 8)}
                            {row.skipped && <span className="ml-1.5 text-[9px] text-amber-400">pattern diverso</span>}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">{fmtHm(row.dep0)}</td>
                          <td className="px-2 py-1 text-right font-mono text-slate-400">{fmtHm(row.arrNow)}</td>
                          <td className="px-2 py-1 text-right font-mono">{row.skipped ? "—" : fmtHm(row.arrNew)}</td>
                          <td className="px-2 py-1 text-right font-mono text-slate-400">{row.skipped ? "—" : `${Math.round((row.arrNew - row.dep0) / 60)}′`}</td>
                          <td className={`px-2 py-1 text-right font-mono ${row.deltaMin > 0 ? "text-amber-300" : row.deltaMin < 0 ? "text-emerald-300" : "text-slate-500"}`}>
                            {row.skipped ? "—" : `${row.deltaMin > 0 ? "+" : ""}${row.deltaMin}′`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rReferenceId && rRows.length === 0 && !stLoading && (
              <p className="text-[11px] text-slate-500">Nessun'altra corsa nella variante oltre al riferimento.</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                {rSelected.length} corse selezionate · <strong className="text-emerald-300">{rChanged.length}</strong> cambierebbero orario
              </span>
              <button onClick={rApply} disabled={rBusy || stLoading || !rReferenceId || rSelected.length === 0}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                {rBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Ricalcola {rSelected.length} corse
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
