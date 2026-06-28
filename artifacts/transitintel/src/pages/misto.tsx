/**
 * Misto — Completamento / Turni Misti (3° processo di ottimizzazione).
 *
 * L'operatore sceglie un DSS TARGET (i turni dove incastrare) e una o più
 * SORGENTI da cui "spacchettare" turni/supplementi in corse loose. Vincolo:
 * stessa unità di validità (stesso giorno-tipo). Il backend arricchisce le
 * coordinate, lancia crew_misto (greedy con ri-cucitura + cambio vettura) e
 * salva un nuovo scenario misto NON distruttivo.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, CheckCircle2, Layers, Shuffle } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Source {
  dssId: string; name: string; scenarioName: string | null;
  dutyCount: number; validityUnitId: string | null; validityUnitName: string | null;
}
interface Duty { code: string; type: string | null; start: string | null; end: string | null; isSupplemento: boolean; residenzaName: string | null }
interface MistoResult { dssId: string; stats: Record<string, number> }

export default function MistoPage() {
  const [targetId, setTargetId] = useState<string>("");
  const [selDuties, setSelDuties] = useState<Record<string, Set<string>>>({}); // sourceDssId → dutyCodes
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MistoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourcesQ = useQuery({
    queryKey: ["misto-sources"],
    queryFn: () => apiFetch<{ sources: Source[] }>("/api/roster/duty-sources"),
  });
  const sources = sourcesQ.data?.sources ?? [];
  const target = sources.find((s) => s.dssId === targetId) ?? null;

  // Sorgenti candidate: stessa validità del target (esclude il target stesso)
  const candidates = useMemo(() => {
    if (!target) return [];
    return sources.filter((s) =>
      s.dssId !== target.dssId &&
      (!target.validityUnitId || s.validityUnitId === target.validityUnitId));
  }, [sources, target]);

  const toggleSource = (dssId: string, on: boolean) => {
    setSelDuties((prev) => {
      const next = { ...prev };
      if (on) next[dssId] = new Set();
      else delete next[dssId];
      return next;
    });
  };

  const run = async () => {
    if (!targetId) return;
    setRunning(true); setError(null); setResult(null);
    try {
      const srcArr = Object.entries(selDuties).map(([dssId, codes]) => ({
        dssId, dutyCodes: Array.from(codes), // vuoto = tutti i turni della sorgente
      }));
      const r = await apiFetch<MistoResult>("/api/driver-shifts/misto", {
        method: "POST",
        body: JSON.stringify({ targetDssId: targetId, sources: srcArr, name: name.trim() || undefined }),
      });
      setResult(r);
    } catch (e: any) { setError(e.message); }
    finally { setRunning(false); }
  };

  const nSources = Object.keys(selDuties).length;

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-200 p-5">
      <div className="flex items-center gap-2 mb-1">
        <Shuffle className="w-5 h-5 text-indigo-400" />
        <h1 className="text-base font-semibold">Completamento / Turni Misti</h1>
      </div>
      <p className="text-xs text-slate-500 mb-4 max-w-3xl">
        Spacchetta turni o supplementi venuti male e prova a incastrarli nei turni di un altro
        servizio (stessa validità). Le corse di categoria diversa comportano un cambio vettura in
        deposito; il turno che le assorbe diventa misto (normativa extraurbana). Non distruttivo.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* TARGET */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" /> Turni TARGET (dove incastrare)
          </div>
          <select
            value={targetId}
            onChange={(e) => { setTargetId(e.target.value); setSelDuties({}); setResult(null); }}
            className="w-full px-2 py-1.5 text-xs rounded bg-slate-950 border border-slate-700 text-slate-100"
          >
            <option value="">— scegli un DSS target —</option>
            {sources.map((s) => (
              <option key={s.dssId} value={s.dssId}>
                {s.name} · {s.dutyCount} turni{s.validityUnitName ? ` · ${s.validityUnitName}` : ""}
              </option>
            ))}
          </select>
          {target && (
            <p className="text-[10px] text-slate-500 mt-2">
              Validità: {target.validityUnitName ?? "—"}. Verranno mostrate come sorgenti solo i DSS con la stessa validità.
            </p>
          )}
        </div>

        {/* SORGENTI */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="text-xs font-semibold text-slate-300 mb-2">Sorgenti da spacchettare</div>
          {!target && <div className="text-[11px] text-slate-600">Scegli prima un target.</div>}
          {target && candidates.length === 0 && <div className="text-[11px] text-slate-600">Nessun altro DSS con la stessa validità.</div>}
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {candidates.map((s) => (
              <SourceRow
                key={s.dssId}
                source={s}
                selected={s.dssId in selDuties}
                selectedCodes={selDuties[s.dssId] ?? new Set()}
                onToggle={(on) => toggleSource(s.dssId, on)}
                onCodes={(codes) => setSelDuties((p) => ({ ...p, [s.dssId]: codes }))}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Azione */}
      <div className="mt-4 flex items-center gap-3">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Nome scenario misto (opzionale)"
          className="px-2 py-1.5 text-xs rounded bg-slate-950 border border-slate-700 text-slate-100 w-72"
        />
        <button
          onClick={run}
          disabled={running || !targetId || nSources === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40"
        >
          {running ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> In corso…</> : <><ArrowRight className="w-3.5 h-3.5" /> Lancia completamento</>}
        </button>
      </div>

      {error && <div className="mt-3 text-xs text-rose-400">{error}</div>}

      {result && (
        <div className="mt-4 rounded-lg border border-emerald-700/40 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-sm text-emerald-300 font-semibold mb-2">
            <CheckCircle2 className="w-4 h-4" /> Completamento eseguito
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="Corse assorbite" value={result.stats.insertedTotal} />
            <Stat label="Con cambio vettura" value={result.stats.insertedCrossCategory} />
            <Stat label="Turni misti" value={result.stats.shiftsMisto} />
            <Stat label="Scoperte residue" value={result.stats.remainingUncovered} />
          </div>
          <p className="text-[10px] text-slate-500 mt-2">
            Salvato come nuovo scenario misto (non distruttivo). Visibile nel Roster tra le fonti turni.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5">
      <div className="text-base font-semibold text-slate-100">{value ?? 0}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

function SourceRow({
  source, selected, selectedCodes, onToggle, onCodes,
}: {
  source: Source; selected: boolean; selectedCodes: Set<string>;
  onToggle: (on: boolean) => void; onCodes: (codes: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const dutiesQ = useQuery({
    queryKey: ["misto-duties", source.dssId],
    queryFn: () => apiFetch<{ duties: Duty[] }>(`/api/driver-shifts/dss/${source.dssId}/duties`),
    enabled: open,
  });
  const duties = dutiesQ.data?.duties ?? [];

  return (
    <div className="rounded border border-slate-800 bg-slate-950/40">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <input type="checkbox" className="accent-indigo-500" checked={selected} onChange={(e) => onToggle(e.target.checked)} />
        <button className="flex-1 text-left text-xs text-slate-200 truncate" onClick={() => { onToggle(!selected); }}>
          {source.name} <span className="text-slate-600">· {source.dutyCount} turni</span>
        </button>
        {selected && (
          <button className="text-[10px] text-indigo-300 hover:text-indigo-200" onClick={() => setOpen((v) => !v)}>
            {open ? "chiudi" : "scegli turni"}{selectedCodes.size ? ` (${selectedCodes.size})` : ""}
          </button>
        )}
      </div>
      {selected && open && (
        <div className="px-2 pb-2 space-y-1 max-h-40 overflow-y-auto border-t border-slate-800 pt-1.5">
          <div className="text-[10px] text-slate-600">Nessuna selezione = tutti i turni della sorgente.</div>
          {dutiesQ.isLoading && <div className="text-[10px] text-slate-500">Carico…</div>}
          {duties.map((d) => {
            const on = selectedCodes.has(d.code);
            return (
              <label key={d.code} className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox" className="accent-indigo-500" checked={on}
                  onChange={(e) => {
                    const next = new Set(selectedCodes);
                    if (e.target.checked) next.add(d.code); else next.delete(d.code);
                    onCodes(next);
                  }}
                />
                <span className="font-mono">{d.code}</span>
                <span className="text-slate-500">{d.type}{d.isSupplemento ? " · suppl." : ""} · {d.start}–{d.end}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
