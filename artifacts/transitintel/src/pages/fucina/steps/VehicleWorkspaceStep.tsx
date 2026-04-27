/**
 * Step 2 — Turni Macchina
 *
 * Wrappa VehicleWorkspace con:
 * - bottone "← Indietro"
 * - bottone "Esporta" (formato da definire — per ora scarica JSON)
 */
import React, { useRef } from "react";
import { ArrowLeft, Download, Truck } from "lucide-react";
import VehicleWorkspace from "@/pages/fucina/vehicle-workspace";
import type { GtfsSelection } from "@/pages/fucina";
import { toast } from "sonner";

interface Props {
  gtfsSelection: GtfsSelection;
  onBack: () => void;
}

export default function VehicleWorkspaceStep({ gtfsSelection, onBack }: Props) {
  // VehicleWorkspace espone l'ultimo result via evento, lo catturiamo per l'export
  const lastResultRef = useRef<any>(null);

  React.useEffect(() => {
    const handler = (e: CustomEvent) => {
      lastResultRef.current = e.detail;
    };
    window.addEventListener("fucina:vehicle-result" as any, handler);
    return () => window.removeEventListener("fucina:vehicle-result" as any, handler);
  }, []);

  const handleExport = () => {
    const result = lastResultRef.current;
    if (!result) {
      toast.warning("Nessun dato da esportare", {
        description: "Carica o genera un scenario prima di esportare.",
      });
      return;
    }
    // Export JSON (il formato CSV/XLS verrà definito in seguito)
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `turni-macchina-${gtfsSelection.date}-${Date.now()}.json`;
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
          <span className="text-[11px] text-orange-300/60 font-medium">Turni Macchina</span>
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
            onClick={handleExport}
            className="flex items-center gap-1.5 text-[11px] text-orange-300 font-medium px-3 py-1.5 rounded-lg border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15 transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            Esporta
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <VehicleWorkspace />
      </div>
    </div>
  );
}
