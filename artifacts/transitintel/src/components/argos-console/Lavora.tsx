/**
 * Far lavorare un agente, in diretta: si sceglie l'agente, facoltativamente
 * un progetto di Planning Studio, si scrive il compito. Si vedono gli
 * strumenti che chiama (con l'esito), le note, la risposta mentre la scrive,
 * il piano. L'esecuzione resta nell'ispettore anche se la pagina si chiude.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Loader2, Play, Search, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listPsProjects } from "@/lib/planning-studio-api";
import {
  DIRETTA_VUOTA, applica, autonomiaEffettiva, console_, durata, esegui, NOMI_AUTONOMIA, token, type Diretta,
} from "@/lib/argos-console";
import { Caricamento, Pill, PillAutonomia, PillFascia, PillStato, Problema, Riquadro, Vuoto } from "./comuni";

const ArgosMarkdown = lazy(() => import("@/components/argos/ArgosMarkdown"));

const ESEMPI = [
  "Quali linee del progetto hanno la frequenza più bassa nell'ora di punta del mattino?",
  "Le coincidenze con i treni alla stazione principale: dove si perdono?",
  "Riassumi lo stato di salute del progetto e che cosa sistemeresti per primo.",
];

export default function Lavora({ agenteIniziale, apriEsecuzione }: { agenteIniziale: string | null; apriEsecuzione: (id: number) => void }) {
  const qc = useQueryClient();
  const agenti = useQuery({ queryKey: ["argos-console", "agenti"], queryFn: console_.agenti });
  const progetti = useQuery({ queryKey: ["argos-console", "progetti"], queryFn: listPsProjects, staleTime: 5 * 60_000 });
  const [chiave, setChiave] = useState<string | null>(agenteIniziale);
  const [progetto, setProgetto] = useState<string>("");
  const [compito, setCompito] = useState("");
  const [diretta, setDiretta] = useState<Diretta>(DIRETTA_VUOTA);
  const [inCorso, setInCorso] = useState(false);
  const [inizio, setInizio] = useState<number | null>(null);
  const [ora, setOra] = useState(Date.now());
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => { if (agenteIniziale) setChiave(agenteIniziale); }, [agenteIniziale]);
  useEffect(() => {
    if (!chiave && agenti.data?.agenti.length) setChiave(agenti.data.agenti.find(a => a.chiave === "analista")?.chiave ?? agenti.data.agenti[0]!.chiave);
  }, [agenti.data, chiave]);
  useEffect(() => {
    if (!inCorso) return;
    const t = setInterval(() => setOra(Date.now()), 500);
    return () => clearInterval(t);
  }, [inCorso]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const agente = useMemo(() => agenti.data?.agenti.find(a => a.chiave === chiave) ?? null, [agenti.data, chiave]);

  async function avvia() {
    if (!chiave || !compito.trim() || inCorso) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setDiretta(DIRETTA_VUOTA);
    setInCorso(true);
    setInizio(Date.now());
    try {
      await esegui(chiave, compito.trim(), progetto || null, ev => setDiretta(d => applica(d, ev)), c.signal);
    } catch (err: any) {
      if (err?.name !== "AbortError") setDiretta(d => ({ ...d, errore: err?.message || "Collegamento interrotto" }));
      else setDiretta(d => ({ ...d, note: [...d.note, "Fermato da te: Argos chiude l'esecuzione e la segna come interrotta"] }));
    } finally {
      setInCorso(false);
      setOra(Date.now());
      void qc.invalidateQueries({ queryKey: ["argos-console", "esecuzioni"] });
      void qc.invalidateQueries({ queryKey: ["argos-console", "budget"] });
    }
  }

  const trascorso = inizio ? (inCorso ? ora : (diretta.fine ? inizio + diretta.fine.ms : ora)) - inizio : null;
  const proposte: any[] = Array.isArray(diretta.piano?.proposals) ? diretta.piano!.proposals : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Riquadro titolo="Chi lavora">
          {agenti.isLoading ? <Caricamento /> : agenti.error ? <Problema errore={agenti.error} /> : (
            <fieldset className="space-y-2">
              <legend className="sr-only">Scegli l'agente</legend>
              {(agenti.data?.agenti ?? []).map(a => (
                <label key={a.chiave} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors ${chiave === a.chiave ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}>
                  <input type="radio" name="agente" value={a.chiave} checked={chiave === a.chiave} onChange={() => setChiave(a.chiave)} className="mt-1 accent-[hsl(var(--primary))]" disabled={inCorso} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{a.nome}</span>
                    <span className="block text-[11px] text-muted-foreground">{a.descrizione}</span>
                    <span className="mt-1 flex flex-wrap gap-1"><PillFascia fascia={a.livelloModello} /><PillAutonomia autonomia={a.autonomia} /></span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {agente && autonomiaEffettiva(agente.autonomia) !== agente.autonomia && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              In questa fase lavora come «{NOMI_AUTONOMIA[autonomiaEffettiva(agente.autonomia)]}»: legge e propone, non scrive su Cerbero.
              Per applicare modifiche usa il Pianificatore dal pannello del progetto.
            </p>
          )}
        </Riquadro>

        <Riquadro titolo="Il compito">
          <div className="space-y-3">
            <div>
              <label htmlFor="argos-progetto" className="text-xs font-medium">Progetto di Planning Studio <span className="font-normal text-muted-foreground">(facoltativo)</span></label>
              <select id="argos-progetto" value={progetto} onChange={e => setProgetto(e.target.value)} disabled={inCorso}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">Nessun progetto: documenti e dati di esercizio</option>
                {(progetti.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">Con un progetto l'agente legge linee, corse e orari con i tuoi diritti.</p>
            </div>
            <div>
              <label htmlFor="argos-compito" className="text-xs font-medium">Che cosa deve fare</label>
              <textarea id="argos-compito" value={compito} onChange={e => setCompito(e.target.value.slice(0, 4000))} rows={5} disabled={inCorso}
                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void avvia(); } }}
                placeholder="Per esempio: dove si perdono le coincidenze con i treni al mattino?"
                className="mt-1 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>Ctrl+Invio per avviare</span><span className="tabular-nums">{compito.length}/4000</span></div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ESEMPI.map(e => (
                <button key={e} type="button" onClick={() => setCompito(e)} disabled={inCorso}
                  className="rounded-full border border-border px-2 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">{e}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void avvia()} disabled={!chiave || !compito.trim() || inCorso} className="flex-1">
                {inCorso ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Play className="mr-1.5 h-4 w-4" aria-hidden />}
                {inCorso ? "Sta lavorando…" : "Avvia"}
              </Button>
              {inCorso && <Button variant="outline" onClick={() => ctrl.current?.abort()}><Square className="mr-1.5 h-4 w-4" aria-hidden />Ferma</Button>}
            </div>
          </div>
        </Riquadro>
      </div>

      <Riquadro titolo="In diretta" azione={
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          {diretta.fine ? <PillStato stato={diretta.fine.status} /> : inCorso ? <PillStato stato="running" /> : null}
          {trascorso != null && <span>{durata(trascorso)}</span>}
          {diretta.fine && <span>{token(diretta.fine.tokens)} token</span>}
        </div>}>
        {!inCorso && !diretta.runId && !diretta.errore ? (
          <Vuoto>Scegli un agente, scrivi il compito e avvia: qui vedi gli strumenti che usa e la risposta mentre la scrive.</Vuoto>
        ) : (
          <div className="space-y-4" aria-live="polite">
            {diretta.errore && <Problema errore={diretta.errore} />}
            {diretta.note.length > 0 && (
              <ul className="space-y-1">
                {diretta.note.map((n, i) => <li key={i} className="text-xs" data-tinta="avviso"><span className="argos-tinta">●</span> {n}</li>)}
              </ul>
            )}
            {diretta.strumenti.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Strumenti usati</div>
                <ol className="flex flex-wrap gap-1.5">
                  {diretta.strumenti.map((s, i) => (
                    <li key={i}>
                      <Pill tinta={s.ok === null ? "info" : s.ok ? "ok" : "errore"}>
                        {s.ok === null ? <CircleDashed className="h-3 w-3 animate-spin" aria-hidden /> : s.ok ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <XCircle className="h-3 w-3" aria-hidden />}
                        <code className="font-mono">{s.nome}</code>
                        <span className="sr-only">{s.ok === null ? "in corso" : s.ok ? "riuscito" : "fallito o rifiutato"}</span>
                      </Pill>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {diretta.testo && (
              <div className="prose-sm max-w-none text-sm leading-relaxed">
                <Suspense fallback={<p className="whitespace-pre-wrap">{diretta.testo}</p>}><ArgosMarkdown>{diretta.testo}</ArgosMarkdown></Suspense>
              </div>
            )}
            {diretta.domanda && (
              <div className="rounded-lg border border-border p-3" data-tinta="memoria">
                <div className="text-[11px] font-medium argos-tinta">L'agente ti chiede</div>
                <div className="mt-1 text-sm">{String(diretta.domanda.question ?? "")}</div>
                {Array.isArray(diretta.domanda.options) && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{diretta.domanda.options.map((o: any, i: number) => <li key={i}>{String(o?.label ?? o)}</li>)}</ul>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">Rispondi con un nuovo compito più preciso.</p>
              </div>
            )}
            {diretta.piano && (
              <div className="rounded-lg border border-border">
                <div className="border-b border-border px-3 py-2 text-sm font-semibold">Il piano proposto</div>
                <div className="space-y-2 p-3">
                  {diretta.piano.summary && <p className="text-sm">{String(diretta.piano.summary)}</p>}
                  {diretta.piano.diagnosis && <p className="text-xs text-muted-foreground">{String(diretta.piano.diagnosis)}</p>}
                  <ol className="space-y-2">
                    {proposte.map((p, i) => (
                      <li key={i} className="rounded-md border border-border px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{String(p.title ?? "")}
                          {p.priority && <Pill tinta={p.priority === "critica" || p.priority === "alta" ? "avviso" : "neutro"}>priorità {String(p.priority)}</Pill>}</div>
                        {p.detail && <p className="mt-1 text-xs text-muted-foreground">{String(p.detail)}</p>}
                      </li>
                    ))}
                  </ol>
                  <p className="text-[11px] text-muted-foreground">Le proposte nascono da rivedere: nessuna è stata applicata.</p>
                </div>
              </div>
            )}
            {diretta.runId != null && !inCorso && (
              <Button variant="outline" size="sm" onClick={() => apriEsecuzione(diretta.runId!)}>
                <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden />Apri la traccia nell'ispettore
              </Button>
            )}
          </div>
        )}
      </Riquadro>
    </div>
  );
}
