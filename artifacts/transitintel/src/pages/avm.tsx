/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AVM — gli apparati di bordo, giorno per giorno e settimana per settimana
 * ───────────────────────────────────────────────────────────────────────────
 * Lo Stato del parco nella Mappa dice come sta il parco adesso, ed è
 * un'istantanea. Questa sezione ha due viste:
 *   · Diario: che cosa ha fatto ogni apparato nelle ultime giornate e che
 *     cosa va guardato — la pagina su cui si scrive una segnalazione;
 *   · Controllo settimanale: rispetto alla settimana prima, chi ha ripreso a
 *     localizzarsi e chi ha smesso — la pagina di chi segue gli interventi.
 *
 * Vive dentro il modulo Centrale Operativa (permesso "centrale") accanto alla
 * Mappa. La vista si può aprire direttamente con ?vista=settimanale.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { Suspense, lazy, useState } from "react";
import { motion } from "framer-motion";
import { SatelliteDish, NotebookText, CalendarCheck } from "lucide-react";

const DiarioAvm = lazy(() => import("@/pages/diario-avm"));
const ControlloAvm = lazy(() => import("@/pages/controllo-avm"));

type Vista = "diario" | "settimanale";

const VISTE: { id: Vista; label: string; icon: React.ReactNode }[] = [
  { id: "diario", label: "Diario", icon: <NotebookText className="w-3.5 h-3.5" /> },
  { id: "settimanale", label: "Controllo settimanale", icon: <CalendarCheck className="w-3.5 h-3.5" /> },
];

function vistaIniziale(): Vista {
  try {
    return new URLSearchParams(window.location.search).get("vista") === "settimanale" ? "settimanale" : "diario";
  } catch {
    return "diario";
  }
}

export default function AvmPage() {
  const [vista, setVista] = useState<Vista>(vistaIniziale);

  const scegli = (v: Vista) => {
    setVista(v);
    /* L'indirizzo segue la vista, così si può mandare il link al controllo. */
    try {
      const url = new URL(window.location.href);
      if (v === "settimanale") url.searchParams.set("vista", "settimanale");
      else url.searchParams.delete("vista");
      window.history.replaceState(null, "", url.toString());
    } catch { /* senza history si resta sulla vista scelta e basta */ }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-8">
      <header className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-white/5 border border-border/60">
          <SatelliteDish className="w-5 h-5 text-sky-300" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">AVM</h1>
          <p className="text-[12px] text-muted-foreground leading-relaxed max-w-2xl">
            Gli apparati di bordo letti dal canale SIRI, un campione ogni due minuti.
            Il diario dice che cosa ha fatto ogni apparato giornata per giornata e a chi
            segnalarlo; il controllo settimanale dice chi ha ripreso a localizzarsi e chi
            ha smesso rispetto alla settimana prima.
          </p>
        </div>
      </header>

      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit" role="tablist" aria-label="Viste AVM">
        {VISTE.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={vista === t.id}
            onClick={() => scegli(t.id)}
            className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              vista === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-white/5"}`}
          >
            {vista === t.id && (
              <motion.div
                layoutId="avm-vista-bg"
                className="absolute inset-0 bg-background/80 border border-border/50 rounded-lg shadow-sm"
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">{t.icon}{t.label}</span>
          </button>
        ))}
      </div>

      <Suspense fallback={
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }>
        {vista === "diario" ? <DiarioAvm /> : <ControlloAvm />}
      </Suspense>
    </div>
  );
}
