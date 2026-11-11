/**
 * AddActivityDialog — inserisce un'attività NON di guida (Riserva / Presidio /
 * Verifica) in un turno autista esistente. L'attività è lavoro ma non guida:
 * compare sul Gantt come blocco dedicato e si somma alle ore di lavoro.
 */
import { useState } from "react";
import { X, ClipboardCheck } from "lucide-react";
import { ACTIVITY_LABELS, timeToMin, minToTime } from "./constants";
import type { DriverActivityType } from "./types";

interface Props {
  /** Autisti esistenti nel piano (la lista da cui scegliere). */
  driverIds: string[];
  suggestedDriverId?: string;
  /** Minuto d'inizio suggerito (es. dal click destro sul Gantt). */
  suggestedStartMin?: number;
  onClose: () => void;
  onConfirm: (opts: {
    driverId: string;
    type: DriverActivityType;
    startMin: number;
    endMin: number;
    note?: string;
  }) => void;
}

const TYPE_OPTIONS: DriverActivityType[] = ["riserva", "presidio", "verifica"];

export function AddActivityDialog({ driverIds, suggestedDriverId, suggestedStartMin, onClose, onConfirm }: Props) {
  const [driverId, setDriverId] = useState(suggestedDriverId ?? driverIds[0] ?? "");
  const [type, setType] = useState<DriverActivityType>("riserva");
  const [startTime, setStartTime] = useState(suggestedStartMin != null ? minToTime(suggestedStartMin) : "06:00");
  const [endTime, setEndTime] = useState(suggestedStartMin != null ? minToTime(suggestedStartMin + 120) : "08:00");
  const [note, setNote] = useState("");

  const startMin = timeToMin(startTime);
  const endMin = timeToMin(endTime);
  const timeInvalid = startMin == null || endMin == null || endMin <= startMin;
  const noDriver = !driverId.trim();
  const durMin = !timeInvalid ? (endMin! - startMin!) : 0;
  const canSubmit = !noDriver && !timeInvalid;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onConfirm({ driverId, type, startMin: startMin!, endMin: endMin!, note: note.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md mx-4 rounded-lg border border-border/60 bg-background shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-teal-400" />
            <h3 className="text-sm font-semibold">Aggiungi attività (non di guida)</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Autista</label>
            <select
              value={driverId}
              onChange={e => setDriverId(e.target.value)}
              className={`w-full text-sm bg-background border rounded px-2 py-1.5 ${noDriver ? "border-red-500/60" : "border-border/50"}`}
            >
              {driverIds.length === 0 && <option value="">— nessun autista —</option>}
              {driverIds.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Attività</label>
            <select
              value={type}
              onChange={e => setType(e.target.value as DriverActivityType)}
              className="w-full text-sm bg-background border border-border/50 rounded px-2 py-1.5"
            >
              {TYPE_OPTIONS.map(t => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Inizio</label>
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                className="w-full text-sm bg-background border border-border/50 rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Fine</label>
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                className={`w-full text-sm bg-background border rounded px-2 py-1.5 ${timeInvalid ? "border-red-500/60" : "border-border/50"}`} />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Nota (facoltativa)</label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="es. presidio capolinea Stazione"
              className="w-full text-sm bg-background border border-border/50 rounded px-2 py-1.5" />
          </div>

          {timeInvalid ? (
            <div className="text-[10px] text-red-400">Fascia oraria non valida (la fine deve essere dopo l'inizio)</div>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              Durata: <span className="font-mono">{Math.floor(durMin / 60)}h{String(durMin % 60).padStart(2, "0")}</span> — conteggiata come lavoro non di guida.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/40 bg-muted/20">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border/50 hover:bg-muted/40 transition">Annulla</button>
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="text-xs px-3 py-1.5 rounded border border-teal-500/60 bg-teal-500/20 text-teal-200 hover:bg-teal-500/30 transition disabled:opacity-40 disabled:cursor-not-allowed">
            Aggiungi attività
          </button>
        </div>
      </div>
    </div>
  );
}
