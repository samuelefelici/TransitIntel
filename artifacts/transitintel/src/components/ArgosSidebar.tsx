/**
 * Argos — assistente AI usato SOLO dentro Planning Studio, al posto di Virgilio.
 *
 * Questo file è il GUSCIO: bottone flottante, drawer ridimensionabile, header
 * con lo stato del servizio. La conversazione vera e propria (tab Chat e tab
 * Agente — quest'ultimo con le modalità Auto · Piano · Accetta modifiche
 * scelte accanto all'input, piani approvabili, domande a risposta multipla)
 * vive in ArgosConversation.
 *
 * Il browser non chiama Argos direttamente: passa dal proxy `/api/ai/argos/*`
 * (stesso dominio, stessa auth), che verifica l'accesso al progetto e conia il
 * token on-behalf-of-user per gli endpoint TransitIntel letti dall'agente.
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, X } from "lucide-react";
import ArgosConversation from "@/components/argos/ArgosConversation";
import { getApiBase } from "@/lib/api";

export default function ArgosSidebar({ projectId }: { projectId?: string }) {
  const [open, setOpen] = React.useState(false);
  const [health, setHealth] = React.useState<{ configured: boolean; reachable?: boolean; cerbero?: boolean; transitintel?: boolean } | null>(null);
  // Larghezza del pannello (ridimensionabile trascinando il bordo sinistro).
  const MIN_W = 320, MAX_W = 900;
  const [width, setWidth] = React.useState<number>(() => {
    if (typeof window === "undefined") return 380;
    const s = Number(localStorage.getItem("argos.panelWidth"));
    return s >= MIN_W && s <= MAX_W ? s : 380;
  });
  const [resizing, setResizing] = React.useState(false);

  // Drag del bordo sinistro: il pannello è ancorato a destra, quindi
  // larghezza = (distanza del cursore dal bordo destro della finestra).
  React.useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const w = Math.min(Math.min(MAX_W, window.innerWidth - 24), Math.max(MIN_W, window.innerWidth - e.clientX - 12));
      setWidth(w);
    };
    const onUp = () => setResizing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizing]);

  React.useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("argos.panelWidth", String(Math.round(width)));
  }, [width]);

  // Health check al primo open
  React.useEffect(() => {
    if (!open || health !== null) return;
    fetch(`${getApiBase()}/api/ai/argos/health`)
      .then(r => r.json())
      .then(d => setHealth(d))
      .catch(() => setHealth({ configured: false }));
  }, [open, health]);

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
            transition={resizing ? { duration: 0 } : { type: "spring", damping: 28, stiffness: 230 }}
            style={{ width }}
            className="fixed top-3 right-3 bottom-3 z-50 max-w-[95vw] rounded-2xl bg-gradient-to-b from-zinc-950/95 via-[#120a1c]/95 to-black/95 backdrop-blur-md border border-violet-400/40 flex flex-col shadow-[0_8px_60px_rgba(139,92,246,0.35),0_0_120px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            {/* Handle di ridimensionamento: bordo sinistro, trascina per allargare */}
            <div
              onPointerDown={(e) => { e.preventDefault(); setResizing(true); }}
              onDoubleClick={() => setWidth(380)}
              title="Trascina per ridimensionare · doppio clic per larghezza standard"
              className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 group/resize flex items-center justify-center"
            >
              <div className="w-1 h-12 rounded-full bg-violet-400/30 group-hover/resize:bg-violet-400/70 transition" />
            </div>
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
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition">
                <X className="w-5 h-5" />
              </button>
            </div>

            <ArgosConversation
              projectId={projectId}
              tiConfigured={health?.transitintel !== false}
              argosReady={!notReady}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
