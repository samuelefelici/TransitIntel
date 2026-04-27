/**
 * Step 3 — Area di Lavoro Turni Macchina
 *
 * Wrappa VehicleWorkspace (Gantt interattivo drag & drop)
 * passando il result dell'ottimizzazione come initialResult.
 */
import React from "react";
import { ArrowLeft, Download, Truck } from "lucide-react";
import { toast } from "sonner";
import VehicleWorkspace from "@/pages/fucina/vehicle-workspace";
import type { GtfsSelection } from "@/pages/fucina";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";

interface Props {
  gtfsSelection: GtfsSelection;
  optimizationResult: ServiceProgramResult;
  savedScenarioId?: string;
  onBack: () => void;
}

export default function WorkspaceStep({ gtfsSelection, optimizationResult, savedScenarioId, onBack }: Props) {
  const handleExport = () => {
    const blob = new Blob([JSON.stringify(optimizationResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `turni-macchina-${gtfsSelection.date || "export"}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Esportazione completata");
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2">
          <Truck className="w-3.5 h-3.5 text-orange-400/60" />
          <span className="text-[11px] text-orange-300/60 font-medium">Area di Lavoro — Turni Macchina</span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10">
            {gtfsSelection.label}
          </span>
          <span className="text-[9px] text-orange-300/30 italic hidden sm:inline">
            Trascina le corse tra i turni
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack}
            className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8">
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-1.5 text-[11px] text-orange-300 font-medium px-3 py-1.5 rounded-lg border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15 transition-all">
            <Download className="w-3.5 h-3.5" /> Esporta JSON
          </button>
          {savedScenarioId && (
            <a href={`/driver-shifts/${savedScenarioId}`}
              className="flex items-center gap-1.5 text-[11px] text-purple-300 font-medium px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition-all">
              Turni Guida →
            </a>
          )}
        </div>
      </div>

      {/* Workspace */}
      <div className="flex-1 overflow-hidden">
        <VehicleWorkspace initialResult={optimizationResult} />
      </div>
    </div>
  );
}
