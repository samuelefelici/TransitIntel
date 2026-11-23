/**
 * Il palco della rete neurale, sopra la chat della scheda Conversazione.
 *
 * Quando parte un turno si apre grande: la rete di Argos (lib/argos-sciame.ts)
 * legge i passaggi della biblioteca, sceglie, collega, chiama gli strumenti e
 * fa volare le parole verso la risposta, che intanto si scrive sotto. A turno
 * finito si richiude da solo in una barra piccola: che cosa ha fatto la rete
 * (passaggi letti, fonti date al modello, ponti, concetti, strumenti, frasi
 * con una fonte, tempo e token), con «Rivedi» per rigiocare la scena.
 *
 * Il palco riceve gli eventi del turno da ArgosConversation (OsservatoreTurno):
 * niente richieste in più, se non la mappa dei documenti per le nebulose.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BookOpen, Brain, ChevronDown, ChevronUp, FileText, Link2, Loader2, RotateCcw, ShieldCheck, Sparkles, Timer, Wrench } from "lucide-react";
import type { OsservatoreTurno } from "@/components/argos/ArgosConversation";
import { FASI_SCIAME, Sciame, type RiepilogoSciame, type StatoSciame } from "@/lib/argos-sciame";
import { durata, mappe, token } from "@/lib/argos-console";

/** quanto resta aperta la scena dopo l'ultima frase verificata, prima di lasciare spazio alla chat */
const PAUSA_FINALE_MS = 1600;

type Vista = "vuota" | "aperta" | "chiusa";

/** la scena non deve mai rompere la chat: un suo errore resta suo */
function prova(f: () => void): void {
  try { f(); } catch (e) { console.warn("palco neurale:", e); }
}

