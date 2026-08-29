/**
 * Editor VERTICALE dei transiti di una corsa: tutte le fermate in ordine di
 * percorrenza con arrivo/partenza modificabili a mano. Ogni modifica applica
 * la CASCATA A VALLE (i tempi successivi slittano dello stesso delta — si sta
 * correggendo la percorrenza della tratta), con vincolo di monotonia e
 * messaggio parlante. Undo passo-passo, badge modifiche, salvataggio con il
 * PUT stop-times esistente CONSERVANDO pickup/dropoff/timepoint/progressive.
 *
 * Usato nel drawer di dettaglio della sezione Corse e nella modalità
 * «Tempi a mano» della zona Percorrenze.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Save, Undo2 } from "lucide-react";
import { getPsStopTimes, setPsStopTimes, type PsStopTime } from "@/lib/planning-studio-api";
import { cascadeEdit, legProfile } from "@/lib/percorrenze-manuali";
import { ttToSec } from "@/lib/traffic-profile";
import TimeInput from "@/components/planning-studio/TimeInput";

const hm = (t: string) => (t || "").slice(0, 5);

export default function TripTransitsEditor({ projectId, tripId, onSaved }: {
  projectId: string; tripId: string; onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const stQ = useQuery({
    queryKey: ["ps", projectId, "trip-stop-times", tripId],
    queryFn: () => getPsStopTimes(projectId, tripId),
  });
  const [rows, setRows] = useState<PsStopTime[]>([]);
  const [history, setHistory] = useState<PsStopTime[][]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(stQ.data ?? []); setHistory([]); }, [stQ.data]);

  const orig = stQ.data ?? [];
  const changed = useMemo(() => {
    if (orig.length !== rows.length) return 0;
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].arrivalTime !== orig[i].arrivalTime || rows[i].departureTime !== orig[i].departureTime) n++;
    }
    return n;
  }, [rows, orig]);

  function edit(idx: number, field: "arr" | "dep", hhmm: string) {
    const r = cascadeEdit(rows, idx, field, hhmm);
    if (!r.ok) { toast.error("Modifica non applicata", { description: r.error }); return; }
    if (r.deltaSec === 0) return;
    setHistory(h => [...h.slice(-29), rows]);
    setRows(r.rows);
  }
  function undo() {
    setHistory(h => {
      if (h.length === 0) return h;
      setRows(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  async function save() {
    setBusy(true);
    try {
      // riscrive la corsa intera conservando i campi che il PUT altrimenti azzererebbe
      await setPsStopTimes(projectId, tripId, rows.map(r => ({
        stopId: r.stopId,
        arrivalTime: r.arrivalTime,
        departureTime: r.departureTime,
        pickupType: r.pickupType,
        dropOffType: r.dropOffType,
        timepoint: r.timepoint,
        shapeDistTraveled: r.shapeDistTraveled ?? null,
      })));
      toast.success("Transiti aggiornati", { description: `${rows.length} fermate salvate` });
      setHistory([]);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-stop-times", tripId] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      onSaved?.();
    } catch (e: any) {
      toast.error("Errore nel salvataggio", { description: e?.message });
    } finally { setBusy(false); }
  }

  const prof = useMemo(() => rows.length >= 2 ? legProfile(rows) : null, [rows]);

  return (
    <div className="p-4 border-b border-slate-800 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
          Transiti alle fermate
          {changed > 0 && <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] normal-case">{changed} modific{changed === 1 ? "a" : "he"}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={undo} disabled={busy || history.length === 0} title="Annulla l'ultima modifica"
            className="p-1 rounded text-slate-400 hover:bg-slate-800 disabled:opacity-30">
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          {changed > 0 && (
            <button onClick={() => { setRows(orig); setHistory([]); }} disabled={busy}
              className="px-2 py-1 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 text-[10px]">Ripristina</button>
          )}
          <button onClick={save} disabled={busy || changed === 0}
            className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1 disabled:opacity-40">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Salva orari
          </button>
        </div>
      </div>
      {stQ.isLoading ? (
        <div className="text-[11px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> caricamento…</div>
      ) : rows.length === 0 ? (
        <div className="text-[11px] text-slate-500">Nessun orario per questa corsa.</div>
      ) : (
        <div className="max-h-[46vh] overflow-auto rounded border border-slate-800">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-slate-900 text-slate-500 z-10">
              <tr>
                <th className="p-1.5 text-left">Fermata</th>
                <th className="p-1.5 text-right" title="Minuti dalla fermata precedente (tratta)">Tratta</th>
                <th className="p-1.5 text-center">Arrivo</th>
                <th className="p-1.5 text-center">Partenza</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const o = orig[i];
                const touched = o && (r.arrivalTime !== o.arrivalTime || r.departureTime !== o.departureTime);
                const legMin = prof && i > 0 ? Math.round(prof.legSec[i - 1] / 6) / 10 : null;
                const dwellMin = prof && prof.dwellSec[i] > 0 ? Math.round(prof.dwellSec[i] / 6) / 10 : null;
                return (
                  <tr key={r.stopId + i} className={`border-t border-slate-800/60 ${touched ? "bg-amber-500/5" : ""}`}>
                    <td className="p-1.5 text-slate-300 truncate max-w-[170px]" title={r.stopName}>
                      <span className="text-slate-600 mr-1">{i + 1}.</span>{r.stopName}
                      {dwellMin != null && <span className="ml-1 text-[9px] text-slate-500" title="Sosta alla fermata">⏸{dwellMin}′</span>}
                    </td>
                    <td className="p-1.5 text-right font-mono text-slate-500">{legMin != null ? `${legMin}′` : "—"}</td>
                    <td className="p-1 text-center">
                      <TimeInput value={hm(r.arrivalTime)} disabled={busy}
                        title="Modificandolo, i tempi successivi slittano dello stesso delta"
                        onCommit={v => edit(i, "arr", v)} />
                    </td>
                    <td className="p-1 text-center">
                      <TimeInput value={hm(r.departureTime)} disabled={busy}
                        title="Modificandolo, i tempi successivi slittano dello stesso delta"
                        onCommit={v => edit(i, "dep", v)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length >= 2 && (
        <p className="text-[10px] text-slate-500 leading-tight">
          Giro: <strong className="text-slate-300">{Math.round((ttToSec(rows[rows.length - 1].arrivalTime) - ttToSec(rows[0].departureTime)) / 60)}′</strong>
          {" "}· ogni modifica fa slittare i tempi a valle dello stesso delta (stai correggendo la percorrenza della tratta);
          la partenza si cambia dalla prima riga. Orari HH:MM, anche &gt;24:00.
        </p>
      )}
    </div>
  );
}
