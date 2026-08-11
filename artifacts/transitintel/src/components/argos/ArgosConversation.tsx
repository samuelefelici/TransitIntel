/**
 * ArgosConversation — la superficie UNICA di conversazione con Argos.
 *
 * Sostituisce la coppia "tab Chat" + "tab Agente": un solo thread, tre POSTURE
 * selezionabili per-messaggio (come i mode di un CLI agentico):
 *   · Auto   → /api/ai/argos/chat        risposte rapide su dati e teoria
 *   · Piano  → /api/ai/argos/agent/chat  (mode=piano)  il turno si chiude SEMPRE
 *              con un piano di proposte approvabili
 *   · Agente → /api/ai/argos/agent/chat  (mode=agente) indagine completa: legge i
 *              dati davanti a te, fa domande quando è incerto, propone quando serve
 *
 * Eventi SSE gestiti: {t} {reset} {tool} {note} {plan} {ask} {error} {done}.
 * {ask} è la domanda a risposta multipla: card con opzioni cliccabili.
 *
 * UX: copia risposta/piano, card di errore con "Riprova", skeleton dello storico,
 * stop dello stream, textarea autosize, autoscroll solo se sei già in fondo.
 */
import React from "react";
import {
  Target, Loader2, Check, X, Send, Trash2, Eye, User, Copy, Square,
  AlertTriangle, TrainFront, Clock, Gauge, PlugZap, Wrench, RotateCcw,
  HelpCircle, Zap, Compass, Brain, Sparkles, Route, CalendarDays,
} from "lucide-react";
import ArgosMarkdown from "@/components/argos/ArgosMarkdown";
import { getApiBase } from "@/lib/api";

/* ══════════════════════ tipi ══════════════════════ */

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

type Plan = { id: number; status: string; summary: string; diagnosis: string; proposals?: Proposal[] };

type AskOption = { label: string; description?: string | null };
type Ask = { question: string; options: AskOption[]; multi?: boolean; answered?: string[] };

type ToolCall = { name: string; args?: Record<string, any> };

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  tools?: ToolCall[];
  plan?: Plan;
  ask?: Ask;
  /** Errore del turno (server o rete): card dedicata con Riprova. */
  error?: string;
  /** Testo utente che ha generato questo turno (per il Riprova). */
  retryText?: string;
  /** Fase muta in corso (es. composizione piano) e note di servizio dal server. */
  phase?: string;
  note?: string;
};

export type ArgosMode = "auto" | "piano" | "agente";

/* ══════════════════════ costanti ══════════════════════ */

const MODES: Record<ArgosMode, {
  label: string; icon: React.ReactNode; desc: string; placeholder: string; needsProject: boolean;
}> = {
  auto: {
    label: "Auto", icon: <Zap className="w-3 h-3" />,
    desc: "Risposte rapide su dati del progetto e teoria del TPL.",
    placeholder: "Chiedi ad Argos…", needsProject: false,
  },
  piano: {
    label: "Piano", icon: <Target className="w-3 h-3" />,
    desc: "Ogni turno si chiude con un piano di proposte da approvare.",
    placeholder: "Cosa deve progettare Argos? (es. il servizio domenicale)…", needsProject: true,
  },
  agente: {
    label: "Agente", icon: <Compass className="w-3 h-3" />,
    desc: "Indagine completa: legge i dati, ti fa domande, propone quando serve.",
    placeholder: "Obiettivo o domanda per l'agente…", needsProject: true,
  },
};

