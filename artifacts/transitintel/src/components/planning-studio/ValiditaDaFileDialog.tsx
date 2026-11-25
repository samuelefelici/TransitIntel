/**
 * «Validità dal file dei turni» (tappa 7.39): nella pagina Validità di
 * Planning Studio. Si carica l'esportazione dei turni in vigore; per ogni
 * corsa del progetto che si ritrova nel file, la validità diventa quella del
 * file (periodo, giorni tipo, giorni in cui non gira). Prima un'anteprima,
 * poi «Applica»; alla fine la verifica e il passo successivo (Calcola Unità).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Rocket, X } from "lucide-react";
import {
  anteprimaValidita, applicaValidita, dataLeggibile, percentuale,
  type AnteprimaValidita, type EsitoValidita,
} from "@/lib/turni-esistenti";

const n = (v: number) => v.toLocaleString("it-IT");

export default function ValiditaDaFileDialog({ projectId, canEdit, onClose, onApplicato, onCalcolaUnita }: {
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
  /** le validità sono cambiate: la matrice va riletta */
  onApplicato: () => void;
  /** il passo successivo: apre «Calcola Unità» */
  onCalcolaUnita: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [anteprima, setAnteprima] = useState<AnteprimaValidita | null>(null);
  const [esito, setEsito] = useState<EsitoValidita | null>(null);
  const [leggo, setLeggo] = useState(false);
  const [applico, setApplico] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [elenco, setElenco] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !applico) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, applico]);

  async function scegli(f: File | null) {
    setFile(f); setAnteprima(null); setEsito(null); setErrore(null); setElenco(false);
    if (!f) return;
    setLeggo(true);
    try { setAnteprima(await anteprimaValidita(projectId, f)); }
    catch (e: any) { setErrore(e?.message ?? "Il file non si legge"); }
    finally { setLeggo(false); }
  }

  async function applica() {
    if (!file) return;
    setApplico(true); setErrore(null);
    try {
      const r = await applicaValidita(projectId, file);
      setEsito(r);
      onApplicato();
      toast.success("Validità aggiornate", { description: `${n(r.corseDaAggiornare)} corse con le date del file` });
    } catch (e: any) {
      setErrore(e?.message ?? "Non riuscito");
    } finally { setApplico(false); }
  }

  const a = esito ?? anteprima;
  const riconosciute = a ? a.riconosciutePerNumero + a.riconosciutePerOrario : 0;
  const pct = a ? percentuale(riconosciute, a.corseNelFile) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={() => !applico && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="validita-file-titolo" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-slate-700 bg-slate-950 shadow-2xl">
        <div className="p-5 border-b border-slate-800 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 id="validita-file-titolo" className="text-base font-semibold text-slate-100">Validità dal file dei turni</h2>
            <p className="text-xs text-slate-400 mt-1">
              Carica l'esportazione dei turni in vigore (file BDROP). Il file dice in quali giorni gira ogni corsa:
              per ogni corsa del progetto che si ritrova nel file, Cerbero scrive quelle date come sua validità.
              Le corse che il file non ha restano come sono. Il file non viene conservato.
            </p>
          </div>
          <button onClick={onClose} disabled={applico} aria-label="Chiudi" className="text-slate-500 hover:text-slate-200 p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!esito && (
            <section className="space-y-2">
              <label htmlFor="validita-file" className="flex items-center gap-3 rounded-lg border border-dashed border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 px-4 py-3 cursor-pointer transition-colors">
                {leggo ? <Loader2 className="w-4 h-4 text-emerald-300 animate-spin" /> : <FileUp className="w-4 h-4 text-emerald-300" />}
                <span className="text-sm text-slate-200 truncate">{file ? file.name : "Scegli il file dei turni (.txt)"}</span>
                {leggo && <span className="ml-auto text-[11px] text-slate-500">confronto le corse col progetto…</span>}
              </label>
              <input id="validita-file" type="file" accept=".txt,text/plain" className="sr-only" disabled={!canEdit}
                onChange={(e) => void scegli(e.target.files?.[0] ?? null)} />
              {!canEdit && <p className="text-[11px] text-amber-300">Hai il progetto in sola lettura: puoi vedere l'anteprima solo chi lo modifica.</p>}
            </section>
          )}

          {a && (
            <section className="space-y-3">
              <p className="text-xs text-slate-400">
                Turni in vigore dal <b className="text-slate-200">{dataLeggibile(a.periodo.dal, false)}</b> al <b className="text-slate-200">{dataLeggibile(a.periodo.al, false)}</b>: è il periodo che prendono le corse aggiornate.
              </p>

              {esito ? (
                <div className={`rounded-lg border p-3 ${esito.verifica.diverse === 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
                  <div className="flex items-center gap-2">
                    {esito.verifica.diverse === 0 ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                    <p className="text-sm text-slate-100">
                      <b>{n(esito.corseDaAggiornare)}</b> corse aggiornate. Verifica: <b>{n(esito.verifica.esatte)}</b> girano esattamente nei giorni del file
                      {esito.verifica.diverse > 0 && <>, <b>{n(esito.verifica.diverse)}</b> no</>}.
                    </p>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2">
                    {esito.progettiFucinaSincronizzati === 1
                      ? "Il progetto di Fucina di questo programma sta rifacendo il suo feed con le validità nuove."
                      : esito.progettiFucinaSincronizzati > 1
                        ? `I ${n(esito.progettiFucinaSincronizzati)} progetti di Fucina di questo programma stanno rifacendo il loro feed con le validità nuove.`
                        : "Non ci sono ancora progetti di Fucina di questo programma."}
                  </p>
                </div>
              ) : (
                <div className={`rounded-lg border p-3 ${pct >= 70 ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
                  <p className="text-sm text-slate-100">
                    <b>{n(a.corseDaAggiornare)}</b> corse del progetto prenderanno la validità del file
                    <span className="text-slate-400"> su {n(a.corseDelProgetto)}</span>
                  </p>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Del file si ritrovano {n(riconosciute)} corse su {n(a.corseNelFile)} ({pct}%): {n(a.riconosciutePerNumero)} col numero della corsa, {n(a.riconosciutePerOrario)} con linea e orario.
                    {pct < 70 && " Se sono poche, il GTFS del progetto è probabilmente di un altro periodo."}
                  </p>
                </div>
              )}

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                {[
                  ["Giorni in cui non girano", a.dateSpente],
                  ["Corse del progetto non nel file", a.corseDelProgettoFuoriDalFile],
                  ["Corse del file incerte", a.incerte],
                  ["Corse del file non trovate", a.nonTrovate],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-2">
                    <dd className="text-base font-semibold text-slate-100 tabular-nums">{n(v as number)}</dd>
                    <dt className="text-[10px] text-slate-500 leading-tight">{k}</dt>
                  </div>
                ))}
              </dl>
              <ul className="text-[11px] text-slate-400 space-y-1 list-disc pl-4">
                <li>Le corse del progetto non nel file restano con la validità di prima.</li>
                {a.incerte > 0 && <li>Una corsa del file è «incerta» quando nel progetto ci sono più corse con la stessa linea e lo stesso orario: non si sceglie a caso, resta fuori.</li>}
                {a.corseSpenteNelProgetto > 0 && <li>{n(a.corseSpenteNelProgetto)} corse sono spente nel progetto: non si toccano.</li>}
                {!esito && <li className="text-amber-300">Per le corse aggiornate la validità di prima si sostituisce, eccezioni messe a mano comprese; le loro categorie (Scuole aperte, chiuse…) non si ricalcolano più da sole.</li>}
              </ul>

              {a.elencoNonTrovate.length > 0 && (
                <div>
                  <button onClick={() => setElenco((v) => !v)} className="text-[11px] text-emerald-300 hover:text-emerald-200">
                    {elenco ? "Nascondi" : "Mostra"} le corse incerte e non trovate{a.incerte + a.nonTrovate > a.elencoNonTrovate.length ? ` (le prime ${n(a.elencoNonTrovate.length)})` : ""}
                  </button>
                  {elenco && (
                    <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-800">
                      <table className="w-full text-[11px]">
                        <thead className="sticky top-0 bg-slate-900 text-slate-500">
                          <tr><th className="text-left px-2 py-1">Linea</th><th className="text-left px-2 py-1">Orario</th><th className="text-left px-2 py-1">Da → a</th><th className="text-left px-2 py-1">Turno guida</th><th className="text-left px-2 py-1">Perché</th></tr>
                        </thead>
                        <tbody className="text-slate-300">
                          {a.elencoNonTrovate.map((c, i) => (
                            <tr key={i} className="border-t border-slate-900">
                              <td className="px-2 py-1 font-mono">{c.linea ?? "—"}</td>
                              <td className="px-2 py-1 font-mono tabular-nums">{c.partenza}–{c.arrivo}</td>
                              <td className="px-2 py-1">{c.da} → {c.a}</td>
                              <td className="px-2 py-1 font-mono">{c.turnoGuida}</td>
                              <td className="px-2 py-1">{c.incerta ? "incerta" : "non trovata"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {esito && (
                <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
                  <p className="text-xs text-slate-200 font-semibold">Il passo successivo, per i turni</p>
                  <ol className="text-[11px] text-slate-400 space-y-0.5 list-decimal pl-4">
                    <li>«Calcola Unità»: raggruppa i giorni con le stesse corse (di solito i tipi di giorno del file).</li>
                    <li>Fucina › Progetti di esercizio › questo programma: avvia il progetto di un'unità.</li>
                    <li>Nel progetto di Fucina › Scenari vetture › «Importa turni esistenti», con un giorno dell'unità.</li>
                  </ol>
                  <button onClick={onCalcolaUnita}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold hover:from-indigo-500 hover:to-violet-500">
                    <Rocket className="h-3.5 w-3.5" /> Calcola Unità ora
                  </button>
                </div>
              )}
            </section>
          )}

          {errore && <p role="alert" className="text-xs text-red-300 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">{errore}</p>}
        </div>

        <div className="p-3 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={applico} className="px-3 py-1.5 rounded-md text-xs text-slate-400 hover:text-slate-200 transition-colors">
            {esito ? "Chiudi" : "Annulla"}
          </button>
          {!esito && (
            <button onClick={() => void applica()} disabled={!anteprima || applico || leggo || !canEdit || anteprima.corseDaAggiornare === 0}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed">
              {applico ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {anteprima ? `Applica a ${n(anteprima.corseDaAggiornare)} corse` : "Applica"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
