/**
 * Rotazioni Riposi — creazione (griglia tipo Excel + assistente CP-SAT) ed elenco.
 *
 * Una rotazione riposi è un ciclo di N settimane × 7 giorni. L'utente costruisce
 * la tabella a mano (clic su una cella per mettere/togliere il riposo) oppure usa
 * l'assistente automatico (OR-Tools) che, dati domanda e vincoli, propone i
 * pattern migliori; scegliendone uno la griglia si compila da sola.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Save, Loader2, Plus, Minus, Wand2, Trash2, CalendarDays, ChevronRight, Users, Check } from "lucide-react";
import { apiFetch } from "@/lib/api";

const GIORNI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
type Grid = (string | null)[][];

export interface Rotazione {
  id: string; name: string; weeks: number; pattern: Grid; meta: any; createdAt: string;
}

const TEXT = "px-2 py-1.5 text-sm rounded-md bg-slate-950 border border-slate-700 text-slate-100 focus:border-violet-500 focus:outline-none";
const LBL = "block text-[11px] font-medium text-slate-400 mb-0.5";

function emptyGrid(weeks: number): Grid {
  return Array.from({ length: weeks }, () => Array.from({ length: 7 }, () => null));
}

/* ══════════════════ Griglia editabile ══════════════════ */
function RiposoGrid({ grid, code, onToggle }: { grid: Grid; code: string; onToggle: (w: number, d: number) => void }) {
  return (
    <div className="overflow-auto border border-slate-800 rounded-lg">
      <table className="border-collapse text-sm w-full">
        <thead>
          <tr className="bg-slate-900/60">
            <th className="px-2 py-1 text-[10px] text-slate-500 sticky left-0 bg-slate-900/60 border-b border-slate-800">Sett.</th>
            {GIORNI.map((g, i) => (
              <th key={g} className={`px-2 py-1 text-[11px] font-semibold border-b border-slate-800 ${i === 6 ? "text-violet-300" : "text-slate-300"}`}>{g}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week, w) => (
            <tr key={w} className="odd:bg-white/[0.02]">
              <td className="px-2 py-1 text-[11px] font-mono text-slate-500 sticky left-0 bg-slate-950 border-b border-slate-800/50 text-center">{w + 1}</td>
              {week.map((cell, d) => (
                <td key={d} className="border-b border-l border-slate-800/40 p-0.5 text-center">
                  <button
                    onClick={() => onToggle(w, d)}
                    title={cell ? `${cell} — clic per togliere` : `clic per mettere ${code}`}
                    className={`w-9 h-8 rounded font-bold text-[12px] transition-colors ${
                      cell
                        ? (cell === "R" ? "bg-blue-500/25 text-blue-300 border border-blue-500/40" : "bg-emerald-500/25 text-emerald-300 border border-emerald-500/40")
                        : "text-slate-700 hover:bg-slate-800/60"
                    }`}
                  >
                    {cell ?? "·"}
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ══════════════════ Dialog CREAZIONE ══════════════════ */
export function RotazioneRiposiCreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [code, setCode] = useState("R");
  const [grid, setGrid] = useState<Grid>(() => emptyGrid(4));
  const [assistOpen, setAssistOpen] = useState(false);
  const weeks = grid.length;

  const setWeeks = (n: number) => {
    const target = Math.max(1, Math.min(60, n));
    setGrid((g) => {
      if (target === g.length) return g;
      if (target < g.length) return g.slice(0, target);
      return [...g, ...Array.from({ length: target - g.length }, () => Array.from({ length: 7 }, () => null))];
    });
  };
  const toggle = (w: number, d: number) =>
    setGrid((g) => g.map((week, wi) => wi !== w ? week : week.map((c, di) => di !== d ? c : (c ? null : code))));

  const saveMut = useMutation({
    mutationFn: () => apiFetch<Rotazione>("/api/roster/rotazioni-riposi", {
      method: "POST", body: JSON.stringify({ name, pattern: grid, meta: assistMeta }),
    }),
    onSuccess: () => {
      toast.success("Rotazione riposi salvata");
      qc.invalidateQueries({ queryKey: ["roster", "rotazioni-riposi"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [assistMeta, setAssistMeta] = useState<any>(null);
  const restCount = useMemo(() => grid.reduce((s, w) => s + w.filter(Boolean).length, 0), [grid]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><CalendarDays className="w-4 h-4 text-violet-400" /> Nuova rotazione riposi</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-[12px] text-slate-400">
            Il ciclo si chiude dopo <b>{weeks}</b> settiman{weeks === 1 ? "a" : "e"} e ricomincia. Ogni conducente parte da
            una riga diversa e avanza di una settimana alla volta. Clicca una cella per mettere/togliere il riposo.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <label className="block flex-1 min-w-[200px]"><span className={LBL}>Nome rotazione</span>
              <input className={`${TEXT} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Rotazione Conerobus 4 settimane" />
            </label>
            <label className="block"><span className={LBL}>Settimane (righe)</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setWeeks(weeks - 1)} className="p-1.5 rounded bg-slate-800 hover:bg-slate-700"><Minus className="w-3.5 h-3.5" /></button>
                <input type="number" className={`${TEXT} w-16 text-center`} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 1)} />
                <button onClick={() => setWeeks(weeks + 1)} className="p-1.5 rounded bg-slate-800 hover:bg-slate-700"><Plus className="w-3.5 h-3.5" /></button>
              </div>
            </label>
            <label className="block"><span className={LBL}>Codice riposo</span>
              <input className={`${TEXT} w-24`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8) || "R")} />
            </label>
            <span className="text-[11px] text-slate-500 pb-1.5">{restCount} riposi nel ciclo</span>
          </div>

          <RiposoGrid grid={grid} code={code} onToggle={toggle} />

          {/* Assistente CP-SAT */}
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.04]">
            <button onClick={() => setAssistOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
              <Wand2 className="w-4 h-4 text-violet-300" />
              <span className="text-xs font-semibold text-violet-200">Assistente automatico (calcolo ottimo)</span>
              <span className="text-[10px] text-slate-500">— se è difficile costruirla a mano, dai domanda e vincoli e scegli fra i pattern proposti</span>
              <ChevronRight className={`w-4 h-4 ml-auto text-slate-500 transition-transform ${assistOpen ? "rotate-90" : ""}`} />
            </button>
            {assistOpen && (
              <AssistantPanel onPick={(pattern, meta) => {
                setGrid(pattern.map((row) => row.map((v) => (v ? code : null))));
                setAssistMeta(meta);
                toast.success(`Pattern caricato: ${pattern.length} settimane`);
              }} />
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
          <button onClick={() => saveMut.mutate()} disabled={!name.trim() || saveMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva rotazione
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Pannello assistente (OR-Tools) ─── */
interface SolveResult {
  N: number; K: number; T: number; pattern: number[][];
  riposi_anno: number; max_extra: number; total_extra: number; tot_autisti: number;
  dom_domenica_eff: number; delta_riposi: number;
}
function AssistantPanel({ onPick }: { onPick: (pattern: number[][], meta: any) => void }) {
  const [p, setP] = useState({
    domanda_feriali: 51, domanda_domenica: 15, mode: "forza" as "forza" | "pct",
    forza_feriale_reale: 66, riserva_domenica_pct: 25,
    riposi_anno_target: 54, tol_riposi: 1, max_consec: 6, balance_weekday: true,
    n_min: 11, n_max: 56, k_min: 1, k_max: 4, timeout_per_attempt: 4, top_n: 12,
  });
  const set = (k: keyof typeof p, v: any) => setP((s) => ({ ...s, [k]: v }));
  const [results, setResults] = useState<SolveResult[]>([]);

  const solveMut = useMutation({
    mutationFn: () => apiFetch<{ results: SolveResult[]; count: number }>("/api/roster/rotazioni-riposi/solve", {
      method: "POST", body: JSON.stringify(p),
    }),
    onSuccess: (r) => {
      setResults(r.results ?? []);
      if (!r.results?.length) toast.info("Nessuna configurazione fattibile: allarga il range o le tolleranze");
      else toast.success(`${r.count} configurazioni trovate`);
    },
    onError: (e: Error) => toast.error("Calcolo fallito", { description: e.message }),
  });

  const numF = (k: keyof typeof p, label: string) => (
    <label className="block"><span className={LBL}>{label}</span>
      <input type="number" className={`${TEXT} w-full`} value={p[k] as number} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  );

  return (
    <div className="border-t border-violet-500/20 p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {numF("domanda_feriali", "Turni feriali")}
        {numF("domanda_domenica", "Turni domenicali")}
        <label className="block"><span className={LBL}>Buffer domenica</span>
          <select className={`${TEXT} w-full`} value={p.mode} onChange={(e) => set("mode", e.target.value)}>
            <option value="forza">Forza feriale reale</option>
            <option value="pct">Percentuale</option>
          </select>
        </label>
        {p.mode === "forza" ? numF("forza_feriale_reale", "Forza feriale reale") : numF("riserva_domenica_pct", "Riserva domenica %")}
        {numF("riposi_anno_target", "Riposi/anno target")}
        {numF("tol_riposi", "Tolleranza riposi")}
        {numF("max_consec", "Max gg consecutivi")}
        <label className="flex items-center gap-1.5 text-xs text-slate-300 pt-5">
          <input type="checkbox" checked={p.balance_weekday} onChange={(e) => set("balance_weekday", e.target.checked)} className="accent-violet-500" /> Bilancia Lun–Sab
        </label>
        {numF("n_min", "N min")}{numF("n_max", "N max")}
        {numF("k_min", "K min")}{numF("k_max", "K max")}
      </div>
      <button onClick={() => solveMut.mutate()} disabled={solveMut.isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-500 disabled:opacity-50">
        {solveMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />} Calcola rotazioni ottime
      </button>

      {results.length > 0 && (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-950 text-slate-400">
              <tr>
                <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5">N×K</th><th className="px-2 py-1.5">Driver</th>
                <th className="px-2 py-1.5">Riposi/anno</th><th className="px-2 py-1.5">Picco ecc.</th><th className="px-2 py-1.5">Tot ecc.</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className={`border-t border-slate-800 hover:bg-slate-800/40 ${i === 0 ? "bg-emerald-500/10" : ""}`}>
                  <td className="px-2 py-1 text-center">{i + 1}{i === 0 && <span className="ml-1 text-[9px] text-emerald-400">★</span>}</td>
                  <td className="px-2 py-1 text-center font-mono">{r.N}×{r.K}</td>
                  <td className="px-2 py-1 text-center">{r.tot_autisti}</td>
                  <td className="px-2 py-1 text-center">{r.riposi_anno.toFixed(2)}</td>
                  <td className="px-2 py-1 text-center">{r.max_extra}</td>
                  <td className="px-2 py-1 text-center">{r.total_extra}</td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => onPick(r.pattern, { source: "cpsat", N: r.N, K: r.K, riposi_anno: r.riposi_anno, max_extra: r.max_extra, total_extra: r.total_extra, tot_autisti: r.tot_autisti })}
                      className="px-2 py-0.5 rounded bg-violet-600 text-white text-[10px] hover:bg-violet-500">Usa</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-500 px-2 py-1">★ = più bilanciata · «Usa» carica il pattern nella griglia sopra (poi puoi modificarlo).</p>
        </div>
      )}
    </div>
  );
}

/* ══════════════════ Dialog ELENCO ══════════════════ */
export function RotazioniRiposiListDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ["roster", "rotazioni-riposi"],
    queryFn: () => apiFetch<{ rotazioni: Rotazione[] }>("/api/roster/rotazioni-riposi").then((r) => r.rotazioni),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/roster/rotazioni-riposi/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Rotazione eliminata"); qc.invalidateQueries({ queryKey: ["roster", "rotazioni-riposi"] }); },
  });
  const rot = listQ.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><CalendarDays className="w-4 h-4 text-violet-400" /> Elenco rotazioni riposi</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-3">
          {listQ.isLoading ? (
            <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico…</div>
          ) : rot.length === 0 ? (
            <div className="text-center text-slate-500 text-sm py-10">Nessuna rotazione salvata.</div>
          ) : rot.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-sm">{r.name}</span>
                <span className="text-[11px] text-slate-500">{r.weeks} settimane · {r.pattern.reduce((s, w) => s + w.filter(Boolean).length, 0)} riposi</span>
                {r.meta?.source === "cpsat" && <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">CP-SAT {r.meta.N}×{r.meta.K}</span>}
                <button onClick={() => { if (confirm(`Eliminare "${r.name}"?`)) delMut.mutate(r.id); }} className="ml-auto p-1 rounded text-slate-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <MiniGrid grid={r.pattern} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MiniGrid({ grid, highlight }: { grid: Grid; highlight?: number }) {
  return (
    <div className="overflow-auto">
      <table className="border-collapse text-[10px]">
        <thead><tr>
          <th className="px-1 text-slate-600" />
          {GIORNI.map((g, i) => <th key={g} className={`px-1 py-0.5 ${i === 6 ? "text-violet-400" : "text-slate-500"}`}>{g}</th>)}
        </tr></thead>
        <tbody>
          {grid.map((week, w) => (
            <tr key={w} className={highlight === w ? "bg-violet-500/15" : ""}>
              <td className={`px-1 font-mono ${highlight === w ? "text-violet-300 font-bold" : "text-slate-600"}`}>{w + 1}{highlight === w && " ◄"}</td>
              {week.map((c, d) => (
                <td key={d} className="px-0.5 py-0.5">
                  <span className={`inline-flex w-6 h-5 items-center justify-center rounded text-[9px] font-bold ${
                    c ? (c === "R" ? "bg-blue-500/25 text-blue-300" : "bg-emerald-500/25 text-emerald-300") : "text-slate-800"
                  }`}>{c ?? "·"}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ══════════════════ Dialog ASSEGNA ROTAZIONI (scaglioni) ══════════════════ */
interface PickerDriver {
  id: string; name: string; cognome: string | null; nome: string | null;
  badge: string | null; residenzaServizio: string | null; categoria: string | null;
}
const restDays = (week: (string | null)[]) => week.map((c, i) => c ? GIORNI[i] : null).filter(Boolean).join(" ");

export function AssegnaRotazioniDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const rotQ = useQuery({
    queryKey: ["roster", "rotazioni-riposi"],
    queryFn: () => apiFetch<{ rotazioni: Rotazione[] }>("/api/roster/rotazioni-riposi").then((r) => r.rotazioni),
  });
  const drvQ = useQuery({
    queryKey: ["roster", "drivers"],
    queryFn: () => apiFetch<{ drivers: PickerDriver[] }>("/api/roster/drivers").then((r) => r.drivers),
  });
  const rotazioni = rotQ.data ?? [];
  const drivers = drvQ.data ?? [];
  const [rotId, setRotId] = useState<string>("");
  const rot = rotazioni.find((r) => r.id === rotId) ?? null;

  // assign: driverId → weekIndex (scaglione). Caricato dal server, editabile localmente.
  const [assign, setAssign] = useState<Record<string, number>>({});
  const asgQ = useQuery({
    enabled: !!rotId,
    queryKey: ["roster", "assegnazioni", rotId],
    queryFn: () => apiFetch<{ assegnazioni: Array<{ weekIndex: number; driverId: string }> }>(`/api/roster/rotazioni-riposi/${rotId}/assegnazioni`).then((r) => r.assegnazioni),
  });
  // sincronizza lo stato locale quando cambia rotazione / arrivano i dati
  const loadedKey = useRef<string>("");
  useEffect(() => {
    if (!rotId || !asgQ.data) return;
    const key = `${rotId}:${asgQ.dataUpdatedAt}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    const m: Record<string, number> = {};
    for (const a of asgQ.data) m[a.driverId] = a.weekIndex;
    setAssign(m);
  }, [rotId, asgQ.data, asgQ.dataUpdatedAt]);

  const [pickerWeek, setPickerWeek] = useState<number | null>(null);

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/api/roster/rotazioni-riposi/${rotId}/assegnazioni`, {
      method: "PUT",
      body: JSON.stringify({ assignments: Object.entries(assign).map(([driverId, weekIndex]) => ({ driverId, weekIndex })) }),
    }),
    onSuccess: () => {
      toast.success("Assegnazioni salvate — la cadenza compare nei dati di ogni conducente");
      qc.invalidateQueries({ queryKey: ["roster", "assegnazioni", rotId] });
      qc.invalidateQueries({ queryKey: ["roster", "cadenze"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const assignedCount = Object.keys(assign).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><Users className="w-4 h-4 text-violet-400" /> Assegna rotazioni — scaglioni</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block flex-1 min-w-[240px]"><span className={LBL}>Rotazione riposi</span>
              <select className={`${TEXT} w-full`} value={rotId} onChange={(e) => { setRotId(e.target.value); setAssign({}); loadedKey.current = ""; }}>
                <option value="">— scegli una rotazione —</option>
                {rotazioni.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.weeks} sett.</option>)}
              </select>
            </label>
            {rot && <span className="text-[11px] text-slate-500 pb-1.5">{assignedCount} conducenti assegnati su {drivers.length}</span>}
          </div>

          {!rot ? (
            <div className="text-center text-slate-500 text-sm py-10">
              Scegli una rotazione. Poi, per ogni <b>settimana</b> (scaglione), aggiungi il gruppo di conducenti che parte da quella riga.
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[12px] text-slate-400">
                Ogni riga è uno <b>scaglione</b>: i conducenti aggiunti partono da quella settimana del ciclo e avanzano di una
                settimana alla volta. Un conducente può stare in un solo scaglione.
              </p>
              {rot.pattern.map((week, w) => {
                const members = Object.entries(assign).filter(([, wi]) => wi === w).map(([id]) => id);
                return (
                  <div key={w} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-500/20 text-violet-300 text-xs font-bold">{w + 1}</span>
                      <span className="text-sm font-semibold">Scaglione {w + 1}</span>
                      <span className="text-[11px] text-slate-500">riposi: {restDays(week) || "—"}</span>
                      <span className="text-[11px] text-slate-500">· {members.length} conducenti</span>
                      <button onClick={() => setPickerWeek(w)}
                        className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-violet-600 text-white text-xs hover:bg-violet-500">
                        <Plus className="w-3.5 h-3.5" /> Aggiungi
                      </button>
                    </div>
                    {members.length === 0 ? (
                      <div className="text-[11px] text-slate-600 italic">Nessun conducente in questo scaglione.</div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {members.map((id) => {
                          const d = driverById.get(id);
                          return (
                            <span key={id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-xs">
                              <span className="font-medium">{d?.name ?? id.slice(0, 8)}</span>
                              {d?.residenzaServizio && <span className="text-[10px] text-slate-500">{d.residenzaServizio}</span>}
                              <button onClick={() => setAssign((a) => { const n = { ...a }; delete n[id]; return n; })}
                                className="p-0.5 rounded-full text-slate-500 hover:text-rose-400 hover:bg-slate-700"><X className="w-3 h-3" /></button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Chiudi</button>
          <button onClick={() => saveMut.mutate()} disabled={!rot || saveMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva assegnazioni
          </button>
        </div>
      </div>

      {pickerWeek !== null && rot && (
        <DriverPicker
          drivers={drivers}
          assign={assign}
          targetWeek={pickerWeek}
          onClose={() => setPickerWeek(null)}
          onConfirm={(ids) => {
            setAssign((a) => { const n = { ...a }; for (const id of ids) n[id] = pickerWeek; return n; });
            setPickerWeek(null);
          }}
        />
      )}
    </div>
  );
}

/* ─── Selettore conducenti (filtrabile per deposito) ─── */
function DriverPicker({ drivers, assign, targetWeek, onClose, onConfirm }: {
  drivers: PickerDriver[]; assign: Record<string, number>; targetWeek: number;
  onClose: () => void; onConfirm: (ids: string[]) => void;
}) {
  const depots = useMemo(() => [...new Set(drivers.map((d) => d.residenzaServizio).filter(Boolean))].sort() as string[], [drivers]);
  const [depot, setDepot] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const filtered = drivers.filter((d) => {
    if (depot && d.residenzaServizio !== depot) return false;
    if (q && !`${d.name} ${d.badge ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allVisible = () => setSel((s) => { const n = new Set(s); filtered.forEach((d) => n.add(d.id)); return n; });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col text-slate-100" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold">Aggiungi conducenti allo scaglione {targetWeek + 1}</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-end gap-2">
          <label className="block"><span className={LBL}>Deposito</span>
            <select className={`${TEXT} w-40`} value={depot} onChange={(e) => setDepot(e.target.value)}>
              <option value="">Tutti i depositi</option>
              {depots.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="block flex-1 min-w-[140px]"><span className={LBL}>Cerca</span>
            <input className={`${TEXT} w-full`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="cognome, matricola…" />
          </label>
          <button onClick={allVisible} className="px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">Seleziona tutti</button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="text-center text-slate-600 text-sm py-8">Nessun conducente.</div>
          ) : filtered.map((d) => {
            const cur = assign[d.id];
            const inThis = cur === targetWeek;
            const inOther = cur != null && cur !== targetWeek;
            const on = sel.has(d.id);
            return (
              <button key={d.id} onClick={() => toggle(d.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left text-xs ${
                  on ? "border-violet-500 bg-violet-500/10" : "border-slate-800 hover:bg-slate-800/50"
                }`}>
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? "bg-violet-500 border-violet-500" : "border-slate-600"}`}>
                  {on && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="font-medium flex-1 min-w-0 truncate">{d.name}</span>
                {d.categoria && <span className="text-[10px] text-slate-500">{d.categoria}</span>}
                {d.residenzaServizio && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{d.residenzaServizio}</span>}
                {inThis && <span className="text-[10px] text-emerald-400">già qui</span>}
                {inOther && <span className="text-[10px] text-amber-400">scagl. {cur + 1} → sposta</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800">
          <span className="text-[11px] text-slate-500">{sel.size} selezionati · {filtered.length} mostrati</span>
          <button onClick={() => onConfirm([...sel])} disabled={sel.size === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
            <Plus className="w-4 h-4" /> Aggiungi allo scaglione {targetWeek + 1}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ Dialog ALGORITMO: Assegna cadenze → Riposi ══════════════════ */
export function GeneraRiposiDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const rotQ = useQuery({
    queryKey: ["roster", "rotazioni-riposi"],
    queryFn: () => apiFetch<{ rotazioni: Rotazione[] }>("/api/roster/rotazioni-riposi").then((r) => r.rotazioni),
  });
  const drvQ = useQuery({
    queryKey: ["roster", "drivers"],
    queryFn: () => apiFetch<{ drivers: PickerDriver[] }>("/api/roster/drivers").then((r) => r.drivers),
  });
  const rotazioni = rotQ.data ?? [];
  const drivers = drvQ.data ?? [];
  const depots = useMemo(() => [...new Set(drivers.map((d) => d.residenzaServizio).filter(Boolean))].sort() as string[], [drivers]);
  const categorie = useMemo(() => [...new Set(drivers.map((d) => d.categoria).filter(Boolean))].sort() as string[], [drivers]);

  const [rotId, setRotId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [categoria, setCategoria] = useState("");
  const [deposito, setDeposito] = useState("");
  const [result, setResult] = useState<{ drivers: number; created: number; cleared: number } | null>(null);

  const genMut = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; drivers: number; created: number; cleared: number }>(
      `/api/roster/rotazioni-riposi/${rotId}/genera-riposi`,
      { method: "POST", body: JSON.stringify({ startDate, categoria, deposito, days: 365 }) },
    ),
    onSuccess: (r) => {
      setResult({ drivers: r.drivers, created: r.created, cleared: r.cleared });
      toast.success(`Riposi caricati: ${r.created} voci su ${r.drivers} conducenti`);
      qc.invalidateQueries({ queryKey: ["roster", "board"] });
    },
    onError: (e: Error) => toast.error("Generazione fallita", { description: e.message }),
  });

  const canRun = !!rotId && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && !genMut.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><Wand2 className="w-4 h-4 text-violet-400" /> Assegna cadenze → Riposi</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-[12px] text-slate-400">
            Carica automaticamente i <b>riposi</b> dei conducenti assegnati alla rotazione sul tabellone, per un anno intero a
            partire dalla data scelta. Rieseguibile: rigenera in modo idempotente (gestisce nuovi conducenti, rimozioni,
            cambi di scaglione).
          </p>
          <label className="block"><span className={LBL}>Rotazione</span>
            <select className={`${TEXT} w-full`} value={rotId} onChange={(e) => { setRotId(e.target.value); setResult(null); }}>
              <option value="">— scegli una rotazione —</option>
              {rotazioni.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.weeks} sett.</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={LBL}>Data di inizio</span>
              <input type="date" className={`${TEXT} w-full`} value={startDate} onChange={(e) => { setStartDate(e.target.value); setResult(null); }} />
            </label>
            <label className="block"><span className={LBL}>Categoria</span>
              <select className={`${TEXT} w-full`} value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Tutte le categorie</option>
                {categorie.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block"><span className={LBL}>Deposito</span>
              <select className={`${TEXT} w-full`} value={deposito} onChange={(e) => setDeposito(e.target.value)}>
                <option value="">Tutti i depositi</option>
                {depots.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>
          <p className="text-[11px] text-slate-500">
            Il lunedì della settimana d'inizio allinea il ciclo (i riposi partono comunque dalla data scelta). I conducenti
            senza scaglione nella rotazione vengono ignorati.
          </p>

          {result && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2.5 text-xs space-y-0.5">
              <div className="font-semibold text-emerald-300">Riposi generati ✓</div>
              <div className="text-slate-300">{result.created} voci di riposo su <b>{result.drivers}</b> conducenti · {result.cleared} voci precedenti riconciliate.</div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Chiudi</button>
          <button onClick={() => genMut.mutate()} disabled={!canRun}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
            {genMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Carica riposi (anno)
          </button>
        </div>
      </div>
    </div>
  );
}
