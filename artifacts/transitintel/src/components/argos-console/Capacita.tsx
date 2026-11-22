/**
 * Il registro delle capacità: ogni strumento che un agente può chiamare, con
 * il modulo di Cerbero e l'effetto. Sopra, la scala che il guardiano applica:
 * quale autonomia può usare quale effetto.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  AUTONOMIE, console_, EFFETTI, nomeModulo, NOMI_AUTONOMIA, NOMI_EFFETTO, SPIEGA_EFFETTO, type Effetto,
} from "@/lib/argos-console";
import { Caricamento, PillEffetto, Problema, Riquadro, TINTA_EFFETTO, Vuoto } from "./comuni";

/** Chi può usare che cosa (argos/api/registry.py, _RICHIESTO e _SERVE_CONFERMA). */
const SCALA: Record<Effetto, { da: (typeof AUTONOMIE)[number]; conferma: boolean }> = {
  lettura: { da: "osserva", conferma: false },
  esito: { da: "osserva", conferma: false },
  memoria: { da: "propone", conferma: false },
  scrittura: { da: "applica", conferma: true },
  distruttivo: { da: "applica", conferma: true },
};

export default function Capacita() {
  const q = useQuery({ queryKey: ["argos-console", "registro"], queryFn: console_.registro });
  const [cerca, setCerca] = useState("");
  const [modulo, setModulo] = useState("");
  const [effetti, setEffetti] = useState<Set<Effetto>>(new Set());

  const righe = useMemo(() => {
    const t = cerca.trim().toLowerCase();
    return (q.data?.capacita ?? []).filter(c =>
      (!modulo || c.modulo === modulo)
      && (!effetti.size || effetti.has(c.effetto))
      && (!t || c.name.toLowerCase().includes(t) || c.descrizione.toLowerCase().includes(t)));
  }, [q.data, cerca, modulo, effetti]);

  const commuta = (e: Effetto) => setEffetti(s => { const n = new Set(s); n.has(e) ? n.delete(e) : n.add(e); return n; });

  return (
    <div className="space-y-4">
      <Riquadro titolo="La regola del guardiano">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Quale autonomia serve per ogni effetto</caption>
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="py-1.5 pr-3 font-medium">Effetto</th><th className="py-1.5 pr-3 font-medium">Che cosa fa</th>
                {AUTONOMIE.map(a => <th key={a} className="py-1.5 pr-3 text-center font-medium">{NOMI_AUTONOMIA[a]}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {EFFETTI.map(e => (
                <tr key={e}>
                  <td className="py-2 pr-3"><PillEffetto effetto={e} /></td>
                  <td className="py-2 pr-3 text-muted-foreground">{SPIEGA_EFFETTO[e]}</td>
                  {AUTONOMIE.map(a => {
                    const si = AUTONOMIE.indexOf(a) >= AUTONOMIE.indexOf(SCALA[e].da);
                    return (
                      <td key={a} className="py-2 pr-3 text-center text-xs" data-tinta={si ? TINTA_EFFETTO[e] : "neutro"}>
                        {si ? <span className="argos-tinta font-medium">{SCALA[e].conferma ? "sì, con conferma" : "sì"}</span> : <span className="text-muted-foreground">no</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Uno strumento sconosciuto non si esegue mai. Una skill non alza l'autonomia: dà solo gli strumenti.</p>
      </Riquadro>

      <Riquadro titolo={q.data ? `Le capacità (${righe.length} di ${q.data.totale})` : "Le capacità"}>
        {q.isLoading ? <Caricamento /> : q.error ? <Problema errore={q.error} /> : (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <label className="relative min-w-[14rem] flex-1">
                <span className="sr-only">Cerca fra le capacità</span>
                <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
                <input value={cerca} onChange={e => setCerca(e.target.value)} placeholder="Cerca per nome o descrizione"
                  className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </label>
              <label className="text-[11px] text-muted-foreground">Modulo
                <select value={modulo} onChange={e => setModulo(e.target.value)} className="ml-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground">
                  <option value="">Tutti</option>
                  {Object.keys(q.data?.perModulo ?? {}).map(m => <option key={m} value={m}>{nomeModulo(m)}</option>)}
                </select>
              </label>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Filtra per effetto">
                {EFFETTI.map(e => (
                  <button key={e} type="button" aria-pressed={effetti.has(e)} onClick={() => commuta(e)} data-tinta={TINTA_EFFETTO[e]}
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${effetti.has(e) ? "argos-tinta border-current" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    {NOMI_EFFETTO[e]} {q.data?.perEffetto[e] ?? 0}
                  </button>
                ))}
              </div>
            </div>
            {!righe.length ? <Vuoto>Nessuna capacità con questi filtri.</Vuoto> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr><th className="py-1.5 pr-3 font-medium">Strumento</th><th className="py-1.5 pr-3 font-medium">Modulo</th>
                      <th className="py-1.5 pr-3 font-medium">Effetto</th><th className="py-1.5 font-medium">Che cosa fa</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {righe.map(c => (
                      <tr key={c.name} className="align-top">
                        <td className="py-1.5 pr-3"><code className="font-mono text-[12px]">{c.name}</code></td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{nomeModulo(c.modulo)}</td>
                        <td className="py-1.5 pr-3"><PillEffetto effetto={c.effetto} /></td>
                        <td className="py-1.5 text-muted-foreground">{c.descrizione}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Riquadro>
    </div>
  );
}
