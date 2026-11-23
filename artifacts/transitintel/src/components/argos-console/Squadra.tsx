/**
 * La squadra: ogni agente con la sua fascia di modello, l'autonomia (e quella
 * con cui lavora davvero in questa fase), le skill e gli strumenti; il
 * dettaglio mostra il prompt che riceve e ogni strumento con il suo effetto.
 * Sotto, la biblioteca delle skill con le loro versioni.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  autonomiaEffettiva, console_, nomeModulo, NOMI_AUTONOMIA, type Capacita, type SchedaAgente,
} from "@/lib/argos-console";
import { BarraEffetti, Caricamento, Pill, PillAutonomia, PillEffetto, PillFascia, Problema, Riquadro, Vuoto } from "./comuni";

function DettaglioAgente({ chiave }: { chiave: string }) {
  const q = useQuery({ queryKey: ["argos-console", "agente", chiave], queryFn: () => console_.agente(chiave) });
  const [prompt, setPrompt] = useState(false);
  if (q.isLoading) return <Caricamento />;
  if (q.error) return <Problema errore={q.error} />;
  if (!q.data) return null;
  const perModulo = q.data.capacita.reduce<Record<string, Capacita[]>>((m, c) => ({ ...m, [c.modulo]: [...(m[c.modulo] ?? []), c] }), {});
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div>
        <button type="button" onClick={() => setPrompt(p => !p)} aria-expanded={prompt}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {prompt ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          Il prompt che riceve ({q.data.systemPrompt.length.toLocaleString("it-IT")} caratteri)
        </button>
        {prompt && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 text-[11px] leading-relaxed">{q.data.systemPrompt}</pre>}
      </div>
      <div className="space-y-2">
        {Object.entries(perModulo).sort((a, b) => b[1].length - a[1].length).map(([modulo, caps]) => (
          <details key={modulo} className="rounded-lg border border-border">
            <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-medium">{nomeModulo(modulo)} · {caps.length}</summary>
            <ul className="divide-y divide-border border-t border-border">
              {caps.map(c => (
                <li key={c.name} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 px-3 py-1.5 text-xs">
                  <PillEffetto effetto={c.effetto} />
                  <span className="min-w-0"><code className="font-mono text-[11px]">{c.name}</code>
                    <span className="block truncate text-muted-foreground" title={c.descrizione}>{c.descrizione}</span></span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

function CartaAgente({ a, faiLavorare }: { a: SchedaAgente; faiLavorare: (chiave: string) => void }) {
  const [aperta, setAperta] = useState(false);
  const effettiva = autonomiaEffettiva(a.autonomia);
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{a.nome}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{a.descrizione}</p>
        </div>
        <Button size="sm" onClick={() => faiLavorare(a.chiave)} aria-label={`Fai lavorare ${a.nome}`}>
          <Play className="mr-1 h-3.5 w-3.5" aria-hidden />Lavora
        </Button>
      </header>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <PillFascia fascia={a.livelloModello} />
        <PillAutonomia autonomia={a.autonomia} />
        {effettiva !== a.autonomia && (
          <Pill tinta="avviso" title="In questa fase gli agenti della console non scrivono su Cerbero: le scritture restano al Pianificatore nelle conversazioni, che sa annullare un turno">
            ora lavora come «{NOMI_AUTONOMIA[effettiva]}»
          </Pill>
        )}
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">{a.strumenti.length} strumenti</div>
        <BarraEffetti perEffetto={a.perEffetto} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {a.skills.map(s => (
          <span key={s.chiave} className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px]">{s.nome} <span className="text-muted-foreground">v{s.versione}</span></span>
        ))}
      </div>
      <button type="button" onClick={() => setAperta(x => !x)} aria-expanded={aperta}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        {aperta ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
        {aperta ? "Chiudi il dettaglio" : "Prompt e strumenti"}
      </button>
      {aperta && <DettaglioAgente chiave={a.chiave} />}
    </article>
  );
}

export default function Squadra({ faiLavorare }: { faiLavorare: (chiave: string) => void }) {
  const agenti = useQuery({ queryKey: ["argos-console", "agenti"], queryFn: console_.agenti });
  const skill = useQuery({ queryKey: ["argos-console", "skill"], queryFn: console_.skill });
  return (
    <div className="space-y-4">
      {agenti.isLoading ? <Caricamento /> : agenti.error ? <Problema errore={agenti.error} /> : (
        <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {(agenti.data?.agenti ?? []).map(a => <CartaAgente key={a.chiave} a={a} faiLavorare={faiLavorare} />)}
        </div>
      )}
      <Riquadro titolo="La biblioteca delle skill">
        {skill.isLoading ? <Caricamento /> : skill.error ? <Problema errore={skill.error} /> : !skill.data?.skill.length ? <Vuoto>Nessuna skill.</Vuoto> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Skill con la versione in vigore e gli strumenti che portano</caption>
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="py-1.5 pr-3 font-medium">Skill</th><th className="py-1.5 pr-3 font-medium">Quando si usa</th>
                  <th className="py-1.5 pr-3 font-medium">In vigore</th><th className="py-1.5 pr-3 font-medium">Strumenti</th><th className="py-1.5 font-medium">Versioni</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {skill.data.skill.map(s => {
                  const attiva = s.versioni.find(v => v.versione === s.versioneAttiva);
                  return (
                    <tr key={s.chiave} className="align-top">
                      <td className="py-2 pr-3 font-medium">{s.nome}<div className="text-[11px] font-normal text-muted-foreground">{s.origine === "sistema" ? "di sistema" : "dell'operatore"}</div></td>
                      <td className="py-2 pr-3 text-muted-foreground">{s.descrizione}</td>
                      <td className="py-2 pr-3 tabular-nums">v{s.versioneAttiva}</td>
                      <td className="py-2 pr-3 tabular-nums" title={attiva?.strumenti.join(", ")}>{attiva?.strumenti.length ?? 0}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {s.versioni.map(v => (
                            <Pill key={v.versione} tinta={v.stato === "attiva" ? "ok" : v.stato === "bozza" ? "avviso" : "neutro"} title={v.nota ?? undefined}>v{v.versione} {v.stato}</Pill>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Riquadro>
    </div>
  );
}