const SUGGESTED: Record<ArgosMode, { label: string; prompt: string; icon: React.ReactNode }[]> = {
  auto: [
    { label: "Riepilogo progetto", prompt: "Dammi un riepilogo del progetto: quante fermate, linee, corse e calendari ha.", icon: <Sparkles className="w-3 h-3" /> },
    { label: "Percorso di una linea", prompt: "Che percorso fa la linea 1? Elenca le fermate in ordine.", icon: <Route className="w-3 h-3" /> },
    { label: "Corse e frequenze", prompt: "Quante corse fa la linea 1 nei giorni feriali e con che frequenza media?", icon: <Clock className="w-3 h-3" /> },
    { label: "Calendari di servizio", prompt: "Quali calendari di servizio ci sono nel progetto?", icon: <CalendarDays className="w-3 h-3" /> },
  ],
  piano: [
    { label: "Servizio domenicale", prompt: "Progetta il servizio domenicale del progetto e proponimi il piano.", icon: <CalendarDays className="w-3 h-3" /> },
    { label: "Coincidenze treno", prompt: "Fai un piano per agganciare le corse ai treni del mattino nella stazione principale.", icon: <TrainFront className="w-3 h-3" /> },
    { label: "Copertura domanda", prompt: "Dove la domanda resta scoperta? Proponi un piano per coprirla.", icon: <Target className="w-3 h-3" /> },
  ],
  agente: [
    { label: "Valutazione completa", prompt: "Fai una valutazione completa del progetto.", icon: <Gauge className="w-3 h-3" /> },
    { label: "Criticità del servizio", prompt: "Quali sono le tre criticità più gravi del servizio attuale? Mostrami le evidenze.", icon: <AlertTriangle className="w-3 h-3" /> },
    { label: "Migliora le coincidenze", prompt: "Migliora le coincidenze con i treni del mattino nella stazione principale.", icon: <TrainFront className="w-3 h-3" /> },
  ],
};

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
  ti_line_route: "percorso linea",
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
  ask_user: "domanda per te",
};

function toolLabel(name: string): string {
  return TOOL_LABEL[name] || name.replace(/^(ti_|tpl_|ps_)/, "").replace(/_/g, " ");
}

/** Cosa dire sotto lo spinner mentre lo stream non produce testo. */
function streamStatus(msg: Msg): string {
  if (msg.note) return msg.note;
  if (msg.phase === TOOL_LABEL.emit_transit_plan) return "sto componendo il piano — può richiedere uno o due minuti…";
  if (msg.phase) return `${msg.phase} in corso…`;
  return "sto indagando…";
}

/** Il piano come markdown (per la copia negli appunti). */
function planToMarkdown(plan: Plan): string {
  const rows = (plan.proposals || []).map(p => {
    const tags = [p.priority, KIND_LABEL[p.kind] || p.kind, p.line, p.hub, p.day_type].filter(Boolean).join(" · ");
    return `## ${p.title}\n*${tags}*\n\n${p.detail}\n\n- **Perché**: ${p.rationale}\n- **Impatto**: ${p.impact}\n- **Affidabilità**: ${p.confidence}`;
  });
  return [`# Piano #${plan.id}`, plan.diagnosis ? `**Diagnosi** — ${plan.diagnosis}` : "", plan.summary ? `**Strategia** — ${plan.summary}` : "", ...rows]
    .filter(Boolean).join("\n\n");
}

