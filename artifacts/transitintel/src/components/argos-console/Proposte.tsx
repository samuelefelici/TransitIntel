/**
 * La scheda «Proposte»: le proposte di tutti i piani degli agenti (il
 * Pianificatore, Argos con la squadra, l'Analista…), con lo stato di
 * avanzamento e la priorità, per decidere da quale partire.
 *
 * Da fare → in corso (la sta applicando il Pianificatore) → fatta; oppure
 * scartata, col perché (diventa una lezione per i turni futuri dell'agente).
 * «Parti da questa» la passa al Pianificatore sul suo progetto, nella scheda
 * Conversazione; quando il Pianificatore l'applica, si segna fatta da sola.
 * Si vedono quelle dei progetti che l'utente apre e quelle senza progetto.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, ListChecks, Play, RotateCcw, X } from "lucide-react";
import { listPsProjects } from "@/lib/planning-studio-api";
import { proposte, quandoFa, type GruppoProposte, type PropostaAgente, type StatoProposta } from "@/lib/argos-console";
import { avanzamento, azioni, NOME_PRIORITA, NOME_STATO, nomeAgente } from "@/lib/argos-proposte";
import { Caricamento, Numero, Pill, Problema, Riquadro, Vuoto, type Tinta } from "./comuni";

const TINTA_STATO: Record<StatoProposta, Tinta> = { open: "info", accepted: "memoria", applied: "ok", rejected: "neutro" };
const TINTA_PRIORITA: Record<string, Tinta> = { critica: "errore", alta: "avviso", media: "info", bassa: "neutro" };
const GRUPPI: Array<{ k: GruppoProposte; nome: string }> = [
  { k: "aperte", nome: "Da fare e in corso" }, { k: "da_fare", nome: "Da fare" }, { k: "in_corso", nome: "In corso" },
  { k: "fatte", nome: "Fatte" }, { k: "scartate", nome: "Scartate" }, { k: "tutte", nome: "Tutte" },
];
const CAMPO = "h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function Proposte({ partiDa, apriEsecuzione }: {
  partiDa: (p: PropostaAgente) => void;
  apriEsecuzione: (runId: number) => void;
}) {
  const qc = useQueryClient();
  const [progetto, setProgetto] = useState<string>("");
  const [gruppo, setGruppo] = useState<GruppoProposte>("aperte");
  const progetti = useQuery({ queryKey: ["argos-console", "progetti"], queryFn: listPsProjects, staleTime: 5 * 60_000 });
  const elenco = useQuery({
    queryKey: ["argos-console", "proposte", progetto, gruppo],
    queryFn: () => proposte.elenco(progetto || null, gruppo),
  });
  const cambia = useMutation({
    mutationFn: (v: { id: number; stato: StatoProposta; nota?: string }) => proposte.cambia(v.id, v.stato, v.nota),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["argos-console", "proposte"] }); },
  });
  const nomeProgetto = useMemo(() => {
    const m = new Map((progetti.data ?? []).map(p => [p.id, p.name]));
    return (id: string) => (id ? m.get(id) ?? "Progetto" : "Senza progetto");
  }, [progetti.data]);

  const c = elenco.data?.conteggi;
  const av = avanzamento(c ?? {});

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Numero etichetta="Da fare" valore={c?.open ?? "–"} tinta="info" />
        <Numero etichetta="In corso" valore={c?.accepted ?? "–"} tinta="memoria" nota="le sta applicando il Pianificatore" />
        <Numero etichetta="Fatte" valore={c?.applied ?? "–"} tinta="ok" />
        <Numero etichetta="Scartate" valore={c?.rejected ?? "–"} />
        <Numero etichetta="Avanzamento" valore={`${av.percento}%`} nota={`${av.fatte} fatte su ${av.totale}`} tinta="ok" />
      </div>

      <Riquadro
        titolo={<span className="inline-flex items-center gap-1.5"><ListChecks className="h-4 w-4" aria-hidden />Le proposte degli agenti</span>}
        azione={
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Progetto
            <select value={progetto} onChange={e => setProgetto(e.target.value)} className={CAMPO} aria-label="Progetto delle proposte">
              <option value="">Tutti i miei</option>
              <option value="senza">Senza progetto</option>
              {(progetti.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        }>
        <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Quali proposte">
          {GRUPPI.map(g => (
            <button key={g.k} type="button" role="radio" aria-checked={gruppo === g.k} onClick={() => setGruppo(g.k)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${gruppo === g.k ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}>
              {g.nome}
            </button>
          ))}
        </div>
        {elenco.isLoading ? <Caricamento /> : elenco.error ? <Problema errore={elenco.error} /> : !elenco.data?.proposte.length ? (
          <Vuoto>{gruppo === "aperte"
            ? "Niente da fare qui. Quando un agente prepara un piano, le sue proposte compaiono in questa scheda, dalla più urgente."
            : "Nessuna proposta in questo gruppo."}</Vuoto>
        ) : (
          <ol className="space-y-2">
            {elenco.data.proposte.map(p => (
              <RigaProposta key={p.id} p={p} progetto={nomeProgetto(p.project_id)} occupato={cambia.isPending}
                cambia={(stato, nota) => cambia.mutate({ id: p.id, stato, nota })}
                parti={() => partiDa(p)} apriEsecuzione={() => apriEsecuzione(p.run_id)} />
            ))}
          </ol>
        )}
        {cambia.error && <div className="mt-2"><Problema errore={cambia.error} /></div>}
      </Riquadro>
    </div>
  );
}

function RigaProposta({ p, progetto, occupato, cambia, parti, apriEsecuzione }: {
  p: PropostaAgente; progetto: string; occupato: boolean;
  cambia: (stato: StatoProposta, nota?: string) => void; parti: () => void; apriEsecuzione: () => void;
}) {
  const [aperta, setAperta] = useState(false);
  const [scarto, setScarto] = useState<string | null>(null);
  const meta = [progetto, p.line ? `linea ${p.line}` : null, p.day_type, `da ${nomeAgente(p.agent_key)}`, quandoFa(p.created_at)]
    .filter(Boolean).join(" · ");
  const BOTTONE = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:opacity-40";
  return (
    <li className="rounded-lg border border-border bg-card px-3 py-2.5" data-stato={p.status}>
      <div className="flex flex-wrap items-start gap-2">
        <button type="button" onClick={() => setAperta(v => !v)} aria-expanded={aperta}
          aria-label={aperta ? "Chiudi i dettagli" : "Apri i dettagli"} className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted">
          {aperta ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tinta={TINTA_PRIORITA[p.priority] ?? "neutro"} title="priorità">{NOME_PRIORITA[p.priority] ?? p.priority}</Pill>
            <span className={`text-sm font-medium ${p.status === "applied" || p.status === "rejected" ? "text-muted-foreground" : ""}`}>{p.title}</span>
            <Pill tinta={TINTA_STATO[p.status]}>{NOME_STATO[p.status]}</Pill>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{meta}</div>
          {p.impact && <div className="mt-1 text-xs">Effetto atteso: {p.impact}</div>}
          {aperta && (
            <dl className="mt-2 space-y-1 text-xs">
              {p.detail && <div><dt className="inline font-medium">Intervento: </dt><dd className="inline">{p.detail}</dd></div>}
              {p.rationale && <div><dt className="inline font-medium">Perché: </dt><dd className="inline">{p.rationale}</dd></div>}
              {p.confidence && <div><dt className="inline font-medium">Fiducia: </dt><dd className="inline">{p.confidence}</dd></div>}
              {p.review_note && <div><dt className="inline font-medium">Nota: </dt><dd className="inline">{p.review_note}</dd></div>}
              <div>
                <button type="button" onClick={apriEsecuzione} className="text-primary underline-offset-2 hover:underline">
                  Il turno che l'ha proposta (esecuzione #{p.run_id})
                </button>
              </div>
            </dl>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {azioni(p).map(a => {
            if (a === "parti") return (
              <button key={a} type="button" disabled={occupato} onClick={parti} title="Il Pianificatore la applica sul progetto, in «accetta modifiche», poi verifica"
                className={`${BOTTONE} bg-primary text-primary-foreground hover:bg-primary/90`}><Play className="h-3.5 w-3.5" aria-hidden />Parti da questa</button>
            );
            if (a === "fatta") return (
              <button key={a} type="button" disabled={occupato} onClick={() => cambia("applied")}
                className={`${BOTTONE} border border-border hover:bg-muted`}><Check className="h-3.5 w-3.5" aria-hidden />Segna fatta</button>
            );
            if (a === "da_fare") return (
              <button key={a} type="button" disabled={occupato} onClick={() => cambia("open")}
                className={`${BOTTONE} border border-border hover:bg-muted`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Da fare</button>
            );
            if (a === "scarta") return scarto === null ? (
              <button key={a} type="button" disabled={occupato} onClick={() => setScarto("")}
                className={`${BOTTONE} text-muted-foreground hover:bg-muted`}><X className="h-3.5 w-3.5" aria-hidden />Scarta</button>
            ) : null;
            return (
              <button key={a} type="button" disabled={occupato} onClick={() => cambia("open")}
                className={`${BOTTONE} border border-border hover:bg-muted`}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Riapri</button>
            );
          })}
        </div>
      </div>
      {scarto !== null && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); cambia("rejected", scarto); setScarto(null); }}>
          <label className="sr-only" htmlFor={`scarto-${p.id}`}>Perché la scarti</label>
          <input id={`scarto-${p.id}`} value={scarto} onChange={e => setScarto(e.target.value.slice(0, 500))} autoFocus
            placeholder="Perché la scarti (facoltativo: l'agente lo terrà a mente)" className={`${CAMPO} min-w-0 flex-1`} />
          <button type="submit" disabled={occupato} className={`${BOTTONE} bg-muted hover:bg-muted/70`}>Scarta</button>
          <button type="button" onClick={() => setScarto(null)} className={`${BOTTONE} text-muted-foreground hover:bg-muted`}>Annulla</button>
        </form>
      )}
    </li>
  );
}
