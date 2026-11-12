/* ═══════════════════════════════════════════════════════════════
 *  Ambito del calcolo dei turni guida: su quali cluster di cambio si può
 *  tagliare, vincoli globali di soluzione (BDSI cap. 14), costi avanzati
 *  (BDS5). Valgono per il calcolo che si sta per lanciare; la regola che
 *  li unisce alla configurazione è in config-solver.ts.
 * ═══════════════════════════════════════════════════════════════ */
import React, { useEffect, useId, useRef } from "react";
import { Loader2, MapPin, X } from "lucide-react";
import { VincoliGlobaliEditor } from "./bdsi-tools";
import { Bds5CostsEditor } from "./bds5-costs";
import { EMPTY_BDS5 } from "./bds5-config";
import { AMBITO_VUOTO, clusterDaMandare, vincoloAttivo, type AmbitoDelCalcolo } from "./config-solver";

/** Un cluster come lo riceve il solver: tutti quelli dell'elenco, non solo quelli «di cambio». */
export interface ClusterDelCalcolo {
  id: string;
  name: string;
  color: string;
  stopCount: number;
  isInterchange: boolean;
}

export function AmbitoDelCalcoloPanel({ aperto, onChiudi, ambito, onCambia, cluster }: {
  aperto: boolean;
  onChiudi: () => void;
  ambito: AmbitoDelCalcolo;
  onCambia: (a: AmbitoDelCalcolo) => void;
  /** `null` finché l'elenco non è arrivato */
  cluster: ClusterDelCalcolo[] | null;
}) {
  const titolo = useId();
  const chiudi = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!aperto) return;
    chiudi.current?.focus();
    const tasto = (e: KeyboardEvent) => { if (e.key === "Escape") onChiudi(); };
    window.addEventListener("keydown", tasto);
    return () => window.removeEventListener("keydown", tasto);
  }, [aperto, onChiudi]);

  if (!aperto) return null;

  const tutti = cluster ?? [];
  /* nessuna scelta = tutti spuntati */
  const scelti = new Set(ambito.clusterScelti ?? tutti.map(c => c.id));
  const ristretto = clusterDaMandare(ambito.clusterScelti) !== null && scelti.size < tutti.length;
  const nessuno = ambito.clusterScelti !== null && scelti.size === 0;

  const scegli = (ids: string[] | null) => onCambia({ ...ambito, clusterScelti: ids });
  const cambia = (id: string) => {
    const n = new Set(scelti);
    if (n.has(id)) n.delete(id); else n.add(id);
    /* tutti spuntati di nuovo = nessuna scelta */
    scegli(n.size === tutti.length ? null : tutti.filter(c => n.has(c.id)).map(c => c.id));
  };

  const scritti = ambito.vincoliGlobali.length;
  const attivi = ambito.vincoliGlobali.filter(vincoloAttivo).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onChiudi}>
      <div
        role="dialog" aria-modal="true" aria-labelledby={titolo}
        className="bg-zinc-900 border border-purple-500/30 rounded-lg w-full max-w-3xl max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800">
          <div>
            <h3 id={titolo} className="text-sm font-semibold text-purple-100">Ambito del calcolo</h3>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              Valgono per il calcolo CP-SAT che lanci da questa pagina. Non cambiano il profilo di regole.
            </p>
          </div>
          <button ref={chiudi} onClick={onChiudi} aria-label="Chiudi"
            className="p-1 rounded text-zinc-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* ── Cluster di cambio ── */}
          <section className="rounded-lg border border-zinc-800 bg-black/30 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-[11px] font-semibold text-orange-300 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> Cluster di cambio
                {cluster && (
                  <span className="font-mono text-orange-400">{scelti.size}/{tutti.length}</span>
                )}
              </p>
              <div className="flex gap-1">
                <button onClick={() => scegli(null)}
                  className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-orange-500/40">
                  Tutti
                </button>
                <button onClick={() => scegli([])}
                  className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-orange-500/40">
                  Nessuno
                </button>
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 mb-2 leading-relaxed">
              Sono i punti dove un conducente può passare il bus a un collega. Con meno cluster ci sono meno
              tagli possibili e turni più rigidi; con più cluster più flessibilità e più cambi.
            </p>
            {cluster === null ? (
              <div className="text-[11px] text-zinc-500 flex items-center gap-2 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Caricamento cluster…
              </div>
            ) : tutti.length === 0 ? (
              <p className="text-[11px] text-amber-300/80">
                Nessun cluster definito: i conducenti cambiano solo al rientro in deposito.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 max-h-48 overflow-y-auto pr-1">
                {tutti.map(c => {
                  const spuntato = scelti.has(c.id);
                  return (
                    <label key={c.id}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-[11px] ${spuntato ? "bg-orange-500/10 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"}`}>
                      <input type="checkbox" checked={spuntato} onChange={() => cambia(c.id)}
                        className="w-3 h-3 accent-orange-500" />
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                      <span className="flex-1 truncate">{c.name}</span>
                      {!c.isInterchange && <span className="text-[9px] text-zinc-500">non di cambio</span>}
                      <span className="font-mono text-[10px] text-zinc-500" title="Fermate del cluster">
                        {c.stopCount === 0 ? "senza fermate" : c.stopCount}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {nessuno && tutti.length > 0 && (
              <p className="mt-2 text-[10px] text-amber-300/90">
                Nessun cluster scelto: il calcolo li usa tutti. Per restringere, spuntane almeno uno.
              </p>
            )}
            {ristretto && (
              <p className="mt-2 text-[10px] text-orange-300/90">
                Il calcolo taglierà solo su {scelti.size} cluster su {tutti.length}.
              </p>
            )}
          </section>

          {/* ── Vincoli globali (BDSI cap. 14) ── */}
          <section className="rounded-lg border border-zinc-800 bg-black/30 p-3">
            <VincoliGlobaliEditor
              vincoli={ambito.vincoliGlobali}
              onChange={v => onCambia({ ...ambito, vincoliGlobali: v })}
            />
            {scritti > attivi && (
              <p className="mt-2 text-[10px] text-amber-300/90">
                {scritti - attivi === 1 ? "Un vincolo non conta" : `${scritti - attivi} vincoli non contano`}:
                {" "}serve almeno una tipologia e almeno un limite.
              </p>
            )}
          </section>

          {/* ── Costi avanzati (BDS5) ── */}
          <section className="rounded-lg border border-zinc-800 bg-black/30 p-3">
            <Bds5CostsEditor
              cfg={ambito.bds5}
              onChange={b => onCambia({ ...ambito, bds5: b })}
            />
          </section>
        </div>

        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={() => onCambia({ ...AMBITO_VUOTO, bds5: EMPTY_BDS5 })}
            className="text-xs text-zinc-400 hover:text-white px-2 py-1.5"
          >
            Azzera tutto
          </button>
          <button onClick={onChiudi}
            className="text-xs font-medium text-white px-3 py-1.5 rounded-md bg-purple-600 hover:bg-purple-500">
            Fatto
          </button>
        </div>
      </div>
    </div>
  );
}
