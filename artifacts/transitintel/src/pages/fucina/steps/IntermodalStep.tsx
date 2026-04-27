/**
 * Step 7 — Intermodale & Territorio
 *
 * Rileva hub di trasporto (treni / aerei / porto) e POI (scuole, industrie,
 * ospedali, uffici) serviti dalle linee selezionate nello step 1.
 *
 * Riusa la pagina `IntermodalPage` in modalità "embedded", passando i
 * `routeIds` come filtro server-side. Le proposte di adeguamento orario
 * possono essere applicate come modifiche al risultato di ottimizzazione.
 */
import React, { useMemo } from "react";
import { ArrowLeft, ArrowRightLeft, Sparkles } from "lucide-react";
import { toast } from "sonner";
import IntermodalPage from "@/pages/intermodal";
import type { GtfsSelection, VehicleAssignment } from "@/pages/fucina";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";

interface Props {
  gtfsSelection: GtfsSelection;
  assignment: VehicleAssignment;
  optimizationResult: ServiceProgramResult;
  onBack: () => void;
  /** Propagates approved schedule tweaks back to the Workspace step */
  onApplyProposals?: (proposals: Array<{
    action: "add" | "shift" | "extend";
    hubId: string;
    hubName: string;
    currentTime?: string;
    proposedTime: string;
    reason: string;
    impact: string;
  }>) => void;
}

export default function IntermodalStep({
  gtfsSelection, assignment, optimizationResult, onBack, onApplyProposals,
}: Props) {
  // Extract selected route IDs from the vehicle-assignment step
  const routeIds = useMemo(
    () => Array.from(assignment.selectedRoutes.keys()),
    [assignment.selectedRoutes],
  );

  const handleApplyProposals = (proposals: Parameters<NonNullable<Props["onApplyProposals"]>>[0]) => {
    if (proposals.length === 0) {
      toast.info("Nessuna proposta da applicare");
      return;
    }
    if (onApplyProposals) {
      onApplyProposals(proposals);
    }
    toast.success(`${proposals.length} proposte inoltrate`, {
      description: "Le modifiche saranno riflesse nell'Area di Lavoro",
    });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ArrowRightLeft className="w-3.5 h-3.5 text-orange-400/60 shrink-0" />
          <span className="text-[11px] text-orange-300/60 font-medium">
            Intermodale &amp; Territorio
          </span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10 shrink-0">
            {gtfsSelection.label}
          </span>
          <span className="text-[10px] text-orange-300/40 shrink-0">
            · {routeIds.length} linee selezionate
          </span>
          <span className="text-[10px] text-orange-300/40 shrink-0">
            · {optimizationResult.shifts.length} turni attivi
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
          <div className="flex items-center gap-1.5 text-[10px] text-amber-300/60 italic">
            <Sparkles className="w-3 h-3 text-amber-400/60" />
            Hub e POI filtrati sulle linee selezionate
          </div>
        </div>
      </div>

      {/* Intermodal workspace (riuso componente esistente) */}
      <div className="flex-1 overflow-hidden">
        <IntermodalPage
          routeIds={routeIds}
          embedded={true}
          onApplyProposals={handleApplyProposals}
        />
      </div>
    </div>
  );
}
