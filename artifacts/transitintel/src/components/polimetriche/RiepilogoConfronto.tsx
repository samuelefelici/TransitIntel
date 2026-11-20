/**
 * Il riepilogo del confronto con la bigliettazione (tappa 6.34c): tutte le
 * linee abbinate in una tabella, un percorso per riga, con l'abbinamento
 * (salvato, o solo proposto), i punti abbinati e le coppie che cambiano
 * fascia. E i due file unici, coppie e punti, per ribattere le differenze
 * senza scaricare un percorso alla volta.
 *
 * Nei file entrano di default solo i percorsi con l'abbinamento salvato: una
 * proposta non rivista può avere un punto sulla fermata sbagliata.
 *
 * API: GET /api/fares/polimetriche/ufficiale/riepilogo. I conti sono quelli
 * del confronto di una linea (lib/polimetrica-confronto.ts).
 */
import React from "react";
import { ArrowLeft, Download, GitCompareArrows, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { FasciaKm } from "@/lib/fasce-km";
import {
  csvCoppieDiTutte, csvPuntiDiTutte, ETICHETTE_STATO, percorsiNelFile, riepilogoLinee, totaliRiepilogo,
  type DettaglioLinea, type StatoAbbinamento, type VoceRiepilogo,
} from "@/lib/polimetrica-confronto";

type Filtro = "tutti" | StatoAbbinamento | "differenze";
const FILTRI: [Filtro, string][] = [["tutti", "Tutti"], ["salvato", "Salvati"], ["proposta", "Da rivedere"], ["senza", "Senza proposta"], ["differenze", "Con differenze"]];

const n = (x: number) => x.toLocaleString("it-IT");
/** «1 percorso», «12 percorsi» */
const quanti = (x: number, uno: string, tanti: string) => `${n(x)} ${x === 1 ? uno : tanti}`;
const km1 = (x: number) => x.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const COLORE_STATO: Record<StatoAbbinamento, string> = {
  salvato: "bg-emerald-500/20 text-emerald-200 border-emerald-500/30",
  proposta: "bg-amber-500/10 text-amber-200 border-amber-500/30",
  senza: "bg-rose-500/10 text-rose-200 border-rose-500/30",
};

function scarica(nome: string, testo: string) {
  const url = URL.createObjectURL(new Blob([testo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const passa = (v: VoceRiepilogo, f: Filtro): boolean =>
  f === "tutti" || (f === "differenze" ? (v.numeri?.cambiano ?? 0) > 0 : v.stato === f);

export function RiepilogoConfronto({ importId, fasce, onIndietro, onApri }: {
  importId: string; fasce: readonly FasciaKm[];
  onIndietro: () => void;
  /** apre il confronto di una linea */
  onApri: (linea: string) => void;
}) {
  const [linee, setLinee] = React.useState<DettaglioLinea[] | null>(null);
  const [errore, setErrore] = React.useState<string | null>(null);
  const [filtro, setFiltro] = React.useState<Filtro>("tutti");
  const [ancheLeProposte, setAncheLeProposte] = React.useState(false);
  const [soloDifferenze, setSoloDifferenze] = React.useState(true);

  React.useEffect(() => {
    let vivo = true;
    apiFetch<{ linee: DettaglioLinea[] }>(`/api/fares/polimetriche/ufficiale/riepilogo?importId=${encodeURIComponent(importId)}`)
      .then((r) => { if (vivo) { setLinee(r.linee); setErrore(null); } })
      .catch((e: any) => { if (vivo) setErrore(e?.message || "Riepilogo non leggibile"); });
    return () => { vivo = false; };
  }, [importId]);

  const voci = React.useMemo(() => (linee ? riepilogoLinee(linee, fasce) : []), [linee, fasce]);
  const t = React.useMemo(() => totaliRiepilogo(voci), [voci]);
  const senzaPunti = linee ? linee.filter((l) => l.percorsi.length === 0).length : 0;
  const visibili = voci.filter((v) => passa(v, filtro));
  const nelFile = percorsiNelFile(voci, ancheLeProposte);

  const indietro = (
    <button type="button" onClick={onIndietro}
      className="text-[12px] px-2.5 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1.5">
      <ArrowLeft className="w-3.5 h-3.5" /> Le linee
    </button>
  );
  if (errore) return <div className="p-6 space-y-3">{indietro}<p role="alert" className="text-sm text-red-300">{errore}</p></div>;
  if (!linee) return <div className="h-full flex items-center justify-center text-emerald-400/50"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-emerald-50">
      <div className="flex flex-wrap items-center gap-3">
        {indietro}
        <h2 className="text-base font-bold text-emerald-200">Riepilogo del confronto con la bigliettazione</h2>
      </div>

      {/* ── I totali ── */}
      <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/30 p-3 space-y-1.5">
        <p className="text-[12px] text-emerald-100">
          {quanti(t.percorsi, "percorso", "percorsi")} di {quanti(t.linee, "linea abbinata", "linee abbinate")}: <strong>{n(t.salvati)} con l'abbinamento salvato</strong>, {n(t.proposte)} con la sola proposta da rivedere
          {t.senza > 0 && <>, {n(t.senza)} senza proposta</>}.
        </p>
        <p className="text-[12px] text-emerald-300/80">
          {n(t.abbinati)} punti tariffari su {n(t.punti)} con la loro fermata · {quanti(t.coppie, "coppia", "coppie")} di nodi, di cui{" "}
          <span className={t.cambiano ? "text-amber-300" : ""}>{quanti(t.cambiano, "cambia", "cambiano")} fascia</span>
          {t.salvati > 0 && <> ({n(t.cambianoNeiSalvati)} nei percorsi salvati)</>}
          {t.spente > 0 && <>, {n(t.spente)} senza fascia nella bigliettazione</>}
          {t.mancano > 0 && <>, {quanti(t.mancano, "manca", "mancano")} nella bigliettazione</>}.
        </p>
        {senzaPunti > 0 && (
          <p className="text-[11px] text-emerald-400/60">
            {quanti(senzaPunti, "linea abbinata non ha", "linee abbinate non hanno")} punti tariffari nella bigliettazione (solo righe): non c'è niente da mettere sulle fermate.
          </p>
        )}
        <p className="text-[11px] text-emerald-400/60">
          Dove l'abbinamento non è salvato i numeri vengono dalla proposta di Cerbero: vanno guardati, perché un punto sulla fermata sbagliata sposta km e fasce.
        </p>
      </section>

      {/* ── I file unici ── */}
      <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/30 p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[12px] text-emerald-100 font-medium">Un file per tutte le linee</p>
        <label className="flex items-center gap-1.5 text-[11px] text-emerald-300/80 cursor-pointer">
          <input id="riepilogo-anche-proposte" type="checkbox" checked={ancheLeProposte} onChange={(e) => setAncheLeProposte(e.target.checked)} className="accent-emerald-500" />
          anche i percorsi non ancora salvati (proposte da rivedere)
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-emerald-300/80 cursor-pointer">
          <input id="riepilogo-solo-differenze" type="checkbox" checked={soloDifferenze} onChange={(e) => setSoloDifferenze(e.target.checked)} className="accent-emerald-500" />
          solo le differenze
        </label>
        <span className="text-[11px] text-emerald-400/60">{nelFile === 0 ? "Nessun percorso entra nei file: salva un abbinamento, o includi le proposte." : `${quanti(nelFile, "percorso", "percorsi")} nei file`}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" disabled={nelFile === 0}
            onClick={() => scarica(soloDifferenze ? "differenze-tutte-le-linee.csv" : "coppie-tutte-le-linee.csv", csvCoppieDiTutte(voci, { ancheLeProposte, soloDifferenze }))}
            className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500 text-emerald-950 font-semibold hover:bg-emerald-400 disabled:opacity-40 flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> {soloDifferenze ? "Differenze (CSV)" : "Coppie (CSV)"}
          </button>
          <button type="button" disabled={nelFile === 0}
            onClick={() => scarica("punti-tutte-le-linee.csv", csvPuntiDiTutte(voci, ancheLeProposte))}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40 flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Punti (CSV)
          </button>
        </div>
      </section>

      {/* ── I percorsi ── */}
      <section className="space-y-2">
        <div role="group" aria-label="Filtra i percorsi" className="flex flex-wrap gap-1">
          {FILTRI.map(([f, etichetta]) => (
            <button key={f} type="button" onClick={() => setFiltro(f)} aria-pressed={filtro === f}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${filtro === f ? "bg-emerald-500/25 border-emerald-400/50 text-emerald-50" : "border-emerald-800/50 text-emerald-300/70 hover:bg-emerald-500/10"}`}>
              {etichetta} <span className="tabular-nums opacity-70">{voci.filter((v) => passa(v, f)).length}</span>
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-emerald-900/40 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-[10px] uppercase tracking-wider text-emerald-400/60 bg-emerald-950/40">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Linea</th>
                <th className="text-left font-semibold px-3 py-2">Azienda</th>
                <th className="text-left font-semibold px-3 py-2">Percorso</th>
                <th className="text-left font-semibold px-3 py-2">Abbinamento</th>
                <th className="text-right font-semibold px-3 py-2">Punti</th>
                <th className="text-right font-semibold px-3 py-2">Scarto max</th>
                <th className="text-right font-semibold px-3 py-2">Coppie</th>
                <th className="text-right font-semibold px-3 py-2">Cambiano</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-900/30">
              {visibili.map((v) => (
                <tr key={`${v.linea}\u0000${v.percorso}\u0000${v.direzione}`}>
                  <td className="px-3 py-1.5 font-mono font-semibold text-emerald-100 whitespace-nowrap">{v.linea}</td>
                  <td className="px-3 py-1.5 font-mono text-emerald-200/80 whitespace-nowrap">{v.abbinata}</td>
                  <td className="px-3 py-1.5 text-emerald-200/90">
                    {v.da} <span className="text-emerald-400/50">→</span> {v.a}
                    <span className="ml-1.5 text-[10px] text-emerald-400/50 whitespace-nowrap">percorso {v.percorso} · direzione {v.direzione}</span>
                  </td>
                  <td className="px-3 py-1.5"><span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${COLORE_STATO[v.stato]}`}>{ETICHETTE_STATO[v.stato]}</span></td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{v.numeri ? `${v.numeri.abbinati} su ${v.numeri.punti}` : "—"}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${v.numeri && v.numeri.scartoMassimo >= 2 ? "text-amber-300" : ""}`}>{v.numeri ? `${km1(v.numeri.scartoMassimo)} km` : "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{v.numeri?.coppie ?? "—"}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${v.numeri?.cambiano ? "text-amber-300" : "text-emerald-200/70"}`}>{v.numeri?.cambiano ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" onClick={() => onApri(v.linea)}
                      title={`Apri il confronto della linea ${v.linea}`}
                      className="text-[11px] px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 inline-flex items-center gap-1 whitespace-nowrap">
                      <GitCompareArrows className="w-3 h-3" /> Confronta
                    </button>
                  </td>
                </tr>
              ))}
              {visibili.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-4 text-emerald-400/50 italic">
                  {voci.length === 0 ? "Nessuna linea abbinata con punti tariffari: prima si abbinano le linee." : "Nessun percorso per questo filtro."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
