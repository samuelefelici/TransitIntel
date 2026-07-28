/**
 * CALENDARIO AZIENDALE — definizione semplice delle validità (albero 3 livelli).
 *
 * L'operatore imposta UNA VOLTA: periodi scolastici, periodo estivo, festività
 * extra (patrono). Il sistema classifica ogni giorno dell'anno:
 *   Scuole Aperte | Scuole Chiuse (Invernale/Estivo) | Festivo (Domenica/Rosso)
 *   + distinzione Feriale/Sabato.
 *
 * MULTI-ANNO: il selettore anno permette di redigere anche il calendario
 * dell'anno prossimo (il lavoro tipico d'autunno). L'ANTEPRIMA è LIVE: la
 * classificazione gira in locale (lib/day-classifier, copia client del modulo
 * server) sul profilo in bozza — niente più griglia opaca finché non salvi.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, CalendarRange, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { classifyRange, type CalendarProfile as AlgoProfile } from "@/lib/day-classifier";
import ValiditySectionNav from "./ValiditySectionNav";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import ConfirmDialog, { type ConfirmRequest } from "@/components/planning-studio/ConfirmDialog";

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
  const currentYear = new Date().getFullYear();
  // Anno visualizzato/editato: −1 … +2 (redigere il calendario dell'anno
  // prossimo è il caso d'uso principale in autunno).
  const [year, setYear] = useState(currentYear);
  const yearOptions = useMemo(
    () => Array.from({ length: 4 }, (_, i) => currentYear - 1 + i), [currentYear]);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [holidayError, setHolidayError] = useState<string | null>(null);

  const profileQ = useQuery({
    queryKey: ["ps", projectId, "calendar-profile"],
    queryFn: () => apiFetch<{ profile: Profile }>(
      `/api/planning-studio/projects/${projectId}/calendar-profile`),
    enabled: !!projectId,
  });

  const profile: Profile = draft ?? profileQ.data?.profile ?? { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
  const edit = (p: Profile) => setDraft(p);

  // ── Validazione periodi ──
  const invalidPeriods = useMemo(() => {
    const bad = new Set<number>();
    profile.closedPeriods.forEach((p, i) => {
      if (!p.from || !p.to || p.from > p.to) bad.add(i);
    });
    return bad;
  }, [profile.closedPeriods]);
  const overlappingPeriods = useMemo(() => {
    // Sovrapposizione fra periodi chiusi: non è un errore bloccante (vince il
    // primo che matcha), ma quasi sempre è una svista da segnalare.
    const overlap = new Set<number>();
    const ps = profile.closedPeriods;
    for (let i = 0; i < ps.length; i++) {
      if (invalidPeriods.has(i)) continue;
      for (let j = i + 1; j < ps.length; j++) {
        if (invalidPeriods.has(j)) continue;
        if (ps[i].from <= ps[j].to && ps[i].to >= ps[j].from) { overlap.add(i); overlap.add(j); }
      }
    }
    return overlap;
  }, [profile.closedPeriods, invalidPeriods]);
  const canSave = !!draft && invalidPeriods.size === 0;

  // ── ANTEPRIMA LIVE: classificazione client-side del profilo corrente ──
  const classification = useMemo(() => {
    const algoProfile: AlgoProfile = {
      closedPeriods: profile.closedPeriods.filter((_, i) => !invalidPeriods.has(i)),
      summerPeriod: profile.summerPeriod,
      extraHolidays: profile.extraHolidays,
    };
    return classifyRange(`${year}-01-01`, `${year}-12-31`, algoProfile);
  }, [profile, year, invalidPeriods]);
  const dayByDate = useMemo(
    () => new Map(classification.days.map((d) => [d.date, d])), [classification]);

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
      qc.invalidateQueries({ queryKey: ["ps", projectId, "calendar-profile"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "day-classification"] });
      // il sync ha ricalcolato categorie-per-data e corsa→categoria: aggiorna
      // filtro/colonna Categorie in Corse, filtro categorie del TTD e liste
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps-validity-categories"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // griglia annuale: 12 righe (mesi) × 31 colonne
  const months = useMemo(() => Array.from({ length: 12 }, (_, m) => {
    const nDays = new Date(year, m + 1, 0).getDate();
    return {
      name: new Date(year, m, 1).toLocaleDateString("it-IT", { month: "short" }),
      days: Array.from({ length: nDays }, (_, i) =>
        `${year}-${String(m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`),
    };
  }), [year]);

  const applyStandard = () => {
    // Calendario scolastico tipico italiano — base da aggiustare.
    // Le date esatte non devono combaciare con i tag delle corse:
    // la validità "Scuole Chiuse" delle corse copre TUTTI i periodi.
    const std: ClosedPeriod[] = [
      { from: `${year}-01-01`, to: `${year}-01-06`, kind: "invernale", label: "Epifania" },
      { from: `${year}-04-02`, to: `${year}-04-08`, kind: "invernale", label: "Pasqua" },
      { from: `${year}-06-08`, to: `${year}-09-14`, kind: "estivo", label: "Estivo" },
      { from: `${year}-12-23`, to: `${year}-12-31`, kind: "invernale", label: "Natale" },
    ];
    edit({ ...profile, closedPeriods: std });
    toast.info(`Precaricato un calendario scolastico standard per il ${year}: aggiusta le date e premi Salva`);
  };

  const addHoliday = (raw: string) => {
    const v = raw.trim();
    if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(v)) {
      setHolidayError('Formato non valido: usa "MM-DD" (ogni anno) o "AAAA-MM-GG" (solo quell\'anno).');
      return false;
    }
    if (profile.extraHolidays.includes(v)) {
      setHolidayError("Festività già presente.");
      return false;
    }
    setHolidayError(null);
    edit({ ...profile, extraHolidays: [...profile.extraHolidays, v] });
    return true;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-white/10"><ArrowLeft className="w-4 h-4" /></button>
        </Link>
        <CalendarRange className="w-5 h-5 text-sky-400" />
        <div className="flex-1">
          <h1 className="text-lg font-bold flex items-center gap-2">
            Calendario Aziendale
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              title="Anno visualizzato: i pulsanti Standard/Estivo/Invernale precaricano date di quest'anno"
              className="px-2 py-1 rounded-lg bg-background border border-border/60 text-sm font-semibold"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}{y === currentYear ? " (corrente)" : ""}</option>
              ))}
            </select>
          </h1>
          <p className="text-xs text-muted-foreground">
            Di default tutto è "scuole aperte": aggiungi solo i periodi di scuole chiuse (vacanze). Ogni giorno cade in una sola classe (le tue validità)
          </p>
        </div>
        <button
          onClick={() => saveMut.mutate()}
          disabled={!canSave || saveMut.isPending}
          title={!draft ? "Nessuna modifica da salvare" : invalidPeriods.size > 0 ? "Correggi i periodi con date non valide prima di salvare" : "Salva il calendario e risincronizza le categorie"}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-40 text-white text-sm font-medium"
        >
          {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salva
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <PsProjectNav projectId={projectId} active="calendar" />
        <ValiditySectionNav projectId={projectId} active="calendar" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Periodi SCUOLE CHIUSE (vacanze) — il resto è scuole aperte.
            Ogni periodo ha il proprio tipo (estivo/invernale): puoi inserire
            più periodi invernali (Natale, Pasqua, ponti…) senza un blocco unico. */}
        <div className="lg:col-span-2 rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Periodi scuole chiuse (vacanze)</p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  if (profile.closedPeriods.length === 0) { applyStandard(); return; }
                  setConfirmReq({
                    title: `Precaricare il calendario standard ${year}?`,
                    message: (
                      <>
                        <b>Sostituisce</b> i {profile.closedPeriods.length} periodi attuali con il
                        calendario scolastico tipico (Epifania, Pasqua, Estivo, Natale) del {year}.
                        Le festività extra restano invariate.
                      </>
                    ),
                    confirmLabel: "Sostituisci",
                    onConfirm: () => { applyStandard(); },
                  });
                }}
                className="flex items-center gap-1 px-2 py-1 rounded bg-fuchsia-500/15 hover:bg-fuchsia-500/25 text-fuchsia-300 text-[11px] font-medium"
                title="Precarica un calendario scolastico tipico (Estivo, Natale, Pasqua, Epifania) da modificare"
              ><CalendarRange className="w-3 h-3" /> Standard</button>
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
            const invalid = invalidPeriods.has(i);
            const overlaps = overlappingPeriods.has(i);
            return (
              <div key={i}>
                <div className="flex items-center gap-1.5 text-xs">
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
                    className={`flex-1 px-2 py-1 rounded bg-background border ${invalid ? "border-red-500" : "border-border/60"}`} />
                  <span>→</span>
                  <input type="date" value={p.to}
                    onChange={(e) => edit({ ...profile, closedPeriods: profile.closedPeriods.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })}
                    className={`flex-1 px-2 py-1 rounded bg-background border ${invalid ? "border-red-500" : "border-border/60"}`} />
                  <button onClick={() => edit({ ...profile, closedPeriods: profile.closedPeriods.filter((_, j) => j !== i) })}
                    className="p-1 rounded hover:bg-red-500/10 text-red-400"><Trash2 className="w-3 h-3" /></button>
                </div>
                {invalid && (
                  <p className="mt-0.5 ml-1 text-[11px] text-red-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> La data di inizio deve precedere (o uguagliare) la fine.
                  </p>
                )}
                {!invalid && overlaps && (
                  <p className="mt-0.5 ml-1 text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Si sovrappone a un altro periodo: per le date in comune vale il primo dell'elenco.
                  </p>
                )}
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
            onChange={() => { if (holidayError) setHolidayError(null); }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const input = e.target as HTMLInputElement;
              if (addHoliday(input.value)) input.value = "";
            }}
            className={`w-full px-2 py-1 rounded bg-background border text-xs ${holidayError ? "border-red-500" : "border-border/60"}`}
          />
          {holidayError
            ? <p className="text-[11px] text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {holidayError}</p>
            : <p className="text-[11px] text-muted-foreground">I rossi nazionali (incl. Pasqua/Pasquetta) sono automatici.</p>}
        </div>
      </div>

      {/* Riepilogo foglie = candidate unità (LIVE sul profilo corrente) */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4">
        <p className="text-xs font-semibold mb-2">
          Classi risultanti nel {year} ({classification.summary.length}) — le tue candidate unità di progettazione
          {draft && <span className="ml-2 text-amber-400 font-normal">anteprima delle modifiche non salvate</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          {classification.summary.map((s) => (
            <span key={s.key} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/40 text-xs">
              <span className="w-3 h-3 rounded" style={{ backgroundColor: LEAF_COLOR[s.key] ?? "#64748b" }} />
              <b>{s.label}</b>
              <span className="text-muted-foreground font-mono">{s.count} gg</span>
            </span>
          ))}
        </div>
      </div>

      {/* Anteprima annuale — LIVE: si aggiorna a ogni modifica, salvata o no */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-4 overflow-x-auto">
        {profileQ.isLoading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico il profilo…</div>
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
                          style={{ backgroundColor: d ? (LEAF_COLOR[d.key] ?? "#64748b") : "#1e293b" }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {draft && <p className="mt-2 text-[11px] text-amber-400">Anteprima live delle modifiche non salvate — premi "Salva" per applicarle alle categorie delle corse.</p>}
      </div>

      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  );
}
