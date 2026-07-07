/**
 * Argos — assistente AI usato SOLO dentro Planning Studio, al posto di Virgilio.
 *
 * A differenza di Virgilio (Anthropic, tool sul feed GTFS in esercizio + azioni UI),
 * Argos è un servizio separato (FastAPI/RAG) che legge i dati del PROGETTO Planning
 * Studio aperto (tabelle ps_*: fermate, linee, varianti, corse, orari, calendari) e
 * i libri di teoria del TPL. Il browser non lo chiama direttamente: passa dal proxy
 * `POST /api/ai/argos/chat` (stesso dominio, stessa auth), che gli inoltra anche il
 * `projectId` come contesto.
 *
 * Stream SSE nativo di Argos (righe `data: {...}`):
 *   {t:"..."} pezzo di testo · {reset:true} azzera il parziale · {error:"..."} ·
 *   {done:true, sources, tokens, budget}
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, X, Send, Loader2, User, Trash2, Sparkles, Route, Clock, CalendarDays, Brain } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getApiBase } from "@/lib/api";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};

const SUGGESTED_PROMPTS: { label: string; prompt: string; icon: React.ReactNode }[] = [
  { label: "Riepilogo progetto", prompt: "Dammi un riepilogo del progetto: quante fermate, linee, corse e calendari ha.", icon: <Sparkles className="w-3 h-3" /> },
  { label: "Percorso di una linea", prompt: "Che percorso fa la linea 1? Elenca le fermate in ordine.", icon: <Route className="w-3 h-3" /> },
  { label: "Corse e frequenze", prompt: "Quante corse fa la linea 1 nei giorni feriali e con che frequenza media?", icon: <Clock className="w-3 h-3" /> },
  { label: "Calendari di servizio", prompt: "Quali calendari di servizio ci sono nel progetto (feriale, festivo, scolastico)?", icon: <CalendarDays className="w-3 h-3" /> },
];

export default function ArgosSidebar({ projectId }: { projectId?: string }) {
  const [open, setOpen] = React.useState(false);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  // Ragionamento profondo: Argos passa a Opus, più giri di tool e verifica (deep).
  // Opt-in perché costa di più sul budget di Argos: si accende solo quando serve.
  const [deep, setDeep] = React.useState(false);
  const [health, setHealth] = React.useState<{ configured: boolean; reachable?: boolean; cerbero?: boolean } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Health check al primo open
  React.useEffect(() => {
    if (!open || health !== null) return;
    fetch(`${getApiBase()}/api/ai/argos/health`)
      .then(r => r.json())
      .then(d => setHealth(d))
      .catch(() => setHealth({ configured: false }));
  }, [open, health]);

  // Auto-scroll
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: Msg = { id: crypto.randomUUID(), role: "assistant", content: "", streaming: true };
    setMsgs(prev => [...prev, userMsg, assistantMsg]);

    const history = [...msgs, userMsg].map(m => ({ role: m.role, content: m.content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch(`${getApiBase()}/api/ai/argos/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, projectId, deep }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const err = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${err}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const patchLast = (fn: (m: Msg) => Msg) => {
        setMsgs(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = fn(last);
          return next;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          // Argos usa solo righe `data: {...}`; le righe che iniziano con `:` sono
          // commenti SSE (padding anti-buffering) e vanno ignorate.
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("data:")) data += line.slice(5).trimStart();
          }
          if (!data) continue;
          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          if (typeof payload.t === "string") {
            patchLast(m => ({ ...m, content: m.content + payload.t }));
          } else if (payload.reset) {
            // Argos ha prodotto testo interlocutorio prima di consultare i dati:
            // azzera il parziale, la risposta finale arriva dopo.
            patchLast(m => ({ ...m, content: "" }));
          } else if (payload.error) {
            patchLast(m => ({ ...m, content: m.content + `\n\n❌ **Errore**: ${payload.error}`, streaming: false }));
          } else if (payload.done) {
            patchLast(m => ({ ...m, streaming: false }));
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setMsgs(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, content: last.content + `\n\n❌ **Errore**: ${err.message}`, streaming: false };
          }
          return next;
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const clear = () => setMsgs([]);
  const notReady = health !== null && (!health.configured || health.reachable === false);

  return (
    <>
      {/* Floating button */}
      <motion.button
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.95 }}
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-2xl bg-zinc-950/90 border border-violet-400/50 flex items-center justify-center group shadow-[0_0_30px_rgba(139,92,246,0.55)]"
        title="Apri Argos"
      >
        <Eye className="w-6 h-6 text-violet-300" />
        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-violet-300 animate-pulse" />
        <span className="absolute right-full mr-3 px-2 py-1 rounded-md bg-zinc-950/95 text-violet-300 text-xs font-bold border border-violet-400/40 opacity-0 group-hover:opacity-100 transition pointer-events-none whitespace-nowrap">
          Argos · AI di pianificazione
        </span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 230 }}
            className="fixed top-3 right-3 bottom-3 z-50 w-[340px] max-w-[90vw] rounded-2xl bg-gradient-to-b from-zinc-950/95 via-[#120a1c]/95 to-black/95 backdrop-blur-md border border-violet-400/40 flex flex-col shadow-[0_8px_60px_rgba(139,92,246,0.35),0_0_120px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-violet-400/30 bg-black/40 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-400/40 flex items-center justify-center">
                  <Eye className="w-5 h-5 text-violet-300" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-violet-200 leading-none drop-shadow-[0_0_6px_rgba(139,92,246,0.5)]">
                    Argos
                  </h2>
                  <p className="text-[10px] text-violet-400/70 font-mono mt-0.5">
                    {notReady ? "⚠️ non configurato" : health ? (projectId ? "● online · legge il progetto" : "● online · pianificazione") : "verifica…"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDeep(v => !v)}
                  className={`p-1.5 rounded-lg transition ${
                    deep
                      ? "text-violet-200 bg-violet-500/20 ring-1 ring-violet-400/50 drop-shadow-[0_0_6px_rgba(139,92,246,0.6)]"
                      : "text-zinc-400 hover:bg-white/5 hover:text-violet-300"
                  }`}
                  title={deep
                    ? "Ragionamento profondo ATTIVO — Argos usa Opus, più analisi e verifica (più lento e costoso). Clic per disattivare."
                    : "Ragionamento profondo — analisi passo-passo con verifica (più lento). Clic per attivare."}
                >
                  <Brain className="w-4 h-4" />
                </button>
                {msgs.length > 0 && (
                  <button onClick={clear} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-rose-300 transition" title="Cancella chat">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3 text-[13px]">
              {notReady && (
                <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200 text-xs">
                  <p className="font-bold mb-1">⚙️ Argos non raggiungibile</p>
                  <p className="text-amber-200/80">
                    Imposta <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">ARGOS_URL</code> nelle
                    variabili d'ambiente del backend (URL del servizio Argos) e assicurati che Argos abbia
                    <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">CERBERO_DATABASE_URL</code> configurata.
                  </p>
                </div>
              )}

              {msgs.length === 0 && !notReady && (
                <div className="text-center pt-6 space-y-4">
                  <div className="mx-auto w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-400/30 flex items-center justify-center">
                    <Eye className="w-8 h-8 text-violet-300" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-violet-200">Sono Argos 👁️</h3>
                    <p className="text-xs text-zinc-400 mt-1">
                      {projectId
                        ? "Vedo tutti i dati di questo progetto Planning Studio — fermate, linee, corse, orari, calendari — e i libri di teoria del TPL. Chiedimi pure."
                        : "Apri un progetto per farmi leggere i suoi dati. Posso comunque aiutarti sulla teoria della pianificazione del servizio."}
                    </p>
                  </div>
                  {projectId && (
                    <div className="grid grid-cols-1 gap-2 pt-2">
                      {SUGGESTED_PROMPTS.map(s => (
                        <button
                          key={s.label}
                          onClick={() => send(s.prompt)}
                          className="text-left px-3 py-2 rounded-lg bg-zinc-900/60 hover:bg-violet-500/10 border border-white/5 hover:border-violet-400/40 transition group"
                        >
                          <div className="flex items-center gap-2 text-violet-300 text-[11px] font-bold uppercase tracking-wider">
                            {s.icon}{s.label}
                          </div>
                          <p className="text-xs text-zinc-300 mt-0.5 group-hover:text-zinc-100">{s.prompt}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {msgs.map(m => <MessageBubble key={m.id} msg={m} />)}
            </div>

            {/* Input */}
            <div className="p-3 border-t border-violet-400/30 bg-black/40">
              <form onSubmit={e => { e.preventDefault(); send(); }} className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  rows={1}
                  placeholder="Chiedi ad Argos…"
                  disabled={loading || notReady}
                  className="flex-1 resize-none rounded-xl bg-zinc-900/80 border border-violet-400/25 focus:border-violet-400/60 focus:outline-none focus:ring-2 focus:ring-violet-400/20 px-3 py-2 text-sm text-violet-100 placeholder:text-zinc-500 max-h-32"
                  style={{ minHeight: 38 }}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || loading || notReady}
                  className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-400 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed text-black flex items-center justify-center shadow-[0_0_15px_rgba(139,92,246,0.4)] transition"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </form>
              <p className="text-[10px] text-zinc-500 mt-1.5 text-center">
                {deep && <span className="text-violet-300 font-semibold">🧠 ragionamento profondo · </span>}
                ⏎ invia · ⇧⏎ nuova riga · l'AI può sbagliare, verifica i dati critici
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function MessageBubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
        isUser ? "bg-violet-500/20 border border-violet-400/40" : "bg-violet-500/10 border border-violet-400/30"
      }`}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-violet-200" />
          : <Eye className="w-3.5 h-3.5 text-violet-300" />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
        {msg.content && (
          <div className={`inline-block max-w-full text-left rounded-2xl px-3 py-1.5 text-[11.5px] leading-snug
            ${isUser
              ? "bg-violet-500/15 border border-violet-400/30 text-violet-100"
              : "bg-zinc-900/70 border border-white/5 text-zinc-100"}`}>
            {isUser
              ? <p className="whitespace-pre-wrap">{msg.content}</p>
              : <div className="prose prose-sm prose-invert max-w-none text-[11.5px] leading-snug prose-p:my-1 prose-headings:text-violet-200 prose-headings:text-[12.5px] prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1.5 prose-strong:text-violet-200 prose-code:text-fuchsia-300 prose-code:text-[11px] prose-code:bg-black/40 prose-code:px-1 prose-code:rounded prose-a:text-violet-300 prose-table:text-[11px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>}
          </div>
        )}
        {msg.streaming && !msg.content && (
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-zinc-900/70 border border-white/5 text-zinc-400 text-xs">
            <Loader2 className="w-3 h-3 animate-spin" /> sto consultando i dati…
          </div>
        )}
      </div>
    </div>
  );
}