/** La domanda come testo (per lo storico persistente). */
function askToText(ask: Ask): string {
  const opts = (ask.options || []).map(o => `· ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  return `\n\n❓ **${ask.question}**\n${opts}`;
}

/** Il piano come traccia breve (per history del modello E storico persistente:
 *  UNA sola definizione, così i due testi non possono divergere). */
function planTrace(plan: Plan): string {
  const titles = (plan.proposals || []).map(p => p.title).slice(0, 6).join(" · ");
  return `\n\n📋 **Piano #${plan.id}** — ${(plan.proposals || []).length} proposte${titles ? `: ${titles}` : ""}`;
}

/* ══════════════════════ micro-componenti ══════════════════════ */

function CopyButton({ text, title = "Copia" }: { text: string; title?: string }) {
  const [ok, setOk] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1600);
        }).catch(() => {});
      }}
      title={ok ? "Copiato!" : title}
      className={`p-1 rounded-md border transition ${
        ok ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
           : "text-zinc-500 border-transparent hover:text-violet-300 hover:border-violet-400/30 hover:bg-white/5"
      }`}
    >
      {ok ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-4 animate-pulse pt-2" aria-label="Carico lo storico…">
      {[0, 1, 2].map(i => (
        <div key={i} className={`flex gap-2.5 ${i % 2 ? "flex-row-reverse" : ""}`}>
          <div className="shrink-0 w-7 h-7 rounded-lg bg-zinc-800/80" />
          <div className={`space-y-1.5 ${i % 2 ? "items-end flex flex-col" : ""}`}>
            <div className="h-3 w-40 rounded bg-zinc-800/80" />
            <div className={`h-3 rounded bg-zinc-800/60 ${i % 2 ? "w-24" : "w-56"}`} />
            {!(i % 2) && <div className="h-3 w-32 rounded bg-zinc-800/40" />}
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ error, onRetry, retrying }: { error: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="mt-2 text-left rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5">
      <p className="text-[11px] text-rose-200 leading-relaxed flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-300" />
        <span><span className="font-bold">Qualcosa è andato storto.</span> {error}</span>
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-500/15 text-rose-200 border border-rose-500/40 hover:bg-rose-500/25 disabled:opacity-40 transition"
        >
          <RotateCcw className="w-3 h-3" /> Riprova
        </button>
      )}
    </div>
  );
}

