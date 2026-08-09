/**
 * Argos L2 — l'agente come CONVERSAZIONE (stile Claude Code).
 *
 * Non più "obiettivo → run one-shot": una chat agentica persistente in cui
 * Argos indaga i dati del progetto DAVANTI a te — ogni strumento che legge
 * compare come chip mentre lo legge — risponde in streaming, e quando la
 * conversazione lo chiede emette un PIANO di proposte (card con
 * accetta/rifiuta, persistite in agent_runs/agent_proposals).
 *
 * Persistenza: thread 'agente' di ps_argos_messages (separato dalla chat),
 * per progetto e per utente. Stream: /api/ai/argos/agent/chat (SSE) —
 * eventi {t}, {reset}, {tool:{name,args}}, {plan:{...}}, {error}, {done}.
 */
import React from "react";
import {
  Target, Loader2, Check, X, Send, Trash2, Eye, User,
  AlertTriangle, TrainFront, Clock, Gauge, PlugZap, Wrench,
} from "lucide-react";
import ArgosMarkdown from "@/components/argos/ArgosMarkdown";
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

type Plan = {
  id: number;
  status: string;
  summary: string;
  diagnosis: string;
  proposals?: Proposal[];
};

type ToolCall = { name: string; args?: Record<string, any> };

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  tools?: ToolCall[];
  plan?: Plan;
};

