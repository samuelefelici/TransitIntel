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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CalendarRange, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import ValiditySectionNav from "./ValiditySectionNav";

type PeriodKind = "estivo" | "invernale";
interface ClosedPeriod { from: string; to: string; label?: string; kind?: PeriodKind }
interface Profile {
  /** periodi di SCUOLE CHIUSE; vuoto = tutto l'anno scuole aperte.
   *  Ogni periodo porta il proprio tipo (estivo/invernale): così si possono
   *  inserire PIÙ periodi invernali (Natale, Pasqua, ponti…) e più estivi. */
  closedPeriods: ClosedPeriod[];
  /** @deprecated periodo estivo unico — solo per leggere i profili legacy */
  summerPeriod: { from: string; to: string } | null;
  extraHolidays: string[];
}

/** Tipo effettivo di un periodo: esplicito, oppure dedotto dal vecchio
 *  summerPeriod per i profili salvati prima della migrazione. */
function periodKind(p: ClosedPeriod, summer: { from: string; to: string } | null): PeriodKind {
  if (p.kind) return p.kind;
  if (summer && p.from <= summer.to && p.to >= summer.from) return "estivo"; // overlap col periodo estivo legacy
  return "invernale";
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
  "festivo/domenica_aperte/-": "#a78bfa",
  "festivo/domenica_chiuse/-": "#7c3aed",
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

  const profile: Profile = draft ?? classQ.data?.profile ?? { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
  const edit = (p: Profile) => setDraft(p);

  const saveMut = useMutation({
    mutationFn: () => {
      // Migrazione: ogni periodo viene salvato con il proprio `kind` esplicito
      // e il vecchio summerPeriod unico viene azzerato (ora è ridondante).
      const normalized: Profile = {
        closedPeriods: profile.closedPeriods.map((p) => ({
          from: p.from, to: p.to,
          ...(p.label && p.label.trim() ? { label: p.label.trim() } : {}),
          kind: periodKind(p, profile.summerPeriod),
        })),
        summerPeriod: null,
        extraHolidays: profile.extraHolidays,
      };
      return apiFetch<{
        ok: boolean;
        sync?: { categoryDates: number; tripCategoryUpserts: number; tripsWithCategories: number } | null;
        syncError?: string | null;
      }>(`/api/planning-studio/projects/${projectId}/calendar-profile`, {
        method: "PUT", body: JSON.stringify(normalized),
      });
    },
    onSuccess: (r) => {
      if (r?.sync) {
        toast.success("Calendario aziendale salvato", {
          description: `Categorie risincronizzate: ${r.sync.categoryDates} date classificate · ${r.sync.tripsWithCategories} corse aggiornate.`,
        });
      } else {
        toast.success("Calendario aziendale salvato", {
          description: r?.syncError ? `Attenzione: sync categorie non riuscita (${r.syncError})` : undefined,
        });
      }
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "day-classification"] });
      // il sync ha ricalcolato categorie-per-data e corsa→categoria: aggiorna
      // filtro/colonna Categorie in Corse, filtro categorie del TTD e liste
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps-validity-categories"] });
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
            Di default tutto è "scuole aperte": aggiungi solo i periodi di scuole chiuse (vacanze). Ogni giorno cade in una sola classe (le tue validità)
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

      <ValiditySectionNav projectId={projectId} active="calendar" />

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Periodi SCUOLE CHIUSE (vacanze) — il resto è scuole aperte.
            Ogni periodo ha il proprio tipo (estivo/invernale): puoi inserire
            più periodi invernali (Natale, Pasqua, ponti…) senza un blocco unico. */}
        <div className="lg:col-span-2 rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Periodi scuole chiuse (vacanze)</p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => edit({ ...profile, closedPeriods: [...profile.closedPeriods, { from: `${year}-06-08`, to: `${year}-09-14`, kind: "estivo", label: "Estivo" }] })}
                className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 text-[11px] font-medium"
                title="Aggiungi un periodo estivo di scuole chiuse"
              ><Plus className="w-3 h-3" /> Estivo</button>
              <button
                onClick={() => edit({ ...profile, closedPeriods: [...profile.closedPeriods, { from: `${year}-12-23`, to: `${year}-12-31`, kind: "invernale" }] })}
                className="flex items-center gap-1 px-2 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 text-[11px] font-medium"
                title="Aggiungi un periodo invernale di scuole chiuse (es. Natale, Pasqua)"
              ><Plus className="w-3 h-3" /> Invernale</button>
            </div>
          </div>
          {profile.closedPeriods.map((p, i) => {
            const kind = periodKind(p, profile.summerPeriod);
            const isSummer = kind === "estivo";
            return (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <select
                  value={kind}
                  onChange={(e) => edit({ ...profile, closedPeriods: profile.closedPeriods.map((x, j) => j === i ? { ...x, kind: e.target.value as PeriodKind } : x) })}
                  title="Sotto-ramo scuole chiuse: estivo o invernale"
                  className={`px-1.5 py-1 rounded border border-border/60 font-medium ${isSummer ? "bg-amber-500/15 text-amber-300" : "bg-sky-500/15 text-sky-300"}`}
                >
                  <option value="invernale">Invernale</option>
                  <option value="estivo">Estivo</option>
                </select>
                <input type="text" value={p.label ?? ""} placeholder="Nome (es. Natale, Pasqua…)"
                  onChange={(e) => edit({ ...profile, closedPeriods: profile.closedPeriods.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })}
                  title="Nome del periodo di scuole chiuse: identifica il periodo in matrice e nelle UDP"
                  className="w-28 px-2 py-1 rounded bg-background border border-border/60" />
                <input type="date" value={p.from}
                  onChange={(e) => edit({ ...profile, closedPeriods: profile.closedPeriods.map((x, j) => j === i ? { ...x, from: e.target.value } : x) })}
                  className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
                <span>→</span>
                <input type="date" value={p.to}
                  onChange={(e) => edit({ ...profile, closedPeriods: profile.closedPeriods.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })}
                  className="flex-1 px-2 py-1 rounded bg-background border border-border/60" />
                <button onClick={() => edit({ ...profile, closedPeriods: profile.closedPeriods.filter((_, j) => j !== i) })}
                  className="p-1 rounded hover:bg-red-500/10 text-red-400"><Trash2 className="w-3 h-3" /></button>
              </div>
            );
          })}
          {profile.closedPeriods.length === 0 && <p className="text-[11px] text-muted-foreground">Nessun periodo: tutto l'anno conta come "scuole aperte". Aggiungi le vacanze — estive (es. giugno–settembre) e invernali (Natale, Pasqua, ponti). Puoi inserirne quante ne servono.</p>}
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
            <thead>
              <tr>
                <th className="pr-2" />
                {Array.from({ length: 31 }, (_, i) => (
                  <th key={i} className="w-4 pb-1 text-[8px] font-normal text-muted-foreground tabular-nums">{i + 1}</th>
                ))}
              </tr>
            </thead>
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
