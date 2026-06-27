/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante (2 finestre)
 * ───────────────────────────────────────────────────────────────────────────
 * A sinistra il tabellone (operatori × giorni). A destra i turni SCOPERTI per
 * giorno. Per assegnare: seleziona un turno a destra → Q (taglia), seleziona
 * un conducente a sinistra → W (incolla): il turno va nel giorno giusto perché
 * la tabella ha una colonna per ogni giorno. Click su un turno assegnato per
 * rimuoverlo. Anagrafica conducente completa via la matita.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Loader2,
  UserPlus, Users, Pencil, Scissors, ClipboardPaste, Info,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import DriverEditDialog, { type RosterDriver } from "@/components/roster/DriverEditDialog";

/* ─── Tipi (allineati a /api/roster/*) ─── */
interface RosterDuty {
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
}
interface RosterAssignment { id: string; driverId: string; day: string; dutyCode: string; dssId: string }
interface DutySource {
  dssId: string; name: string; scenarioName: string | null;
  scenarioDate: string | null; dutyCount: number; createdAt: string;
  isOperational?: boolean; validityUnitName?: string | null;
}
interface Board {
  from: string; days: string[]; drivers: RosterDriver[];
  duties: RosterDuty[]; assignments: RosterAssignment[];
  /** residenza di servizio (deposito) dello scenario → colore dei turni */
  residenza?: { name: string; color: string } | null;
}

const DUTY_TYPE_COLOR: Record<string, string> = {
  intero: "#10b981", semiunico: "#38bdf8", spezzato: "#f59e0b", supplemento: "#a78bfa",
};
function dutyColor(type: string | null): string {
  return DUTY_TYPE_COLOR[String(type ?? "").toLowerCase()] ?? "#64748b";
}
function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}
function shiftDate(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
function dayLabel(iso: string): { dow: string; dm: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    dow: d.toLocaleDateString("it-IT", { weekday: "short", timeZone: "UTC" }),
    dm: d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", timeZone: "UTC" }),
  };
}
function driverLabel(d: RosterDriver): string {
  return [d.cognome, d.nome].filter(Boolean).join(" ") || d.name;
}

