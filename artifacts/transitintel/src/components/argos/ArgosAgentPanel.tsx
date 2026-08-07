/**
 * Argos L2 — modalità AGENTE: pianificazione orientata a un obiettivo.
 *
 * A differenza della chat (che risponde a una domanda), qui dai ad Argos un
 * OBIETTIVO sul progetto ("migliora la copertura domenicale di Jesi") e lui:
 *   1. indaga da solo con i tool di sola-lettura (copertura, coincidenze, orari);
 *   2. produce un PIANO = pacchetto di proposte concrete, motivate e con impatto;
 *   3. le registra perché tu le riveda (accetta/rifiuta). Resta sola-proposta:
 *      nessuna modifica automatica ai dati del progetto.
 *
 * Tutto passa dal proxy `/api/ai/argos/agent/*` (stesso dominio, stessa auth).
 */
import React from "react";
import {
  Target, Loader2, Check, X, ChevronDown, ChevronRight, History,
  AlertTriangle, Sparkles, TrainFront, Clock, Gauge,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

type Proposal = {
  id: number;
  kind: string;
  title: string;
  line: string | null;
  hub: string | null;
  detail: string;
  rationale: string;
  impact: string;
  day_type: string | null;
  confidence: string;
  priority: string;
  status: string;
};

type Step = { tool: string; args: Record<string, any> };

type Run = {
  id: number;
  objective: string;
  status: string;
  summary: string;
  diagnosis: string;
  steps: Step[];
  error?: string | null;
  tokens: number;
  created_at: string;
  proposals?: Proposal[];
  proposals_count?: number;
  proposals_open?: number;
};

const SUGGESTED: string[] = [
  "Migliora le coincidenze con i treni del mattino nella stazione principale.",
  "Dove la domanda resta scoperta nei giorni feriali? Proponi come coprirla.",
  "Rendi utile il servizio della domenica sui poli attrattori principali.",
];

const PRIORITY_STYLE: Record<string, string> = {
  critica: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  alta: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  media: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  bassa: "bg-zinc-600/20 text-zinc-400 border-zinc-600/40",
};

const KIND_LABEL: Record<string, string> = {
  add_trip: "Nuova corsa",
  shift_trip: "Sposta corsa",
  extend_span: "Estendi arco",
  increase_frequency: "Più frequenza",
  new_connection: "Nuova coincidenza",
  other: "Intervento",
};

export default function ArgosAgentPanel({ projectId }: { projectId?: string }) {
  const [objective, setObjective] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [current, setCurrent] = React.useState<Run | null>(null);
  const [runs, setRuns] = React.useState<Run[]>([]);
  const [showSteps, setShowSteps] = React.useState(false);

  // Storico run del progetto (senza le singole proposte, solo i conteggi).
  React.useEffect(() => {
    if (!projectId) { setRuns([]); return; }
    let cancelled = false;
    fetch(`${getApiBase()}/api/ai/argos/agent/runs?projectId=${projectId}`)
      .then(r => r.ok ? r.json() : { runs: [] })
      .then(d => { if (!cancelled) setRuns(d.runs || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const runGoal = async (text?: string) => {
    const obj = (text ?? objective).trim();
    if (!obj || !projectId || running) return;
    setRunning(true);
    setError(null);
    setCurrent(null);
    setShowSteps(false);
    try {
      const r = await fetch(`${getApiBase()}/api/ai/argos/agent/goal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, objective: obj }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `Errore ${r.status}`);
      const run: Run = d.run;
      setCurrent(run);
      setRuns(prev => [{ ...run, proposals_count: run.proposals?.length ?? 0, proposals_open: run.proposals?.length ?? 0 }, ...prev]);
    } catch (e: any) {
      setError(e?.message || "Pianificazione non riuscita");
    } finally {
      setRunning(false);
    }
  };

  const openRun = async (id: number) => {
    if (!projectId) return;
    setError(null);
    try {
      const r = await fetch(`${getApiBase()}/api/ai/argos/agent/runs/${id}?projectId=${projectId}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `Errore ${r.status}`);
      setCurrent(d.run);
      setShowSteps(false);
    } catch (e: any) {
      setError(e?.message || "Run non disponibile");
    }
  };

  const setProposalStatus = async (pid: number, status: string) => {
    if (!projectId) return;
    // Ottimistico: aggiorna subito, poi conferma col server.
    setCurrent(prev => prev ? {
      ...prev,
      proposals: (prev.proposals || []).map(p => p.id === pid ? { ...p, status } : p),
    } : prev);
    try {
      await fetch(`${getApiBase()}/api/ai/argos/agent/proposals/${pid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, status }),
      });
    } catch { /* la UI resta ottimistica; un refresh riallineerà */ }
  };

  const notReady = !projectId;

  return (
    <div className="flex flex-col h-full">
      {/* ── Casella obiettivo ── */}
      <div className="p-3 border-b border-violet-400/25 bg-black/30 space-y-2">
        <div className="flex items-center gap-2 text-violet-300">
          <Target className="w-4 h-4" />
          <span className="text-[11px] font-bold uppercase tracking-wider">Dammi un obiettivo</span>
        </div>
        <textarea
          value={objective}
          onChange={e => setObjective(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runGoal(); } }}
          rows={2}
          disabled={running || notReady}
          placeholder={notReady ? "Apri un progetto per usare l'agente…" : "Es. Aggancia le corse ai treni del mattino a Falconara."}
          className="w-full resize-none rounded-xl bg-zinc-900/80 border border-violet-400/25 focus:border-violet-400/60 focus:outline-none focus:ring-2 focus:ring-violet-400/20 px-3 py-2 text-sm text-violet-100 placeholder:text-zinc-500 max-h-32"
        />
        <button
          onClick={() => runGoal()}
          disabled={!objective.trim() || running || notReady}
          className="w-full h-9 rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-400 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed text-black font-bold text-[12px] flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(139,92,246,0.4)] transition"
        >
          {running ? <><Loader2 className="w-4 h-4 animate-spin" /> Sto pianificando…</> : <><Sparkles className="w-4 h-4" /> Genera il piano</>}
        </button>
        {!current && !running && !notReady && (
          <div className="flex flex-col gap-1 pt-0.5">
            {SUGGESTED.map(s => (
              <button key={s} onClick={() => { setObjective(s); runGoal(s); }}
                className="text-left px-2.5 py-1.5 rounded-lg bg-zinc-900/50 hover:bg-violet-500/10 border border-white/5 hover:border-violet-400/40 text-[11px] text-zinc-300 hover:text-zinc-100 transition">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Contenuto ── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-[13px]">
        {running && (
          <div className="rounded-xl border border-violet-400/25 bg-violet-500/5 p-3 text-[12px] text-violet-200/90 flex items-start gap-2">
            <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-violet-200">Sto indagando sul progetto…</p>
              <p className="text-violet-300/70 mt-0.5">Leggo copertura, coincidenze e orari, poi costruisco un piano. Può richiedere fino a un paio di minuti.</p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {current && <RunView run={current} onStatus={setProposalStatus} showSteps={showSteps} onToggleSteps={() => setShowSteps(v => !v)} />}

        {/* Storico run (quando non stai guardando un run) */}
        {!current && !running && (
          runs.length > 0 ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                <History className="w-3 h-3" /> Piani precedenti
              </div>
              {runs.map(r => (
                <button key={r.id} onClick={() => openRun(r.id)}
                  className="w-full text-left px-3 py-2 rounded-lg bg-zinc-900/50 hover:bg-violet-500/10 border border-white/5 hover:border-violet-400/40 transition">
                  <p className="text-[12px] text-zinc-200 line-clamp-2">{r.objective}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-2">
                    <RunStatusDot status={r.status} />
                    {(r.proposals_count ?? 0)} proposte
                    {(r.proposals_open ?? 0) > 0 && <span className="text-violet-400">· {r.proposals_open} da rivedere</span>}
                    <span className="ml-auto">{fmtDate(r.created_at)}</span>
                  </p>
                </button>
              ))}
            </div>
          ) : (
            !notReady && (
              <div className="text-center pt-8 space-y-3">
                <div className="mx-auto w-14 h-14 rounded-2xl bg-violet-500/10 border border-violet-400/30 flex items-center justify-center">
                  <Target className="w-7 h-7 text-violet-300" />
                </div>
                <p className="text-xs text-zinc-400 max-w-[260px] mx-auto">
                  Dammi un obiettivo e costruisco un piano di interventi concreti, motivati dai dati del progetto. Poi lo rivedi tu.
                </p>
              </div>
            )
          )
        )}
      </div>
    </div>
  );
}

function RunView({ run, onStatus, showSteps, onToggleSteps }: {
  run: Run;
  onStatus: (pid: number, status: string) => void;
  showSteps: boolean;
  onToggleSteps: () => void;
}) {
  const proposals = run.proposals || [];
  return (
    <div className="space-y-3">
      {/* Obiettivo + diagnosi */}
      <div className="rounded-xl border border-violet-400/25 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 p-3">
        <div className="flex items-center gap-1.5 text-violet-300 text-[10px] font-bold uppercase tracking-wider mb-1">
          <Target className="w-3 h-3" /> Obiettivo
        </div>
        <p className="text-[12.5px] text-violet-100 font-medium">{run.objective}</p>
        {run.diagnosis && (
          <div className="mt-2 pt-2 border-t border-violet-400/15">
            <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-0.5">Diagnosi</p>
            <p className="text-[12px] text-zinc-300 leading-relaxed whitespace-pre-wrap">{run.diagnosis}</p>
          </div>
        )}
      </div>

      {run.summary && (
        <p className="text-[12px] text-zinc-300 leading-relaxed whitespace-pre-wrap px-0.5">{run.summary}</p>
      )}

      {/* Proposte */}
      {proposals.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{proposals.length} proposte</p>
          {proposals.map(p => <ProposalCard key={p.id} p={p} onStatus={onStatus} />)}
        </div>
      ) : (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          Nessuna proposta: i dati non bastavano per questo obiettivo. Guarda la diagnosi qui sopra per cosa verificare.
        </div>
      )}

      {/* Come ci sono arrivato (trasparenza sui tool letti) */}
      {(run.steps?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-white/5 bg-zinc-900/40">
          <button onClick={onToggleSteps} className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] text-zinc-400 hover:text-zinc-200 transition">
            {showSteps ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Come ci sono arrivato ({run.steps.length} letture)
            {run.tokens > 0 && <span className="ml-auto text-zinc-600">{(run.tokens / 1000).toFixed(1)}k token</span>}
          </button>
          {showSteps && (
            <div className="px-3 pb-2.5 space-y-1">
              {run.steps.map((s, i) => (
                <div key={i} className="text-[10.5px] text-zinc-500 font-mono flex items-start gap-1.5">
                  <span className="text-violet-400/70">{i + 1}.</span>
                  <span className="text-zinc-400">{s.tool}</span>
                  {Object.keys(s.args || {}).length > 0 && (
                    <span className="text-zinc-600 truncate">{Object.entries(s.args).map(([k, v]) => `${k}=${v}`).join(" ")}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, onStatus }: { p: Proposal; onStatus: (pid: number, status: string) => void }) {
  const prioCls = PRIORITY_STYLE[p.priority] || PRIORITY_STYLE.media;
  const accepted = p.status === "accepted" || p.status === "applied";
  const rejected = p.status === "rejected";
  return (
    <div className={`rounded-xl border p-2.5 transition ${
      accepted ? "border-emerald-500/40 bg-emerald-500/5"
      : rejected ? "border-zinc-700/40 bg-zinc-900/30 opacity-60"
      : "border-violet-400/20 bg-zinc-900/50"
    }`}>
      <div className="flex items-center gap-1.5 flex-wrap mb-1">
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-bold uppercase tracking-wide ${prioCls}`}>{p.priority}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-zinc-800/70 text-zinc-300 border border-white/5">{KIND_LABEL[p.kind] || p.kind}</span>
        {p.line && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 inline-flex items-center gap-0.5"><TrainFront className="w-2.5 h-2.5" />{p.line}</span>}
        {p.hub && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/25">{p.hub}</span>}
      </div>

      <p className="text-[12.5px] font-bold text-zinc-100 leading-snug">{p.title}</p>
      {p.detail && <p className="text-[12px] text-zinc-300 mt-1 leading-relaxed whitespace-pre-wrap">{p.detail}</p>}

      {(p.rationale || p.impact) && (
        <div className="mt-1.5 space-y-1">
          {p.rationale && <p className="text-[11px] text-zinc-400 leading-relaxed"><span className="text-zinc-500 font-semibold">Perché · </span>{p.rationale}</p>}
          {p.impact && <p className="text-[11px] text-emerald-300/90 leading-relaxed"><span className="text-emerald-400/80 font-semibold">Impatto · </span>{p.impact}</p>}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-white/5">
        <span className="text-[9.5px] text-zinc-500 inline-flex items-center gap-1"><Gauge className="w-2.5 h-2.5" />affidabilità {p.confidence}</span>
        {p.day_type && <span className="text-[9.5px] text-zinc-500 inline-flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{p.day_type}</span>}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onStatus(p.id, accepted ? "open" : "accepted")}
            title={accepted ? "Annulla accettazione" : "Accetta"}
            className={`px-2 py-1 rounded-lg text-[10px] font-bold inline-flex items-center gap-1 transition border ${
              accepted ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-zinc-800/60 text-zinc-300 border-white/5 hover:border-emerald-500/40 hover:text-emerald-300"
            }`}>
            <Check className="w-3 h-3" /> {accepted ? "Accettata" : "Accetta"}
          </button>
          <button onClick={() => onStatus(p.id, rejected ? "open" : "rejected")}
            title={rejected ? "Annulla rifiuto" : "Rifiuta"}
            className={`px-2 py-1 rounded-lg text-[10px] font-bold inline-flex items-center gap-1 transition border ${
              rejected ? "bg-zinc-700/40 text-zinc-300 border-zinc-600/40" : "bg-zinc-800/60 text-zinc-400 border-white/5 hover:border-rose-500/40 hover:text-rose-300"
            }`}>
            <X className="w-3 h-3" /> {rejected ? "Rifiutata" : "Rifiuta"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunStatusDot({ status }: { status: string }) {
  const color = status === "completed" ? "bg-emerald-400" : status === "empty" ? "bg-amber-400" : status === "failed" ? "bg-rose-400" : "bg-violet-400";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
