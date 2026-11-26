/**
 * Le conversazioni con Argos: a sinistra l'elenco (per progetto, archiviate a
 * parte), a destra la conversazione aperta, da riprendere dove si era rimasti.
 *
 * Una conversazione nasce con un modo che non cambia più: Risposta e Analisi
 * (documenti, dati di Cerbero, web; Analisi più a fondo) oppure Agente, con un
 * agente della squadra. Il Pianificatore lavora su un progetto e porta con sé
 * tutto quello che aveva nel pannello di Planning Studio: modalità Agente ·
 * Piano · Accetta, obiettivi, sorveglianza, piani da approvare, annullo.
 *
 * Le chat del vecchio pannello non si perdono: per ogni progetto si possono
 * importare in una conversazione («Dal pannello · …») e riprendere da qui.
 * La memoria vera sta in Argos (tabelle conversations e conversation_messages);
 * Cerbero filtra per utente e per progetto accessibile (routes/argos-console.ts).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, Download, Eye, Loader2, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listPsProjects } from "@/lib/planning-studio-api";
import {
  console_, conversazioni, NOMI_MODO, quandoFa, SPIEGA_MODO, TITOLI_PANNELLO, token,
  type Conversazione, type ModoConversazione,
} from "@/lib/argos-console";
import type { OsservatoreTurno } from "@/components/argos/ArgosConversation";
import { origineDi, promptApplica, titoloApplica, type PianoArgos } from "@/lib/argos-applica";
import { proposte as proposteApi } from "@/lib/argos-console";
import { Caricamento, Pill, Problema, Vuoto } from "./comuni";
import { StudioNeurale } from "./StudioNeurale";

const ArgosConversation = lazy(() => import("@/components/argos/ArgosConversation"));

/** Il regista di Argos: sceglie la squadra da sé (argos/api/regia.py). */
const REGISTA = "regista";
type Scelta = "regia" | ModoConversazione;
const CHIAVE_ELENCO = "argos-elenco-chiuso";

function leggiElencoChiuso(): boolean {
  try { return localStorage.getItem(CHIAVE_ELENCO) !== "0"; } catch { return true; }
}
const CAMPO = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function messaggioDi(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "errore");
}

