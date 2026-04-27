/**
 * Virgilio — Assistente AI di TransitIntel.
 * Chat sidebar con tool calling e streaming SSE.
 * Tema dark + accenti neon verde, coerente con Trip Planner.
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, X, Send, Loader2, Wrench, User,
  Trash2, ChevronDown, Zap, Mic, MicOff, Volume2, VolumeX,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getApiBase } from "@/lib/api";
import VirgilioAvatar from "@/components/VirgilioAvatar";
import VirgilioOctopus from "@/components/VirgilioOctopus";
import { VirgilioBus, type UiAction } from "@/lib/virgilio-bus";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useSpeechSynthesis, isHighQualityVoice } from "@/hooks/use-speech-synthesis";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; input: any; output?: any; error?: boolean }>;
  streaming?: boolean;
  /** Indice in `content` dove inizia l'ultimo segmento di testo (post-tool).
   * Solo questo segmento viene letto ad alta voce dal TTS, così evitiamo
   * di leggere ragionamenti / commenti intermedi tra una tool call e l'altra. */
  lastTextStartIdx?: number;
};

const SUGGESTED_PROMPTS: { label: string; prompt: string; icon: React.ReactNode }[] = [
  { label: "Linee per Senigallia", prompt: "Quante e quali linee servono Senigallia?", icon: <Zap className="w-3 h-3" /> },
  { label: "Statistiche rete", prompt: "Dammi un riepilogo della rete: fermate, linee, popolazione coperta.", icon: <Sparkles className="w-3 h-3" /> },
  { label: "Zone scoperte", prompt: "Quali sono le zone più sotto-servite della provincia?", icon: <Zap className="w-3 h-3" /> },
  { label: "Simula viaggio", prompt: "Voglio andare da Ancona stazione (43.616, 13.504) a Numana (43.516, 13.621) sabato mattina alle 9. Quali alternative ho?", icon: <Sparkles className="w-3 h-3" /> },
];