export const PalcoNeurale = forwardRef<OsservatoreTurno>(function PalcoNeurale(_props, ref) {
  const contenitore = useRef<HTMLDivElement>(null);
  const tela = useRef<HTMLCanvasElement>(null);
  const motore = useRef<Sciame | null>(null);
  const [vista, setVista] = useState<Vista>("vuota");
  const [stato, setStato] = useState<StatoSciame | null>(null);
  const [riepilogo, setRiepilogo] = useState<RiepilogoSciame | null>(null);
  const [altezza, setAltezza] = useState(360);
  // canvas non disponibile (browser vecchio, memoria): niente scena, la chat resta com'è
  const [guasto, setGuasto] = useState(false);
  // chi apre o chiude a mano decide lui: la scena non si richiude da sola
  const aMano = useRef(false);
  const chiusura = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // gli eventi arrivati prima che la tela esista (il primo turno) aspettano qui
  const inAttesa = useRef<Array<(m: Sciame) => void>>([]);

  const mappa = useQuery({ queryKey: ["argos-console", "mappa", "documenti"], queryFn: mappe.documenti, staleTime: 10 * 60_000, retry: false });

  const conMotore = useCallback((f: (m: Sciame) => void) => {
    const m = motore.current;
    if (m) prova(() => f(m)); else inAttesa.current.push(f);
  }, []);

  useImperativeHandle(ref, () => ({
    inizio(domanda: string) {
      aMano.current = false;
      clearTimeout(chiusura.current);
      setRiepilogo(null);
      setVista("aperta");
      conMotore(m => m.avvia(domanda));
    },
    evento(payload: unknown) { conMotore(m => m.evento(payload)); },
    fine(esito, messaggio) {
      conMotore(m => { m.fine(esito, messaggio); setRiepilogo(m.riepilogo()); });
    },
  }), [conMotore]);

  // la tela nasce col primo turno e resta: «Rivedi» rigioca l'ultimo
  useEffect(() => {
    if (vista === "vuota" || guasto || motore.current || !tela.current) return;
    let m: Sciame;
    try {
      // il motore avvisa già dal costruttore: il riepilogo si chiede a motore.current, che c'è solo dopo
      m = new Sciame(tela.current, { onStato: s => { setStato(s); if (!s.inCorso && motore.current) setRiepilogo(motore.current.riepilogo()); } });
    } catch (e) {
      console.warn("palco neurale non disponibile:", e);
      inAttesa.current = [];
      setGuasto(true);
      return;
    }
    motore.current = m;
    if (mappa.data) prova(() => m.impostaMappa(mappa.data));
    for (const f of inAttesa.current.splice(0)) prova(() => f(m));
  }, [vista, guasto, mappa.data]);
  useEffect(() => () => { motore.current?.distruggi(); motore.current = null; clearTimeout(chiusura.current); }, []);
  useEffect(() => { const m = motore.current; if (mappa.data && m) prova(() => m.impostaMappa(mappa.data)); }, [mappa.data]);

  // la scena ha raccontato tutto: dopo una pausa la chat torna grande
  useEffect(() => {
    if (!stato?.finito || stato.inCorso || vista !== "aperta" || aMano.current) return;
    chiusura.current = setTimeout(() => setVista("chiusa"), PAUSA_FINALE_MS);
    return () => clearTimeout(chiusura.current);
  }, [stato?.finito, stato?.inCorso, vista]);

  // chiusa o nascosta (un'altra scheda della pagina), la tela non disegna
  useEffect(() => { motore.current?.pausa(vista !== "aperta"); }, [vista]);

  // l'altezza della scena: una buona parte del riquadro, lasciando posto alla chat
  useEffect(() => {
    const box = contenitore.current?.parentElement;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      const h = box.getBoundingClientRect().height;
      if (h <= 0) { motore.current?.pausa(true); return; }
      setAltezza(Math.round(Math.max(240, Math.min(h * 0.62, h - 220))));
      motore.current?.pausa(vista !== "aperta");
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [vista]);
  useEffect(() => { motore.current?.ridimensiona(); }, [altezza]);

  const apri = () => { aMano.current = true; clearTimeout(chiusura.current); setVista("aperta"); };
  const chiudi = () => { aMano.current = true; clearTimeout(chiusura.current); setVista("chiusa"); };
  const rivedi = () => { let ok = false; prova(() => { ok = !!motore.current?.rivedi(); }); if (ok) { aMano.current = false; setVista("aperta"); } };

  if (vista === "vuota" || guasto) return <div ref={contenitore} hidden />;
  const fase = FASI_SCIAME[stato?.fase ?? 0]!;
  const inCorso = !!stato?.inCorso;

  return (
    <div ref={contenitore} className="shrink-0 border-b border-violet-400/25">
      {vista === "chiusa" && (
        <BarraRiepilogo riepilogo={riepilogo} stato={stato} apri={apri} rivedi={rivedi} />
      )}
      <motion.div
        initial={false}
        animate={{ height: vista === "aperta" ? altezza : 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative overflow-hidden"
        aria-hidden={vista !== "aperta"}
      >
        <div className="absolute inset-x-0 top-0" style={{ height: altezza }}>
          <canvas ref={tela} className="block h-full w-full" role="img"
            aria-label={`La rete di Argos al lavoro: fase ${fase.n.toLowerCase()}, ${fase.s}`} />
          <div className="pointer-events-none absolute left-3 top-2.5 max-w-[19rem] border-l-[3px] border-violet-400 pl-2.5 font-mono">
            <div className="text-[17px] font-bold leading-tight tracking-wide text-zinc-100 md:text-[19px]">
              {String((stato?.fase ?? 0) + 1).padStart(2, "0")} {fase.n}
            </div>
            <div className="mt-0.5 text-[10.5px] text-violet-300/80">{fase.s}</div>
            {stato?.meta.map(r => <div key={r} className="mt-1 hidden text-[9.5px] leading-snug text-zinc-500 md:block">{r}</div>)}
          </div>
          <div className="absolute right-2.5 top-2.5 flex items-center gap-2">
            <ol className="hidden items-center gap-1 md:flex" aria-label="Le fasi">
              {FASI_SCIAME.map((f, i) => (
                <li key={f.k} title={`${String(i + 1).padStart(2, "0")} ${f.n}`}
                  className={`h-1.5 w-5 rounded-full ${i < (stato?.fase ?? 0) || (stato?.finito && i === stato.fase) ? "bg-violet-400/80" : i === stato?.fase ? "bg-pink-400" : "bg-zinc-700"}`} />
              ))}
            </ol>
            {inCorso && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" aria-label="Argos sta lavorando" />}
            <button type="button" onClick={chiudi}
              className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-violet-100 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />Riduci
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
});

/** La piccola dashboard: che cosa ha fatto la rete nell'ultimo turno. */
function BarraRiepilogo({ riepilogo, stato, apri, rivedi }: {
  riepilogo: RiepilogoSciame | null;
  stato: StatoSciame | null;
  apri: () => void;
  rivedi: () => void;
}) {
  const inCorso = !!stato?.inCorso;
  const r = riepilogo;
  const fase = FASI_SCIAME[stato?.fase ?? 0]!;
  const verificate = r && r.verificaDisponibile ? r.tracciate + r.senzaFonte : 0;
  return (
    <div className="flex items-center gap-3 bg-black/40 px-3 py-2 text-[11.5px] text-zinc-300" aria-label="Che cosa ha fatto la rete neurale">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5 font-medium text-violet-200">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />Connessione neurale
      </span>
      {inCorso ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-violet-300">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />{String((stato?.fase ?? 0) + 1).padStart(2, "0")} {fase.n.toLowerCase()} · {fase.s}
        </span>
      ) : r ? (
        <>
          {r.candidati > 0 ? (
            <>
              <Voce icona={BookOpen} titolo="Passaggi della biblioteca letti dalla rete">{r.candidati} letti</Voce>
              <Voce icona={FileText} titolo="Passaggi dati al modello per rispondere (le fonti numerate)">{r.fonti} fonti</Voce>
              {r.ponti > 0 && <Voce icona={Link2} titolo="Documenti collegati per ponte">{r.ponti} ponti</Voce>}
              {r.concetti > 0 && <Voce icona={Brain} titolo={`${r.relazioni} relazioni fra concetti`}>{r.concetti} concetti</Voce>}
            </>
          ) : (
            <Voce icona={BookOpen} titolo="Il turno non ha cercato nei documenti">niente documenti</Voce>
          )}
          {r.strumenti.length > 0 && (
            <Voce icona={Wrench} titolo={[...new Set(r.strumenti)].join(", ")}>
              {r.strumenti.length} {r.strumenti.length === 1 ? "strumento" : "strumenti"}
            </Voce>
          )}
          {r.verificaDisponibile ? (
            verificate > 0 && (
              <Voce icona={ShieldCheck} titolo={`${r.senzaFonte} frasi senza una fonte${r.nonVerificabili ? `, ${r.nonVerificabili} non verificabili` : ""}`}>
                {r.tracciate}/{verificate} frasi con fonte
              </Voce>
            )
          ) : r.candidati > 0 && <Voce icona={ShieldCheck} titolo="La verifica delle frasi non è arrivata">verifica n.d.</Voce>}
          {r.secondi != null && <Voce icona={Timer} titolo="Durata del turno">{durata(r.secondi * 1000)}{r.tokens ? ` · ${token(r.tokens)} token` : ""}</Voce>}
          {r.categorie.slice(0, 3).map(c => (
            <span key={c.nome} className="hidden items-center gap-1 text-zinc-400 2xl:inline-flex" title={`${c.nome}: ${c.tenuti} tenuti su ${c.candidati} letti`}>
              <span className="h-2 w-2 rounded-[2px]" style={{ background: c.colore }} aria-hidden />
              <span className="max-w-[9rem] truncate">{c.nome.toLowerCase()}</span>
              <span className="font-mono text-zinc-500">{c.tenuti}/{c.candidati}</span>
            </span>
          ))}
          {r.ricostruita && r.candidati > 0 && <span className="text-zinc-500">percorso dalle fonti finali</span>}
        </>
      ) : (
        <span className="text-zinc-500">nessun turno da raccontare</span>
      )}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {stato?.puoRivedere && (
          <button type="button" onClick={rivedi} className={BOTTONE}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />Rivedi
          </button>
        )}
        <button type="button" onClick={apri} className={BOTTONE}>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />{inCorso ? "Guarda" : "Apri"}
        </button>
      </span>
    </div>
  );
}

const BOTTONE = "inline-flex items-center gap-1 rounded-full border border-violet-400/40 px-2.5 py-1 text-[11px] font-medium text-violet-100 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400";

function Voce({ icona: Icona, titolo, children }: { icona: typeof BookOpen; titolo: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1" title={titolo}>
      <Icona className="h-3.5 w-3.5 text-violet-300/80" aria-hidden />
      <span>{children}</span>
    </span>
  );
}
