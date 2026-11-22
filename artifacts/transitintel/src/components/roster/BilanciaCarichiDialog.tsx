/**
 * «Bilancia i carichi» (PR 7.7): per un periodo, la proposta dell'API
 * (POST /api/roster/bilancia-carichi) e poi l'applicazione. Le mosse le
 * sceglie l'API: turni ceduti a chi è libero o scambiati nello stesso giorno,
 * fra conducenti dello stesso deposito, senza violazioni di riposo. Qui si
 * guarda e si conferma.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Scale, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Pezzo { id: string; codice: string; dssId: string; minuti: number }
interface Mossa { tipo: "cede" | "scambio"; giorno: string; da: { id: string; nome: string }; a: { id: string; nome: string }; turno: Pezzo; inCambio: Pezzo | null }
interface Carico { id: string; nome: string; prima: number; dopo: number; turniPrima: number; turniDopo: number }
interface Deposito { deposito: string; conducenti: number; scartoPrima: number; scartoDopo: number; mosse: Mossa[]; carichi: Carico[] }
interface Proposta { dal: string; al: string; depositi: Deposito[] }
interface Esito { fatte: Mossa[]; nonAndate: Array<{ mossa: Mossa; motivo: string }> }

const LBL = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const TEXT = "rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";

const giornoRoma = (piu: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date(Date.now() + piu * 86_400_000));
const ore = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`;
const data = (g: string) => g.split("-").reverse().slice(0, 2).join("/");
const turni = (n: number) => `${n} ${n === 1 ? "turno" : "turni"}`;

export function BilanciaCarichiDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [dal, setDal] = useState(giornoRoma(1));
  const [al, setAl] = useState(giornoRoma(14));
  const [proposta, setProposta] = useState<Proposta | null>(null);

  const corpo = (applica: boolean) => JSON.stringify({ dal, al, ...(applica ? { applica: true } : {}) });
  const calcola = useMutation({
    mutationFn: () => apiFetch<Proposta>("/api/roster/bilancia-carichi", { method: "POST", body: corpo(false) }),
    onSuccess: (r) => setProposta(r),
    onError: (e: Error) => toast.error("Proposta non calcolata", { description: e.message }),
  });
  const applica = useMutation({
    mutationFn: () => apiFetch<Esito>("/api/roster/bilancia-carichi", { method: "POST", body: corpo(true) }),
    onSuccess: (r) => {
      const n = r.fatte.length, no = r.nonAndate.length;
      toast.success(`Fatti ${n} spostamenti`, { description: no ? `${no} non si sono potuti fare: ${r.nonAndate[0]!.motivo}` : "I carichi sono più vicini" });
      qc.invalidateQueries({ queryKey: ["roster", "board"] });
      onClose();
    },
    onError: (e: Error) => toast.error("Spostamenti non fatti", { description: e.message }),
  });

  const mosse = proposta?.depositi.reduce((n, d) => n + d.mosse.length, 0) ?? 0;
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dal) && /^\d{4}-\d{2}-\d{2}$/.test(al) && al >= dal;
  const cambia = (f: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { f(e.target.value); setProposta(null); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><Scale className="w-4 h-4 text-violet-400" /> Bilancia i carichi</div>
          <button onClick={onClose} aria-label="Chiudi" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-[12px] text-slate-400">
            Nel periodo, i turni già assegnati passano da chi lavora più ore a chi ne lavora meno, nello stesso deposito:
            a chi quel giorno è <b>libero</b> (senza turni né voci), oppure con uno <b>scambio</b> fra due turni dello stesso giorno.
            Non si toccano le sostituzioni, i turni forzati, chi è fittizio; nessuna mossa crea violazioni di riposo.
            Prima si guarda la proposta, poi si applica: i controlli sono quelli del cambio turno a mano.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className={LBL}>Dal</span>
              <input id="bilancia-dal" type="date" className={TEXT} value={dal} min={giornoRoma(1)} onChange={cambia(setDal)} />
            </label>
            <label className="block"><span className={LBL}>Al</span>
              <input id="bilancia-al" type="date" className={TEXT} value={al} min={dal} onChange={cambia(setAl)} />
            </label>
            <button
              className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              disabled={!dateOk || calcola.isPending} onClick={() => calcola.mutate()}
            >
              {calcola.isPending ? "Calcolo…" : "Calcola la proposta"}
            </button>
          </div>

          {proposta && !proposta.depositi.length && (
            <p className="text-sm text-slate-300">Nessun deposito con almeno due conducenti su cui scrivi.</p>
          )}
          {proposta?.depositi.map((d) => (
            <section key={d.deposito} className="rounded-lg border border-slate-800">
              <header className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 bg-slate-950/60">
                <div className="text-sm font-medium">{d.deposito} <span className="text-slate-400 font-normal">· {d.conducenti} conducenti</span></div>
                <div className="text-[12px] tabular-nums text-slate-300">
                  scarto fra il più carico e il meno carico: <b>{ore(d.scartoPrima)}</b>
                  {d.mosse.length ? <> → <b className="text-emerald-300">{ore(d.scartoDopo)}</b></> : null}
                </div>
              </header>
              {d.mosse.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-slate-400">Niente da spostare: i carichi sono già vicini, o nessuna mossa evita le violazioni.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead className="text-slate-400">
                      <tr className="text-left"><th className="px-3 py-1">Giorno</th><th className="px-3 py-1">Turno</th><th className="px-3 py-1">Da</th><th className="px-3 py-1">A</th><th className="px-3 py-1">In cambio</th></tr>
                    </thead>
                    <tbody>
                      {d.mosse.map((m) => (
                        <tr key={`${m.giorno}|${m.turno.id}`} className="border-t border-slate-800">
                          <td className="px-3 py-1 tabular-nums">{data(m.giorno)}</td>
                          <td className="px-3 py-1 font-mono">{m.turno.codice} <span className="text-slate-400 font-sans">{ore(m.turno.minuti)}</span></td>
                          <td className="px-3 py-1">{m.da.nome}</td>
                          <td className="px-3 py-1">{m.a.nome}</td>
                          <td className="px-3 py-1 text-slate-400">{m.inCambio ? <><span className="font-mono">{m.inCambio.codice}</span> {ore(m.inCambio.minuti)}</> : "— (era libero)"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <details className="px-3 py-2 text-[12px] text-slate-300 border-t border-slate-800">
                <summary className="cursor-pointer">Ore per conducente</summary>
                <ul className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 tabular-nums">
                  {d.carichi.map((c) => (
                    <li key={c.id} className="flex justify-between gap-2">
                      <span className="truncate">{c.nome}</span>
                      <span>{ore(c.prima)} · {turni(c.turniPrima)}{c.dopo !== c.prima ? <> → <b>{ore(c.dopo)}</b> · {turni(c.turniDopo)}</> : null}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Annulla</button>
          <button
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            disabled={!mosse || applica.isPending} onClick={() => applica.mutate()}
          >
            {applica.isPending ? "Applico…" : `Applica ${mosse} spostamenti`}
          </button>
        </div>
      </div>
    </div>
  );
}
