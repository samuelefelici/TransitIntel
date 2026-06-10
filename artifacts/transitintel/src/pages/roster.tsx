/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — tabellone assegnazione turni guida al personale viaggiante
 * ───────────────────────────────────────────────────────────────────────────
 * Righe = operatori (anche fittizi, generabili con un click), colonne = giorni
 * della settimana. Click su una cella vuota → scheda laterale con i TURNI
 * SCOPERTI del giorno (dai turni guida salvati nello Scheduling Engine):
 * click sul turno per assegnarlo all'operatore. Click su un turno assegnato
 * per rimuoverlo. Un turno per operatore al giorno; ogni turno coperto da un
 * solo operatore al giorno.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock, Loader2,
  UserPlus, Users, X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

/* ─── Tipi (allineati a /api/roster/*) ─── */

interface RosterDriver { id: string; name: string; badge: string | null; isFictitious: boolean }
interface RosterDuty {
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
}
interface RosterAssignment { id: string; driverId: string; day: string; dutyCode: string; dssId: string }
interface DutySource {
  dssId: string; name: string; scenarioName: string | null;
  scenarioDate: string | null; dutyCount: number; createdAt: string;
}
interface Board {
  from: string; days: string[]; drivers: RosterDriver[];
  duties: RosterDuty[]; assignments: RosterAssignment[];
}

const DUTY_TYPE_COLOR: Record<string, string> = {
  intero: "#10b981", semiunico: "#38bdf8", spezzato: "#f59e0b", supplemento: "#a78bfa",
};
function dutyColor(type: string | null): string {
  return DUTY_TYPE_COLOR[String(type ?? "").toLowerCase()] ?? "#64748b";
}

function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (x.getUTCDay() + 6) % 7; // 0 = lunedì
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

