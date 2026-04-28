/**
 * AddVehicleShiftDialog — crea manualmente un nuovo turno macchina vuoto.
 *
 * Il turno è uno scheletro: nessuna corsa assegnata. Serve come contenitore
 * in cui l'utente trascinerà poi corse dal Gantt o dall'advisor intermodale.
 */
import { useState } from "react";
import { X, BusFront } from "lucide-react";
import {
  VEHICLE_LABELS, VEHICLE_COLORS, CATEGORY_COLORS, CATEGORY_LABELS,
} from "@/pages/optimizer-route/constants";
import type { VehicleType, ServiceCategory } from "@/pages/optimizer-route/types";

interface Props {
  /** ID proposto (es. "M99"); modificabile dall'utente. */
  suggestedVehicleId: string;
  /** ID veicolo già usati nel piano (per validazione duplicati). */
  existingVehicleIds: string[];
  onClose: () => void;
  onConfirm: (opts: {
    vehicleId: string;
    vehicleType: VehicleType;
    category: ServiceCategory;
  }) => void;
}

const VEHICLE_OPTIONS: VehicleType[] = ["pollicino", "10m", "12m", "autosnodato"];
const CATEGORY_OPTIONS: ServiceCategory[] = ["urbano", "extraurbano"];

export function AddVehicleShiftDialog({ suggestedVehicleId, existingVehicleIds, onClose, onConfirm }: Props) {
  const [vehicleId, setVehicleId] = useState(suggestedVehicleId);
  const [vehicleType, setVehicleType] = useState<VehicleType>("12m");
  const [category, setCategory] = useState<ServiceCategory>("urbano");

  const idTaken = existingVehicleIds.includes(vehicleId.trim());
  const idEmpty = !vehicleId.trim();
  const canSubmit = !idTaken && !idEmpty;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm({ vehicleId: vehicleId.trim(), vehicleType, category });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md mx-4 rounded-lg border border-border/60 bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <BusFront className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold">Aggiungi turno macchina</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              ID veicolo
            </label>
            <input
              type="text"
              value={vehicleId}
              onChange={e => setVehicleId(e.target.value)}
              className={`w-full text-sm bg-background border rounded px-2 py-1.5 ${
                idTaken || idEmpty ? "border-red-500/60" : "border-border/50"
              }`}
              placeholder="M99"
            />
            {idTaken && <div className="text-[10px] text-red-400 mt-1">ID già esistente</div>}
            {idEmpty && <div className="text-[10px] text-red-400 mt-1">ID obbligatorio</div>}
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              Tipo veicolo
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {VEHICLE_OPTIONS.map(v => {
                const active = vehicleType === v;
                const color = VEHICLE_COLORS[v] ?? "#94a3b8";
                return (
                  <button
                    key={v}
                    onClick={() => setVehicleType(v)}
                    className={`text-xs px-2 py-1.5 rounded border transition ${
                      active ? "text-white" : "bg-background hover:bg-muted/40 text-foreground border-border/50"
                    }`}
                    style={active ? { background: color, borderColor: color } : undefined}
                  >
                    {VEHICLE_LABELS[v] ?? v}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              Categoria servizio
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {CATEGORY_OPTIONS.map(c => {
                const active = category === c;
                const color = CATEGORY_COLORS[c] ?? "#94a3b8";
                return (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={`text-xs px-2 py-1.5 rounded border transition ${
                      active ? "text-white" : "bg-background hover:bg-muted/40 text-foreground border-border/50"
                    }`}
                    style={active ? { background: color, borderColor: color } : undefined}
                  >
                    {CATEGORY_LABELS[c]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="text-[10px] text-muted-foreground">
            Il turno verrà creato vuoto. Trascina poi le corse dal Gantt per assegnarle al nuovo veicolo.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/40 bg-muted/20">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-border/50 hover:bg-muted/40 transition"
          >
            Annulla
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="text-xs px-3 py-1.5 rounded border border-orange-500/60 bg-orange-500/20 text-orange-200 hover:bg-orange-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Crea turno
          </button>
        </div>
      </div>
    </div>
  );
}

/** Costruisce un VehicleShift vuoto pronto da inserire in ServiceProgramResult.shifts. */
export function createEmptyVehicleShift(opts: {
  vehicleId: string;
  vehicleType: VehicleType;
  category: ServiceCategory;
  fifoOrder?: number;
}): import("@/pages/optimizer-route/types").VehicleShift {
  return {
    vehicleId: opts.vehicleId,
    vehicleType: opts.vehicleType,
    category: opts.category,
    trips: [],
    startMin: 0,
    endMin: 0,
    totalServiceMin: 0,
    totalDeadheadMin: 0,
    totalDeadheadKm: 0,
    depotReturns: 0,
    tripCount: 0,
    fifoOrder: opts.fifoOrder ?? 999,
    firstOut: 0,
    lastIn: 0,
    shiftDuration: 0,
    downsizedTrips: 0,
  };
}

/** Genera un nuovo vehicleId univoco non già presente in shifts (pattern MN). */
export function nextVehicleId(existingIds: string[], prefix = "M"): string {
  const used = new Set(existingIds);
  // Trova il massimo numero presente con questo prefisso
  let maxN = 0;
  for (const id of used) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  let n = maxN + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