export default function CopilotSidebar() {
  const [open, setOpen] = React.useState(false);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [healthOk, setHealthOk] = React.useState<boolean | null>(null);
  const [voiceOut, setVoiceOut] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("virgilio.voiceOut") === "1";
  });
  const [voicePickerOpen, setVoicePickerOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // Voce di Virgilio: narratore calmo, tono più basso per suonare maschile/autoritario.
  // Con voci Premium/Neural il risultato è molto naturale; con voci standard è comunque
  // percepito meno robotico grazie a rate/pitch ridotti.
  const tts = useSpeechSynthesis({ lang: "it-IT", rate: 0.95, pitch: 0.9 });
  const lastSpokenIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    localStorage.setItem("virgilio.voiceOut", voiceOut ? "1" : "0");
    if (!voiceOut) tts.stop();
  }, [voiceOut]);

  // Auto-speak: quando un messaggio assistant è completo, leggilo ad alta voce
  // MA solo l'ultimo segmento (post-tool), così non legge i ragionamenti
  React.useEffect(() => {
    if (!voiceOut || !tts.supported) return;
    const last = [...msgs].reverse().find(
      m => m.role === "assistant" && !m.streaming && m.content.trim().length > 0
    );
    if (last && last.id !== lastSpokenIdRef.current) {
      lastSpokenIdRef.current = last.id;
      const startIdx = last.lastTextStartIdx ?? 0;
      const spoken = last.content.slice(startIdx).trim();
      if (spoken.length > 0) tts.speak(spoken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, voiceOut]);

  // Health check on first open
  React.useEffect(() => {
    if (!open || healthOk !== null) return;
    fetch(`${getApiBase()}/api/ai/health`)
      .then(r => r.json())
      .then(d => setHealthOk(!!d.configured))
      .catch(() => setHealthOk(false));
  }, [open, healthOk]);

  // Auto-scroll
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [msgs]);

  // Voice input (Web Speech API, browser-side, gratis)
  const speech = useSpeechRecognition({
    lang: "it-IT",
    continuous: false,
    interimResults: true,
  });

  // Mentre parla, popola la textarea col transcript live
  React.useEffect(() => {
    if (speech.listening) {
      const live = (speech.transcript + " " + speech.interimTranscript).trim();
      setInput(live);
    }
  }, [speech.transcript, speech.interimTranscript, speech.listening]);

  // Quando smette di ascoltare e ha catturato qualcosa → invia automaticamente
  const prevListening = React.useRef(false);
  React.useEffect(() => {
    if (prevListening.current && !speech.listening) {
      const final = speech.transcript.trim();
      if (final) {
        // piccolo delay per UX
        setTimeout(() => {
          send(final);
          speech.reset();
        }, 200);
      }
    }
    prevListening.current = speech.listening;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.listening]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    tts.stop(); // zittisci Virgilio se sta ancora parlando
    setInput("");
    setLoading(true);

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: Msg = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [], streaming: true };
    setMsgs(prev => [...prev, userMsg, assistantMsg]);

    const history = [...msgs, userMsg].map(m => ({ role: m.role, content: m.content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch(`${getApiBase()}/api/ai/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history }),
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

        // Parse SSE: chunks separati da \n\n
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines = part.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }

          if (event === "text") {
            setMsgs(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, content: last.content + payload.delta };
              }
              return next;
            });
          } else if (event === "tool_use") {
            setMsgs(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  toolCalls: [...(last.toolCalls || []), { name: payload.name, input: payload.input }],
                  // Reset del cursore TTS: il testo emesso DOPO il prossimo tool è
                  // la risposta finale dell'utente. Tutto quello prima è "ragionamento".
                  lastTextStartIdx: last.content.length,
                };
              }
              return next;
            });
          } else if (event === "tool_result") {
            setMsgs(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant" && last.toolCalls) {
                const tcs = [...last.toolCalls];
                // attach output to last matching tool call without output
                for (let i = tcs.length - 1; i >= 0; i--) {
                  if (tcs[i].name === payload.name && tcs[i].output === undefined) {
                    tcs[i] = { ...tcs[i], output: payload.output, error: !!payload.output?.error };
                    break;
                  }
                }
                next[next.length - 1] = { ...last, toolCalls: tcs };
              }
              return next;
            });
          } else if (event === "done") {
            setMsgs(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, streaming: false };
              }
              return next;
            });
          } else if (event === "ui_action") {
            // Virgilio sta pilotando l'UI (navigare, focus map, highlight)
            VirgilioBus.emit({ type: payload.type, payload: payload.payload } as UiAction);
          } else if (event === "error") {
            setMsgs(prev => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  content: last.content + `\n\n❌ **Errore**: ${payload.message}`,
                  streaming: false,
                };
              }
              return next;
            });
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setMsgs(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: last.content + `\n\n❌ **Errore**: ${err.message}`,
              streaming: false,
            };
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

  return (
    <>
      {/* Floating button */}
      <motion.button
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.95 }}
        data-virgilio-anchor="true"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-2xl bg-zinc-950/90 border border-emerald-400/50 flex items-center justify-center group shadow-[0_0_30px_rgba(16,185,129,0.55)]"
        title="Apri Virgilio"
      >
        <VirgilioOctopus size={44} state={loading ? "active" : tts.speaking ? "speaking" : "idle"} />
        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-300 animate-pulse" />
        <span className="absolute right-full mr-3 px-2 py-1 rounded-md bg-zinc-950/95 text-emerald-300 text-xs font-bold border border-emerald-400/40 opacity-0 group-hover:opacity-100 transition pointer-events-none whitespace-nowrap">
          Virgilio · AI
        </span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <>
            {/* NIENTE backdrop: lo schermo resta visibile e cliccabile.
                Virgilio è un agente, l'utente DEVE vedere l'app reagire dietro. */}

            {/* Drawer compatto */}
            <motion.div
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 230 }}
              className="fixed top-3 right-3 bottom-3 z-50 w-[340px] max-w-[90vw] rounded-2xl bg-gradient-to-b from-zinc-950/95 via-[#0a1410]/95 to-black/95 backdrop-blur-md border border-emerald-400/40 flex flex-col shadow-[0_8px_60px_rgba(16,185,129,0.35),0_0_120px_rgba(0,0,0,0.6)] overflow-hidden"
            >
              {/* Header */}
              <div className="px-4 py-3 border-b border-emerald-400/30 bg-black/40 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div data-virgilio-anchor="open">
                    <VirgilioOctopus size={40} state={loading ? "active" : tts.speaking ? "speaking" : "idle"} />
                  </div>
                  <div>
                    <h2 className="text-sm font-black text-emerald-200 leading-none drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]">
                      Virgilio
                    </h2>
                    <p className="text-[10px] text-emerald-400/70 font-mono mt-0.5">
                      {healthOk === false ? "⚠️ API key mancante" : healthOk ? "● online · la tua guida TPL" : "verifica…"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {tts.supported && (
                    <div className="relative flex items-center">
                      <button
                        onClick={() => {
                          if (voiceOut && tts.speaking) tts.stop();
                          setVoiceOut(v => !v);
                        }}
                        className={`p-1.5 rounded-lg transition ${
                          voiceOut
                            ? "text-emerald-300 hover:bg-emerald-500/15 drop-shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                            : "text-zinc-400 hover:bg-white/5 hover:text-emerald-300"
                        } ${tts.speaking ? "animate-pulse" : ""}`}
                        title={
                          voiceOut
                            ? tts.speaking
                              ? "Virgilio sta parlando — clic per fermare"
                              : "Voce attiva — clic per disattivare"
                            : "Voce disattivata — clic per attivare"
                        }
                      >
                        {voiceOut ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                      </button>
                      {tts.italianVoices.length > 1 && (
                        <button
                          onClick={() => {
                            // Debug: stampa tutte le voci che il browser vede
                            if (typeof window !== "undefined" && "speechSynthesis" in window) {
                              const all = window.speechSynthesis.getVoices();
                              console.group("🎙️ [Virgilio] Voci viste dal browser (" + all.length + ")");
                              console.table(all.map(v => ({ name: v.name, lang: v.lang, local: v.localService, default: v.default })));
                              const siri = all.filter(v => /siri/i.test(v.name));
                              console.log("Voci con 'siri' nel nome:", siri.length, siri.map(v => `${v.name} (${v.lang})`));
                              const it = all.filter(v => v.lang?.toLowerCase().startsWith("it"));
                              console.log("Voci italiane (it-*):", it.length, it.map(v => v.name));
                              console.groupEnd();
                            }
                            setVoicePickerOpen(o => !o);
                          }}
                          className="p-0.5 -ml-1 rounded text-zinc-500 hover:text-emerald-300 transition"
                          title="Scegli voce italiana (apri Console del browser per vedere tutte le voci disponibili)"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      )}
                      {voicePickerOpen && (
                        <div
                          className="absolute top-full right-0 mt-1 w-64 max-h-72 overflow-y-auto bg-zinc-950/98 border border-emerald-400/40 rounded-lg shadow-[0_8px_30px_rgba(16,185,129,0.3)] z-50 backdrop-blur-md"
                          onMouseLeave={() => setVoicePickerOpen(false)}
                        >
                          <div className="px-3 py-2 text-[10px] font-bold text-emerald-300 border-b border-emerald-400/20 bg-emerald-500/5">
                            🎙️ Voce italiana ({tts.italianVoices.length})
                          </div>
                          {tts.voice && !isHighQualityVoice(tts.voice) && (
                            <div className="px-3 py-2 text-[10px] text-amber-200 bg-amber-500/10 border-b border-amber-400/30 leading-relaxed">
                              ⚠️ <strong>Voce sintetica rilevata.</strong> Per un timbro naturale scarica una voce <strong>Premium</strong> da <em>Impostazioni di Sistema → Accessibilità → Contenuto Vocale → Voci di sistema → Italiano</em> e scegli una voce con il badge ⭐ qui sotto.
                            </div>
                          )}
                          {tts.italianVoices.map((v) => {
                            const isSelected = tts.voice?.name === v.name;
                            const isPremium = /neural|premium|enhanced|natural|online|google|cloud/i.test(v.name);
                            const isMale = /(luca|diego|cosimo|roberto|lorenzo|matteo|giorgio|stefano|marco|paolo|davide|enrico|standard-c|standard-d|wavenet-c|wavenet-d|neural2-c|neural2-d)/i.test(v.name);
                            return (
                              <button
                                key={v.name}
                                onClick={() => {
                                  tts.setVoice(v);
                                  // anteprima rapida
                                  setTimeout(() => tts.speak("Ciao, sono Virgilio"), 50);
                                  setVoicePickerOpen(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-xs transition border-b border-emerald-400/10 last:border-0 ${
                                  isSelected
                                    ? "bg-emerald-500/15 text-emerald-200"
                                    : "text-zinc-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate">{v.name}</span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {isMale && (
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
                                        ♂
                                      </span>
                                    )}
                                    {isPremium && (
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-400/30">
                                        ⭐
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="text-[9px] text-zinc-500 mt-0.5">
                                  {v.lang} {v.localService ? "· locale" : "· cloud"}
                                </div>
                              </button>
                            );
                          })}
                          <div className="px-3 py-2 text-[9px] text-zinc-500 border-t border-emerald-400/20 bg-black/40 leading-relaxed">
                            💡 <strong className="text-emerald-300">Voci Siri non visibili?</strong> Le voci scaricate da <em>Accessibilità → Voce in tempo reale</em> NON sono esposte al browser. Vai in <strong>Impostazioni → Accessibilità → <span className="text-amber-300">Contenuto vocale</span> → Voce di sistema → Gestisci voci</strong> e scarica <strong>Italiano → Siri Voce 3 (Premium)</strong>. Funziona solo in <strong>Safari</strong> (Chrome/Edge non supportano le voci Siri).
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
                {healthOk === false && (
                  <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200 text-xs">
                    <p className="font-bold mb-1">⚙️ Configurazione richiesta</p>
                    <p className="text-amber-200/80">
                      Aggiungi <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">ANTHROPIC_API_KEY=sk-ant-...</code> al file <code className="bg-black/40 px-1.5 py-0.5 rounded text-amber-300">.env</code> nella root del repo, poi riavvia il backend.
                    </p>
                  </div>
                )}

                {msgs.length === 0 && healthOk !== false && (
                  <div className="text-center pt-6 space-y-4">
                    <div className="mx-auto w-fit">
                      <VirgilioOctopus size={88} state="idle" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-emerald-200">Sono Virgilio, la tua guida 🐙</h3>
                      <p className="text-xs text-zinc-400 mt-1">I miei tentacoli toccano ogni dato dell'ecosistema TPL. Posso anche guidarti nell'app, evidenziare elementi e centrare la mappa per te.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-2 pt-2">
                      {SUGGESTED_PROMPTS.map(s => (
                        <button
                          key={s.label}
                          onClick={() => send(s.prompt)}
                          className="text-left px-3 py-2 rounded-lg bg-zinc-900/60 hover:bg-emerald-500/10 border border-white/5 hover:border-emerald-400/40 transition group"
                        >
                          <div className="flex items-center gap-2 text-emerald-300 text-[11px] font-bold uppercase tracking-wider">
                            {s.icon}{s.label}
                          </div>
                          <p className="text-xs text-zinc-300 mt-0.5 group-hover:text-zinc-100">{s.prompt}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {msgs.map(m => <MessageBubble key={m.id} msg={m} />)}
              </div>

              {/* Input */}
              <div className="p-3 border-t border-emerald-400/30 bg-black/40">
                {speech.listening && (
                  <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-400/40 text-rose-200 text-[11px]">
                    <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                    <span className="font-bold">Ascolto…</span>
                    <span className="text-rose-300/70 italic truncate">{speech.interimTranscript || "parla pure"}</span>
                  </div>
                )}
                {speech.error && !speech.listening && (
                  <div className="mb-2 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-400/40 text-amber-200 text-[11px]">
                    🎙️ {speech.error}
                  </div>
                )}
                <form
                  onSubmit={e => { e.preventDefault(); send(); }}
                  className="flex items-end gap-2"
                >
                  <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={1}
                    placeholder={speech.listening ? "🎙️ sto trascrivendo…" : "Chiedi a Virgilio…"}
                    disabled={loading || healthOk === false}
                    className="flex-1 resize-none rounded-xl bg-zinc-900/80 border border-emerald-400/25 focus:border-emerald-400/60 focus:outline-none focus:ring-2 focus:ring-emerald-400/20 px-3 py-2 text-sm text-emerald-100 placeholder:text-zinc-500 max-h-32"
                    style={{ minHeight: 38 }}
                  />
                  {speech.supported ? (
                    <button
                      type="button"
                      onClick={() => speech.listening ? speech.stop() : speech.start()}
                      disabled={loading || healthOk === false}
                      title={speech.listening ? "Stop registrazione" : "Parla con Virgilio"}
                      className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition border
                        ${speech.listening
                          ? "bg-rose-500 border-rose-300 text-white shadow-[0_0_18px_rgba(244,63,94,0.6)] animate-pulse"
                          : "bg-zinc-900/80 border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/15 hover:border-emerald-400/70"}
                        disabled:opacity-30 disabled:cursor-not-allowed`}
                    >
                      {speech.listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => alert("Il microfono richiede Chrome, Edge o Safari su una pagina sicura (https o localhost). Firefox non supporta la Web Speech API.")}
                      title="Microfono non supportato dal browser corrente — usa Chrome/Edge/Safari"
                      className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition border bg-zinc-900/40 border-zinc-700/50 text-zinc-500 hover:border-amber-400/40 hover:text-amber-300"
                    >
                      <MicOff className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!input.trim() || loading || healthOk === false}
                    className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-lime-400 hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed text-black flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)] transition"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </form>
                <p className="text-[10px] text-zinc-500 mt-1.5 text-center">
                  ⏎ invia · ⇧⏎ nuova riga · {speech.supported ? "🎙️ supportato" : "🎙️ non supportato dal browser"} · l'AI può sbagliare, verifica i dati critici
                </p>
              </div>
            </motion.div>
          </>
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
        isUser
          ? "bg-emerald-500/20 border border-emerald-400/40"
          : ""
      }`}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-emerald-200" />
          : <VirgilioOctopus size={28} state={msg.streaming ? "active" : "idle"} />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? "text-right" : ""}`}>
        {/* Tool calls (compact) */}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="space-y-1 mb-2">
            {msg.toolCalls.map((tc, i) => <ToolCallChip key={i} tc={tc} />)}
          </div>
        )}
        {/* Content */}
        {msg.content && (
          <div className={`inline-block max-w-full text-left rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed
            ${isUser
              ? "bg-emerald-500/15 border border-emerald-400/30 text-emerald-100"
              : "bg-zinc-900/70 border border-white/5 text-zinc-100"}`}>
            {isUser
              ? <p className="whitespace-pre-wrap">{msg.content}</p>
              : <div className="prose prose-sm prose-invert max-w-none prose-headings:text-emerald-200 prose-strong:text-emerald-200 prose-code:text-lime-300 prose-code:bg-black/40 prose-code:px-1 prose-code:rounded prose-a:text-emerald-300 prose-table:text-xs">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>}
          </div>
        )}
        {msg.streaming && !msg.content && msg.toolCalls?.every(t => t.output !== undefined) !== false && (
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-zinc-900/70 border border-white/5 text-zinc-400 text-xs">
            <Loader2 className="w-3 h-3 animate-spin" /> sto pensando…
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallChip({ tc }: { tc: { name: string; input: any; output?: any; error?: boolean } }) {
  const [open, setOpen] = React.useState(false);
  const done = tc.output !== undefined;
  return (
    <div className={`rounded-lg border text-[11px] overflow-hidden transition
      ${tc.error ? "border-rose-400/40 bg-rose-500/10" : done ? "border-emerald-400/30 bg-emerald-500/5" : "border-amber-400/40 bg-amber-500/10"}`}>
      <button onClick={() => setOpen(!open)} className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left">
        <Wrench className={`w-3 h-3 shrink-0 ${tc.error ? "text-rose-300" : done ? "text-emerald-300" : "text-amber-300 animate-pulse"}`} />
        <span className="font-mono font-bold text-zinc-200 truncate">{tc.name}</span>
        {!done && <Loader2 className="w-3 h-3 animate-spin text-amber-300 ml-auto shrink-0" />}
        {done && <ChevronDown className={`w-3 h-3 ml-auto shrink-0 text-zinc-400 transition ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1.5 text-[10px] font-mono">
          <div>
            <span className="text-zinc-500">input:</span>
            <pre className="text-zinc-300 bg-black/40 rounded p-1.5 mt-0.5 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(tc.input, null, 2)}</pre>
          </div>
          {done && (
            <div>
              <span className="text-zinc-500">output:</span>
              <pre className="text-zinc-300 bg-black/40 rounded p-1.5 mt-0.5 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">{JSON.stringify(tc.output, null, 2).slice(0, 2000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