const SUGGESTED: string[] = [
  "Fai una valutazione completa del progetto.",
  "Migliora le coincidenze con i treni del mattino nella stazione principale.",
  "Dove la domanda resta scoperta nei giorni feriali? Proponi come coprirla.",
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

/** Etichette leggibili per i chip degli strumenti in lettura. */
const TOOL_LABEL: Record<string, string> = {
  ti_project_context: "contesto progetto",
  ti_project_health: "salute progetto",
  ti_validity_coverage: "copertura validità",
  ti_demand_coverage: "copertura domanda",
  ti_train_coincidences: "coincidenze treni",
  ti_train_sync_status: "freschezza orari treni",
  ti_day_types: "giorni-tipo",
  ti_lines: "linee",
  ti_validities: "validità",
  ti_line_stats: "scheda linea",
  ti_line_timetable: "quadro orario",
  ti_udp: "unità di progettazione",
  ti_operational: "quadro d'esercizio",
  ti_km: "km annui",
  ti_activity: "attività recente",
  ti_territory_place: "territorio · luogo",
  ti_territory_search: "territorio · ricerca",
  ti_territory_around: "territorio · dintorni",
  ti_territory_reach: "isocrone pedonali",
  emit_transit_plan: "emissione piano",
};

export default function ArgosAgentPanel({ projectId, tiConfigured = true }: { projectId?: string; tiConfigured?: boolean }) {
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const notReady = !projectId;
  const tiBlocked = !!projectId && !tiConfigured;

  // Storico persistente del thread 'agente' (separato dalla chat).
  React.useEffect(() => {
    if (!projectId) { setMsgs([]); return; }
    let cancelled = false;
    fetch(`${getApiBase()}/api/ai/argos/history?projectId=${projectId}&thread=agente`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => {
        if (cancelled) return;
        setMsgs((d.messages || []).map((m: any) => ({
          id: String(m.id), role: m.role, content: m.content,
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading || notReady || tiBlocked) return;
    setInput("");
    setLoading(true);

    const history = [...msgs.map(m => ({ role: m.role, content: m.content })), { role: "user" as const, content: text }];
    setMsgs(prev => [
      ...prev,
      { id: `u${Date.now()}`, role: "user", content: text },
      { id: `a${Date.now()}`, role: "assistant", content: "", streaming: true, tools: [] },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let assistantAccum = "";
    let planForSave: Plan | null = null;

    const patchLast = (fn: (m: Msg) => Msg) => {
      setMsgs(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") next[next.length - 1] = fn(last);
        return next;
      });
    };

    try {
      const r = await fetch(`${getApiBase()}/api/ai/argos/agent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, projectId }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const err = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${err}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!part.trim()) continue;
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("data:")) data += line.slice(5).trimStart();
          }
          if (!data) continue;
          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          if (typeof payload.t === "string") {
            assistantAccum += payload.t;
            patchLast(m => ({ ...m, content: m.content + payload.t }));
          } else if (payload.reset) {
            assistantAccum = "";
            patchLast(m => ({ ...m, content: "" }));
          } else if (payload.tool && typeof payload.tool.name === "string") {
            patchLast(m => ({ ...m, tools: [...(m.tools || []), payload.tool] }));
          } else if (payload.plan) {
            planForSave = payload.plan;
            patchLast(m => ({ ...m, plan: payload.plan }));
          } else if (payload.error) {
            patchLast(m => ({ ...m, content: m.content + `\n\n❌ **Errore**: ${payload.error}`, streaming: false }));
          } else if (payload.done) {
            patchLast(m => ({ ...m, streaming: false }));
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        patchLast(m => ({ ...m, content: m.content + `\n\n❌ **Errore**: ${err.message}`, streaming: false }));
      }
    } finally {
      // Lo spinner si risolve SEMPRE, anche se lo stream muore senza {done}
      // (proxy che chiude, rete): il parziale resta visibile e viene salvato.
      patchLast(m => ({ ...m, streaming: false }));
      setLoading(false);
      abortRef.current = null;
      if (projectId) {
        // Il piano vive in agent_runs; nello storico testo ne resta la traccia.
        let saved = assistantAccum;
        const p = planForSave as Plan | null;
        if (p) {
          const titles = (p.proposals || []).map((x: Proposal) => x.title).slice(0, 6).join(" · ");
          saved += `\n\n📋 **Piano #${p.id}** — ${(p.proposals || []).length} proposte${titles ? `: ${titles}` : ""}`;
        }
        const toSave: { role: string; content: string }[] = [{ role: "user", content: text }];
        if (saved.trim()) toSave.push({ role: "assistant", content: saved });
        fetch(`${getApiBase()}/api/ai/argos/history`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, thread: "agente", messages: toSave }),
        }).catch(() => {});
      }
    }
  };

  const clear = () => {
    setMsgs([]);
    if (projectId) {
      fetch(`${getApiBase()}/api/ai/argos/history?projectId=${projectId}&thread=agente`, { method: "DELETE" }).catch(() => {});
    }
  };

  const setProposalStatus = async (msgId: string, pid: number, status: string) => {
    if (!projectId) return;
    setMsgs(prev => prev.map(m => m.id !== msgId || !m.plan ? m : {
      ...m,
      plan: { ...m.plan, proposals: (m.plan.proposals || []).map(p => p.id === pid ? { ...p, status } : p) },
    }));
    try {
      await fetch(`${getApiBase()}/api/ai/argos/agent/proposals/${pid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, status }),
      });
    } catch { /* ottimistico; un refresh riallinea */ }
  };

  return (
    <>
      {/* ── Messaggi ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3 text-[13px]">
        {tiBlocked && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200 text-xs">
            <p className="font-bold mb-1 flex items-center gap-1.5"><PlugZap className="w-3.5 h-3.5" /> TransitIntel non collegato ad Argos</p>
            <p className="text-amber-200/80 leading-relaxed">
              L'agente usa gli endpoint di TransitIntel. Imposta{" "}
              <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">TRANSITINTEL_API_URL</code>{" "}
              nelle variabili d'ambiente di Argos e riavvia. La <strong>Chat</strong> funziona comunque.
            </p>
          </div>
        )}

        {msgs.length === 0 && !tiBlocked && (
          <div className="text-center pt-6 space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-400/30 flex items-center justify-center">
              <Target className="w-8 h-8 text-violet-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-violet-200">Agente Argos</h3>
              <p className="text-xs text-zinc-400 mt-1 max-w-[280px] mx-auto">
                {notReady
                  ? "Apri un progetto per usare l'agente."
                  : "Dammi un obiettivo o fammi domande: indago i dati davanti a te, e quando serve ti propongo un piano di interventi da rivedere. La conversazione resta salvata."}
              </p>
            </div>
            {projectId && (
              <div className="grid grid-cols-1 gap-2 pt-1">
                {SUGGESTED.map(s => (
                  <button key={s} onClick={() => send(s)}
                    className="text-left px-3 py-2 rounded-lg bg-zinc-900/60 hover:bg-violet-500/10 border border-white/5 hover:border-violet-400/40 text-[12px] text-zinc-300 hover:text-zinc-100 transition">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {msgs.map(m => (
          <AgentBubble key={m.id} msg={m} onProposalStatus={(pid, status) => setProposalStatus(m.id, pid, status)} />
        ))}
      </div>

      {/* ── Input ── */}
      <div className="p-3 border-t border-violet-400/30 bg-black/40">
        <form onSubmit={e => { e.preventDefault(); send(); }} className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
            placeholder={notReady ? "Apri un progetto…" : tiBlocked ? "TransitIntel non collegato…" : "Obiettivo o domanda per l'agente…"}
            disabled={loading || notReady || tiBlocked}
            className="flex-1 resize-none rounded-xl bg-zinc-900/80 border border-violet-400/25 focus:border-violet-400/60 focus:outline-none focus:ring-2 focus:ring-violet-400/20 px-3 py-2 text-sm text-violet-100 placeholder:text-zinc-500 max-h-32"
            style={{ minHeight: 38 }}
          />
          {msgs.length > 0 && !loading && (
            <button type="button" onClick={clear} title="Cancella conversazione agente"
              className="shrink-0 w-10 h-10 rounded-xl bg-zinc-900/80 border border-white/5 hover:border-rose-400/40 text-zinc-400 hover:text-rose-300 flex items-center justify-center transition">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={!input.trim() || loading || notReady || tiBlocked}
            className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-400 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed text-black flex items-center justify-center shadow-[0_0_15px_rgba(139,92,246,0.4)] transition"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
        <p className="text-[10px] text-zinc-500 mt-1.5 text-center">
          🎯 agente · legge i dati davanti a te · le proposte le approvi tu
        </p>
      </div>
    </>
  );
}

function AgentBubble({ msg, onProposalStatus }: { msg: Msg; onProposalStatus: (pid: number, status: string) => void }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
        isUser ? "bg-zinc-800 border border-white/10" : "bg-violet-500/15 border border-violet-400/40"
      }`}>
        {isUser ? <User className="w-3.5 h-3.5 text-zinc-400" /> : <Eye className="w-3.5 h-3.5 text-violet-300" />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
        {/* Attività strumenti: cosa sta leggendo, in tempo reale */}
        {!isUser && (msg.tools?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {(msg.tools || []).map((t, i) => {
              const isLast = i === (msg.tools!.length - 1);
              const active = msg.streaming && isLast;
              return (
                <span key={i} className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md border font-mono ${
                  active ? "bg-violet-500/20 text-violet-200 border-violet-400/50" : "bg-zinc-900/70 text-zinc-400 border-white/5"
                }`}>
                  {active ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wrench className="w-2.5 h-2.5" />}
                  {TOOL_LABEL[t.name] || t.name}
                </span>
              );
            })}
          </div>
        )}

        {(msg.content || (!msg.plan && msg.streaming)) && (
          <div className={`inline-block max-w-full text-left rounded-2xl px-3 py-1.5 text-[11.5px] leading-snug ${
            isUser ? "bg-violet-500/15 border border-violet-400/25 text-violet-100" : "bg-zinc-900/70 border border-white/5 text-zinc-200"
          }`}>
            {isUser
              ? <span className="whitespace-pre-wrap">{msg.content}</span>
              : msg.content
                ? <ArgosMarkdown className="prose prose-sm prose-invert max-w-none text-[11.5px] leading-snug prose-p:my-1 prose-headings:text-violet-200 prose-headings:text-[12.5px] prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1.5 prose-strong:text-violet-200 prose-code:text-fuchsia-300 prose-code:text-[11px] prose-code:bg-black/40 prose-code:px-1 prose-code:rounded prose-a:text-violet-300 prose-table:text-[11px]">{msg.content}</ArgosMarkdown>
                : <span className="inline-flex items-center gap-2 text-zinc-400 text-xs"><Loader2 className="w-3 h-3 animate-spin" /> sto indagando…</span>}
          </div>
        )}

        {/* Card del piano emesso in questo turno */}
        {msg.plan && <PlanCard plan={msg.plan} onStatus={onProposalStatus} />}
      </div>
    </div>
  );
}

function PlanCard({ plan, onStatus }: { plan: Plan; onStatus: (pid: number, status: string) => void }) {
  const proposals = plan.proposals || [];
  return (
    <div className="mt-2 text-left rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 p-2.5 space-y-2">
      <p className="text-[10px] font-bold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
        <Target className="w-3 h-3" /> Piano #{plan.id} · {proposals.length} proposte
      </p>
      {plan.diagnosis && (
        <p className="text-[11px] text-zinc-300 leading-relaxed whitespace-pre-wrap"><span className="text-zinc-500 font-semibold">Diagnosi · </span>{plan.diagnosis}</p>
      )}
      {proposals.length === 0 ? (
        <p className="text-[11px] text-amber-200 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Nessuna proposta: guarda la diagnosi.</p>
      ) : proposals.map(p => <ProposalCard key={p.id} p={p} onStatus={onStatus} />)}
    </div>
  );
}

function ProposalCard({ p, onStatus }: { p: Proposal; onStatus: (pid: number, status: string) => void }) {
  const prioCls = PRIORITY_STYLE[p.priority] || PRIORITY_STYLE.media;
  const accepted = p.status === "accepted" || p.status === "applied";
  const rejected = p.status === "rejected";
  return (
    <div className={`rounded-lg border p-2 transition ${
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
      <p className="text-[12px] font-bold text-zinc-100 leading-snug">{p.title}</p>
      {p.detail && <p className="text-[11.5px] text-zinc-300 mt-0.5 leading-relaxed whitespace-pre-wrap">{p.detail}</p>}
      {(p.rationale || p.impact) && (
        <div className="mt-1 space-y-0.5">
          {p.rationale && <p className="text-[10.5px] text-zinc-400 leading-relaxed"><span className="text-zinc-500 font-semibold">Perché · </span>{p.rationale}</p>}
          {p.impact && <p className="text-[10.5px] text-emerald-300/90 leading-relaxed"><span className="text-emerald-400/80 font-semibold">Impatto · </span>{p.impact}</p>}
        </div>
      )}
      <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-white/5">
        <span className="text-[9px] text-zinc-500 inline-flex items-center gap-1"><Gauge className="w-2.5 h-2.5" />affidabilità {p.confidence}</span>
        {p.day_type && <span className="text-[9px] text-zinc-500 inline-flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{p.day_type}</span>}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onStatus(p.id, accepted ? "open" : "accepted")}
            title={accepted ? "Annulla accettazione" : "Accetta"}
            className={`px-2 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center gap-1 transition border ${
              accepted ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-zinc-800/60 text-zinc-300 border-white/5 hover:border-emerald-500/40 hover:text-emerald-300"
            }`}>
            <Check className="w-3 h-3" /> {accepted ? "Accettata" : "Accetta"}
          </button>
          <button onClick={() => onStatus(p.id, rejected ? "open" : "rejected")}
            title={rejected ? "Annulla rifiuto" : "Rifiuta"}
            className={`px-2 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center gap-1 transition border ${
              rejected ? "bg-zinc-700/40 text-zinc-300 border-zinc-600/40" : "bg-zinc-800/60 text-zinc-400 border-white/5 hover:border-rose-500/40 hover:text-rose-300"
            }`}>
            <X className="w-3 h-3" /> {rejected ? "Rifiutata" : "Rifiuta"}
          </button>
        </div>
      </div>
    </div>
  );
}
