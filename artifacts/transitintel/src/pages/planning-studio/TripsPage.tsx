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
import {
  ArrowLeft, Bus, Filter, Trash2, X, Loader2, Check, Calendar as CalendarIcon,
  Power, PowerOff, CalendarPlus, CalendarMinus, Save, Eye, EyeOff, Timer,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsVariants, type PsVariant,
  listPsCalendars, type PsCalendar,
  listPsTrips, deletePsTrip, updatePsTrip, bulkUpdatePsTrips, type PsTrip,
  getPsStopTimes, type PsStopTime,
  batchCreatePsTrips, type PsBatchTripInput,
  listPsTripExceptions, addPsTripException, deletePsTripException, type PsTripException,
} from "@/lib/planning-studio-api";

function fmtTime(t?: string | null) {
  if (!t) return "—";
  return t.length >= 5 ? t.slice(0, 5) : t;
}
function fmtDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
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
  const [calendarFilter, setCalendarFilter] = useState<string>("");
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
    queryKey: ["ps", projectId, "trips", routeId, variantId],
    queryFn: () => listPsTrips(projectId, {
      routeId: routeId || undefined,
      variantId: variantId || undefined,
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
    if (calendarFilter) trips = trips.filter(t => t.calendarId === calendarFilter);
    if (onlyActive) trips = trips.filter(t => t.isActive);
    // ordina per orario partenza se disponibile, altrimenti per shortName/headsign
    return [...trips].sort((a, b) => {
      const ta = firstTimes[a.id], tb = firstTimes[b.id];
      if (ta && tb) return ta.localeCompare(tb);
      if (ta) return -1;
      if (tb) return 1;
      return (a.shortName || a.headsign || "").localeCompare(b.shortName || b.headsign || "");
    });
  }, [tripsQ.data, calendarFilter, onlyActive, firstTimes]);

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
  useEffect(() => { setSelected(new Set()); }, [routeId, variantId, calendarFilter, onlyActive]);

  /* ─── C1 · Genera corse a cadenza (even headway, Ceder §4.3) ───
   * Corsa template + fascia oraria + headway → partenze t_k = t0 + k·H,
   * orari propagati su tutte le fermate clonando gli stop_times traslati. */
  const [genOpen, setGenOpen] = useState(false);
  const [genTemplateId, setGenTemplateId] = useState("");
  const [genFrom, setGenFrom] = useState("06:00");
  const [genTo, setGenTo] = useState("20:00");
  const [genEvery, setGenEvery] = useState("15");
  const [genBusy, setGenBusy] = useState(false);

  const genToSec = (t: string) => { const q = t.split(":").map(Number); return (q[0] || 0) * 3600 + (q[1] || 0) * 60 + (q[2] || 0); };
  const genSecToHms = (x: number) => {
    const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.round(x % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  const genPreviewCount = useMemo(() => {
    const H = Math.round(Number(genEvery));
    const a = genToSec(genFrom + ":00"), b = genToSec(genTo + ":00");
    if (!Number.isFinite(H) || H < 1 || b <= a) return 0;
    return Math.floor((b - a) / (H * 60)) + 1;
  }, [genFrom, genTo, genEvery]);

  async function runGenerate() {
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
      const minOff = Math.min(...sts.map(st => genToSec(st.arrivalTime) - baseDep));
      const deps: number[] = [];
      for (let t = winFrom; t <= winTo; t += H * 60) {
        if (Math.abs(t - baseDep) < 30) continue; // il template esiste già: non clonarlo su se stesso
        if (t + minOff < 0) continue;             // niente orari negativi
        deps.push(t);
      }
      if (deps.length === 0) throw new Error("Nessuna partenza da generare nella fascia");
      if (deps.length > 200) throw new Error(`${deps.length} corse superano il limite di 200 per batch: restringi la fascia o allunga la cadenza`);
      const payload: PsBatchTripInput[] = deps.map(dep => ({
        routeId: tpl.routeId,
        variantId: tpl.variantId,
        calendarId: tpl.calendarId ?? null,
        headsign: tpl.headsign ?? null,
        direction: tpl.direction ?? 0,
        serviceLabel: tpl.serviceLabel ?? null,
        stopTimes: sts.map(st => ({
          stopId: st.stopId,
          arrivalTime: genSecToHms(genToSec(st.arrivalTime) - baseDep + dep),
          departureTime: genSecToHms(genToSec(st.departureTime) - baseDep + dep),
          timepoint: st.timepoint,
        })),
      }));
      const r = await batchCreatePsTrips(projectId, payload);
      toast.success(`✅ ${r.count} corse generate`, {
        description: `${genFrom}–${genTo} · una ogni ${H} min · orari propagati su ${sts.length} fermate`,
        duration: 6000,
      });
      setGenOpen(false);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Generazione fallita", { description: e?.message });
    } finally { setGenBusy(false); }
  }

  /* ─── Mutations ─── */
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PsTrip> }) =>
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
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100">
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
      </div>

      {/* Filtri */}
      <div className="h-12 border-b border-slate-800 bg-slate-900/40 px-4 flex items-center gap-3 text-xs">
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
          value={calendarFilter} onChange={e => setCalendarFilter(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[160px]"
        >
          <option value="">Tutti i calendari</option>
          {calendars.map(c => (
            <option key={c.id} value={c.id}>{c.code} {c.name ? `· ${c.name}` : ""}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-slate-400">
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)}
            className="accent-amber-500" />
          Solo attive
        </label>

        <button
          onClick={() => {
            if (!variantId) { toast.info("Seleziona linea e variante", { description: "La cadenza si genera da una corsa template della variante." }); return; }
            setGenTemplateId(filteredTrips[0]?.id ?? "");
            setGenOpen(true);
          }}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-500 transition-colors"
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
            Nessuna corsa trovata con i filtri attuali.
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
                <th className="p-2 text-left">Calendario</th>
                <th className="p-2 text-left">Validità</th>
                <th className="p-2 text-left">Etichetta</th>
                <th className="p-2 text-center w-16">Stato</th>
                <th className="p-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filteredTrips.map(t => {
                const route = routes.find(r => r.id === t.routeId);
                const variant = variants.find(v => v.id === t.variantId);
                const cal = calendars.find(c => c.id === t.calendarId);
                const isSel = selected.has(t.id);
                return (
                  <tr key={t.id} className={`border-b border-slate-800/60 hover:bg-slate-900/50 ${
                    isSel ? "bg-amber-500/5" : ""
                  } ${!t.isActive ? "opacity-50" : ""}`}>
                    <td className="p-2">
                      <input type="checkbox" checked={isSel} onChange={() => toggleSel(t.id)}
                        className="accent-amber-500" />
                    </td>
                    <td className="p-2 font-mono text-slate-300">
                      {fmtTime(firstTimes[t.id])}
                    </td>
                    <td className="p-2">
                      <div className="font-medium text-slate-200">{route?.shortName || "?"}</div>
                      <div className="text-[10px] text-slate-500">{variant?.name || ""}</div>
                    </td>
                    <td className="p-2 text-slate-300">{t.headsign || "—"}</td>
                    <td className="p-2 text-slate-400">
                      {cal ? <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px]">{cal.code}</span> : "—"}
                    </td>
                    <td className="p-2 text-slate-400">
                      {t.validFrom || t.validTo
                        ? <span>{fmtDate(t.validFrom)} → {fmtDate(t.validTo)}</span>
                        : <span className="text-slate-600">illimitata</span>}
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

      {/* ─── Dialog: Genera corse a cadenza (C1 — even headway) ─── */}
      {genOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !genBusy && setGenOpen(false)}>
          <div className="w-full max-w-md mx-4 rounded-xl border border-amber-500/30 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Timer className="w-4 h-4 text-amber-400" /> Genera corse a cadenza
              </h3>
              <button onClick={() => !genBusy && setGenOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Corsa template</label>
                <select value={genTemplateId} onChange={e => setGenTemplateId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs">
                  <option value="">— scegli la corsa da replicare —</option>
                  {filteredTrips.map(t => (
                    <option key={t.id} value={t.id}>
                      {fmtTime(firstTimes[t.id])} · {t.shortName || t.headsign || t.id.slice(0, 8)}
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
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                ≈ <strong>{genPreviewCount}</strong> partenze nella fascia {genFrom}–{genTo} (headway costante).
                {genPreviewCount > 200 && <span className="text-red-300"> Oltre il limite di 200: restringi la fascia.</span>}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setGenOpen(false)} disabled={genBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={runGenerate} disabled={genBusy || !genTemplateId || genPreviewCount === 0 || genPreviewCount > 200}
                className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {genBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Timer className="w-3.5 h-3.5" />}
                Genera corse
              </button>
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
        className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Validità
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-2 z-20 flex items-center gap-2">
          <input type="date" value={vf} onChange={e => setVf(e.target.value)}
            className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs" />
          <span className="text-slate-500">→</span>
          <input type="date" value={vt} onChange={e => setVt(e.target.value)}
            className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs" />
          <button
            onClick={() => { onApply(vf, vt); setOpen(false); }}
            className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            <Check className="w-3 h-3" />
          </button>
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
