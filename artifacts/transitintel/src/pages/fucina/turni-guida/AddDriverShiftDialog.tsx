/**
 * AddDriverShiftDialog — crea manualmente un nuovo turno guida vuoto.
 *
 * Il turno creato è "scheletro": nessuna corsa assegnata, nessun veicolo.
 * Serve come contenitore in cui l'utente può poi trascinare corse dal Gantt
 * (vista esplosa) o dalla fucina.
 */
import { useState } from "react";
import { X, UserPlus } from "lucide-react";
import { TYPE_LABELS, TYPE_DESC } from "./constants";
import type { DriverShiftType } from "./types";

interface Props {
  /** ID proposto (es. "manual1"); modificabile dall'utente. */
  suggestedDriverId: string;
  /** ID già usati nel piano corrente (per validazione duplicati). */
  existingDriverIds: string[];
  onClose: () => void;
  onConfirm: (opts: {
    driverId: string;
    type: DriverShiftType;
    nastroStartMin: number;
    nastroEndMin: number;
  }) => void;
}

function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

const TYPE_OPTIONS: DriverShiftType[] = ["intero", "semiunico", "spezzato", "supplemento"];

export function AddDriverShiftDialog({ suggestedDriverId, existingDriverIds, onClose, onConfirm }: Props) {
  const [driverId, setDriverId] = useState(suggestedDriverId);
  const [type, setType] = useState<DriverShiftType>("intero");
  const [startTime, setStartTime] = useState("06:00");
  const [endTime, setEndTime] = useState("14:00");

  const startMin = timeToMin(startTime);
  const endMin = timeToMin(endTime);
  const idTaken = existingDriverIds.includes(driverId.trim());
  const idEmpty = !driverId.trim();
  const timeInvalid = Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin;
  const nastroMin = !timeInvalid ? endMin - startMin : 0;
  const canSubmit = !idTaken && !idEmpty && !timeInvalid;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm({
      driverId: driverId.trim(),
      type,
      nastroStartMin: startMin,
      nastroEndMin: endMin,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md mx-4 rounded-lg border border-border/60 bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold">Aggiungi turno guida</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              ID autista
            </label>
            <input
              type="text"
              value={driverId}
              onChange={e => setDriverId(e.target.value)}
              className={`w-full text-sm bg-background border rounded px-2 py-1.5 ${
                idTaken || idEmpty ? "border-red-500/60" : "border-border/50"
              }`}
              placeholder="manual1"
            />
            {idTaken && <div className="text-[10px] text-red-400 mt-1">ID già esistente</div>}
            {idEmpty && <div className="text-[10px] text-red-400 mt-1">ID obbligatorio</div>}
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              Tipo turno
            </label>
            <select
              value={type}
              onChange={e => setType(e.target.value as DriverShiftType)}
              className="w-full text-sm bg-background border border-border/50 rounded px-2 py-1.5"
            >
              {TYPE_OPTIONS.map(t => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            <div className="text-[10px] text-muted-foreground/80 italic mt-1">{TYPE_DESC[type]}</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
                Inizio nastro
              </label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className="w-full text-sm bg-background border border-border/50 rounded px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
                Fine nastro
              </label>
              <input
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                className={`w-full text-sm bg-background border rounded px-2 py-1.5 ${
                  timeInvalid ? "border-red-500/60" : "border-border/50"
                }`}
              />
            </div>
          </div>
          {timeInvalid ? (
            <div className="text-[10px] text-red-400">Fascia oraria non valida (la fine deve essere dopo l'inizio)</div>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              Nastro: <span className="font-mono">{Math.floor(nastroMin / 60)}h{String(nastroMin % 60).padStart(2, "0")}</span>
              {" "}— il turno verrà creato vuoto. Trascina poi le corse per riempirlo.
            </div>
          )}
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
            className="text-xs px-3 py-1.5 rounded border border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Crea turno
          </button>
        </div>
      </div>
    </div>
  );
}
