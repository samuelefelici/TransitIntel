/**
 * CALENDARIO AZIENDALE — definizione semplice delle validità (albero 3 livelli).
 *
 * L'operatore imposta UNA VOLTA: periodi scolastici, periodo estivo, festività
 * extra (patrono). Il sistema classifica ogni giorno dell'anno:
 *   Scuole Aperte | Scuole Chiuse (Invernale/Estivo) | Festivo (Domenica/Rosso)
 *   + distinzione Feriale/Sabato.
 * L'anteprima annuale mostra le foglie risultanti: sono le candidate unità di
 * progettazione (poche per costruzione, mai una per data).
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CalendarRange, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Profile {
  schoolPeriods: Array<{ from: string; to: string }>;
  summerPeriod: { from: string; to: string } | null;
  extraHolidays: string[];
}
interface DayClass { date: string; weekday: number; level1: string; level2: string | null; label: string; key: string }
interface Classification {
  profile: Profile;
  days: DayClass[];
  summary: Array<{ key: string; label: string; count: number; weekdays: string[] }>;
}

const LEAF_COLOR: Record<string, string> = {
  "scuole_aperte/-/Feriale": "#10b981",
  "scuole_aperte/-/Sabato": "#34d399",
  "scuole_chiuse/invernale/Feriale": "#38bdf8",
  "scuole_chiuse/invernale/Sabato": "#7dd3fc",
  "scuole_chiuse/estivo/Feriale": "#f59e0b",
  "scuole_chiuse/estivo/Sabato": "#fbbf24",
  "festivo/domenica/-": "#a78bfa",
  "festivo/rosso/-": "#ef4444",
};

export default function CalendarProfilePage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  const year = new Date().getFullYear();
  const [draft, setDraft] = useState<Profile | null>(null);

  const classQ = useQuery({
    queryKey: ["ps", projectId, "day-classification", year],
    queryFn: () => apiFetch<Classification>(
      `/api/planning-studio/projects/${projectId}/day-classification?from=${year}-01-01&to=${year}-12-31`),
    enabled: !!projectId,
  });

  const profile: Profile = draft ?? classQ.data?.profile ?? { schoolPeriods: [], summerPeriod: null, extraHolidays: [] };
  const edit = (p: Profile) => setDraft(p);

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/api/planning-studio/projects/${projectId}/calendar-profile`, {
      method: "PUT", body: JSON.stringify(profile),
    }),
    onSuccess: () => {
      toast.success("Calendario aziendale salvato");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "day-classification"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dayByDate = useMemo(() => new Map((classQ.data?.days ?? []).map((d) => [d.date, d])), [classQ.data]);

  // griglia annuale: 12 righe (mesi) × 31 colonne
  const months = useMemo(() => Array.from({ length: 12 }, (_, m) => {
    const nDays = new Date(year, m + 1, 0).getDate();
    return {
      name: new Date(year, m, 1).toLocaleDateString("it-IT", { month: "short" }),
      days: Array.from({ length: nDays }, (_, i) =>
        `${year}-${String(m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`),
    };
  }), [year]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
        </Link>
        <CalendarRange className="w-5 h-5 text-sky-400" />
        <div className="flex-1">
          <h1 className="text-lg font-bold">Calendario Aziendale · {year}</h1>
          <p className="text-xs text-muted-foreground">
            Imposta periodi scolastici, estivo e festività: ogni giorno cade in una sola classe (le tue validità)
          </p>
        </div>
        <button
          onClick={() => saveMut.mutate()}
          disabled={!draft || saveMut.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-40 text-white text-sm font-medium"
        >
          {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salva
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Periodi scolastici */}
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <p className="text-xs font-semibold flex items-center justify-between">
            Periodi scolastici (scuole aperte)
            <button
              onClick={() => edit({ ...profile, schoolPeriods: [...profile.schoolPeriods, { from: `${year}-09-15`, to: `${year}-12-22` }] })}
              className="p-1 rounded hover:bg-white/10 text-emerald-400"
            ><Plus className="w-3.5 h-3.5" /></button>
          </p>
          {profile.schoolPeriods.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs">
              <input type="date" value={p.from}
                onChange={(e) => edit({ ...profile, schoolPeriods: profile.schoolPeriods.map((x, j) => j === i ? { ...x, from: e.target.value } : x) })}
                className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
              <span>→</span>
              <input type="date" value={p.to}
                onChange={(e) => edit({ ...profile, schoolPeriods: profile.schoolPeriods.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })}
                className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
              <button onClick={() => edit({ ...profile, schoolPeriods: profile.schoolPeriods.filter((_, j) => j !== i) })}
                className="p-1 rounded hover:bg-red-500/10 text-red-400"><Trash2 className="w-3 h-3" /></button>
            </div>
          ))}
          {profile.schoolPeriods.length === 0 && <p className="text-[11px] text-muted-foreground">Nessun periodo: tutto l'anno conta come "scuole chiuse".</p>}
        </div>

        {/* Periodo estivo */}
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <p className="text-xs font-semibold">Periodo estivo (ramo "scuole chiuse")</p>
          <div className="flex items-center gap-1.5 text-xs">
            <input type="date" value={profile.summerPeriod?.from ?? ""}
              onChange={(e) => edit({ ...profile, summerPeriod: { from: e.target.value, to: profile.summerPeriod?.to ?? `${year}-09-14` } })}
              className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
            <span>→</span>
            <input type="date" value={profile.summerPeriod?.to ?? ""}
              onChange={(e) => edit({ ...profile, summerPeriod: { from: profile.summerPeriod?.from ?? `${year}-06-15`, to: e.target.value } })}
              className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
          </div>
          <p className="text-[11px] text-muted-foreground">Fuori da questo intervallo, "scuole chiuse" = invernale (es. vacanze di Natale).</p>
        </div>

        {/* Festività extra */}
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <p className="text-xs font-semibold">Festività extra (oltre ai rossi nazionali)</p>
          <div className="flex flex-wrap gap-1.5">
            {profile.extraHolidays.map((h, i) => (
              <span key={i} className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/10 text-red-300 text-[11px] font-mono">
                {h}
                <button onClick={() => edit({ ...profile, extraHolidays: profile.extraHolidays.filter((_, j) => j !== i) })}>×</button>
              </span>
            ))}
          </div>
          <input
            placeholder="MM-DD (es. 05-04 patrono) + Invio"
            onKeyDown={(e) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (e.key === "Enter" && /^(\d{4}-)?\d{2}-\d{2}$/.test(v)) {
                edit({ ...profile, extraHolidays: [...profile.extraHolidays, v] });
                (e.target as HTMLInputElement).value = "";
              }
            }}
            className="w-full px-2 py-1 rounded bg-background border border-border/60 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">I rossi nazionali (incl. Pasqua/Pasquetta) sono automatici.</p>
        </div>
      </div>

      {/* Riepilogo foglie = candidate unità */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4">
        <p className="text-xs font-semibold mb-2">Classi risultanti ({classQ.data?.summary.length ?? 0}) — le tue candidate unità di progettazione</p>
        <div className="flex flex-wrap gap-2">
          {classQ.data?.summary.map((s) => (
            <span key={s.key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/40 text-xs">
              <span className="w-3 h-3 rounded" style={{ backgroundColor: LEAF_COLOR[s.key] ?? "#64748b" }} />
              <b>{s.label}</b>
              <span className="text-muted-foreground font-mono">{s.count} gg</span>
            </span>
          ))}
        </div>
      </div>

      {/* Anteprima annuale */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 overflow-x-auto">
        {classQ.isLoading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Classifico l'anno…</div>
        ) : (
          <table className="border-collapse">
            <tbody>
              {months.map((m) => (
                <tr key={m.name}>
                  <td className="pr-2 text-[10px] uppercase text-muted-foreground">{m.name}</td>
                  {m.days.map((date) => {
                    const d = dayByDate.get(date);
                    return (
                      <td key={date} className="p-px">
                        <div
                          title={`${date} · ${d?.label ?? ""}`}
                          className="w-4 h-4 rounded-[3px]"
                          style={{ backgroundColor: d ? (LEAF_COLOR[d.key] ?? "#64748b") : "#1e293b", opacity: draft ? 0.45 : 1 }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {draft && <p className="mt-2 text-[11px] text-amber-400">Modifiche non salvate: l'anteprima si aggiorna dopo "Salva".</p>}
      </div>
    </div>
  );
}
