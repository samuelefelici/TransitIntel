/**
 * «Importa turni esistenti» (tappa 7.38): carichi il file dei turni
 * dell'azienda, scegli il giorno, vedi quante corse si riconoscono nel GTFS
 * del progetto e salvi. Nascono uno scenario di turni macchina e uno di turni
 * guida, che si aprono come quelli calcolati da Cerbero.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, X } from "lucide-react";
import {
  anteprimaTurni, importaTurni, dataLeggibile, etichettaTipo, primaDataUtile, nomeProposto,
  riconosciute, percentuale, giudizio, type Anteprima,
} from "@/lib/turni-esistenti";

const oggi = () => new Date().toISOString().slice(0, 10);

export default function ImportaTurniDialog({ projectId, onClose, onImportato }: {
  projectId: string;
  onClose: () => void;
  onImportato: (vehicleScenarioId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<Anteprima | null>(null);
  const [giorno, setGiorno] = useState<Anteprima | null>(null);
  const [tipo, setTipo] = useState<string>("");
  const [data, setData] = useState<string>("");
  const [nome, setNome] = useState("");
  const [nomeToccato, setNomeToccato] = useState(false);
  const [leggo, setLeggo] = useState(false);
  const [controllo, setControllo] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [mostraNonTrovate, setMostraNonTrovate] = useState(false);
  const richiesta = useRef(0);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !salvo) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, salvo]);

  async function scegliFile(f: File | null) {
    setFile(f); setBase(null); setGiorno(null); setErrore(null); setTipo(""); setData("");
    if (!f) return;
    setLeggo(true);
    try {
      const a = await anteprimaTurni(projectId, f);
      setBase(a);
      const primo = a.tipiDiGiorno[0];
      if (primo) { setTipo(primo.chiave); setData(primaDataUtile(primo.date, oggi()) ?? ""); }
    } catch (e: any) {
      setErrore(e?.message ?? "Il file non si legge");
    } finally { setLeggo(false); }
  }

  const tipoScelto = useMemo(() => base?.tipiDiGiorno.find((t) => t.chiave === tipo) ?? null, [base, tipo]);

  /* a ogni giorno scelto, il controllo delle corse */
  useEffect(() => {
    if (!file || !data) return;
    const n = ++richiesta.current;
    setControllo(true); setGiorno(null); setErrore(null); setMostraNonTrovate(false);
    if (!nomeToccato) setNome(nomeProposto(data));
    anteprimaTurni(projectId, file, data)
      .then((a) => { if (n === richiesta.current) setGiorno(a); })
      .catch((e: any) => { if (n === richiesta.current) setErrore(e?.message ?? "Controllo non riuscito"); })
      .finally(() => { if (n === richiesta.current) setControllo(false); });
  }, [file, data, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importa() {
    if (!file || !data) return;
    setSalvo(true); setErrore(null);
    try {
      const r = await importaTurni(projectId, file, data, nome);
      toast.success("Turni importati", { description: `${r.resoconto.turniMacchina} turni macchina e ${r.resoconto.turniGuida} turni guida` });
      onImportato(r.vehicleScenarioId);
    } catch (e: any) {
      setErrore(e?.message ?? "Import non riuscito");
    } finally { setSalvo(false); }
  }

  const r = giorno?.resoconto;
  const g = r ? giudizio(r) : null;
  const pct = r ? percentuale(riconosciute(r), r.corseNelFile) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={() => !salvo && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="importa-turni-titolo" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-orange-500/30 bg-gradient-to-br from-zinc-950 to-black shadow-2xl">
        <div className="p-5 border-b border-zinc-800 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2 id="importa-turni-titolo" className="text-base font-bold text-zinc-100">Importa turni esistenti</h2>
            <p className="text-xs text-zinc-500 mt-1">
              Carica l'esportazione dei turni in vigore (file BDROP). Cerbero crea i turni macchina e i turni guida
              del giorno che scegli, agganciati alle corse del GTFS di questo progetto. Il file non viene conservato.
            </p>
          </div>
          <button onClick={onClose} disabled={salvo} aria-label="Chiudi" className="text-zinc-500 hover:text-zinc-200 p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 1. il file */}
          <section className="space-y-2">
            <label htmlFor="importa-turni-file" className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">1 · Il file dei turni</label>
            <label htmlFor="importa-turni-file"
              className="flex items-center gap-3 rounded-lg border border-dashed border-orange-500/40 bg-orange-500/5 hover:bg-orange-500/10 px-4 py-3 cursor-pointer transition-colors">
              {leggo ? <Loader2 className="w-4 h-4 text-orange-300 animate-spin" /> : <FileUp className="w-4 h-4 text-orange-300" />}
              <span className="text-sm text-zinc-200 truncate">{file ? file.name : "Scegli il file (.txt)"}</span>
              {file && <span className="ml-auto text-[10px] text-zinc-500 font-mono">{(file.size / 1024 / 1024).toFixed(1)} MB</span>}
            </label>
            <input id="importa-turni-file" type="file" accept=".txt,text/plain" className="sr-only"
              onChange={(e) => void scegliFile(e.target.files?.[0] ?? null)} />
            {base && (
              <p className="text-xs text-zinc-400">
                Turni in vigore dal <b className="text-zinc-200">{dataLeggibile(base.periodo.dal, false)}</b> al <b className="text-zinc-200">{dataLeggibile(base.periodo.al, false)}</b>
                {" "}· {base.tipiDiGiorno.length} tipi di giorno
              </p>
            )}
          </section>

          {/* 2. il giorno */}
          {base && (
            <section className="space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">2 · Il giorno da importare</span>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <select id="importa-turni-tipo" aria-label="Tipo di giorno" value={tipo}
                  onChange={(e) => {
                    const t = base.tipiDiGiorno.find((x) => x.chiave === e.target.value);
                    setTipo(e.target.value);
                    if (t) setData(primaDataUtile(t.date, oggi()) ?? "");
                  }}
                  className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200">
                  {base.tipiDiGiorno.map((t) => (
                    <option key={t.chiave} value={t.chiave}>
                      {etichettaTipo(t.nomi)} — {t.date.length} {t.date.length === 1 ? "giorno" : "giorni"}
                    </option>
                  ))}
                </select>
                <select id="importa-turni-data" aria-label="Data" value={data} onChange={(e) => setData(e.target.value)}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 font-mono">
                  {(tipoScelto?.date ?? []).map((d) => <option key={d} value={d}>{dataLeggibile(d)}</option>)}
                </select>
              </div>
              {tipoScelto && (
                <p className="text-[11px] text-zinc-500">
                  {tipoScelto.turniMacchina} turni macchina e {tipoScelto.turniGuida} turni guida nel file per questo tipo di giorno.
                </p>
              )}
            </section>
          )}

          {/* 3. le corse */}
          {(controllo || r) && (
            <section className="space-y-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">3 · Le corse nel GTFS del progetto</span>
              {controllo && !r ? (
                <p className="text-xs text-zinc-400"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Controllo le corse del {dataLeggibile(data)}…</p>
              ) : r && giorno ? (
                <>
                  <div className={`rounded-lg border p-3 ${g === "bene" ? "border-emerald-500/30 bg-emerald-500/5" : g === "attenzione" ? "border-amber-500/30 bg-amber-500/5" : "border-red-500/30 bg-red-500/5"}`}>
                    <div className="flex items-center gap-2">
                      {g === "bene" ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertTriangle className={`w-4 h-4 shrink-0 ${g === "attenzione" ? "text-amber-400" : "text-red-400"}`} />}
                      <p className="text-sm text-zinc-100">
                        <b>{riconosciute(r).toLocaleString("it-IT")}</b> corse del file riconosciute su {r.corseNelFile.toLocaleString("it-IT")} (<b>{pct}%</b>)
                      </p>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden" aria-hidden>
                      <div className={`h-full ${g === "bene" ? "bg-emerald-400" : g === "attenzione" ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-2">
                      {r.riconosciutePerNumero.toLocaleString("it-IT")} col numero della corsa, {r.riconosciutePerOrario.toLocaleString("it-IT")} con linea e orario.
                      {g !== "bene" && " Le corse non trovate restano fuori dai turni: di solito vuol dire che il GTFS del progetto è di un altro periodo."}
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                    {[
                      ["Turni macchina", r.turniMacchina],
                      ["Turni guida", r.turniGuida],
                      ["Corse non trovate", r.nonTrovate],
                      ["Corse del GTFS senza turno", r.corseDelGtfsSenzaTurno],
                    ].map(([k, v]) => (
                      <div key={k as string} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2">
                        <dd className="text-base font-bold text-zinc-100 tabular-nums">{(v as number).toLocaleString("it-IT")}</dd>
                        <dt className="text-[10px] text-zinc-500 leading-tight">{k}</dt>
                      </div>
                    ))}
                  </dl>
                  {r.turniMacchinaVuoti > 0 && (
                    <p className="text-[11px] text-zinc-500">{r.turniMacchinaVuoti} turni macchina del file non hanno nessuna corsa riconosciuta e non vengono creati.</p>
                  )}
                  {(giorno.nonTrovate?.length ?? 0) > 0 && (
                    <div>
                      <button onClick={() => setMostraNonTrovate((v) => !v)} className="text-[11px] text-orange-300 hover:text-orange-200">
                        {mostraNonTrovate ? "Nascondi" : "Mostra"} le corse non trovate{r.nonTrovate > (giorno.nonTrovate?.length ?? 0) ? ` (le prime ${giorno.nonTrovate!.length})` : ""}
                      </button>
                      {mostraNonTrovate && (
                        <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-zinc-800">
                          <table className="w-full text-[11px]">
                            <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
                              <tr><th className="text-left px-2 py-1">Linea</th><th className="text-left px-2 py-1">Orario</th><th className="text-left px-2 py-1">Da → a</th><th className="text-left px-2 py-1">Turno guida</th></tr>
                            </thead>
                            <tbody className="text-zinc-300">
                              {giorno.nonTrovate!.map((c, i) => (
                                <tr key={i} className="border-t border-zinc-900">
                                  <td className="px-2 py-1 font-mono">{c.linea ?? "—"}</td>
                                  <td className="px-2 py-1 font-mono tabular-nums">{c.partenza}–{c.arrivo}</td>
                                  <td className="px-2 py-1">{c.da} → {c.a}</td>
                                  <td className="px-2 py-1 font-mono">{c.turnoGuida}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="space-y-1">
                    <label htmlFor="importa-turni-nome" className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">Nome dei turni</label>
                    <input id="importa-turni-nome" value={nome} maxLength={120}
                      onChange={(e) => { setNome(e.target.value); setNomeToccato(true); }}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200" />
                  </div>
                </>
              ) : null}
            </section>
          )}

          {errore && (
            <p role="alert" className="text-xs text-red-300 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">{errore}</p>
          )}
        </div>

        <div className="p-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={salvo} className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Annulla
          </button>
          <button onClick={() => void importa()} disabled={!r || salvo || controllo || r.turniMacchina === 0}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 disabled:opacity-40 disabled:cursor-not-allowed">
            {salvo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
            {r ? `Importa ${r.turniMacchina} turni macchina e ${r.turniGuida} turni guida` : "Importa"}
          </button>
        </div>
      </div>
    </div>
  );
}
