/**
 * Step 1 — Programma Esercizio
 *
 * Wrappa il ServiceProgramPage esistente (optimizer-route) con:
 * - header Scheduling Engine coerente
 * - bottone "← Indietro" e "Avanti →" per navigare lo stepper
 * - passa gtfsSelection per filtrare i dati
 */
import React, { Suspense } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronRight, ClipboardList, Loader2 } from "lucide-react";
import type { GtfsSelection } from "@/pages/fucina";

// Riusa direttamente la pagina optimizer-route esistente
import ServiceProgramPage from "@/pages/optimizer-route";

interface Props {
  gtfsSelection: GtfsSelection;
  onBack: () => void;
  onComplete: () => void;
}

export default function ServiceProgramStep({ gtfsSelection, onBack, onComplete }: Props) {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-3.5 h-3.5 text-orange-400/60" />
          <span className="text-[11px] text-orange-300/60 font-medium">Programma Esercizio</span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10">
            {gtfsSelection.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Indietro
          </button>
          <button
            onClick={onComplete}
            className="flex items-center gap-1.5 text-[11px] text-black font-semibold px-3 py-1.5 rounded-lg bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_12px_rgba(251,146,60,0.3)] transition-shadow"
          >
            Vai ai Turni Macchina
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content — pagina esistente */}
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={
          <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin text-orange-400" />
            <span className="text-sm">Caricamento…</span>
          </div>
        }>
          <ServiceProgramPage />
        </Suspense>
      </div>
    </div>
  );
}
