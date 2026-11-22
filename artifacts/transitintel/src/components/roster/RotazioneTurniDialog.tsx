/**
 * «Crea rotazione turni» (PR 7.8): per un gruppo di rotazione, la tabella dei
 * posti (per ogni posto il turno dei feriali, del sabato e della domenica),
 * la data di riferimento, chi è su quale posto oggi; poi la rotazione
 * applicata a un periodo: proposta e assegnazione.
 * API: GET/PUT /api/roster/rotazioni-turni/:gruppo, POST …/applica.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface GruppoTurni { id: string; depositoCodice: string; nome: string; dataRiferimento: string | null; conducenti: number }
interface Posto { feriale: string | null; sabato: string | null; domenica: string | null }
interface Dettaglio {
  gruppo: { id: string; nome: string; depositoNome: string; cadenza: "settimanale" | "semimensile"; riferimento: string | null; scrive: boolean };
  posti: Posto[];
  periodoDiOggi: string;
  conducenti: Array<{ id: string; nome: string; fittizio: boolean; posizione: number | null; postoDiOggi: number | null }>;
}
interface Assegnazione { giorno: string; driverId: string; nome: string; posto: number; codice: string; dssId: string }
interface NonFatta { giorno: string | null; driverId: string; nome: string; posto: number | null; codice: string | null; motivo: keyof typeof MOTIVI }
interface Proposta { assegnazioni?: Assegnazione[]; fatte?: Assegnazione[]; nonFatte: NonFatta[]; nonAndate?: Array<{ assegnazione: Assegnazione; motivo: string }> }

const LBL = "block text-[11px] uppercase tracking-wide text-slate-400 mb-1";
const TEXT = "rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
const CELLA = "w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[12px] text-slate-100";
const MOTIVI = {
  non_pubblicato: "il turno non è pubblicato quel giorno",
  ambiguo: "il codice è in più turni guida pubblicati quel giorno",
  gia_assegnato: "il turno è già di un altro conducente",
  senza_posizione: "senza posizione nel gruppo",
  posizione_oltre: "posizione oltre i posti della tabella",
} as const;
const CADENZE = { settimanale: "ogni settimana (lunedì)", semimensile: "il 1° e il 16 del mese" } as const;

const giornoRoma = (piu: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date(Date.now() + piu * 86_400_000));
const data = (g: string) => g.split("-").reverse().slice(0, 2).join("/");
const vuoto = (): Posto => ({ feriale: null, sabato: null, domenica: null });

export function RotazioneTurniDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const gruppi = useQuery({ queryKey: ["roster", "gruppi-turni"], queryFn: () => apiFetch<{ gruppi: GruppoTurni[] }>("/api/roster/gruppi-turni").then((r) => r.gruppi) });
  const [gruppoId, setGruppoId] = useState("");
  const dettaglio = useQuery({
    queryKey: ["roster", "rotazioni-turni", gruppoId],
    queryFn: () => apiFetch<Dettaglio>(`/api/roster/rotazioni-turni/${gruppoId}`),
    enabled: !!gruppoId,
  });
  const [posti, setPosti] = useState<Posto[]>([]);
  const [riferimento, setRiferimento] = useState("");
  const [dal, setDal] = useState(giornoRoma(1));
  const [al, setAl] = useState(giornoRoma(14));
  const [proposta, setProposta] = useState<Proposta | null>(null);

  /* all'arrivo del gruppo: la sua tabella, o tanti posti vuoti quanti i conducenti */
  useEffect(() => {
    const d = dettaglio.data;
    if (!d) return;
    const n = Math.max(1, ...d.conducenti.map((c) => c.posizione ?? 0));
    setPosti(d.posti.length ? d.posti : Array.from({ length: n }, vuoto));
    setRiferimento(d.gruppo.riferimento ?? d.periodoDiOggi);
    setProposta(null);
  }, [dettaglio.data]);

  const salva = useMutation({
    mutationFn: () => apiFetch(`/api/roster/rotazioni-turni/${gruppoId}`, { method: "PUT", body: JSON.stringify({ dataRiferimento: riferimento, posti }) }),
    onSuccess: () => { toast.success("Tabella dei posti salvata"); qc.invalidateQueries({ queryKey: ["roster", "rotazioni-turni", gruppoId] }); },
    onError: (e: Error) => toast.error("Tabella non salvata", { description: e.message }),
  });
  const corpo = (applica: boolean) => JSON.stringify({ dal, al, ...(applica ? { applica: true } : {}) });
  const calcola = useMutation({
    mutationFn: () => apiFetch<Proposta>(`/api/roster/rotazioni-turni/${gruppoId}/applica`, { method: "POST", body: corpo(false) }),
    onSuccess: (r) => setProposta(r),
    onError: (e: Error) => toast.error("Proposta non calcolata", { description: e.message }),
  });
  const assegna = useMutation({
    mutationFn: () => apiFetch<Proposta>(`/api/roster/rotazioni-turni/${gruppoId}/applica`, { method: "POST", body: corpo(true) }),
    onSuccess: (r) => {
      const no = r.nonAndate?.length ?? 0;
      toast.success(`Assegnati ${r.fatte?.length ?? 0} turni`, { description: no ? `${no} non assegnati: ${r.nonAndate![0]!.motivo}` : "I turni rimasti si coprono con «Copri gli scoperti»" });
      qc.invalidateQueries({ queryKey: ["roster", "board"] });
      onClose();
    },
    onError: (e: Error) => toast.error("Rotazione non applicata", { description: e.message }),
  });

  const d = dettaglio.data;
  const salvata = useMemo(() => !!d && JSON.stringify(d.posti) === JSON.stringify(posti) && (d.gruppo.riferimento ?? d.periodoDiOggi) === riferimento && d.posti.length > 0, [d, posti, riferimento]);
  const cambia = (i: number, campo: keyof Posto, v: string) => { setPosti((p) => p.map((x, j) => (j === i ? { ...x, [campo]: v.trim() ? v : null } : x))); setProposta(null); };
  const chiDiOggi = (posto: number) => d?.conducenti.filter((c) => c.postoDiOggi === posto).map((c) => c.nome).join(", ") || "—";
  const nonFatteDelPeriodo = proposta?.nonFatte.filter((n) => n.giorno) ?? [];
  const nonFatteDelGruppo = proposta?.nonFatte.filter((n) => !n.giorno) ?? [];
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dal) && /^\d{4}-\d{2}-\d{2}$/.test(al) && al >= dal;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold flex items-center gap-2"><RefreshCw className="w-4 h-4 text-violet-400" /> Rotazione turni</div>
          <button onClick={onClose} aria-label="Chiudi" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5 space-y-4">
          <p className="text-[12px] text-slate-400">
            Ogni gruppo ha una tabella di posti: per ogni posto il turno dei feriali, del sabato e della domenica o festivo.
            Nel periodo della data di riferimento la posizione 1 è sul posto 1; a ogni cambio di periodo (la cadenza del deposito)
            ognuno passa al posto successivo. I conducenti, le posizioni e i gruppi si cambiano nella scheda del conducente.
          </p>
          <label className="block max-w-md"><span className={LBL}>Gruppo</span>
            <select id="rotazione-gruppo" className={`${TEXT} w-full`} value={gruppoId} onChange={(e) => { setGruppoId(e.target.value); setProposta(null); }}>
              <option value="">— scegli un gruppo —</option>
              {(gruppi.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.nome} · {g.depositoCodice} · {g.conducenti} conducenti</option>)}
            </select>
          </label>
          {gruppi.data && !gruppi.data.length && <p className="text-sm text-slate-300">Nessun gruppo di rotazione: si creano dando un gruppo ai conducenti nella loro scheda.</p>}

          {d && (
            <>
              <div className="flex flex-wrap items-end gap-4 text-[12px] text-slate-300">
                <div><span className={LBL}>Deposito</span>{d.gruppo.depositoNome}</div>
                <div><span className={LBL}>Cambio di periodo</span>{CADENZE[d.gruppo.cadenza]}</div>
                <label className="block"><span className={LBL}>Data di riferimento</span>
                  <input id="rotazione-riferimento" type="date" className={TEXT} value={riferimento} onChange={(e) => { setRiferimento(e.target.value); setProposta(null); }} disabled={!d.gruppo.scrive} />
                </label>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-950 text-slate-400">
                    <tr className="text-left"><th className="px-2 py-1.5 w-14">Posto</th><th className="px-2 py-1.5">Feriali</th><th className="px-2 py-1.5">Sabato</th><th className="px-2 py-1.5">Domenica e festivi</th><th className="px-2 py-1.5">Oggi</th><th className="w-8" /></tr>
                  </thead>
                  <tbody>
                    {posti.map((p, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-2 py-1 tabular-nums text-slate-400">{i + 1}</td>
                        {(["feriale", "sabato", "domenica"] as const).map((campo) => (
                          <td key={campo} className="px-2 py-1">
                            <input id={`posto-${i + 1}-${campo}`} aria-label={`Posto ${i + 1}, ${campo}`} className={CELLA} value={p[campo] ?? ""} maxLength={40}
                              disabled={!d.gruppo.scrive} onChange={(e) => cambia(i, campo, e.target.value)} placeholder="—" />
                          </td>
                        ))}
                        <td className="px-2 py-1 text-slate-400">{chiDiOggi(i + 1)}</td>
                        <td className="px-1">
                          {d.gruppo.scrive && posti.length > 1 && (
                            <button aria-label={`Togli il posto ${i + 1}`} className="p-1 text-slate-500 hover:text-rose-300" onClick={() => { setPosti((x) => x.filter((_, j) => j !== i)); setProposta(null); }}><Trash2 className="w-3.5 h-3.5" /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.gruppo.scrive && (
                <div className="flex flex-wrap gap-2">
                  <button className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-[12px] text-slate-200 hover:bg-slate-800" onClick={() => { setPosti((x) => [...x, vuoto()]); setProposta(null); }}>
                    <Plus className="w-3.5 h-3.5" /> Aggiungi un posto
                  </button>
                  <button className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50" disabled={salvata || salva.isPending} onClick={() => salva.mutate()}>
                    {salva.isPending ? "Salvo…" : salvata ? "Tabella salvata" : "Salva la tabella"}
                  </button>
                </div>
              )}
              {d.conducenti.length > 0 && (
                <details className="text-[12px] text-slate-300">
                  <summary className="cursor-pointer">Conducenti del gruppo ({d.conducenti.length})</summary>
                  <ul className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                    {d.conducenti.map((c) => (
                      <li key={c.id} className="flex justify-between gap-2">
                        <span className="truncate">{c.nome}{c.fittizio ? <span className="text-slate-500"> (fittizio)</span> : null}</span>
                        <span className="tabular-nums text-slate-400">posizione {c.posizione ?? "—"} · oggi posto {c.postoDiOggi ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {d.gruppo.scrive && (
                <section className="rounded-lg border border-slate-800 p-3 space-y-3">
                  <div className="text-sm font-medium">Applica la rotazione</div>
                  {!salvata && <p className="text-[12px] text-amber-300">Salva prima la tabella: la proposta usa quella salvata.</p>}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block"><span className={LBL}>Dal</span>
                      <input id="rotazione-dal" type="date" className={TEXT} value={dal} min={giornoRoma(1)} onChange={(e) => { setDal(e.target.value); setProposta(null); }} />
                    </label>
                    <label className="block"><span className={LBL}>Al</span>
                      <input id="rotazione-al" type="date" className={TEXT} value={al} min={dal} onChange={(e) => { setAl(e.target.value); setProposta(null); }} />
                    </label>
                    <button className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                      disabled={!salvata || !dateOk || calcola.isPending} onClick={() => calcola.mutate()}>
                      {calcola.isPending ? "Calcolo…" : "Calcola la proposta"}
                    </button>
                  </div>
                  {proposta && (
                    <div className="space-y-2 text-[12px]">
                      <div className="text-sm"><b>{proposta.assegnazioni?.length ?? 0}</b> turni da assegnare · <b>{nonFatteDelPeriodo.length}</b> non assegnabili</div>
                      {nonFatteDelGruppo.length > 0 && (
                        <ul className="text-amber-300">{nonFatteDelGruppo.map((n) => <li key={n.driverId}>{n.nome}: {MOTIVI[n.motivo]}</li>)}</ul>
                      )}
                      {(proposta.assegnazioni?.length ?? 0) > 0 && (
                        <details>
                          <summary className="cursor-pointer">Le assegnazioni</summary>
                          <ul className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2 tabular-nums">
                            {proposta.assegnazioni!.map((a) => <li key={`${a.giorno}|${a.driverId}`}>{data(a.giorno)} · <span className="font-mono">{a.codice}</span> · {a.nome} <span className="text-slate-500">(posto {a.posto})</span></li>)}
                          </ul>
                        </details>
                      )}
                      {nonFatteDelPeriodo.length > 0 && (
                        <details>
                          <summary className="cursor-pointer">Non assegnabili ({nonFatteDelPeriodo.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {nonFatteDelPeriodo.map((n) => <li key={`${n.giorno}|${n.driverId}`}>{data(n.giorno!)} · <span className="font-mono">{n.codice}</span> · {n.nome}: {MOTIVI[n.motivo]}</li>)}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Chiudi</button>
          <button
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            disabled={!proposta?.assegnazioni?.length || assegna.isPending} onClick={() => assegna.mutate()}
          >
            {assegna.isPending ? "Assegno…" : `Assegna ${proposta?.assegnazioni?.length ?? 0} turni`}
          </button>
        </div>
      </div>
    </div>
  );
}