export default function RosterPage() {
  const qc = useQueryClient();
  const [from, setFrom] = useState(() => mondayOf(new Date()));
  const [dssId, setDssId] = useState("");
  // cella selezionata per l'assegnazione: scheda turni scoperti del giorno
  const [picker, setPicker] = useState<{ driverId: string; driverName: string; day: string } | null>(null);

  const sourcesQ = useQuery({
    queryKey: ["roster", "sources"],
    queryFn: () => apiFetch<{ sources: DutySource[] }>("/api/roster/duty-sources"),
  });

  const boardQ = useQuery({
    queryKey: ["roster", "board", from, dssId],
    queryFn: () => apiFetch<Board>(`/api/roster/board?from=${from}&days=7${dssId ? `&dssId=${dssId}` : ""}`),
  });
  const invalidateBoard = () => qc.invalidateQueries({ queryKey: ["roster", "board"] });

  const seedMut = useMutation({
    mutationFn: () => apiFetch<{ created: number }>("/api/roster/drivers/seed", {
      method: "POST", body: JSON.stringify({ count: 10 }),
    }),
    onSuccess: (r) => { toast.success(`${r.created} operatori fittizi creati`); invalidateBoard(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignMut = useMutation({
    mutationFn: (input: { driverId: string; day: string; dutyCode: string }) =>
      apiFetch("/api/roster/assignments", {
        method: "POST", body: JSON.stringify({ ...input, dssId }),
      }),
    onSuccess: () => { setPicker(null); invalidateBoard(); },
    onError: (e: Error) => toast.error("Assegnazione fallita", { description: e.message }),
  });

  const unassignMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/roster/assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateBoard(),
    onError: (e: Error) => toast.error(e.message),
  });

  const board = boardQ.data;
  const dutyByCode = useMemo(
    () => new Map((board?.duties ?? []).map((d) => [d.code, d])),
    [board?.duties],
  );
  const assignByCell = useMemo(() => {
    const m = new Map<string, RosterAssignment>();
    for (const a of board?.assignments ?? []) m.set(`${a.driverId}|${a.day}`, a);
    return m;
  }, [board?.assignments]);
  // turni scoperti per giorno = tutti i turni della fonte − già assegnati quel giorno
  const uncoveredByDay = useMemo(() => {
    const m = new Map<string, RosterDuty[]>();
    if (!board) return m;
    for (const day of board.days) {
      const taken = new Set(board.assignments.filter((a) => a.day === day).map((a) => a.dutyCode));
      m.set(day, board.duties.filter((d) => !taken.has(d.code)));
    }
    return m;
  }, [board]);

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-lg">
          <Users className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-48">
          <h1 className="text-xl font-bold">Roster · Personale Viaggiante</h1>
          <p className="text-xs text-muted-foreground">
            Assegna i turni guida dello Scheduling Engine agli operatori, giorno per giorno
          </p>
        </div>
        <button
          onClick={() => seedMut.mutate()}
          disabled={seedMut.isPending}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/90 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
        >
          {seedMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
          +10 operatori fittizi
        </button>
      </div>

      {/* Fonte turni + settimana */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={dssId}
          onChange={(e) => setDssId(e.target.value)}
          className="flex-1 min-w-64 px-3 py-2 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-violet-500/60"
        >
          <option value="">— Scegli i turni guida da assegnare (DSS salvato) —</option>
          {sourcesQ.data?.sources.map((s) => (
            <option key={s.dssId} value={s.dssId}>
              {s.name} · {s.dutyCount} turni {s.scenarioName ? `· ${s.scenarioName}` : ""}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1 rounded-lg border border-border/60 px-1 py-1">
          <button onClick={() => setFrom(shiftDate(from, -7))} className="p-1.5 rounded hover:bg-white/10"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs font-mono px-2 flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-violet-400" />
            {dayLabel(from).dm} – {dayLabel(shiftDate(from, 6)).dm}
          </span>
          <button onClick={() => setFrom(shiftDate(from, 7))} className="p-1.5 rounded hover:bg-white/10"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>

      {!dssId && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Seleziona una fonte turni: i turni guida salvati dallo Scheduling Engine (Fucina → salva scenario turni guida) compaiono nel menu sopra.
        </div>
      )}

      {/* Tabellone */}
      <div className="rounded-xl border border-border/60 bg-card/60 overflow-auto">
        {boardQ.isLoading ? (
          <div className="p-10 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Carico il tabellone…
          </div>
        ) : !board || board.drivers.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground text-sm">
            Nessun operatore: genera gli operatori fittizi con il bottone in alto.
          </div>
        ) : (
          <table className="min-w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-background z-10">
              <tr>
                <th className="text-left px-3 py-2 border-b border-border/50 sticky left-0 bg-background min-w-44">Operatore</th>
                {board.days.map((day) => {
                  const { dow, dm } = dayLabel(day);
                  const uncovered = uncoveredByDay.get(day)?.length ?? 0;
                  return (
                    <th key={day} className="px-2 py-2 border-b border-border/50 text-center min-w-28">
                      <span className="block uppercase text-[10px] text-muted-foreground">{dow}</span>
                      <span className="block font-semibold">{dm}</span>
                      {dssId && (
                        <span className={`block text-[9px] font-mono ${uncovered > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                          {uncovered > 0 ? `${uncovered} scoperti` : "coperto"}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {board.drivers.map((drv) => (
                <tr key={drv.id} className="odd:bg-white/[0.02]">
                  <td className="px-3 py-1.5 border-b border-border/20 sticky left-0 bg-background">
                    <span className="font-medium">{drv.name}</span>
                    {drv.isFictitious && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300">fittizio</span>}
                    {drv.badge && <span className="block text-[9px] text-muted-foreground font-mono">{drv.badge}</span>}
                  </td>
                  {board.days.map((day) => {
                    const a = assignByCell.get(`${drv.id}|${day}`);
                    const duty = a ? dutyByCode.get(a.dutyCode) : undefined;
                    return (
                      <td key={day} className="px-1.5 py-1.5 border-b border-border/20 text-center align-middle">
                        {a ? (
                          <button
                            onClick={() => { if (confirm(`Rimuovere ${a.dutyCode} da ${drv.name}?`)) unassignMut.mutate(a.id); }}
                            title={duty ? `${a.dutyCode} · ${duty.start ?? ""}–${duty.end ?? ""} (click per rimuovere)` : a.dutyCode}
                            className="w-full px-1.5 py-1 rounded text-white text-[10px] font-bold leading-tight hover:opacity-80 transition-opacity"
                            style={{ backgroundColor: dutyColor(duty?.type ?? null) }}
                          >
                            {a.dutyCode}
                            {duty?.start && <span className="block font-normal opacity-90">{duty.start}–{duty.end}</span>}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              if (!dssId) { toast.info("Seleziona prima la fonte turni"); return; }
                              setPicker({ driverId: drv.id, driverName: drv.name, day });
                            }}
                            className="w-full h-8 rounded border border-dashed border-border/40 hover:border-violet-500/60 hover:bg-violet-500/5 transition-colors text-muted-foreground/30 hover:text-violet-400"
                            title="Assegna un turno"
                          >
                            +
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Legenda tipi turno */}
      {dssId && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {Object.entries(DUTY_TYPE_COLOR).map(([t, c]) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded" style={{ backgroundColor: c }} /> {t}
            </span>
          ))}
        </div>
      )}

      {/* ── Scheda turni scoperti del giorno ── */}
      {picker && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={() => setPicker(null)}>
          <div
            className="w-96 max-w-[92vw] h-full bg-background border-l border-border/60 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
              <Clock className="w-4 h-4 text-violet-400" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">Turni scoperti · {dayLabel(picker.day).dow} {dayLabel(picker.day).dm}</p>
                <p className="text-[11px] text-muted-foreground">Assegna a <b>{picker.driverName}</b></p>
              </div>
              <button onClick={() => setPicker(null)} className="p-1 rounded hover:bg-white/10 text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {(uncoveredByDay.get(picker.day) ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground p-3 text-center">
                  🎉 Tutti i turni del giorno sono coperti.
                </p>
              )}
              {(uncoveredByDay.get(picker.day) ?? []).map((d) => (
                <button
                  key={d.code}
                  disabled={assignMut.isPending}
                  onClick={() => assignMut.mutate({ driverId: picker.driverId, day: picker.day, dutyCode: d.code })}
                  className="w-full text-left px-3 py-2 rounded-lg border border-border/40 hover:border-violet-500/60 hover:bg-violet-500/5 transition-colors flex items-center gap-3 disabled:opacity-50"
                >
                  <span className="px-2 py-1 rounded text-white text-xs font-bold" style={{ backgroundColor: dutyColor(d.type) }}>
                    {d.code}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">{d.start ?? "?"} – {d.end ?? "?"}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {d.type ?? "turno"}{d.nastro ? ` · nastro ${d.nastro}` : ""}{d.work ? ` · lavoro ${d.work}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
