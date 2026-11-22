/**
 * L'ispettore: le esecuzioni degli agenti e, per ognuna, la traccia passo
 * per passo (avvio, strumenti con modulo ed effetto, esiti e durate, i no del
 * guardiano, il piano, la risposta, la fine), i numeri e le proposte.
 * Si vedono solo le esecuzioni dei progetti che l'utente può aprire.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon, CheckCircle2, ChevronDown, ChevronRight, CircleStop, FileText, Flag, HelpCircle, Info,
  ListChecks, PlayCircle, RefreshCw, ShieldX, Wrench, XCircle, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  console_, durata, NOMI_TIPO, quandoFa, riepilogo, sintesiEvento, token,
  type EventoTraccia, type RigaEsecuzione, type StatoEsecuzione, type TipoEvento,
} from "@/lib/argos-console";
import { Barre, Caricamento, Numero, Pill, PillStato, Problema, Riquadro, Vuoto, type Tinta } from "./comuni";

const ArgosMarkdown = lazy(() => import("@/components/argos/ArgosMarkdown"));

const ICONA: Record<TipoEvento, LucideIcon> = {
  avvio: PlayCircle, nota: Info, strumento: Wrench, esito: CheckCircle2, rifiuto: ShieldX, piano: ListChecks,
  domanda: HelpCircle, rapporto: FileText, testo: FileText, fine: Flag, errore: AlertOctagon,
};

function tintaEvento(e: EventoTraccia): Tinta {
  switch (e.tipo) {
    case "esito": return e.dati?.ok === false ? "errore" : "ok";
    case "rifiuto": case "errore": return "errore";
    case "nota": return "avviso";
    case "strumento": return "info";
    case "piano": case "domanda": case "rapporto": return "memoria";
    case "fine": return e.dati?.status === "failed" ? "errore" : "ok";
    default: return "neutro";
  }
}

function Evento({ e, t0 }: { e: EventoTraccia; t0: number }) {
  const [aperto, setAperto] = useState(false);
  const Icona = e.tipo === "esito" && e.dati?.ok === false ? XCircle : ICONA[e.tipo] ?? Info;
  const dopo = new Date(e.at).getTime() - t0;
  return (
    <li className="relative pl-8" data-tinta={tintaEvento(e)}>
      <span className="absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card">
        <Icona className="h-3.5 w-3.5 argos-tinta" aria-hidden />
      </span>
      <button type="button" onClick={() => setAperto(x => !x)} aria-expanded={aperto}
        className="w-full rounded-md px-2 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold argos-tinta">{NOMI_TIPO[e.tipo] ?? e.tipo}</span>
          <span className="tabular-nums text-muted-foreground">#{e.seq} · +{durata(Math.max(0, dopo))}</span>
          {aperto ? <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
        </div>
        <div className="mt-0.5 break-words text-sm">{sintesiEvento(e)}</div>
      </button>
      {aperto && (
        <pre className="mx-2 mb-2 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-muted/50 p-2 text-[11px] leading-relaxed">{JSON.stringify(e.dati, null, 2)}</pre>
      )}
    </li>
  );
}

function Dettaglio({ id }: { id: number }) {
  const q = useQuery({
    queryKey: ["argos-console", "esecuzione", id], queryFn: () => console_.esecuzione(id),
    refetchInterval: (query) => ((query.state.data as any)?.status === "running" ? 3000 : false),
  });
  const r = useMemo(() => riepilogo(q.data?.eventi ?? []), [q.data]);
  const [soloProblemi, setSoloProblemi] = useState(false);
  if (q.isLoading) return <Caricamento />;
  if (q.error) return <Problema errore={q.error} />;
  if (!q.data) return null;
  const d = q.data;
  const t0 = d.eventi.length ? new Date(d.eventi[0]!.at).getTime() : 0;
  const eventi = soloProblemi ? d.eventi.filter(e => ["rifiuto", "errore", "nota"].includes(e.tipo) || (e.tipo === "esito" && e.dati?.ok === false)) : d.eventi;
  const testo = d.eventi.find(e => e.tipo === "testo")?.dati?.testo as string | undefined;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <PillStato stato={d.status as StatoEsecuzione} />
          <span className="text-xs text-muted-foreground">#{d.id} · {d.agent_key} · {new Date(d.created_at).toLocaleString("it-IT")}{d.project_id ? " · su un progetto" : ""}</span>
          {r.limitata && <Pill tinta="avviso">autonomia limitata a «propone»</Pill>}
        </div>
        <h3 className="mt-2 text-base font-semibold">{d.objective}</h3>
        {d.error && <div className="mt-2"><Problema errore={d.error} /></div>}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-6">
        <Numero etichetta="Durata" valore={durata(r.ms)} />
        <Numero etichetta="Token" valore={token(r.token || d.tokens)} />
        <Numero etichetta="Strumenti" valore={r.strumenti} />
        <Numero etichetta="Falliti" valore={r.falliti} tinta={r.falliti ? "errore" : undefined} />
        <Numero etichetta="Rifiuti del guardiano" valore={r.rifiuti} tinta={r.rifiuti ? "avviso" : undefined} />
        <Numero etichetta="Proposte" valore={d.proposte.length} />
      </div>
      {r.modello && <div className="text-[11px] text-muted-foreground">Modello: <code className="font-mono">{r.modello}</code></div>}

      {r.perStrumento.length > 0 && (
        <Riquadro titolo="Dove è andato il tempo">
          <Barre tinta="info" formato={durata}
            righe={r.perStrumento.slice(0, 10).map(s => ({ etichetta: s.nome, valore: s.ms, nota: `×${s.volte}${s.falliti ? ` · ${s.falliti} falliti` : ""}` }))} />
        </Riquadro>
      )}

      <Riquadro titolo={`La traccia (${d.eventi.length} passi)`} azione={
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={soloProblemi} onChange={e => setSoloProblemi(e.target.checked)} className="accent-[hsl(var(--primary))]" />
          solo problemi
        </label>}>
        {eventi.length ? (
          <ol className="relative space-y-1 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-border">
            {eventi.map(e => <Evento key={e.seq} e={e} t0={t0} />)}
          </ol>
        ) : <Vuoto>{soloProblemi ? "Nessun problema in questa esecuzione." : "Nessun passo registrato."}</Vuoto>}
      </Riquadro>

      {(d.summary || d.proposte.length > 0) && (
        <Riquadro titolo="Il piano">
          {d.summary && <p className="text-sm">{d.summary}</p>}
          {d.diagnosis && <p className="mt-1 text-xs text-muted-foreground">{d.diagnosis}</p>}
          <ol className="mt-3 space-y-2">
            {d.proposte.map(p => (
              <li key={p.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{p.title}
                  <Pill tinta={p.status === "open" ? "info" : p.status === "rejected" ? "errore" : "ok"}>{p.status === "open" ? "da rivedere" : p.status}</Pill>
                  {p.line && <Pill tinta="neutro">linea {p.line}</Pill>}</div>
                {p.detail && <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>}
                {p.rationale && <p className="mt-1 text-xs"><span className="text-muted-foreground">Perché:</span> {p.rationale}</p>}
              </li>
            ))}
          </ol>
        </Riquadro>
      )}

      {testo && (
        <Riquadro titolo="La risposta">
          <div className="prose-sm max-w-none text-sm leading-relaxed">
            <Suspense fallback={<p className="whitespace-pre-wrap">{testo}</p>}><ArgosMarkdown>{testo}</ArgosMarkdown></Suspense>
          </div>
        </Riquadro>
      )}
    </div>
  );
}

export default function Ispettore({ selezionata, seleziona }: { selezionata: number | null; seleziona: (id: number | null) => void }) {
  const agenti = useQuery({ queryKey: ["argos-console", "agenti"], queryFn: console_.agenti });
  const [agente, setAgente] = useState("");
  const [stato, setStato] = useState<"" | StatoEsecuzione>("");
  const q = useQuery({
    queryKey: ["argos-console", "esecuzioni", agente], queryFn: () => console_.esecuzioni(agente || undefined, 100),
    refetchInterval: 15_000,
  });
  const righe: RigaEsecuzione[] = (q.data?.esecuzioni ?? []).filter(r => !stato || r.status === stato);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <Riquadro titolo="Esecuzioni" azione={
        <Button variant="ghost" size="sm" onClick={() => void q.refetch()} aria-label="Aggiorna l'elenco"><RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} aria-hidden /></Button>}>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="text-[11px] text-muted-foreground">Agente
            <select value={agente} onChange={e => setAgente(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground">
              <option value="">Tutti</option>
              {(agenti.data?.agenti ?? []).map(a => <option key={a.chiave} value={a.chiave}>{a.nome}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-muted-foreground">Stato
            <select value={stato} onChange={e => setStato(e.target.value as any)} className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground">
              <option value="">Tutti</option><option value="running">In corso</option><option value="completed">Completate</option>
              <option value="failed">Fallite</option><option value="empty">Vuote</option>
            </select>
          </label>
        </div>
        {q.isLoading ? <Caricamento /> : q.error ? <Problema errore={q.error} /> : !righe.length ? <Vuoto>Nessuna esecuzione.</Vuoto> : (
          <ul className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
            {righe.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => seleziona(r.id)} aria-current={selezionata === r.id}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selezionata === r.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/60"}`}>
                  <div className="flex items-center justify-between gap-2"><PillStato stato={r.status} /><span className="text-[11px] tabular-nums text-muted-foreground">{quandoFa(r.created_at)}</span></div>
                  <div className="mt-1 line-clamp-2 text-sm">{r.objective}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{r.agent_key} · {r.eventi} passi · {r.proposte} proposte · {token(r.tokens)} token</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Riquadro>
      <div>
        {selezionata != null ? <Dettaglio key={selezionata} id={selezionata} /> : (
          <Vuoto><CircleStop className="mx-auto mb-2 h-5 w-5" aria-hidden />Scegli un'esecuzione per vederne la traccia.</Vuoto>
        )}
      </div>
    </div>
  );
}
