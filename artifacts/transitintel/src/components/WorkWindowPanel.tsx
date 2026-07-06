/**
 * WorkWindowPanel — "Finestra di lavoro" condivisa tra le aree Turni Macchina
 * e Turni Guida.
 *
 * L'operatore TRASCINA uno o più turni interi (dalle etichette di riga del
 * gantt, InteractiveGantt rowsDraggable) dentro la finestra: qui i turni sono
 * mostrati A COLONNA, una riga per attività (corse, fuorilinea, pre-turno,
 * taxi, depositi…). Con "Spacchetta" restano SOLO le corse, selezionabili;
 * con "Rimpacchetta" le corse selezionate diventano un turno NUOVO chiuso in
 * automatico (fuorilinea rigenerati, tipologia e matricola automatiche) —
 * la logica di ricostruzione è del workspace ospite (onRepack).
 */
import React, { useState } from "react";
import { X, PackageOpen, Package, Trash2, CheckSquare, Square, GripVertical } from "lucide-react";

export interface WorkActivity {
  /** id univoco nell'ambito della finestra (per le corse: tripId) */
  id: string;
  /** true = corsa di servizio (selezionabile e rimpacchettabile) */
  isTrip: boolean;
  /** etichetta tipo attività (Corsa 21, Fuorilinea, Pre-turno, Taxi…) */
  kindLabel: string;
  /** colore accento dell'attività */
  kindColor?: string;
  /** fascia oraria "HH:MM → HH:MM" */
  timeLabel: string;
  /** descrizione (origine → destinazione, note) */
  desc: string;
}

export interface WorkShiftView {
  id: string;
  label: string;
  sub?: string;
  unpacked: boolean;
  activities: WorkActivity[];
}

interface Props {
  /** turni attualmente nella finestra (adattati dal workspace ospite) */
  shifts: WorkShiftView[];
  /** id corse selezionate (globali alla finestra) */
  selected: Set<string>;
  onToggleSelect: (activityId: string) => void;
  onToggleSelectAll: (shiftId: string) => void;
  /** drop di un turno (rowId dal gantt) */
  onDropShift: (shiftId: string) => void;
  onRemoveShift: (shiftId: string) => void;
  /** spacchetta: rimuove le attività non-corsa dal turno nella finestra */
  onUnpack: (shiftId: string) => void;
  onUnpackAll: () => void;
  /** rimpacchetta le corse selezionate in un turno nuovo */
  onRepack: () => void;
  onClose: () => void;
  busy?: boolean;
  /** accent: "amber" (TM) | "purple" (TG) */
  accent?: "amber" | "purple";
}

export default function WorkWindowPanel({
  shifts, selected, onToggleSelect, onToggleSelectAll, onDropShift, onRemoveShift,
  onUnpack, onUnpackAll, onRepack, onClose, busy, accent = "purple",
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const ac = accent === "amber"
    ? { text: "text-amber-300", border: "border-amber-500/40", bg: "bg-amber-500/10", solid: "bg-amber-500/20" }
    : { text: "text-purple-300", border: "border-purple-500/40", bg: "bg-purple-500/10", solid: "bg-purple-500/20" };
  const nSel = selected.size;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData("application/x-cerbero-row") || e.dataTransfer.getData("text/plain");
    if (id) onDropShift(id);
  };

  return (
    <div
      className={`flex flex-col border rounded-xl overflow-hidden bg-card/60 ${dragOver ? `${ac.border} ${ac.bg}` : "border-border/40"}`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-background/40 flex-wrap">
        <span className={`text-xs font-bold ${ac.text}`}>🪟 Finestra di lavoro</span>
        <span className="text-[10px] text-muted-foreground">{shifts.length} turni · {nSel} corse selezionate</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={onUnpackAll} disabled={busy || shifts.length === 0}
            title="Toglie fuorilinea, pre-turno, taxi ecc. da TUTTI i turni: restano solo le corse"
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70 disabled:opacity-40">
            <PackageOpen className="w-3.5 h-3.5" /> Spacchetta tutto
          </button>
          <button onClick={onRepack} disabled={busy || nSel === 0}
            title="Chiude un turno NUOVO con le corse selezionate: fuorilinea rigenerati, tipologia e matricola automatiche"
            className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border ${ac.border} ${ac.solid} ${ac.text} hover:opacity-90 disabled:opacity-40`}>
            <Package className="w-3.5 h-3.5" /> Rimpacchetta ({nSel})
          </button>
          <button onClick={onClose} title="Chiudi la finestra di lavoro"
            className="p-1 rounded text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Corpo */}
      {shifts.length === 0 ? (
        <div className={`flex flex-col items-center justify-center gap-2 py-12 text-center border-2 border-dashed m-3 rounded-xl ${dragOver ? ac.border : "border-border/30"}`}>
          <GripVertical className="w-6 h-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Trascina qui uno o più turni dal gantt (prendili dall'etichetta a sinistra)</p>
          <p className="text-[11px] text-muted-foreground/60">Li vedrai a colonna, una riga per attività: spacchetta, riordina la selezione, rimpacchetta.</p>
        </div>
      ) : (
        <div className="flex gap-3 p-3 overflow-x-auto">
          {shifts.map((s) => {
            const trips = s.activities.filter((a) => a.isTrip);
            const allSel = trips.length > 0 && trips.every((t) => selected.has(t.id));
            return (
              <div key={s.id} className="w-64 shrink-0 border border-border/40 rounded-lg bg-background/40 flex flex-col max-h-[420px]">
                <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/30">
                  <button onClick={() => onToggleSelectAll(s.id)} title={allSel ? "Deseleziona tutte le corse" : "Seleziona tutte le corse"}
                    className={`shrink-0 ${ac.text}`}>
                    {allSel ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-bold text-foreground truncate">{s.label}</div>
                    {s.sub && <div className="text-[9px] text-muted-foreground truncate">{s.sub}</div>}
                  </div>
                  {!s.unpacked && (
                    <button onClick={() => onUnpack(s.id)} title="Spacchetta: lascia SOLO le corse"
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                      <PackageOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => onRemoveShift(s.id)} title="Rimuovi dalla finestra"
                    className="p-0.5 rounded text-muted-foreground hover:text-rose-400">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="overflow-y-auto divide-y divide-border/15">
                  {s.activities.map((a, i) => (
                    <div key={`${a.id}-${i}`}
                      onClick={a.isTrip ? () => onToggleSelect(a.id) : undefined}
                      className={`flex items-center gap-1.5 px-2 py-1 text-[10px] ${a.isTrip ? "cursor-pointer hover:bg-muted/30" : "opacity-60"} ${a.isTrip && selected.has(a.id) ? ac.bg : ""}`}>
                      {a.isTrip ? (
                        selected.has(a.id)
                          ? <CheckSquare className={`w-3 h-3 shrink-0 ${ac.text}`} />
                          : <Square className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                      ) : <span className="w-3 shrink-0" />}
                      <span className="shrink-0 font-semibold px-1 rounded" style={{ color: a.kindColor ?? "#94a3b8", backgroundColor: (a.kindColor ?? "#94a3b8") + "1a" }}>
                        {a.kindLabel}
                      </span>
                      <span className="font-mono shrink-0 text-muted-foreground">{a.timeLabel}</span>
                      <span className="truncate text-foreground/80">{a.desc}</span>
                    </div>
                  ))}
                  {s.activities.length === 0 && (
                    <div className="px-2 py-2 text-[10px] text-muted-foreground">nessuna attività</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
