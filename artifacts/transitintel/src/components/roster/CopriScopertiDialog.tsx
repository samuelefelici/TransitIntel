/**
 * «Copri gli scoperti» (PR 7.6): per un giorno, la proposta dell'API
 * (POST /api/roster/copri-scoperti) e poi l'assegnazione. Chi copre che cosa
 * lo sceglie l'API con le regole dei sostituti: stesso deposito, liberi o a
 * disposizione, senza violazioni. Qui si guarda e si conferma.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wand2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Turno { dssId: string; codice: string; inizio: string | null; fine: string | null; deposito: string | null; titolare: { id: string; nome: string | null } | null }
interface Copertura { turno: Turno; driverId: string; nome: string; gruppo: "libero" | "disposizione" }
interface Risposta {
  day: string;
  pubblicato: boolean;
  coperture?: Copertura[];
  assegnate?: Copertura[];
  nonAndate?: Array<{ turno: Turno; motivo: string }>;
  scoperti: Array<{ turno: Turno; motivo: "nessun_candidato" | "candidati_finiti" }>;
}

const LBL = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const TEXT = "rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
const MOTIVI = {
  nessun_candidato: "nessuno libero nel deposito senza violazioni di riposo",
  candidati_finiti: "i liberi del deposito hanno già un turno della proposta",
} as const;

const orario = (t: Turno) => `${t.inizio ?? "?"}–${t.fine ?? "?"}`;
const domani = () => {
  const d = new Date(Date.now() + 86_400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(d);
};

export function CopriScopertiDialog({ onClose, giornoIniziale }: { onClose: () => void; giornoIniziale?: string }) {
  const qc = useQueryClient();
  const [day, setDay] = useState(giornoIniziale ?? domani());
  const [proposta, setProposta] = useState<Risposta | null>(null);

  const calcola = useMutation({
    mutationFn: () => apiFetch<Risposta>("/api/roster/copri-scoperti", { method: "POST", body: JSON.stringify({ day }) }),
    onSuccess: (r) => setProposta(r),
    onError: (e: Error) => toast.error("Proposta non calcolata", { description: e.message }),
  });
  const assegna = useMutation({
    mutationFn: () => apiFetch<Risposta>("/api/roster/copri-scoperti", { method: "POST", body: JSON.stringify({ day, applica: true }) }),
    onSuccess: (r) => {
      const n = r.assegnate?.length ?? 0;
      const restano = (r.scoperti?.length ?? 0) + (r.nonAndate?.length ?? 0);
      toast.success(`Assegnati ${n} turni`, { description: restano ? `${restano} restano da coprire a mano` : "Nessun turno scoperto" });
      qc.invalidateQueries({ queryKey: ["roster", "board"] });
      onClose();
    },
    onError: (e: Error) => toast.error("Assegnazione non riuscita", { description: e.message }),
  });

  const coperture = proposta?.coperture ?? [];
  const scoperti = proposta?.scoperti ?? [];
  const giornoOk = /^\d{4}-\d{2}-\d{2}$/.test(day);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><Wand2 className="w-4 h-4 text-violet-400" /> Copri gli scoperti</div>
          <button onClick={onClose} aria-label="Chiudi" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-[12px] text-slate-400">
            I turni pubblicati del giorno senza conducente, o col titolare assente, si propongono ai conducenti dello stesso
            deposito <b>liberi</b> o <b>a disposizione</b>, senza violazioni di riposo; a parità chi ha meno turni nei giorni
            intorno. Un turno a testa. Prima si guarda la proposta, poi si assegna: i controlli sono quelli dell&apos;assegnazione a mano.
          </p>
          <div className="flex items-end gap-3">
            <label className="block"><span className={LBL}>Giorno</span>
              <input id="copri-giorno" type="date" className={TEXT} value={day} onChange={(e) => { setDay(e.target.value); setProposta(null); }} />
            </label>
            <button
              className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={!giornoOk || calcola.isPending} onClick={() => calcola.mutate()}
            >
              {calcola.isPending ? "Calcolo…" : "Calcola la proposta"}
            </button>
          </div>

          {proposta && !proposta.pubblicato && (
            <p className="text-sm text-amber-300">Il giorno non ha turni pubblicati: pubblicali prima da «Turni al roster».</p>
          )}
          {proposta?.pubblicato && (
            <>
              <div className="text-sm">
                <b>{coperture.length}</b> turni coperti nella proposta · <b>{scoperti.length}</b> restano scoperti
              </div>
              {coperture.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-[12px]">
                    <thead className="bg-slate-950 text-slate-400">
                      <tr className="text-left"><th className="px-2 py-1.5">Turno</th><th className="px-2 py-1.5">Orario</th><th className="px-2 py-1.5">Deposito</th><th className="px-2 py-1.5">Conducente</th><th className="px-2 py-1.5">Era di</th></tr>
                    </thead>
                    <tbody>
                      {coperture.map((c) => (
                        <tr key={`${c.turno.dssId}|${c.turno.codice}`} className="border-t border-slate-800">
                          <td className="px-2 py-1 font-mono">{c.turno.codice}</td>
                          <td className="px-2 py-1 tabular-nums">{orario(c.turno)}</td>
                          <td className="px-2 py-1">{c.turno.deposito ?? "—"}</td>
                          <td className="px-2 py-1">{c.nome}{c.gruppo === "disposizione" ? <span className="ml-1 text-slate-400">(a disposizione)</span> : null}</td>
                          <td className="px-2 py-1 text-slate-400">{c.turno.titolare ? `${c.turno.titolare.nome ?? "titolare"} (assente)` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {scoperti.length > 0 && (
                <details className="text-[12px] text-slate-300">
                  <summary className="cursor-pointer">Restano scoperti ({scoperti.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {scoperti.map((s) => (
                      <li key={`${s.turno.dssId}|${s.turno.codice}`}>
                        <span className="font-mono">{s.turno.codice}</span> {orario(s.turno)} · {s.turno.deposito ?? "deposito non indicato"}: {MOTIVI[s.motivo]}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Annulla</button>
          <button
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            disabled={!coperture.length || assegna.isPending} onClick={() => assegna.mutate()}
          >
            {assegna.isPending ? "Assegno…" : `Assegna ${coperture.length} turni`}
          </button>
        </div>
      </div>
    </div>
  );
}