export default function RosterPage() {
  const qc = useQueryClient();
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const psProjectId = urlParams.get("psProjectId") ?? "";
  const [from, setFrom] = useState(() => mondayOf(new Date()));
  const [dssId, setDssId] = useState("");
  const [operationalOnly, setOperationalOnly] = useState(urlParams.get("operational") === "1");

  // selezioni + appunti (taglia/incolla)
  const [selDuty, setSelDuty] = useState<{ day: string; code: string } | null>(null);
  const [selDriver, setSelDriver] = useState<string | null>(null);
  const [cut, setCut] = useState<{ day: string; code: string } | null>(null);
  const [editDriver, setEditDriver] = useState<RosterDriver | null | "new">(null);

  const sourcesQ = useQuery({
    queryKey: ["roster", "sources", operationalOnly, psProjectId],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (operationalOnly) qs.set("operationalOnly", "1");
      if (psProjectId) qs.set("psProjectId", psProjectId);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiFetch<{ sources: DutySource[] }>(`/api/roster/duty-sources${suffix}`);
    },
  });

  const boardQ = useQuery({
    queryKey: ["roster", "board", from, dssId],
    queryFn: () => apiFetch<Board>(`/api/roster/board?from=${from}&days=7${dssId ? `&dssId=${dssId}` : ""}`),
  });
  const invalidateBoard = () => qc.invalidateQueries({ queryKey: ["roster", "board"] });

  const seedMut = useMutation({
    mutationFn: () => apiFetch<{ created: number }>("/api/roster/drivers/seed", { method: "POST", body: JSON.stringify({ count: 10 }) }),
    onSuccess: (r) => { toast.success(`${r.created} operatori fittizi creati`); qc.invalidateQueries({ queryKey: ["roster"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignMut = useMutation({
    mutationFn: (input: { driverId: string; day: string; dutyCode: string }) =>
      apiFetch("/api/roster/assignments", { method: "POST", body: JSON.stringify({ ...input, dssId }) }),
    onSuccess: () => { setCut(null); setSelDuty(null); invalidateBoard(); },
    onError: (e: Error) => toast.error("Assegnazione fallita", { description: e.message }),
  });
  const unassignMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/roster/assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateBoard(),
    onError: (e: Error) => toast.error(e.message),
  });

  const board = boardQ.data;
  const dutyByCode = useMemo(() => new Map((board?.duties ?? []).map((d) => [d.code, d])), [board?.duties]);
  const assignByCell = useMemo(() => {
    const m = new Map<string, RosterAssignment>();
    for (const a of board?.assignments ?? []) m.set(`${a.driverId}|${a.day}`, a);
    return m;
  }, [board?.assignments]);
  const uncoveredByDay = useMemo(() => {
    const m = new Map<string, RosterDuty[]>();
    if (!board) return m;
    for (const day of board.days) {
      const taken = new Set(board.assignments.filter((a) => a.day === day).map((a) => a.dutyCode));
      m.set(day, board.duties.filter((d) => !taken.has(d.code)));
    }
    return m;
  }, [board]);

  // ── Taglia/incolla via tastiera: Q = taglia turno selezionato, W = incolla sul conducente ──
  function doPaste() {
    if (!cut) { toast.info("Prima seleziona un turno e premi Q (taglia)"); return; }
    if (!selDriver) { toast.info("Seleziona un conducente a sinistra"); return; }
    if (assignByCell.has(`${selDriver}|${cut.day}`)) { toast.error("Il conducente ha già un turno quel giorno"); return; }
    assignMut.mutate({ driverId: selDriver, day: cut.day, dutyCode: cut.code });
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (k === "q") { e.preventDefault(); if (selDuty) { setCut(selDuty); toast.success(`Turno ${selDuty.code} in taglio — scegli un conducente e premi W`); } }
      else if (k === "w") { e.preventDefault(); doPaste(); }
      else if (e.key === "Escape") { setCut(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selDuty, selDriver, cut, assignByCell]); // eslint-disable-line react-hooks/exhaustive-deps

  const selDutyDetail = selDuty ? dutyByCode.get(selDuty.code) : undefined;
  // colore turno: residenza (deposito) se disponibile, altrimenti per tipo
  const resColor = (type: string | null) => board?.residenza?.color ?? dutyColor(type);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* ── Barra comandi ── */}
      <div className="border-b border-slate-800 bg-slate-900 px-4 py-2.5 flex flex-wrap items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-violet-400" />
          <span className="font-bold text-sm">Roster · Personale Viaggiante</span>
        </div>
        <select
          value={dssId}
          onChange={(e) => setDssId(e.target.value)}
          className="min-w-64 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm outline-none focus:border-violet-500"
        >
          <option value="">— Fonte turni (DSS) —</option>
          {sourcesQ.data?.sources.map((s) => (
            <option key={s.dssId} value={s.dssId}>
              {s.isOperational ? "● " : ""}{s.validityUnitName ? `${s.validityUnitName} · ` : ""}{s.name} · {s.dutyCount} turni
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap cursor-pointer">
          <input type="checkbox" checked={operationalOnly} onChange={(e) => { setOperationalOnly(e.target.checked); setDssId(""); }} className="accent-emerald-500" />
          Solo in esercizio
        </label>
        {board?.residenza && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-300 whitespace-nowrap" title="Residenza di servizio (deposito) — colore dei turni">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: board.residenza.color }} />
            {board.residenza.name}
          </span>
        )}
        <div className="flex items-center gap-1 rounded-lg border border-slate-700 px-1 py-0.5">
          <button onClick={() => setFrom(shiftDate(from, -7))} className="p-1.5 rounded hover:bg-white/10"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs font-mono px-2 flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5 text-violet-400" />{dayLabel(from).dm} – {dayLabel(shiftDate(from, 6)).dm}</span>
          <button onClick={() => setFrom(shiftDate(from, 7))} className="p-1.5 rounded hover:bg-white/10"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden lg:flex items-center gap-1 text-[10px] text-slate-500"><Scissors className="w-3 h-3" /> Q taglia · <ClipboardPaste className="w-3 h-3" /> W incolla</span>
          <button onClick={() => setEditDriver("new")} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium">
            <UserPlus className="w-3.5 h-3.5" /> Conducente
          </button>
          <button onClick={() => seedMut.mutate()} disabled={seedMut.isPending} className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs disabled:opacity-50">
            +10 fittizi
          </button>
        </div>
      </div>

      {/* appunti attivo */}
      {cut && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-1.5 text-[11px] text-amber-200 flex items-center gap-2 shrink-0">
          <Scissors className="w-3.5 h-3.5" /> In taglio: <b>{cut.code}</b> · {dayLabel(cut.day).dow} {dayLabel(cut.day).dm} — seleziona un conducente e premi <b>W</b> (Esc per annullare)
        </div>
      )}

      {/* ── Due finestre ── */}
      <div className="flex-1 min-h-0 flex">
        {/* SINISTRA: tabellone */}
        <div className="flex-1 min-w-0 overflow-auto">
          {boardQ.isLoading ? (
            <div className="p-10 text-center text-slate-500 text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico il tabellone…</div>
          ) : !board || board.drivers.length === 0 ? (
            <div className="p-10 text-center text-slate-500 text-sm">Nessun conducente. Aggiungine uno o genera operatori fittizi.</div>
          ) : (
            <table className="min-w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr>
                  <th className="text-left px-3 py-2 border-b border-slate-800 sticky left-0 bg-slate-900 min-w-52">Conducente</th>
                  {board.days.map((day) => {
                    const { dow, dm } = dayLabel(day);
                    const unc = uncoveredByDay.get(day)?.length ?? 0;
                    return (
                      <th key={day} className="px-2 py-2 border-b border-slate-800 text-center min-w-28">
                        <span className="block uppercase text-[10px] text-slate-500">{dow}</span>
                        <span className="block font-semibold">{dm}</span>
                        {dssId && <span className={`block text-[9px] font-mono ${unc > 0 ? "text-amber-400" : "text-emerald-400"}`}>{unc > 0 ? `${unc} scoperti` : "coperto"}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {board.drivers.map((drv) => {
                  const isSel = selDriver === drv.id;
                  return (
                    <tr key={drv.id} className={isSel ? "bg-violet-500/10" : "odd:bg-white/[0.02]"}>
                      <td className={`px-3 py-1.5 border-b border-slate-800/40 sticky left-0 cursor-pointer ${isSel ? "bg-violet-500/15" : "bg-slate-950"}`}
                          onClick={() => setSelDriver(isSel ? null : drv.id)}>
                        <div className="flex items-center gap-1.5">
                          {drv.matricola && <span className="text-[9px] font-mono text-slate-500">{drv.matricola}</span>}
                          <span className="font-medium truncate">{driverLabel(drv)}</span>
                          {drv.isFictitious && <span className="text-[8px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300">fittizio</span>}
                          <button onClick={(e) => { e.stopPropagation(); setEditDriver(drv); }} className="ml-auto p-0.5 rounded text-slate-500 hover:text-violet-300" title="Anagrafica conducente"><Pencil className="w-3 h-3" /></button>
                        </div>
                      </td>
                      {board.days.map((day) => {
                        const a = assignByCell.get(`${drv.id}|${day}`);
                        const duty = a ? dutyByCode.get(a.dutyCode) : undefined;
                        return (
                          <td key={day} className="px-1.5 py-1.5 border-b border-slate-800/40 text-center align-middle">
                            {a ? (
                              <button
                                onClick={() => { if (confirm(`Rimuovere ${a.dutyCode} da ${driverLabel(drv)}?`)) unassignMut.mutate(a.id); }}
                                title={duty ? `${a.dutyCode} · ${duty.start ?? ""}–${duty.end ?? ""} (click per rimuovere)` : a.dutyCode}
                                className="w-full px-1.5 py-1 rounded text-white text-[10px] font-bold leading-tight hover:opacity-80"
                                style={{ backgroundColor: resColor(duty?.type ?? null) }}
                              >
                                {a.dutyCode}
                                {duty?.start && <span className="block font-normal opacity-90">{duty.start}–{duty.end}</span>}
                              </button>
                            ) : (
                              <button
                                onClick={() => { setSelDriver(drv.id); if (cut && cut.day === day) doPaste(); }}
                                className={`w-full h-8 rounded border border-dashed transition-colors ${cut && cut.day === day && isSel ? "border-amber-500/70 bg-amber-500/10 text-amber-300" : "border-slate-700/60 hover:border-violet-500/60 hover:bg-violet-500/5 text-slate-600 hover:text-violet-400"}`}
                                title={cut && cut.day === day ? "Incolla qui (W)" : "Seleziona conducente"}
                              >
                                {cut && cut.day === day ? "↵" : "+"}
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* DESTRA: turni scoperti per giorno */}
        <div className="w-96 max-w-[40vw] shrink-0 border-l border-slate-800 bg-slate-900/40 flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Turni scoperti per giorno
          </div>
          {!dssId ? (
            <div className="p-4 text-[11px] text-slate-500">Scegli una fonte turni (DSS) per vedere i turni scoperti.</div>
          ) : (
            <div className="flex-1 overflow-auto p-2 space-y-2">
              {board?.days.map((day) => {
                const list = uncoveredByDay.get(day) ?? [];
                return (
                  <div key={day}>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 px-1 mb-1">{dayLabel(day).dow} {dayLabel(day).dm} · {list.length}</div>
                    {list.length === 0 ? (
                      <div className="text-[10px] text-emerald-400/70 px-1 pb-1">tutto coperto</div>
                    ) : list.map((d) => {
                      const isSel = selDuty?.day === day && selDuty?.code === d.code;
                      const isCut = cut?.day === day && cut?.code === d.code;
                      return (
                        <button key={`${day}|${d.code}`}
                          onClick={() => setSelDuty(isSel ? null : { day, code: d.code })}
                          className={`w-full text-left px-2 py-1.5 rounded-lg border mb-1 flex items-center gap-2 transition-colors ${
                            isCut ? "border-amber-500/70 bg-amber-500/10" : isSel ? "border-violet-500/70 bg-violet-500/10" : "border-slate-800 hover:border-violet-500/40"
                          }`}>
                          <span className="px-1.5 py-0.5 rounded text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: resColor(d.type) }}>{d.code}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[11px] text-slate-200">{d.start ?? "?"}–{d.end ?? "?"}</span>
                            <span className="block text-[9px] text-slate-500">{d.type ?? "turno"}{d.tripsCount ? ` · ${d.tripsCount} corse` : ""}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          {/* Dettaglio turno selezionato */}
          {selDutyDetail && (
            <div className="border-t border-slate-800 bg-slate-950 p-3 text-[11px] space-y-1 shrink-0">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200"><Info className="w-3.5 h-3.5 text-violet-400" /> {selDuty?.code} · {selDutyDetail.type ?? "turno"}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-400">
                <span>Orario: <span className="text-slate-200">{selDutyDetail.start ?? "?"}–{selDutyDetail.end ?? "?"}</span></span>
                <span>Nastro: <span className="text-slate-200">{selDutyDetail.nastro ?? "—"}</span></span>
                <span>Lavoro: <span className="text-slate-200">{selDutyDetail.work ?? "—"}</span></span>
                <span>Interruzione: <span className="text-slate-200">{selDutyDetail.interruption ?? "—"}</span></span>
                <span>Riprese: <span className="text-slate-200">{selDutyDetail.ripreseCount}</span></span>
                <span>Corse: <span className="text-slate-200">{selDutyDetail.tripsCount}</span></span>
                {selDutyDetail.costEuro != null && <span>Costo: <span className="text-slate-200">€{selDutyDetail.costEuro.toFixed(0)}</span></span>}
              </div>
              <div className="pt-1 text-[10px] text-slate-500">Q per tagliare · poi seleziona conducente · W per incollare</div>
            </div>
          )}
        </div>
      </div>

      {editDriver !== null && (
        <DriverEditDialog driver={editDriver === "new" ? null : editDriver} onClose={() => setEditDriver(null)} />
      )}
    </div>
  );
}
