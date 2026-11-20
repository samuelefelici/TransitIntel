/**
 * Una linea della bigliettazione accanto alla linea dell'azienda a cui è
 * abbinata (tappa 6.34b): per ogni suo percorso il percorso dell'azienda, la
 * fermata di ogni punto tariffario, i km nuovi e le fasce nuove. Le
 * differenze si scaricano in CSV: sono l'elenco da ribattere a mano nella
 * bigliettazione.
 *
 * API: /api/fares/polimetriche/ufficiale/linea (routes/fares-polimetriche-ufficiale.ts).
 * I conti in lib/polimetrica-confronto.ts.
 */
import React from "react";
import { ArrowLeft, Download, Loader2, Milestone, RotateCcw, Save } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { FasciaKm } from "@/lib/fasce-km";
import {
  confronta, corpoDecisione, csvCoppie, csvPunti, ETICHETTE_ESITO, fermateNelVerso, nodiDaiPunti, nomeFile, riassunto, sceltaIniziale, sceltaPerPercorso,
  type DettaglioLinea, type Esito, type PercorsoAzienda, type PercorsoUfficiale, type Scelta, type Verso,
} from "@/lib/polimetrica-confronto";

/** I nodi da portare nell'area di lavoro di un percorso dell'azienda. */
export interface NodiDaApplicare {
  lineCode: string; routeId: string; variantId: string; direction: Verso;
  boundaries: number[]; scelte: number[]; nodeNames: Record<number, string>;
}