export default function Conversazioni({ progettoIniziale, conversazioneIniziale, onCambia, avvia, onAvviato }: {
  progettoIniziale: string | null;
  conversazioneIniziale: string | null;
  /** «Parti da questa» dalla scheda Proposte: il piano da passare al Pianificatore su quel progetto */
  avvia?: { piano: PianoArgos; progetto: string } | null;
  onAvviato?: () => void;
  /** la conversazione aperta e il progetto del filtro, per l'indirizzo della pagina */
  onCambia: (conversazione: string | null, progetto: string | null) => void;
}) {
  const qc = useQueryClient();
  const progetti = useQuery({ queryKey: ["argos-console", "progetti"], queryFn: listPsProjects, staleTime: 5 * 60_000 });
  const agenti = useQuery({ queryKey: ["argos-console", "agenti"], queryFn: console_.agenti, staleTime: 5 * 60_000 });
  const stato = useQuery({ queryKey: ["argos-console", "stato"], queryFn: console_.stato, refetchInterval: 30_000 });

  const [filtro, setFiltro] = useState<string>(progettoIniziale ?? "");
  const [archiviate, setArchiviate] = useState(false);
  const [aperta, setAperta] = useState<string | null>(conversazioneIniziale);
  const [nuova, setNuova] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [lavoro, setLavoro] = useState<string | null>(null);
  // «Applica col Pianificatore»: la conversazione nuova e il messaggio che parte da solo
  const [inizio, setInizio] = useState<{ conv: string; testo: string; origine: number[] } | null>(null);

  /** Il piano passa al Pianificatore: una conversazione sul progetto, che parte da sola in «accetta
   *  modifiche»; le proposte d'origine si segnano «in corso». */
  const passaAlPianificatore = useCallback(async (progetto: string, piano: PianoArgos) => {
    const d = await esegui("crea", () => conversazioni.crea({
      modo: "agente", agente: "pianificatore", progetto, titolo: titoloApplica(piano),
    }));
    if (!d) return;
    const origine = origineDi(piano);
    void Promise.allSettled(origine.map(id => proposteApi.cambia(id, "accepted")));
    setInizio({ conv: d.conversazione.id, testo: promptApplica(piano), origine });
    setNuova(false);
    aggiorna();
    setAperta(d.conversazione.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Parti da questa» dalla scheda Proposte
  useEffect(() => {
    if (!avvia) return;
    onAvviato?.();
    void passaAlPianificatore(avvia.progetto, avvia.piano);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avvia]);
  // l'elenco si richiude in una striscia: lo schermo va allo studio (ricordato nel browser)
  const [elencoChiuso, setElencoChiuso] = useState(leggiElencoChiuso);
  useEffect(() => { try { localStorage.setItem(CHIAVE_ELENCO, elencoChiuso ? "1" : "0"); } catch { /* storage spento */ } }, [elencoChiuso]);
  const chiuso = elencoChiuso && !!aperta && !nuova;

  const elenco = useQuery({
    queryKey: ["argos-console", "conversazioni", filtro, archiviate],
    queryFn: () => conversazioni.elenco(filtro || null, archiviate),
  });
  const righe = useMemo(() => elenco.data?.conversazioni ?? [], [elenco.data]);
  // quella aperta può non stare nell'elenco (un link, un altro filtro): si legge a parte
  const inElenco = righe.find(c => c.id === aperta) ?? null;
  const fuoriElenco = useQuery({
    queryKey: ["argos-console", "conversazione", aperta],
    queryFn: () => conversazioni.una(aperta!),
    enabled: !!aperta && !inElenco && !elenco.isLoading,
    retry: false,
  });
  const conv: Conversazione | null = inElenco ?? fuoriElenco.data?.conversazione ?? null;

  const pannello = useQuery({
    queryKey: ["argos-console", "pannello", filtro],
    queryFn: () => conversazioni.pannello(filtro),
    enabled: !!filtro,
    staleTime: 60_000,
  });

  useEffect(() => { onCambia(aperta, filtro || null); }, [aperta, filtro, onCambia]);

  // arrivando da Planning Studio con un progetto e nessuna conversazione: l'ultima di quel
  // progetto, oppure il modulo per cominciarne una col Pianificatore
  const primoArrivo = useRef(!!progettoIniziale && !conversazioneIniziale);
  useEffect(() => {
    if (!primoArrivo.current || elenco.isLoading || !elenco.data) return;
    primoArrivo.current = false;
    if (righe.length) setAperta(righe[0]!.id);
    else setNuova(true);
  }, [elenco.isLoading, elenco.data, righe]);

  const nomeProgetto = useCallback((id: string | null) => {
    if (!id) return null;
    return progetti.data?.find(p => p.id === id)?.name ?? "Progetto";
  }, [progetti.data]);
  const nomeAgente = useCallback((chiave: string | null) => {
    if (!chiave) return null;
    return agenti.data?.agenti?.find(a => a.chiave === chiave)?.nome ?? chiave;
  }, [agenti.data]);

  const aggiorna = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["argos-console", "conversazioni"] });
    void qc.invalidateQueries({ queryKey: ["argos-console", "conversazione"] });
  }, [qc]);

  async function esegui<T>(etichetta: string, fn: () => Promise<T>): Promise<T | undefined> {
    setErrore(null);
    setLavoro(etichetta);
    try {
      return await fn();
    } catch (err) {
      setErrore(messaggioDi(err));
      return undefined;
    } finally {
      setLavoro(null);
    }
  }

  async function importa(thread: "chat" | "agente") {
    const d = await esegui("importa", () => conversazioni.importaPannello(filtro, thread));
    if (d) { aggiorna(); setArchiviate(false); setAperta(d.conversazione.id); }
  }

  const importabili = useMemo(() => {
    if (!filtro || !pannello.data || archiviate) return [];
    const gia = new Set(righe.map(r => r.titolo));
    return (["agente", "chat"] as const)
      .filter(t => (pannello.data?.[t] ?? 0) > 0 && !gia.has(TITOLI_PANNELLO[t]))
      .map(t => ({ thread: t, n: pannello.data![t] }));
  }, [filtro, pannello.data, archiviate, righe]);

  const argosPronto = !stato.data || (stato.data.configured && stato.data.reachable !== false);

  return (
    <div className={`grid gap-3 ${chiuso ? "lg:grid-cols-[2.5rem_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"}`}>
      {/* ── l'elenco, o la sua striscia ── */}
      {chiuso ? (
        <aside className="flex gap-1.5 lg:flex-col" aria-label="Le tue conversazioni">
          <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => setElencoChiuso(false)} aria-label={`Apri l'elenco delle conversazioni (${righe.length})`} title="Le conversazioni">
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </Button>
          <Button size="icon" className="h-9 w-9" onClick={() => { setNuova(true); setErrore(null); }} aria-label="Nuova conversazione" title="Nuova conversazione">
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
          </Button>
        </aside>
      ) : (
      <aside className="space-y-3" aria-label="Le tue conversazioni">
        <div className="flex items-center gap-2">
          <Button size="sm" className="flex-1 gap-1.5" onClick={() => { setNuova(true); setErrore(null); }}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden />Nuova conversazione
          </Button>
          {aperta && (
            <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => setElencoChiuso(true)} aria-label="Richiudi l'elenco: più spazio allo studio" title="Richiudi l'elenco">
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
        <div className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-sm">
          <label htmlFor="conv-filtro" className="text-xs font-medium">Progetto</label>
          <select id="conv-filtro" value={filtro} onChange={e => setFiltro(e.target.value)} className={CAMPO}>
            <option value="">Tutte le conversazioni</option>
            {(progetti.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={archiviate} onChange={e => setArchiviate(e.target.checked)} className="accent-[hsl(var(--primary))]" />
            Mostra le archiviate
          </label>
        </div>

        {importabili.length > 0 && (
          <div className="space-y-2 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-3 text-xs">
            <p className="font-medium">Le chat del pannello di Planning Studio</p>
            <p className="text-muted-foreground">Su questo progetto avevi già parlato con Argos dal pannello laterale. Importale per riprenderle da qui: il pannello non c'è più, le chat non si perdono.</p>
            {importabili.map(x => (
              <Button key={x.thread} size="sm" variant="outline" className="w-full justify-start gap-1.5" disabled={!!lavoro} onClick={() => void importa(x.thread)}>
                {lavoro === "importa" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
                {x.thread === "agente" ? "Pianificatore" : "Chat"} · {x.n} messaggi
              </Button>
            ))}
          </div>
        )}

        {elenco.isLoading ? <Caricamento /> : elenco.error ? <Problema errore={elenco.error} /> : righe.length === 0 ? (
          <Vuoto>{archiviate ? "Nessuna conversazione archiviata." : "Ancora nessuna conversazione: cominciane una."}</Vuoto>
        ) : (
          <ul className="space-y-1.5">
            {righe.map(c => (
              <li key={c.id}>
                <button type="button" onClick={() => { setAperta(c.id); setNuova(false); setErrore(null); }}
                  aria-current={c.id === aperta ? "true" : undefined}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${c.id === aperta && !nuova ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"}`}>
                  <span className="block truncate text-sm font-medium">{c.titolo || "Conversazione senza titolo"}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <Pill tinta={c.modo === "agente" ? "memoria" : c.modo === "analisi" ? "avviso" : "info"}>{c.modo === "agente" ? nomeAgente(c.agente) : NOMI_MODO[c.modo]}</Pill>
                    {c.occupata && <Pill tinta="info"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />al lavoro</Pill>}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {[nomeProgetto(c.progetto), `${c.turni} ${c.turni === 1 ? "turno" : "turni"}`, quandoFa(c.aggiornata)].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      )}

      {/* ── la conversazione aperta, o la nuova ── */}
      <section className="min-w-0" aria-live="polite">
        {errore && <div className="mb-3"><Problema errore={errore} /></div>}
        {nuova ? (
          <NuovaConversazione
            progettoIniziale={filtro || progettoIniziale || ""}
            progetti={progetti.data ?? []}
            agenti={agenti.data?.agenti ?? []}
            inCorso={lavoro === "crea"}
            annulla={() => setNuova(false)}
            crea={async dati => {
              const d = await esegui("crea", () => conversazioni.crea(dati));
              if (d) { aggiorna(); setArchiviate(false); setNuova(false); setAperta(d.conversazione.id); }
            }}
          />
        ) : !aperta ? (
          <Vuoto>Scegli una conversazione a sinistra, o cominciane una nuova.</Vuoto>
        ) : !conv ? (
          fuoriElenco.error ? <Problema errore={fuoriElenco.error} /> : <Caricamento />
        ) : (
          <ConversazioneAperta
            key={conv.id}
            conv={conv}
            nomeAgente={nomeAgente(conv.agente)}
            nomeProgetto={nomeProgetto(conv.progetto)}
            lavoro={lavoro}
            argosPronto={argosPronto}
            tiConfigured={stato.data?.transitintel !== false}
            rinomina={async titolo => { if (await esegui("rinomina", () => conversazioni.modifica(conv.id, { titolo }))) aggiorna(); }}
            archivia={async si => {
              if (await esegui("archivia", () => conversazioni.modifica(conv.id, { archiviata: si }))) { aggiorna(); setArchiviate(si); }
            }}
            elimina={async () => {
              if (await esegui("elimina", () => conversazioni.elimina(conv.id))) { aggiorna(); setAperta(null); }
            }}
            onTurnoFinito={aggiorna}
            onApplicaPiano={conv.progetto && !conv.archiviata && conv.agente !== "pianificatore"
              ? piano => { void passaAlPianificatore(conv.progetto!, piano); } : undefined}
            primoMessaggio={inizio?.conv === conv.id ? inizio.testo : undefined}
            origineProposte={inizio?.conv === conv.id ? inizio.origine : undefined}
            onPrimoInviato={() => setInizio(null)}
          />
        )}
      </section>
    </div>
  );
}

function NuovaConversazione({ progettoIniziale, progetti, agenti, inCorso, annulla, crea }: {
  progettoIniziale: string;
  progetti: Array<{ id: string; name: string }>;
  agenti: Array<{ chiave: string; nome: string; descrizione: string }>;
  inCorso: boolean;
  annulla: () => void;
  crea: (d: { modo: ModoConversazione; agente: string | null; progetto: string | null; titolo: string }) => Promise<void>;
}) {
  // Di partenza lavora Argos, che sceglie da sé la squadra (il regista); da un progetto si
  // arriva di solito per pianificare e applicare: lì la proposta resta il Pianificatore.
  const conRegia = agenti.some(a => a.chiave === REGISTA);
  const [scelta, setScelta] = useState<Scelta>(progettoIniziale ? "agente" : "regia");
  const [agente, setAgente] = useState<string>(progettoIniziale ? "pianificatore" : "analista");
  const [progetto, setProgetto] = useState<string>(progettoIniziale);
  const [titolo, setTitolo] = useState("");
  const selezionabili = useMemo(() => agenti.filter(a => a.chiave !== REGISTA), [agenti]);
  useEffect(() => {
    if (selezionabili.length && !selezionabili.some(a => a.chiave === agente)) setAgente(selezionabili[0]!.chiave);
  }, [selezionabili, agente]);
  // un Argos che non ha ancora il regista: la scelta di prima
  useEffect(() => { if (agenti.length && !conRegia && scelta === "regia") setScelta("risposta"); }, [agenti.length, conRegia, scelta]);

  const modo: ModoConversazione = scelta === "regia" ? "agente" : scelta;
  const chi = scelta === "regia" ? REGISTA : agente;
  const scelto = scelta === "agente" ? selezionabili.find(a => a.chiave === agente) ?? null : null;
  const serveProgetto = scelta === "agente" && agente === "pianificatore";
  const pronto = !inCorso && (scelta !== "agente" || !!scelto) && (scelta !== "regia" || conRegia)
    && (!serveProgetto || !!progetto);
  const scelte: Array<{ k: Scelta; nome: string; spiega: string }> = [
    ...(conRegia ? [{ k: "regia" as const, nome: "Argos", spiega: "Sceglie da sé gli agenti giusti e li fa lavorare insieme. Consigliato." }] : []),
    { k: "risposta", nome: NOMI_MODO.risposta, spiega: SPIEGA_MODO.risposta },
    { k: "analisi", nome: NOMI_MODO.analisi, spiega: SPIEGA_MODO.analisi },
    { k: "agente", nome: "Un agente preciso", spiega: "Scegli tu chi lavora, fra quelli della squadra." },
  ];

  return (
    <form className="max-w-2xl space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
      onSubmit={e => { e.preventDefault(); if (pronto) void crea({ modo, agente: modo === "agente" ? chi : null, progetto: progetto || null, titolo: titolo.trim() }); }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Nuova conversazione</h2>
        <button type="button" onClick={annulla} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Chiudi"><X className="h-4 w-4" aria-hidden /></button>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-medium">Come lavora Argos <span className="font-normal text-muted-foreground">(non cambia più)</span></legend>
        {scelte.map(o => (
          <label key={o.k} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors focus-within:ring-2 focus-within:ring-primary/40 ${scelta === o.k ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}>
            <input type="radio" name="conv-modo" value={o.k} checked={scelta === o.k} onChange={() => setScelta(o.k)} className="sr-only" />
            <span className="block font-medium">{o.nome}</span>
            <span className="block text-[11px] text-muted-foreground">{o.spiega}</span>
          </label>
        ))}
      </fieldset>
      {scelta === "agente" && (
        <div>
          <label htmlFor="conv-agente" className="text-xs font-medium">Agente</label>
          <select id="conv-agente" value={agente} onChange={e => setAgente(e.target.value)} className={`mt-1 ${CAMPO}`}>
            {selezionabili.map(a => <option key={a.chiave} value={a.chiave}>{a.nome}</option>)}
          </select>
          {scelto && <p className="mt-1 text-[11px] text-muted-foreground">{scelto.descrizione}</p>}
        </div>
      )}
      <div>
        <label htmlFor="conv-progetto" className="text-xs font-medium">
          Progetto di Planning Studio {serveProgetto ? <span className="font-normal text-muted-foreground">(serve al Pianificatore)</span> : <span className="font-normal text-muted-foreground">(facoltativo)</span>}
        </label>
        <select id="conv-progetto" value={progetto} onChange={e => setProgetto(e.target.value)} className={`mt-1 ${CAMPO}`} required={serveProgetto}>
          <option value="">{serveProgetto ? "Scegli il progetto" : "Nessun progetto"}</option>
          {progetti.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="mt-1 text-[11px] text-muted-foreground">Con un progetto Argos legge linee, corse e orari con i tuoi diritti. La conversazione resta legata a quel progetto.</p>
      </div>
      <div>
        <label htmlFor="conv-titolo" className="text-xs font-medium">Titolo <span className="font-normal text-muted-foreground">(facoltativo: altrimenti la prima domanda)</span></label>
        <input id="conv-titolo" value={titolo} onChange={e => setTitolo(e.target.value.slice(0, 120))} className={`mt-1 ${CAMPO}`} placeholder="Per esempio: orario invernale 2027" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={annulla}>Annulla</Button>
        <Button type="submit" size="sm" disabled={!pronto} className="gap-1.5">
          {inCorso && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}Comincia
        </Button>
      </div>
    </form>
  );
}

function ConversazioneAperta({ conv, nomeAgente, nomeProgetto, lavoro, argosPronto, tiConfigured, rinomina, archivia, elimina, onTurnoFinito, onApplicaPiano, primoMessaggio, onPrimoInviato, origineProposte }: {
  onApplicaPiano?: (piano: PianoArgos) => void;
  primoMessaggio?: string;
  origineProposte?: number[];
  onPrimoInviato?: () => void;
  conv: Conversazione;
  nomeAgente: string | null;
  nomeProgetto: string | null;
  lavoro: string | null;
  argosPronto: boolean;
  tiConfigured: boolean;
  rinomina: (titolo: string) => Promise<void>;
  archivia: (si: boolean) => Promise<void>;
  elimina: () => Promise<void>;
  onTurnoFinito: () => void;
}) {
  const [titolo, setTitolo] = useState<string | null>(null);
  const [conferma, setConferma] = useState(false);
  const legata = useMemo(() => ({ id: conv.id, modo: conv.modo, agente: conv.agente, progetto: conv.progetto }), [conv.id, conv.modo, conv.agente, conv.progetto]);
  // lo studio della rete neurale guarda ogni turno mentre si svolge
  const palco = useRef<OsservatoreTurno>(null);
  const osservatore = useMemo<OsservatoreTurno>(() => ({
    inizio: q => palco.current?.inizio(q),
    evento: p => palco.current?.evento(p),
    fine: (e, m) => palco.current?.fine(e, m),
  }), []);

  return (
    <div className="space-y-2">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {titolo === null ? (
            <h2 className="truncate text-lg font-semibold">{conv.titolo || "Conversazione senza titolo"}</h2>
          ) : (
            <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); void rinomina(titolo).then(() => setTitolo(null)); }}>
              <label htmlFor="conv-rinomina" className="sr-only">Nuovo titolo</label>
              <input id="conv-rinomina" autoFocus value={titolo} onChange={e => setTitolo(e.target.value.slice(0, 120))} className={`${CAMPO} min-w-[16rem]`} />
              <Button type="submit" size="icon" variant="ghost" aria-label="Salva il titolo" disabled={!!lavoro}><Check className="h-4 w-4" aria-hidden /></Button>
              <Button type="button" size="icon" variant="ghost" aria-label="Annulla" onClick={() => setTitolo(null)}><X className="h-4 w-4" aria-hidden /></Button>
            </form>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[conv.modo === "agente" ? nomeAgente : NOMI_MODO[conv.modo], nomeProgetto, `${conv.turni} ${conv.turni === 1 ? "turno" : "turni"}`, conv.tokens ? `${token(conv.tokens)} token` : null,
              conv.compattazioni ? `riassunta ${conv.compattazioni} ${conv.compattazioni === 1 ? "volta" : "volte"}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {conferma ? (
            <span className="flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs" role="alert">
              Eliminarla per sempre, con tutti i messaggi?
              <Button size="sm" variant="destructive" className="h-7" disabled={!!lavoro} onClick={() => void elimina()}>Elimina</Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setConferma(false)}>No</Button>
            </span>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="gap-1" onClick={() => setTitolo(conv.titolo)} disabled={!!lavoro}><Pencil className="h-3.5 w-3.5" aria-hidden />Rinomina</Button>
              <Button size="sm" variant="ghost" className="gap-1" onClick={() => void archivia(!conv.archiviata)} disabled={!!lavoro || conv.occupata}>
                {conv.archiviata ? <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> : <Archive className="h-3.5 w-3.5" aria-hidden />}
                {conv.archiviata ? "Ripristina" : "Archivia"}
              </Button>
              <Button size="sm" variant="ghost" className="gap-1 text-destructive hover:text-destructive" onClick={() => setConferma(true)} disabled={!!lavoro || conv.occupata}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden />Elimina
              </Button>
            </>
          )}
        </div>
      </header>
      <StudioNeurale key={conv.id} ref={palco} titolo={conv.titolo || "Conversazione senza titolo"}>
        <div className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-[var(--studio-chat-in-alto)] via-[var(--studio-chat-in-mezzo)] to-[var(--studio-chat-in-basso)]">
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-violet-300"><Eye className="h-6 w-6 animate-pulse" aria-hidden /></div>}>
            <ArgosConversation
              conversazione={legata}
              projectId={conv.progetto ?? undefined}
              argosReady={argosPronto}
              tiConfigured={tiConfigured}
              onTurnoFinito={onTurnoFinito}
              onApplicaPiano={onApplicaPiano}
              primoMessaggio={primoMessaggio}
              onPrimoInviato={onPrimoInviato}
              origineProposte={origineProposte}
              solaLettura={conv.archiviata ? "Archiviata: ripristinala per continuare" : undefined}
              osservatore={conv.archiviata ? undefined : osservatore}
            />
          </Suspense>
        </div>
      </StudioNeurale>
    </div>
  );
}
