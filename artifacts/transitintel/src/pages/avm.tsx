/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AVM — gli apparati di bordo, giorno per giorno
 * ───────────────────────────────────────────────────────────────────────────
 * Lo Stato del parco nella Mappa dice come sta il parco adesso, ed è
 * un'istantanea. Questa sezione dice che cosa ha fatto ogni apparato nelle
 * ultime giornate e che cosa va guardato: è la pagina su cui si scrive una
 * segnalazione, perché porta con sé i giorni, non il minuto.
 *
 * Il contenuto è il Diario AVM; qui vive con una testata sua e un indirizzo
 * suo, dentro il modulo Centrale Operativa (permesso "centrale") accanto alla
 * Mappa: chi cerca «gli apparati» deve trovarli nel menu, non sotto una
 * scheda di «Dati».
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { Suspense, lazy } from "react";
import { SatelliteDish } from "lucide-react";

const DiarioAvm = lazy(() => import("@/pages/diario-avm"));

export default function AvmPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-5 pb-8">
      <header className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-white/5 border border-border/60">
          <SatelliteDish className="w-5 h-5 text-sky-300" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">AVM</h1>
          <p className="text-[12px] text-muted-foreground leading-relaxed max-w-2xl">
            Gli apparati di bordo letti dal canale SIRI, un campione ogni due minuti,
            giornata per giornata. In cima ciò che va controllato adesso; sotto, il
            verdetto per vettura e le segnalazioni già scritte per chi deve
            intervenire.
          </p>
        </div>
      </header>
      <Suspense fallback={
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }>
        <DiarioAvm />
      </Suspense>
    </div>
  );
}