const km1 = (n: number | null) => (n == null ? "—" : n.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
const conSegno = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${km1(n)}`);
const chiave = (p: { percorso: string; direzione: string }) => `${p.percorso}\u0000${p.direzione}`;

const COLORE_ESITO: Record<Esito, string> = {
  uguale: "text-emerald-300/70", cambia: "text-amber-300", spenta: "text-sky-300/80", manca: "text-rose-300",
};

function scarica(nome: string, testo: string) {
  const url = URL.createObjectURL(new Blob([testo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function ConfrontoLinea({ importId, linea, fasce, onIndietro, onUsaNodi }: {
  importId: string; linea: string; fasce: readonly FasciaKm[];
  onIndietro: () => void;
  onUsaNodi: (n: NodiDaApplicare) => void;
}) {
  const { toast } = useToast();
  const [dettaglio, setDettaglio] = React.useState<DettaglioLinea | null>(null);
  const [errore, setErrore] = React.useState<string | null>(null);
  const [aperto, setAperto] = React.useState<string | null>(null);              // il percorso della bigliettazione che si guarda
  const [scelte, setScelte] = React.useState<Record<string, Scelta | null>>({});  // la scelta su cui si lavora, per percorso
  const [salvate, setSalvate] = React.useState<Record<string, boolean>>({});      // quella scelta è la decisione salvata
  const [salvando, setSalvando] = React.useState(false);
  const [soloDifferenze, setSoloDifferenze] = React.useState(true);

  const leggi = React.useCallback(async () => {
    try {
      const d = await apiFetch<DettaglioLinea>(`/api/fares/polimetriche/ufficiale/linea?codice=${encodeURIComponent(linea)}&importId=${encodeURIComponent(importId)}`);
      setDettaglio(d);
      const iniziali = d.percorsi.map((p) => [chiave(p), sceltaIniziale(p)] as const);
      setScelte(Object.fromEntries(iniziali.map(([k, s]) => [k, s.scelta])));
      setSalvate(Object.fromEntries(iniziali.map(([k, s]) => [k, s.salvata])));
      setAperto((prima) => (prima && d.percorsi.some((p) => chiave(p) === prima) ? prima : d.percorsi[0] ? chiave(d.percorsi[0]) : null));
      setErrore(null);
    } catch (e: any) {
      setErrore(e?.message || "Linea non leggibile");
    }
  }, [importId, linea]);
  React.useEffect(() => { void leggi(); }, [leggi]);

  const percorso: PercorsoUfficiale | null = dettaglio?.percorsi.find((p) => chiave(p) === aperto) ?? null;
  const scelta = percorso ? scelte[chiave(percorso)] ?? null : null;
  const aziendale: PercorsoAzienda | null = scelta ? dettaglio?.percorsiAzienda.find((x) => x.routeId === scelta.routeId && x.variantId === scelta.variantId) ?? null : null;
  const fermate = React.useMemo(() => (aziendale && scelta ? fermateNelVerso(aziendale.fermate, scelta.verso) : []), [aziendale, scelta]);
  const confronto = React.useMemo(
    () => (percorso && scelta && dettaglio ? confronta(percorso, dettaglio.righe, fermate, scelta, fasce) : null),
    [percorso, scelta, dettaglio, fermate, fasce]);

  /* le voci della tendina dei percorsi dell'azienda: prima dove si ritrovano i punti, poi gli altri, nei due versi */
  const voci = React.useMemo(() => {
    if (!percorso || !dettaglio) return [];
    const trovati = new Map(percorso.candidati.map((c) => [`${c.routeId}\u0000${c.variantId}\u0000${c.verso}`, c.trovati]));
    const tutte = dettaglio.percorsiAzienda.flatMap((x) => (["AB", "BA"] as const).map((verso) => {
      const n = trovati.get(`${x.routeId}\u0000${x.variantId}\u0000${verso}`) ?? 0;
      const [da, a] = verso === "AB" ? [x.da, x.a] : [x.a, x.da];
      return {
        routeId: x.routeId, variantId: x.variantId, verso, trovati: n,
        etichetta: `${da} → ${a} · ${x.fermate.length} fermate · ${km1(x.km)} km · ${x.corse} corse${verso === "BA" ? " · al contrario" : ""}${n ? ` · ${n} punti su ${percorso.punti.length}` : ""}`,
      };
    }));
    return tutte.sort((x, y) => y.trovati - x.trovati);
  }, [percorso, dettaglio]);

  const cambia = (s: Scelta) => {
    if (!percorso) return;
    setScelte((prima) => ({ ...prima, [chiave(percorso)]: s }));
    setSalvate((prima) => ({ ...prima, [chiave(percorso)]: false }));
  };

  const salva = async () => {
    if (!percorso || !scelta || !dettaglio) return;
    setSalvando(true);
    try {
      await apiFetch("/api/fares/polimetriche/ufficiale/linea/punti", { method: "PUT", body: JSON.stringify(corpoDecisione(importId, dettaglio.linea, percorso, scelta)) });
      setSalvate((prima) => ({ ...prima, [chiave(percorso)]: true }));
      toast({ title: "Abbinamento salvato", description: `${riassunto(confronto!).abbinati} punti su ${percorso.punti.length} con la loro fermata` });
    } catch (e: any) {
      toast({ title: "Abbinamento non salvato", description: e?.message || "Errore", variant: "destructive" });
    } finally {
      setSalvando(false);
    }
  };

  const tornaAllaProposta = async () => {
    if (!percorso || !dettaglio) return;
    try {
      if (percorso.deciso) {
        const q = new URLSearchParams({ codice: dettaglio.linea, percorso: percorso.percorso, direzione: percorso.direzione });
        await apiFetch(`/api/fares/polimetriche/ufficiale/linea/punti?${q}`, { method: "DELETE" });
      }
      await leggi();
    } catch (e: any) {
      toast({ title: "Non riuscito", description: e?.message || "Errore", variant: "destructive" });
    }
  };

  if (errore) return (
    <div className="p-6 space-y-3">
      <p role="alert" className="text-sm text-red-300">{errore}</p>
      <button type="button" onClick={onIndietro} className="text-[12px] text-emerald-300 hover:underline flex items-center gap-1"><ArrowLeft className="w-3.5 h-3.5" /> Indietro</button>
    </div>
  );
  if (!dettaglio) return <div className="h-full flex items-center justify-center text-emerald-400/50"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const r = confronto ? riassunto(confronto) : null;
  const dove = percorso ? { linea: dettaglio.linea, percorso: percorso.percorso, direzione: percorso.direzione } : null;
  const coppieVisibili = confronto ? confronto.coppie.filter((x) => !soloDifferenze || x.esito !== "uguale") : [];

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-emerald-50">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onIndietro}
          className="text-[12px] px-2.5 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1.5">
          <ArrowLeft className="w-3.5 h-3.5" /> Indietro
        </button>
        <h2 className="text-base font-bold text-emerald-200">
          Linea <span className="font-mono">{dettaglio.linea}</span> della bigliettazione
          {dettaglio.abbinata && <> <span className="text-emerald-400/60 font-normal">accanto alla linea</span> <span className="font-mono">{dettaglio.abbinata}</span></>}
        </h2>
      </div>

      {!dettaglio.abbinata && (
        <p role="alert" className="text-[12px] px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200">
          Questa linea non è abbinata a una linea dell'azienda: prima si abbina, dall'elenco delle linee.
        </p>
      )}

      {/* ── I percorsi della bigliettazione ── */}
      {dettaglio.percorsi.length > 0 && (
        <div role="tablist" aria-label="Percorsi della linea nella bigliettazione" className="flex flex-wrap gap-1.5">
          {dettaglio.percorsi.map((p) => {
            const k = chiave(p), attivo = k === aperto;
            return (
              <button key={k} type="button" role="tab" aria-selected={attivo} onClick={() => setAperto(k)}
                className={`text-[11px] px-2.5 py-1.5 rounded-lg border text-left transition-colors ${attivo ? "bg-emerald-500/25 border-emerald-400/50 text-emerald-50" : "border-emerald-800/50 text-emerald-300/70 hover:bg-emerald-500/10"}`}>
                <span className="font-semibold">Percorso {p.percorso} · direzione {p.direzione}</span>
                <span className="block text-[10px] opacity-80">{p.punti[0]?.nome ?? p.punti[0]?.codice} → {p.punti[p.punti.length - 1]?.nome ?? p.punti[p.punti.length - 1]?.codice} · {p.punti.length} punti{salvate[k] ? " · salvato" : ""}</span>
              </button>
            );
          })}
        </div>
      )}
      {dettaglio.percorsi.length === 0 && (
        <p className="text-[12px] text-emerald-300/70">Questa linea non ha punti tariffari nella bigliettazione: ha solo {dettaglio.righe.length} righe, e non c'è niente da mettere sulle fermate.</p>
      )}

      {percorso && dettaglio.abbinata && (
        <>
          {/* ── Il percorso dell'azienda ── */}
          <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/30 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="confronto-percorso-azienda" className="text-[11px] text-emerald-300/70">Percorso dell'azienda</label>
              <select id="confronto-percorso-azienda"
                value={scelta ? voci.findIndex((v) => v.routeId === scelta.routeId && v.variantId === scelta.variantId && v.verso === scelta.verso) : -1}
                onChange={(e) => { const v = voci[Number(e.target.value)]; if (v) cambia(sceltaPerPercorso(percorso, v.routeId, v.variantId, v.verso)); }}
                className="flex-1 min-w-64 text-[12px] px-2 py-1 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-100 focus:outline-none focus:border-emerald-400/70">
                {!scelta && <option value={-1}>— scegli un percorso —</option>}
                {voci.map((v, i) => <option key={`${v.routeId}-${v.variantId}-${v.verso}`} value={i}>{v.etichetta}</option>)}
              </select>
            </div>
            {voci.length === 0 && <p className="text-[11px] text-amber-200">La linea {dettaglio.abbinata} non ha percorsi in questa fotografia del programma.</p>}
            {percorso.deciso && !percorso.deciso.nellImport && (
              <p className="text-[11px] text-amber-200">L'abbinamento salvato era su un percorso che in questa fotografia del programma non c'è più: qui sotto c'è la proposta.</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={salva} disabled={!scelta || salvando || salvate[chiave(percorso)]}
                className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500 text-emerald-950 font-semibold hover:bg-emerald-400 disabled:opacity-40 flex items-center gap-1.5">
                {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {salvate[chiave(percorso)] ? "Abbinamento salvato" : "Salva l'abbinamento"}
              </button>
              <button type="button" onClick={tornaAllaProposta}
                title="Rimette le fermate che propone Cerbero e toglie l'abbinamento salvato di questo percorso"
                className="text-[12px] px-3 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1.5">
                <RotateCcw className="w-3.5 h-3.5" /> Torna alla proposta
              </button>
              <button type="button" disabled={!confronto || !aziendale || !scelta || (r?.abbinati ?? 0) < 2}
                onClick={() => {
                  if (!confronto || !aziendale || !scelta) return;
                  const n = nodiDaiPunti(confronto, fermate);
                  onUsaNodi({ lineCode: dettaglio.abbinata!, routeId: aziendale.routeId, variantId: aziendale.variantId, direction: scelta.verso, boundaries: n.confini, scelte: n.scelte, nodeNames: n.nomi });
                }}
                title="Apre il percorso nell'area di lavoro con un nodo per ogni punto abbinato: il punto tariffario sulla sua fermata e il nome della bigliettazione. Lì si controlla e si salva."
                className="ml-auto text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40 flex items-center gap-1.5">
                <Milestone className="w-3.5 h-3.5" /> Usa questi punti come nodi del percorso
              </button>
            </div>
          </section>

          {/* ── I punti ── */}
          {confronto && scelta && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[12px] font-semibold text-emerald-200">I punti tariffari sulle fermate</h3>
                {r && (
                  <p className="text-[11px] text-emerald-300/70">
                    {r.abbinati} su {r.punti} con la loro fermata · scarto massimo {km1(r.scartoMassimo)} km
                    {r.fuoriOrdine > 0 && <span className="text-amber-300"> · {r.fuoriOrdine} fuori ordine</span>}
                  </p>
                )}
                <button type="button" onClick={() => dove && scarica(nomeFile(dove, "punti"), csvPunti(dove, confronto))}
                  className="ml-auto text-[11px] px-2.5 py-1 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1">
                  <Download className="w-3 h-3" /> Punti (CSV)
                </button>
              </div>
              <div className="rounded-xl border border-emerald-900/40 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-[10px] uppercase tracking-wider text-emerald-400/60 bg-emerald-950/40">
                    <tr>
                      <th className="text-right font-semibold px-3 py-2 w-10">N.</th>
                      <th className="text-left font-semibold px-3 py-2">Punto della bigliettazione</th>
                      <th className="text-right font-semibold px-3 py-2">Km bigliettazione</th>
                      <th className="text-left font-semibold px-3 py-2">Fermata dell'azienda</th>
                      <th className="text-right font-semibold px-3 py-2">Km nuovo</th>
                      <th className="text-right font-semibold px-3 py-2">Differenza</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-900/30">
                    {confronto.punti.map((x) => {
                      const come = x.fermata && scelta.fermate[x.ordine] != null ? scelta.come[x.ordine] : undefined;
                      return (
                        <tr key={x.ordine}>
                          <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400/60">{x.ordine}</td>
                          <td className="px-3 py-1.5">
                            <span className="text-emerald-100">{x.nome ?? x.codice}</span>
                            <span className="ml-1.5 font-mono text-[10px] text-emerald-400/60">{x.codice}{x.nodo !== x.codice ? ` · nodo ${x.nodo}` : ""}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{km1(x.kmUfficiale)}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <select aria-label={`Fermata per il punto ${x.ordine}, ${x.nome ?? x.codice}`}
                                value={scelta.fermate[x.ordine] ?? ""}
                                onChange={(e) => {
                                  const { [x.ordine]: _tolto, ...come } = scelta.come;
                                  cambia({ ...scelta, fermate: { ...scelta.fermate, [x.ordine]: e.target.value || null }, come });
                                }}
                                className={`text-[12px] px-2 py-1 rounded-lg bg-emerald-950/60 border text-emerald-100 focus:outline-none focus:border-emerald-400/70 max-w-80 ${x.fermata ? "border-emerald-800/50" : "border-amber-500/40"}`}>
                                <option value="">— nessuna fermata —</option>
                                {fermate.map((f, i) => <option key={`${f.stopId}-${i}`} value={f.stopId}>{km1(f.km)} km · {f.nome} ({f.stopId})</option>)}
                              </select>
                              {come && <span className="text-[10px] text-emerald-400/60 whitespace-nowrap">per {come}</span>}
                              {x.fuoriOrdine && <span className="text-[10px] text-amber-300 whitespace-nowrap" title="Questa fermata viene prima di quella del punto precedente">fuori ordine</span>}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{km1(x.kmNuovo)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${x.differenza != null && Math.abs(x.differenza) >= 1 ? "text-amber-300" : "text-emerald-200/80"}`}>{conSegno(x.differenza)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Le coppie ── */}
          {confronto && r && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[12px] font-semibold text-emerald-200">Le coppie di nodi</h3>
                <p className="text-[11px] text-emerald-300/70">
                  {r.coppie} coppie: {r.uguali} uguali, <span className={r.cambiano ? "text-amber-300" : ""}>{r.cambiano} cambiano fascia</span>
                  {r.cambianoForzate > 0 && ` (${r.cambianoForzate} scritte a mano)`}
                  {r.spente > 0 && `, ${r.spente} senza fascia nella bigliettazione`}
                  {r.mancano > 0 && `, ${r.mancano} mancano nella bigliettazione`}
                  {r.righeSenzaPunto > 0 && ` · ${r.righeSenzaPunto} righe della bigliettazione hanno un nodo senza fermata`}
                </p>
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300/80 cursor-pointer">
                  <input type="checkbox" checked={soloDifferenze} onChange={(e) => setSoloDifferenze(e.target.checked)} className="accent-emerald-500" />
                  solo le differenze
                </label>
                <button type="button" onClick={() => dove && scarica(nomeFile(dove, soloDifferenze ? "differenze" : "coppie"), csvCoppie(dove, confronto, soloDifferenze))}
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1">
                  <Download className="w-3 h-3" /> {soloDifferenze ? "Differenze (CSV)" : "Coppie (CSV)"}
                </button>
              </div>
              {fasce.length === 0 && (
                <p className="text-[11px] text-amber-200">Mancano le fasce chilometriche dell'azienda: la fascia nuova non si può calcolare.</p>
              )}
              <div className="rounded-xl border border-emerald-900/40 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-[10px] uppercase tracking-wider text-emerald-400/60 bg-emerald-950/40">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">Da</th>
                      <th className="text-left font-semibold px-3 py-2">A</th>
                      <th className="text-right font-semibold px-3 py-2">Km bigliettazione</th>
                      <th className="text-right font-semibold px-3 py-2">Km nuovi</th>
                      <th className="text-right font-semibold px-3 py-2">Fascia bigliettazione</th>
                      <th className="text-right font-semibold px-3 py-2">Fascia nuova</th>
                      <th className="text-left font-semibold px-3 py-2">Esito</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-900/30">
                    {coppieVisibili.map((x) => (
                      <tr key={`${x.da}\u0000${x.a}`}>
                        <td className="px-3 py-1.5">{x.nomeDa} <span className="font-mono text-[10px] text-emerald-400/60">{x.da}</span></td>
                        <td className="px-3 py-1.5">{x.nomeA} <span className="font-mono text-[10px] text-emerald-400/60">{x.a}</span></td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{km1(x.kmUfficiale)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{km1(x.kmNuovo)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{x.fasciaUfficiale ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{x.fasciaNuova ?? "—"}</td>
                        <td className={`px-3 py-1.5 ${COLORE_ESITO[x.esito]}`}>
                          {ETICHETTE_ESITO[x.esito]}{x.forzata && <span className="ml-1.5 text-[10px] text-amber-300/80">scritta a mano</span>}
                        </td>
                      </tr>
                    ))}
                    {coppieVisibili.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-4 text-emerald-400/50 italic">
                        {confronto.coppie.length === 0 ? "Servono almeno due punti con la loro fermata." : "Nessuna differenza: le fasce della bigliettazione sono quelle che escono dai km nuovi."}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