function AskCard({ ask, disabled, onAnswer, onOther }: {
  ask: Ask;
  disabled: boolean;
  onAnswer: (labels: string[]) => void;
  onOther: () => void;
}) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const answered = ask.answered && ask.answered.length > 0;
  const toggle = (label: string) => {
    if (!ask.multi) { onAnswer([label]); return; }
    setSelected(prev => prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]);
  };
  return (
    <div className="mt-2 text-left rounded-xl border border-sky-400/40 bg-sky-500/10 p-2.5 space-y-2">
      <p className="text-[10px] font-bold text-sky-300 uppercase tracking-wider flex items-center gap-1.5">
        <HelpCircle className="w-3 h-3" /> Argos ti chiede
      </p>
      <p className="text-[12px] font-semibold text-zinc-100 leading-snug">{ask.question}</p>
      <div className="space-y-1.5">
        {(ask.options || []).map((o, i) => {
          const chosen = answered ? ask.answered!.includes(o.label) : selected.includes(o.label);
          return (
            <button
              key={`${i}-${o.label}`}
              type="button"
              disabled={disabled || !!answered}
              onClick={() => toggle(o.label)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg border transition text-[11.5px] ${
                chosen
                  ? "bg-sky-500/25 border-sky-400/60 text-sky-100"
                  : answered
                    ? "bg-zinc-900/40 border-white/5 text-zinc-500"
                    : "bg-zinc-900/60 border-white/10 text-zinc-200 hover:border-sky-400/50 hover:bg-sky-500/10"
              }`}
            >
              <span className="font-bold flex items-center gap-1.5">
                {chosen && <Check className="w-3 h-3 shrink-0" />}{o.label}
              </span>
              {o.description && <span className="block text-[10.5px] opacity-75 mt-0.5">{o.description}</span>}
            </button>
          );
        })}
      </div>
      {!answered && (
        <div className="flex items-center gap-2 pt-0.5">
          {ask.multi && (
            <button
              type="button"
              disabled={disabled || selected.length === 0}
              onClick={() => onAnswer(selected)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-sky-500/20 text-sky-200 border border-sky-400/50 hover:bg-sky-500/30 disabled:opacity-40 transition"
            >
              Invia risposta{selected.length > 1 ? ` (${selected.length})` : ""}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={onOther}
            className="px-2.5 py-1 rounded-lg text-[11px] text-zinc-400 border border-white/10 hover:text-sky-200 hover:border-sky-400/40 transition"
          >
            Altra risposta…
          </button>
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, onStatus }: { plan: Plan; onStatus: (pid: number, status: string) => void }) {
  const proposals = plan.proposals || [];
  return (
    <div className="mt-2 text-left rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <p className="text-[10px] font-bold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
          <Target className="w-3 h-3" /> Piano #{plan.id} · {proposals.length} proposte
        </p>
        <div className="ml-auto"><CopyButton text={planToMarkdown(plan)} title="Copia il piano" /></div>
      </div>
      {plan.diagnosis && (
        <p className="text-[11px] text-zinc-300 leading-relaxed whitespace-pre-wrap"><span className="text-zinc-500 font-semibold">Diagnosi · </span>{plan.diagnosis}</p>
      )}
      {proposals.length === 0 ? (
        <p className="text-[11px] text-amber-200 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Nessuna proposta in questo turno: guarda la diagnosi qui sopra.</p>
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

/* ══════════════════════ bolla messaggio ══════════════════════ */

const PROSE_CLS = "prose prose-sm prose-invert max-w-none text-[11.5px] leading-snug prose-p:my-1 prose-headings:text-violet-200 prose-headings:text-[12.5px] prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1.5 prose-strong:text-violet-200 prose-code:text-fuchsia-300 prose-code:text-[11px] prose-code:bg-black/40 prose-code:px-1 prose-code:rounded prose-a:text-violet-300 prose-table:text-[11px]";

function Bubble({ msg, busy, onProposalStatus, onAskAnswer, onOther, onRetry }: {
  msg: Msg;
  busy: boolean;
  onProposalStatus: (pid: number, status: string) => void;
  onAskAnswer: (labels: string[]) => void;
  onOther: () => void;
  onRetry: (text: string) => void;
}) {
  const isUser = msg.role === "user";
  const tools = msg.tools || [];
  const MAX_CHIPS = 6;
  const hidden = Math.max(0, tools.length - MAX_CHIPS);
  const shown = hidden > 0 ? tools.slice(-MAX_CHIPS) : tools;
  return (
    <div className={`group flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
        isUser ? "bg-zinc-800 border border-white/10" : "bg-violet-500/15 border border-violet-400/40"
      }`}>
        {isUser ? <User className="w-3.5 h-3.5 text-zinc-400" /> : <Eye className="w-3.5 h-3.5 text-violet-300" />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
        {/* Attività strumenti: cosa sta leggendo, in tempo reale */}
        {!isUser && tools.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {hidden > 0 && (
              <span className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-md border font-mono bg-zinc-900/70 text-zinc-500 border-white/5">
                +{hidden} letture
              </span>
            )}
            {shown.map((t, i) => {
              const isLast = i === shown.length - 1;
              const active = msg.streaming && isLast;
              return (
                <span key={i} className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md border font-mono ${
                  active ? "bg-violet-500/20 text-violet-200 border-violet-400/50" : "bg-zinc-900/70 text-zinc-400 border-white/5"
                }`}>
                  {active ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wrench className="w-2.5 h-2.5" />}
                  {toolLabel(t.name)}
                </span>
              );
            })}
          </div>
        )}

        {(msg.content || (!msg.plan && !msg.error && msg.streaming)) && (
          <div className={`inline-block max-w-full text-left rounded-2xl px-3 py-1.5 text-[11.5px] leading-snug ${
            isUser ? "bg-violet-500/15 border border-violet-400/25 text-violet-100" : "bg-zinc-900/70 border border-white/5 text-zinc-200"
          }`}>
            {isUser
              ? <span className="whitespace-pre-wrap">{msg.content}</span>
              : msg.content
                ? <ArgosMarkdown className={PROSE_CLS}>{msg.content}</ArgosMarkdown>
                : <span className="inline-flex items-center gap-2 text-zinc-400 text-xs"><Loader2 className="w-3 h-3 animate-spin" /> {streamStatus(msg)}</span>}
          </div>
        )}

        {/* Azioni sotto la bolla (copia): compaiono al passaggio del mouse */}
        {!isUser && !msg.streaming && msg.content && (
          <div className="mt-0.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
            <CopyButton text={msg.content} title="Copia la risposta" />
          </div>
        )}

        {/* Fase muta in corso o nota di servizio: lo stream è vivo ma non
            produce testo — senza questa riga sembra fermo. */}
        {!isUser && msg.streaming && (msg.phase || msg.note) && msg.content && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] text-violet-300/90">
            <Loader2 className="w-3 h-3 animate-spin" />
            {streamStatus(msg)}
          </div>
        )}

        {/* Card del piano emesso in questo turno */}
        {msg.plan && <PlanCard plan={msg.plan} onStatus={onProposalStatus} />}

        {/* Domanda a risposta multipla */}
        {msg.ask && <AskCard ask={msg.ask} disabled={busy} onAnswer={onAskAnswer} onOther={onOther} />}

        {/* Errore del turno: card dedicata con Riprova */}
        {msg.error && (
          <ErrorCard error={msg.error} retrying={busy}
            onRetry={msg.retryText ? () => onRetry(msg.retryText!) : undefined} />
        )}
      </div>
    </div>
  );
}

