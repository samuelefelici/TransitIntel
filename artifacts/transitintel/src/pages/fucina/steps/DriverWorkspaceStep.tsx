/**
 * Step 7 — Area di Lavoro Turni Guida
 *
 * Wrappa DriverWorkspace (Gantt + CSP autisti) con sub-header coerente
 * allo stile fucina, partendo dallo scenario turni macchina salvato.
 */
import React from "react";
import { ArrowLeft, Users } from "lucide-react";
import { toast } from "sonner";
import DriverWorkspace from "@/pages/fucina/driver-workspace";
import type { GtfsSelection } from "@/pages/fucina";

interface Props {
  gtfsSelection: GtfsSelection;
  vehicleScenarioId: string;
  onBack: () => void;
}

export default function DriverWorkspaceStep({ gtfsSelection, vehicleScenarioId, onBack }: Props) {
  React.useEffect(() => {
    if (!vehicleScenarioId) {
      toast.error("Manca lo scenario turni macchina", {
        description: "Salva uno scenario nello step Ottimizzazione prima di procedere.",
      });
    }
  }, [vehicleScenarioId]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-purple-500/15 bg-purple-950/15 shrink-0">
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-purple-300/70" />
          <span className="text-[11px] text-purple-200 font-medium">
            Area di Lavoro — Turni Guida
          </span>
          <span className="text-[10px] text-purple-300/40 font-mono px-1.5 py-0.5 bg-purple-500/5 rounded border border-purple-500/10">
            {gtfsSelection.label}
          </span>
          <span className="text-[9px] text-purple-300/30 italic hidden sm:inline">
            CSP · saturazione · cap vetture · idle
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[11px] text-purple-300/60 hover:text-purple-200 transition px-2 py-1 rounded-lg hover:bg-purple-500/10"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
        </div>
      </div>

      {/* Workspace */}
      <div className="flex-1 overflow-hidden">
        {vehicleScenarioId ? (
          <DriverWorkspace
            vehicleScenarioId={vehicleScenarioId}
            scenarioLabel={gtfsSelection.label}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <Users className="w-10 h-10 text-purple-400/30 mb-3" />
            <h3 className="text-sm font-semibold text-purple-200 mb-1">
              Scenario turni macchina mancante
            </h3>
            <p className="text-xs text-muted-foreground max-w-md">
              Per generare i turni guida serve uno scenario salvato dello step
              <strong> Ottimizzazione</strong>. Torna indietro, lancia il solver e salva lo scenario.
            </p>
            <button
              onClick={onBack}
              className="mt-4 text-[11px] text-purple-300 px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Torna ai Turni Macchina
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