/* ══════════════════════ componente principale ══════════════════════ */

export default function ArgosConversation({ projectId, tiConfigured = true, argosReady = true }: {
  projectId?: string;
  tiConfigured?: boolean;
  argosReady?: boolean;
}) {
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [mode, setMode] = React.useState<ArgosMode>(() => {
    if (typeof window === "undefined") return "agente";
    const s = localStorage.getItem("argos.mode");
    return s === "auto" || s === "piano" || s === "agente" ? s : "agente";
  });
  // Ragionamento profondo (solo Auto): Opus, più giri di tool. Opt-in: costa di più.
  const [deep, setDeep] = React.useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("argos.deep") === "1");
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true); // autoscroll solo se sei già in fondo
  const abortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => { localStorage.setItem("argos.mode", mode); }, [mode]);
  React.useEffect(() => { localStorage.setItem("argos.deep", deep ? "1" : "0"); }, [deep]);

  // Senza progetto le posture agentiche non hanno dati su cui lavorare.
  const effectiveMode: ArgosMode = !projectId ? "auto" : mode;
  const tiBlocked = !!projectId && !tiConfigured && effectiveMode !== "auto";
  const blocked = !argosReady || tiBlocked;

  // Storico persistente: thread unificato 'agente' (un solo filo per tutte le posture).
  React.useEffect(() => {
    if (!projectId) { setMsgs([]); return; }
    let cancelled = false;
    setHistoryLoading(true);
    fetch(`${getApiBase()}/api/ai/argos/history?projectId=${projectId}&thread=agente`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(d => {
        if (cancelled) return;
        setMsgs((d.messages || []).map((m: any) => ({ id: String(m.id), role: m.role, content: m.content })));
      })
      .catch(() => { if (!cancelled) setMsgs([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => {
      cancelled = true;
      // Cambio progetto a stream in corso: senza abort il vecchio stream
      // continuerebbe a scrivere dentro la history del NUOVO progetto.
      abortRef.current?.abort();
    };
  }, [projectId]);

  // Autoscroll gentile: segue lo stream solo se eri già in fondo.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [msgs]);

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const patchLast = (fn: (m: Msg) => Msg) => {
    setMsgs(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === "assistant") next[next.length - 1] = fn(last);
      return next;
    });
  };

  /** Contenuto di un turno per la HISTORY del modello: il testo più la traccia
   *  di piano e domanda (vivono nelle card, ma il modello deve vederli — es.
   *  per capire "Festivo" come risposta alla SUA domanda del turno prima). */
  const historyContent = (x: Msg): string => {
    let c = x.content;
    if (x.plan) c += planTrace(x.plan);
    if (x.ask) c += askToText(x.ask);
    return c;
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading || blocked) return;
    const m: ArgosMode = effectiveMode;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);
    stickRef.current = true;

    const history = [...msgs.map(x => ({ role: x.role, content: historyContent(x) })), { role: "user" as const, content: text }];
    setMsgs(prev => [
      ...prev,
      { id: `u${Date.now()}`, role: "user", content: text },
      { id: `a${Date.now()}`, role: "assistant", content: "", streaming: true, tools: [], retryText: text },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let assistantAccum = "";
    let planForSave: Plan | null = null;
    let askForSave: Ask | null = null;
    let turnFailed = false;

    const endpoint = m === "auto" ? "/api/ai/argos/chat" : "/api/ai/argos/agent/chat";
    const body = m === "auto"
      ? { messages: history.slice(-20), projectId, deep }
      : { messages: history, projectId, mode: m };

    try {
      const r = await fetch(`${getApiBase()}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${errText ? `: ${errText.slice(0, 300)}` : ""}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Watchdog: il server manda heartbeat ogni pochi secondi, quindi minuti
      // interi SENZA alcun byte = connessione morta a metà (proxy, rete).
      const READ_STALL_MS = 180_000;

      while (true) {
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        let done: boolean, value: Uint8Array | undefined;
        try {
          ({ done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              stallTimer = setTimeout(
                () => reject(new Error("nessun dato dal server da 3 minuti: connessione persa.")),
                READ_STALL_MS);
            }),
          ]));
        } finally {
          clearTimeout(stallTimer);
        }
        if (done) break;
        buffer += decoder.decode(value!, { stream: true });
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
            patchLast(x => ({ ...x, content: x.content + payload.t, phase: undefined, note: undefined }));
          } else if (payload.reset) {
            assistantAccum = "";
            patchLast(x => ({ ...x, content: "" }));
          } else if (typeof payload.note === "string") {
            patchLast(x => ({ ...x, note: payload.note }));
          } else if (payload.tool && typeof payload.tool.name === "string") {
            patchLast(x => ({
              ...x,
              tools: [...(x.tools || []), payload.tool],
              phase: toolLabel(payload.tool.name),
              note: undefined,
            }));
          } else if (payload.ask && typeof payload.ask.question === "string") {
            askForSave = payload.ask;
            patchLast(x => ({ ...x, ask: payload.ask, phase: undefined, note: undefined }));
          } else if (payload.plan) {
            planForSave = payload.plan;
            patchLast(x => ({ ...x, plan: payload.plan, phase: undefined, note: undefined }));
          } else if (payload.error) {
            turnFailed = true;
            patchLast(x => ({ ...x, error: String(payload.error), streaming: false, phase: undefined, note: undefined }));
          } else if (payload.done) {
            patchLast(x => ({ ...x, streaming: false }));
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        turnFailed = true;
        patchLast(x => ({ ...x, error: String(err?.message || err), streaming: false, phase: undefined, note: undefined }));
      }
      try { ctrl.abort(); } catch { /* connessione già chiusa */ }
    } finally {
      // Lo spinner si risolve SEMPRE, anche se lo stream muore senza {done}.
      patchLast(x => ({ ...x, streaming: false, phase: undefined, note: undefined }));
      setLoading(false);
      abortRef.current = null;
      // Piano e domanda vivono nelle rispettive tabelle/carte; nello storico
      // testuale ne resta una traccia leggibile per i turni successivi.
      // Un turno FALLITO senza alcuna risposta non si salva: altrimenti ogni
      // "Riprova" accumulerebbe copie identiche della stessa domanda utente.
      let saved = assistantAccum;
      if (planForSave) saved += planTrace(planForSave);
      if (askForSave) saved += askToText(askForSave);
      const skipSave = turnFailed && !saved.trim();
      if (projectId && !skipSave) {
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

  const stop = () => { abortRef.current?.abort(); };

  const clear = () => {
    if (loading) return;
    setMsgs([]);
    if (projectId) {
      fetch(`${getApiBase()}/api/ai/argos/history?projectId=${projectId}&thread=agente`, { method: "DELETE" }).catch(() => {});
    }
  };

  const answerAsk = (msgId: string, labels: string[]) => {
    setMsgs(prev => prev.map(x => x.id !== msgId || !x.ask ? x : ({ ...x, ask: { ...x.ask, answered: labels } })));
    send(labels.join("; "));
  };

  const setProposalStatus = async (msgId: string, pid: number, status: string) => {
    if (!projectId) return;
    setMsgs(prev => prev.map(x => x.id !== msgId || !x.plan ? x : {
      ...x,
      plan: { ...x.plan, proposals: (x.plan.proposals || []).map(p => p.id === pid ? { ...p, status } : p) },
    }));
    try {
      await fetch(`${getApiBase()}/api/ai/argos/agent/proposals/${pid}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, status }),
      });
    } catch { /* ottimistico; un refresh riallinea */ }
  };

  const meta = MODES[effectiveMode];
  const suggestions = SUGGESTED[effectiveMode];

  return (
    <>
      {/* ── Selettore modalità ── */}
      <div className="px-3 pt-2 pb-1.5 border-b border-violet-400/20 bg-black/20">
        <div className="flex items-center gap-1">
          {(Object.keys(MODES) as ArgosMode[]).map(k => {
            const disabled = MODES[k].needsProject && !projectId;
            const active = effectiveMode === k;
            return (
              <button
                key={k}
                type="button"
                disabled={disabled}
                onClick={() => setMode(k)}
                title={disabled ? "Apri un progetto per questa modalità" : MODES[k].desc}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] py-1.5 rounded-lg font-bold transition ${
                  active
                    ? "bg-violet-500/25 text-violet-200 ring-1 ring-violet-400/50"
                    : disabled
                      ? "text-zinc-600 cursor-not-allowed"
                      : "text-zinc-400 hover:text-violet-300 hover:bg-white/5"
                }`}
              >
                {MODES[k].icon}{MODES[k].label}
              </button>
            );
          })}
          {effectiveMode === "auto" && (
            <button
              type="button"
              onClick={() => setDeep(v => !v)}
              className={`shrink-0 p-1.5 rounded-lg transition ${
                deep
                  ? "text-violet-200 bg-violet-500/20 ring-1 ring-violet-400/50"
                  : "text-zinc-500 hover:bg-white/5 hover:text-violet-300"
              }`}
              title={deep
                ? "Ragionamento profondo ATTIVO — più analisi e verifica (più lento e costoso). Clic per disattivare."
                : "Ragionamento profondo — analisi passo-passo con verifica (più lento). Clic per attivare."}
            >
              <Brain className="w-4 h-4" />
            </button>
          )}
          {msgs.length > 0 && (
            <button
              type="button"
              onClick={clear}
              disabled={loading}
              className="shrink-0 p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-rose-300 disabled:opacity-30 transition"
              title="Cancella la conversazione"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 mt-1 px-0.5">{meta.desc}</p>
      </div>

      {/* ── Messaggi ── */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3.5 space-y-3 text-[13px]">
        {!argosReady && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200 text-xs">
            <p className="font-bold mb-1">⚙️ Argos non raggiungibile</p>
            <p className="text-amber-200/80">
              Imposta <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">ARGOS_URL</code> nelle
              variabili d'ambiente del backend e assicurati che il servizio Argos sia attivo.
            </p>
          </div>
        )}

        {tiBlocked && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200 text-xs">
            <p className="font-bold mb-1 flex items-center gap-1.5"><PlugZap className="w-3.5 h-3.5" /> TransitIntel non collegato ad Argos</p>
            <p className="text-amber-200/80 leading-relaxed">
              Le modalità Piano e Agente usano gli endpoint di TransitIntel. Imposta{" "}
              <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">TRANSITINTEL_API_URL</code>{" "}
              nelle variabili d'ambiente di Argos e riavvia. La modalità <strong>Auto</strong> funziona comunque.
            </p>
          </div>
        )}

        {historyLoading && msgs.length === 0 && <HistorySkeleton />}

        {!historyLoading && msgs.length === 0 && argosReady && !tiBlocked && (
          <div className="text-center pt-6 space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-400/30 flex items-center justify-center">
              <Eye className="w-8 h-8 text-violet-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-violet-200">Sono Argos 👁️</h3>
              <p className="text-xs text-zinc-400 mt-1 max-w-[300px] mx-auto">
                {projectId
                  ? "Un solo filo di conversazione, tre modalità: risposte rapide (Auto), piani con proposte da approvare (Piano), indagine completa (Agente). Se sono incerto, ti faccio una domanda."
                  : "Apri un progetto per le modalità Piano e Agente. In Auto posso comunque aiutarti sulla teoria della pianificazione."}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 pt-1">
              {suggestions.map(s => (
                <button key={s.label} onClick={() => send(s.prompt)}
                  className="text-left px-3 py-2 rounded-lg bg-zinc-900/60 hover:bg-violet-500/10 border border-white/5 hover:border-violet-400/40 transition group">
                  <div className="flex items-center gap-2 text-violet-300 text-[11px] font-bold uppercase tracking-wider">
                    {s.icon}{s.label}
                  </div>
                  <p className="text-xs text-zinc-300 mt-0.5 group-hover:text-zinc-100">{s.prompt}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map(x => (
          <Bubble
            key={x.id}
            msg={x}
            busy={loading}
            onProposalStatus={(pid, status) => setProposalStatus(x.id, pid, status)}
            onAskAnswer={labels => answerAsk(x.id, labels)}
            onOther={() => inputRef.current?.focus()}
            onRetry={t => send(t)}
          />
        ))}
      </div>

      {/* ── Input ── */}
      <div className="p-3 border-t border-violet-400/30 bg-black/40">
        <form onSubmit={e => { e.preventDefault(); send(); }} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); autosize(); }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
            placeholder={blocked ? "Argos non disponibile…" : meta.placeholder}
            disabled={loading || blocked}
            className="flex-1 resize-none rounded-xl bg-zinc-900/80 border border-violet-400/25 focus:border-violet-400/60 focus:outline-none focus:ring-2 focus:ring-violet-400/20 px-3 py-2 text-sm text-violet-100 placeholder:text-zinc-500"
            style={{ minHeight: 38, maxHeight: 160 }}
          />
          {loading ? (
            <button
              type="button"
              onClick={stop}
              title="Interrompi la risposta"
              className="shrink-0 w-10 h-10 rounded-xl bg-zinc-900/80 border border-rose-400/40 text-rose-300 hover:bg-rose-500/10 flex items-center justify-center transition"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || blocked}
              className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-400 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed text-black flex items-center justify-center shadow-[0_0_15px_rgba(139,92,246,0.4)] transition"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </form>
        <p className="text-[10px] text-zinc-500 mt-1.5 text-center">
          {effectiveMode === "auto" && deep && <span className="text-violet-300 font-semibold">🧠 profondo · </span>}
          {effectiveMode === "piano" && <span className="text-violet-300 font-semibold">🎯 ogni turno finisce con proposte da approvare · </span>}
          {effectiveMode === "agente" && <span className="text-violet-300 font-semibold">🧭 legge i dati davanti a te · </span>}
          ⏎ invia · ⇧⏎ nuova riga · l'AI può sbagliare, verifica i dati critici
        </p>
      </div>
    </>
  );
}
