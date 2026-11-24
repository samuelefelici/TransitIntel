/**
 * Lo studio della rete neurale: il crawler di Argos e la chat, insieme.
 *
 * È la pagina della vecchia Argos (frontend/crawler.html) dentro la scheda
 * Conversazione, con tutto quello che aveva:
 *   - in alto la barra dello sciame (zampe, tentacoli, passaggi letti,
 *     collegamenti, segnalazioni, tempo) e le otto fasi, che a turno finito
 *     si cliccano per rivedere una fase sola;
 *   - il palco (lib/argos-sciame.ts) con il titolo della fase;
 *   - sotto, i sei pannelli: crawl log, categorie, copertura, parole,
 *     confidenza, pipeline.py;
 *   - a destra la chat, sempre in vista: le parole della risposta volano lì.
 * «Schermo intero» copre anche il menu di Cerbero; «Solo chat» nasconde la
 * rete e lascia una barra col riepilogo di che cosa ha fatto.
 * «Vista 3D» porta la stessa scena dentro un cervello-nebulosa
 * (lib/argos-cervello3d.ts, three.js caricato solo allora): il motore 2D
 * continua a fare la regia senza disegnare, la vista 3D la legge.
 *
 * Il palco riceve gli eventi del turno da ArgosConversation (OsservatoreTurno):
 * niente richieste in più, se non la mappa dei documenti per le nebulose.
 */
import { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Box, Brain, Eye, EyeOff, FileText, Link2, Loader2, Maximize2, Minimize2, Moon, RotateCcw, ShieldCheck, Sparkles, Sun, Timer, Wrench } from "lucide-react";
import type { OsservatoreTurno } from "@/components/argos/ArgosConversation";
import { FASI_SCIAME, Sciame, type DatiPannelli, type RiepilogoSciame } from "@/lib/argos-sciame";
import type { Cervello3D } from "@/lib/argos-cervello3d";
import { durata, mappe, token } from "@/lib/argos-console";
import { TemaArgosContesto } from "@/lib/argos-tema";

const CHIAVE_SOLO_CHAT = "argos-studio-solo-chat";
const CHIAVE_INTERO = "argos-studio-schermo-intero";
const CHIAVE_VISTA = "argos-studio-vista";
/** ogni quanto si rileggono i pannelli: abbastanza per vederli vivi, poco per React */
const PASSO_PANNELLI_MS = 125;

/** la scena non deve mai rompere la chat: un suo errore resta suo */
function prova(f: () => void): void {
  try { f(); } catch (e) { console.warn("studio neurale:", e); }
}

function leggiSoloChat(): boolean {
  try { return localStorage.getItem(CHIAVE_SOLO_CHAT) === "1"; } catch { return false; }
}

/** schermo intero di partenza: sì sugli schermi larghi, finché chi usa lo studio non lo riduce (ricordato nel browser) */
function leggiIntero(): boolean {
  const largo = typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 1024px)").matches;
  try { const v = localStorage.getItem(CHIAVE_INTERO); return v == null ? largo : v === "1" && largo; } catch { return largo; }
}

type Vista = "2d" | "3d";
/** la vista 3D di partenza sugli schermi larghi, se non si chiede meno movimento; poi quella scelta (ricordata nel browser) */
function leggiVista(): Vista {
  const largo = typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 1024px)").matches;
  const calmo = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  try { const v = localStorage.getItem(CHIAVE_VISTA); if (v === "2d" || v === "3d") return v; } catch { /* storage spento */ }
  return largo && !calmo ? "3d" : "2d";
}

export const StudioNeurale = forwardRef<OsservatoreTurno, { titolo: string; children: ReactNode }>(function StudioNeurale({ titolo, children }, ref) {
  const tela = useRef<HTMLCanvasElement>(null);
  const titoloFase = useRef<HTMLDivElement>(null);
  const radice = useRef<HTMLDivElement>(null);
  const motore = useRef<Sciame | null>(null);
  const [dati, setDati] = useState<DatiPannelli | null>(null);
  const [riepilogo, setRiepilogo] = useState<RiepilogoSciame | null>(null);
  const [soloChat, setSoloChat] = useState(leggiSoloChat);
  const [intero, setIntero] = useState(leggiIntero);
  const [guasto, setGuasto] = useState(false);
  const [vista, setVista] = useState<Vista>(leggiVista);
  /** niente WebGL, o la vista 3D si è rotta: resta il 2D e il pulsante sparisce */
  const [senza3d, setSenza3d] = useState(false);
  /** la vista 3D è tornata al piano da sola perché lenta: lo si dice, per qualche secondo */
  const [lento3d, setLento3d] = useState(false);
  const palco3d = useRef<HTMLDivElement>(null);
  const cervello = useRef<Cervello3D | null>(null);
  const inAttesa = useRef<Array<(m: Sciame) => void>>([]);
  const tema = useContext(TemaArgosContesto);

  const mappa = useQuery({ queryKey: ["argos-console", "mappa", "documenti"], queryFn: mappe.documenti, staleTime: 10 * 60_000, retry: false });

  const conMotore = useCallback((f: (m: Sciame) => void) => {
    const m = motore.current;
    if (m) prova(() => f(m)); else inAttesa.current.push(f);
  }, []);

  useImperativeHandle(ref, () => ({
    inizio(domanda: string) { conMotore(m => m.avvia(domanda)); },
    evento(payload: unknown) { conMotore(m => m.evento(payload)); },
    fine(esito, messaggio) { conMotore(m => { m.fine(esito, messaggio); setRiepilogo(m.riepilogo()); }); },
  }), [conMotore]);

  // la rete nasce con la scheda e resta: «Rivedi» rigioca l'ultimo turno
  useEffect(() => {
    if (!tela.current || motore.current || guasto) return;
    let m: Sciame;
    try { m = new Sciame(tela.current); } catch (e) {
      console.warn("studio neurale non disponibile:", e);
      inAttesa.current = [];
      setGuasto(true);
      return;
    }
    motore.current = m;
    for (const f of inAttesa.current.splice(0)) prova(() => f(m));
    return () => { m.distruggi(); motore.current = null; };
  }, [guasto]);
  useEffect(() => { const m = motore.current; if (mappa.data && m) prova(() => m.impostaMappa(mappa.data)); }, [mappa.data, guasto]);

  // il tema della pagina di Argos (classe .argos-chiaro sul suo contenitore): la rete lo segue, anche se cambia
  useEffect(() => {
    const pagina = radice.current?.closest(".argos-console");
    const applica = () => {
      const m = motore.current, chiaro = !!radice.current?.closest(".argos-chiaro");
      if (m) prova(() => m.impostaTema(chiaro));
      const c = cervello.current;
      if (c) prova(() => c.impostaTema(chiaro));
    };
    applica();
    if (!pagina) return;
    const mo = new MutationObserver(applica);
    mo.observe(pagina, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [guasto]);

  // la chat a destra sugli schermi larghi, sotto sui telefoni: le parole volano lì
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const lato = () => motore.current?.impostaRisposta(mq.matches ? "destra" : "sotto");
    lato();
    mq.addEventListener("change", lato);
    return () => mq.removeEventListener("change", lato);
  }, [guasto]);

  // il palco cambia misura (schermo intero, finestra, chat): la rete si ridisegna; nascosto, si ferma
  useEffect(() => {
    const c = tela.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      const m = motore.current;
      if (!m) return;
      if (r.width < 4 || r.height < 4) { m.pausa(true); return; }
      m.pausa(false);
      m.ridimensiona();
      const c3 = cervello.current;
      if (c3) prova(() => c3.ridimensiona());
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [guasto]);

  // il titolo della fase cambia misura con le sue righe: la rete ci gira attorno
  useEffect(() => {
    const t = titoloFase.current, c = tela.current;
    if (!t || !c) return;
    const misura = () => {
      const a = t.getBoundingClientRect(), b = c.getBoundingClientRect();
      if (a.width > 0 && b.width > 0) motore.current?.impostaTitolo({ x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height });
    };
    const ro = new ResizeObserver(misura);
    ro.observe(t);
    ro.observe(c);
    return () => ro.disconnect();
  }, [guasto]);

  // i pannelli si rileggono a passi brevi, solo se si vedono
  useEffect(() => {
    const t = setInterval(() => {
      const m = motore.current;
      if (!m || document.hidden) return;
      if (soloChat) { setRiepilogo(m.riepilogo()); return; }
      prova(() => setDati(m.pannelli()));
    }, soloChat ? 1000 : PASSO_PANNELLI_MS);
    return () => clearInterval(t);
  }, [soloChat]);

  // la vista 3D: si carica solo quando serve, il motore 2D smette di disegnare e le passa la scena
  const con3d = vista === "3d" && !senza3d && !soloChat && !guasto;
  useEffect(() => {
    if (!con3d) return;
    const m = motore.current, box = palco3d.current;
    if (!m || !box) return;
    let finito = false, c: Cervello3D | null = null;
    const torna2d = (perche: "errore" | "lento" = "errore") => {
      if (finito) return;
      if (perche === "lento") {
        // ricordato: la prossima volta si parte dal piano (il pulsante resta, per riprovare)
        setVista("2d"); setLento3d(true);
        try { localStorage.setItem(CHIAVE_VISTA, "2d"); } catch { /* storage spento */ }
      } else setSenza3d(true);
    };
    import("@/lib/argos-cervello3d").then(mod => {
      if (finito) return;
      if (!mod.webglDisponibile()) { torna2d(); return; }
      const nuovo = new mod.Cervello3D(box, m, { chiaro: !!radice.current?.closest(".argos-chiaro"), onGuasto: torna2d });
      c = nuovo;
      cervello.current = nuovo;
      m.impostaDisegno(false);
    }).catch(e => { console.warn("vista 3D non disponibile:", e); torna2d(); });
    return () => {
      finito = true;
      cervello.current = null;
      if (c) prova(() => c!.distruggi());
      prova(() => m.impostaDisegno(true));
    };
  }, [con3d]);
  useEffect(() => {
    if (!lento3d) return;
    const t = setTimeout(() => setLento3d(false), 6000);
    return () => clearTimeout(t);
  }, [lento3d]);
  const cambiaVista = () => {
    const v: Vista = vista === "3d" ? "2d" : "3d";
    setVista(v);
    setLento3d(false);
    try { localStorage.setItem(CHIAVE_VISTA, v); } catch { /* storage spento */ }
  };

  useEffect(() => { try { localStorage.setItem(CHIAVE_SOLO_CHAT, soloChat ? "1" : "0"); } catch { /* storage spento */ } }, [soloChat]);
  const cambiaIntero = (v: boolean) => { setIntero(v); try { localStorage.setItem(CHIAVE_INTERO, v ? "1" : "0"); } catch { /* storage spento */ } };

  // schermo intero: Esc per uscire, la pagina sotto non scorre
  useEffect(() => {
    if (!intero) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") cambiaIntero(false); };
    window.addEventListener("keydown", esc);
    const prima = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", esc); document.body.style.overflow = prima; };
  }, [intero]);

  const rivedi = (k?: number) => { const m = motore.current; if (m) prova(() => { if (k == null) m.rivedi(); else m.rivediFase(k); }); };
  const conRete = !soloChat && !guasto;
  const fase = FASI_SCIAME[dati?.fase ?? 0]!;

  return (
    <div className={intero
      ? "argos-studio fixed inset-0 z-50 flex flex-col bg-[var(--studio-fondo)] p-1.5"
      : "argos-studio flex flex-col lg:h-[calc(100vh-16.5rem)] lg:min-h-[600px]"}>
      <div ref={radice} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-violet-400/40 bg-[var(--studio-fondo)] text-zinc-200 shadow-[0_8px_40px_rgba(139,92,246,0.25)]">
        {/* ── la barra dello sciame ── */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--studio-bordo)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.09em] text-zinc-500">
          {intero && <span className="max-w-[16rem] truncate normal-case tracking-normal text-zinc-200">{titolo}</span>}
          {conRete && dati && (
            <>
              <Cifra nome="sciame" valore="argos" />
              <Cifra nome="zampe" valore={dati.barra.zampe} />
              <Cifra nome="tentacoli" valore={dati.barra.tentacoli} tinta="text-teal-300" />
              <Cifra nome="passaggi letti" valore={`${dati.barra.letti}/${dati.barra.totale}`} />
              <Cifra nome="collegamenti" valore={dati.barra.collegamenti} tinta="text-amber-300" />
              <Cifra nome="segnalazioni" valore={dati.barra.segnalazioni} tinta="text-pink-400" />
              <Cifra nome="t" valore={dati.barra.secondi.toFixed(2)} />
              <span className="hidden xl:inline-flex"><Cifra nome="frame" valore={dati.barra.fotogrammi} /></span>
            </>
          )}
          {conRete && lento3d && <span role="status" className="normal-case tracking-normal text-amber-300">3D lento su questo computer: rete in piano</span>}
          {!conRete && <span className="inline-flex items-center gap-1.5 normal-case tracking-normal text-violet-200"><Sparkles className="h-3.5 w-3.5" aria-hidden />Connessione neurale</span>}
          <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
            {conRete && dati?.puoRivedere && (
              <button type="button" onClick={() => rivedi()} className={BOTTONE} title="Rigioca tutta la corsa, senza una nuova richiesta">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />Rivedi
              </button>
            )}
            {conRete && !senza3d && (
              <button type="button" onClick={cambiaVista} className={BOTTONE} aria-pressed={vista === "3d"}
                title={vista === "3d" ? "Torna alla rete in piano" : "La rete dentro un cervello-nebulosa, in 3D"}>
                <Box className="h-3.5 w-3.5" aria-hidden />{vista === "3d" ? "Vista 2D" : "Vista 3D"}
              </button>
            )}
            {!guasto && (
              <button type="button" onClick={() => setSoloChat(x => !x)} className={BOTTONE} aria-pressed={soloChat}>
                {soloChat ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
                {soloChat ? "Mostra la rete" : "Solo chat"}
              </button>
            )}
            {tema && (
              <button type="button" onClick={tema.cambia} className={BOTTONE} aria-label={tema.tema === "chiaro" ? "Passa al tema scuro" : "Passa al tema chiaro"}
                title={tema.tema === "chiaro" ? "Tema scuro" : "Tema chiaro"}>
                {tema.tema === "chiaro" ? <Moon className="h-3.5 w-3.5" aria-hidden /> : <Sun className="h-3.5 w-3.5" aria-hidden />}
              </button>
            )}
            <button type="button" onClick={() => cambiaIntero(!intero)} className={BOTTONE} aria-pressed={intero}
              title={intero ? "Esci dallo schermo intero (Esc)" : "Lo studio su tutto lo schermo"}>
              {intero ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
              {intero ? "Riduci" : "Schermo intero"}
            </button>
          </span>
        </div>

        {/* ── le otto fasi ── */}
        {conRete && (
          <div className="grid grid-cols-4 gap-[3px] px-3 py-1 sm:grid-cols-8" role="tablist" aria-label="Le fasi della risposta">
            {FASI_SCIAME.map((f, i) => {
              const cur = dati?.fase === i, fatta = !!dati?.haCorsa && (i < (dati?.fase ?? 0) || (!!dati?.finito && cur)), puo = !!dati?.puoRivedere;
              return (
                <button key={f.k} type="button" role="tab" aria-selected={cur} disabled={!puo} onClick={() => rivedi(i)}
                  title={`${String(i + 1).padStart(2, "0")} ${f.n} — ${f.s}${puo ? " · rivedi questa fase" : ""}`}
                  className={`h-[19px] truncate rounded-[2px] font-mono text-[10px] tracking-[0.04em] transition-colors ${cur ? "bg-violet-400 font-bold text-[var(--studio-fase-attiva-testo)]" : fatta ? "bg-[var(--studio-fase-fatta)] text-zinc-300" : "bg-[var(--studio-fase)] text-zinc-600"} ${puo ? "cursor-pointer hover:text-white" : "cursor-default"}`}>
                  {f.k}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* ── la rete: palco e pannelli (montata sempre: nascosta, si ferma) ── */}
          <div className={`${conRete ? "flex" : "hidden"} min-w-0 flex-col lg:min-h-0 lg:flex-1`}>
            <div className="relative h-[46vh] min-h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
              <canvas ref={tela} className="absolute inset-0 block h-full w-full" role="img"
                aria-label={`La rete di Argos: fase ${fase.n.toLowerCase()}, ${fase.s}`} />
              {/* la vista 3D si monta qui sopra (WebGL e la sua sovrimpressione); col mouse si gira il cervello */}
              <div ref={palco3d} className={`absolute inset-0 overflow-hidden ${con3d ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"}`} />
              <div ref={titoloFase} className="pointer-events-none absolute left-3 top-2.5 max-w-[20rem] border-l-[3px] border-violet-400 pl-2.5 font-mono">
                <div className="text-[16px] font-bold leading-tight tracking-wide text-zinc-100 md:text-[19px]">{String((dati?.fase ?? 0) + 1).padStart(2, "0")} {fase.n}</div>
                <div className="mt-0.5 text-[10.5px] text-[var(--studio-sottotitolo)]">{fase.s}</div>
                {dati?.meta.map(r => <div key={r} className="mt-1 hidden text-[9.5px] leading-snug text-zinc-500 md:block">{r}</div>)}
              </div>
              {dati?.inCorso && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-violet-300" aria-label="Argos sta lavorando" />}
              {dati && !dati.haCorsa && (
                <div className="pointer-events-none absolute bottom-6 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-md bg-[var(--studio-invito)] px-3 py-1 text-center font-mono text-[11.5px] leading-relaxed text-zinc-400">
                  Fai una domanda nella chat: guarda Argos <b className="font-medium text-violet-300">cercare</b>, <b className="font-medium text-violet-300">scegliere</b> e <b className="font-medium text-violet-300">verificare</b>
                  {con3d && <div className="text-[9.5px] tracking-wider text-zinc-500">trascina per girare il cervello · rotella per entrarci</div>}
                  <div className="text-[9.5px] tracking-wider text-zinc-600">
                    {mappa.data ? `${mappa.data.nodes.length} documenti in ${new Set(mappa.data.nodes.map(n => n.category || "")).size} categorie` : mappa.isError ? "mappa non disponibile: userò le categorie delle fonti" : "carico la mappa della conoscenza…"}
                  </div>
                </div>
              )}
            </div>
            {dati && <Pannelli d={dati} />}
          </div>

          {/* ── la chat ── */}
          <div className={conRete
            ? "flex h-[78vh] min-h-0 flex-col border-t border-white/10 lg:h-auto lg:w-[clamp(330px,30vw,560px)] lg:shrink-0 lg:border-l lg:border-t-0"
            : "flex h-[78vh] min-h-0 flex-1 flex-col lg:h-auto"}>
            {!conRete && !guasto && <BarraRiepilogo r={riepilogo} />}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
});

const BOTTONE = "inline-flex items-center gap-1 rounded-full border border-violet-400/40 px-2.5 py-0.5 text-[11px] font-medium text-violet-100 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400";

function Cifra({ nome, valore, tinta = "text-zinc-100" }: { nome: string; valore: ReactNode; tinta?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span>{nome}</span>
      <b className={`font-bold normal-case tracking-[0.02em] tabular-nums ${tinta}`}>{valore}</b>
    </span>
  );
}

// ─── i sei pannelli ─────────────────────────────────────────────────────────
const VERBI: Record<string, string> = {
  leggo: "text-zinc-300", tengo: "text-teal-300", scarto: "text-zinc-600", doppio: "text-amber-500", collego: "text-amber-300",
  concetto: "text-violet-300", strumento: "text-rose-400", segnalo: "text-pink-400", traccio: "text-emerald-400", pronto: "text-teal-300",
};
const CODICE: Record<string, string> = {
  cm: "text-zinc-600", kw: "text-pink-400", fn: "text-teal-200", sg: "text-amber-200", nu: "text-violet-300", op: "text-zinc-500", id: "text-zinc-300",
};

function Pannello({ titolo, metrica, tinta = "text-teal-300", children, piede }: { titolo: string; metrica?: ReactNode; tinta?: string; children: ReactNode; piede?: ReactNode }) {
  return (
    <section className="flex min-w-[148px] flex-1 snap-start flex-col overflow-hidden rounded-md border border-[var(--studio-bordo)] bg-[var(--studio-pannello)] px-2.5 py-2 font-mono text-[10px] leading-[1.36] text-zinc-400" aria-label={titolo}>
      <header className="mb-1.5 flex items-baseline justify-between gap-2 whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.07em] text-zinc-100">
        <span>{titolo}</span>
        {metrica != null && <span className={`font-semibold normal-case tracking-[0.02em] tabular-nums ${tinta}`}>{metrica}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {piede}
    </section>
  );
}

function Pannelli({ d }: { d: DatiPannelli }) {
  return (
    <div className="flex h-[clamp(150px,23vh,214px)] shrink-0 snap-x gap-1.5 overflow-x-auto px-2 pb-2 pt-1 [scrollbar-width:thin]" aria-label="I pannelli dello sciame">
      <Pannello titolo="crawl log" metrica={`${d.eventiAlSecondo} ev/s`}>
        <div className="flex h-full flex-col justify-end">
          {d.diario.map((l, i) => (
            <div key={`${i}-${l.tm}-${l.o}`} className="truncate whitespace-nowrap">
              <span className="text-zinc-600">{l.tm}</span>
              <span className={`mx-1 inline-block min-w-[50px] ${VERBI[l.v] ?? "text-zinc-300"}`}>{l.v}</span>
              <span className="text-[var(--studio-oggetto)]">{l.o}</span>
            </div>
          ))}
        </div>
      </Pannello>

      <Pannello titolo="categorie" metrica={d.categorie.quante} tinta="text-violet-300" piede={<div className="mt-0.5 truncate text-[9.5px] text-zinc-600">parole → passaggi → fonti</div>}>
        {d.categorie.righe.length ? (
          <>
            {d.categorie.righe.slice(0, 5).map(r => (
              <div key={r.nome} className="mb-1">
                <div className="mb-0.5 flex justify-between gap-2 text-zinc-300">
                  <span className="truncate">{r.nome}</span><span className="shrink-0 tabular-nums text-zinc-400">{r.dida}</span>
                </div>
                <div className="h-[3px] overflow-hidden rounded-sm bg-[var(--studio-traccia)]">
                  <i className="block h-full rounded-sm transition-[width] duration-300" style={{ width: `${r.di ? Math.round((100 * r.valore) / r.di) : 0}%`, background: r.colore }} />
                </div>
              </div>
            ))}
            {d.categorie.righe.length > 5 && <div className="text-[9.5px] text-zinc-500">+{d.categorie.righe.length - 5} altr{d.categorie.righe.length - 5 === 1 ? "a" : "e"}</div>}
          </>
        ) : <div className="text-zinc-600">{d.categorie.caricoMappa ? "carico la mappa…" : "nessuna categoria"}</div>}
      </Pannello>

      <Pannello titolo="copertura" metrica="live">
        <div className="flex h-full flex-col">
          <Radar assi={d.radar} />
          <div className="mt-0.5 grid shrink-0 grid-cols-[54px_1fr_20px] items-center gap-x-1.5 gap-y-0.5 text-zinc-400">
            {d.copertura.map(c => (
              <span key={c.nome} className="contents">
                <span>{c.nome}</span>
                <span className="h-1 overflow-hidden rounded-sm bg-[var(--studio-traccia)]"><i className="block h-full bg-teal-400 transition-[width] duration-300" style={{ width: `${Math.min(100, (100 * c.n) / c.max)}%` }} /></span>
                <span className="text-right font-semibold tabular-nums text-zinc-100">{c.n}</span>
              </span>
            ))}
          </div>
        </div>
      </Pannello>

      <Pannello titolo="parole" metrica={d.parole.length} tinta="text-amber-300">
        <div className="flex flex-col gap-[2px]">
          {(d.parole.length ? d.parole : [0, 1, 2].map(i => ({ termine: i ? "" : "—", celle: Array<string | null>(12).fill(null) }))).slice(0, 5).map((r, i) => (
            <div key={`${r.termine}-${i}`} className="flex items-center gap-[2px]">
              <span className="w-8 shrink-0 overflow-hidden text-[9px] text-zinc-500">{r.termine}</span>
              {r.celle.map((c, j) => <span key={j} className="h-[8px] w-[8px] shrink-0 rounded-[1px] transition-colors duration-300" style={{ background: c || "var(--studio-cella)" }} />)}
            </div>
          ))}
        </div>
        <div className="mt-1 text-[9.5px] text-zinc-500">parole al minuto<b className="block text-[15px] font-semibold leading-tight tabular-nums text-zinc-100">{d.parolePerMinuto == null ? "—" : `${d.parolePerMinuto}/m`}</b></div>
        <div className="mt-0.5 grid grid-cols-[1fr_auto_1fr_auto] gap-x-2 text-[9.5px]">
          <span className="text-zinc-500">lette</span><b className="text-right tabular-nums">{d.conteggi.lette}</b>
          <span className="text-zinc-500">collegate</span><b className="text-right tabular-nums text-amber-300">{d.conteggi.collegate}</b>
          <span className="text-zinc-500">segnalate</span><b className="text-right tabular-nums text-pink-400">{d.conteggi.segnalate}</b>
          <span className="text-zinc-500">ipotizzate</span><b className="text-right tabular-nums text-teal-300">{d.conteggi.ipotizzate}</b>
        </div>
      </Pannello>

      <Pannello titolo="confidenza" metrica="live"
        piede={<><div className="mt-0.5 truncate text-[9.5px] font-semibold text-pink-400">senza fonte · {d.confidenza.senzaFonte}</div><div className="truncate text-[9.5px] text-zinc-600">verifica, non indovinare</div></>}>
        <div className="flex h-full flex-col">
          <Linea punti={d.confidenza.punteggi} />
          <Lancetta valore={d.confidenza.valore} dida={d.confidenza.dida} />
        </div>
      </Pannello>

      <Pannello titolo="pipeline.py" metrica={`${d.lineeAlSecondo} l/s`} tinta="text-pink-400">
        <div className="whitespace-pre text-[10px] leading-[1.5] text-zinc-300">
          {d.codice.righe.map((l, i) => (
            <span key={i} className={`block overflow-hidden rounded-[2px] px-[3px] ${i === d.codice.corrente && d.codice.cursore ? "bg-pink-400/10" : ""}`}>
              {l.parti.map(([c, t], j) => <span key={j} className={CODICE[c] ?? ""}>{t}</span>)}
              {i === d.codice.corrente && d.codice.cursore && <span className="ml-[3px] inline-block h-[11px] w-[6px] animate-pulse bg-pink-400 align-[-2px]" aria-hidden />}
            </span>
          ))}
        </div>
      </Pannello>
    </div>
  );
}

/** il radar delle categorie in gioco (SVG: nitido a ogni misura) */
function Radar({ assi }: { assi: Array<{ asse: string; valore: number }> }) {
  const W = 160, H = 84, cx = W / 2, cy = H / 2, R = 30, n = assi.length;
  const punto = (i: number, k: number) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; return [cx + Math.cos(a) * R * k, cy + Math.sin(a) * R * k] as const; };
  const anello = (k: number) => assi.map((_, i) => punto(i, k).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="min-h-0 w-full flex-1" preserveAspectRatio="xMidYMid meet" aria-hidden>
      {[0.33, 0.66, 1].map(k => <polygon key={k} points={anello(k)} fill="none" style={{ stroke: "var(--studio-griglia)" }} />)}
      {assi.map((_, i) => { const [x, y] = punto(i, 1); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} style={{ stroke: "var(--studio-griglia)" }} />; })}
      <polygon points={assi.map((a, i) => punto(i, a.valore).join(",")).join(" ")} className="fill-teal-400/35 stroke-teal-400" strokeWidth={1.2} />
      {assi.map((a, i) => {
        const ang = -Math.PI / 2 + (i / n) * Math.PI * 2, x = cx + Math.cos(ang) * (R + 10), y = cy + Math.sin(ang) * (R + 7);
        const ancora = Math.abs(Math.cos(ang)) < 0.3 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
        return <text key={i} x={x} y={y} fontSize={7.5} style={{ fill: "var(--studio-etichetta)" }} textAnchor={ancora} dominantBaseline="middle" fontFamily="inherit">{a.asse}</text>;
      })}
    </svg>
  );
}

/** la linea dei punteggi dei passaggi letti */
function Linea({ punti }: { punti: number[] }) {
  const W = 160, H = 30;
  if (punti.length < 2) return <svg viewBox={`0 0 ${W} ${H}`} className="h-[30px] w-full shrink-0" aria-hidden><line x1={0} y1={H - 1.5} x2={W} y2={H - 1.5} style={{ stroke: "var(--studio-griglia)" }} /></svg>;
  const mn = Math.min(...punti) - 0.02, mx = Math.max(...punti) + 0.02, n = punti.length;
  const P = punti.map((v, i) => [2 + (i / (n - 1)) * (W - 4), H - 3 - ((v - mn) / (mx - mn || 1)) * (H - 7)] as const);
  let d = `M${P[0]![0]},${P[0]![1]}`;
  for (let i = 1; i < n; i++) { const [x0, y0] = P[i - 1]!, [x1, y1] = P[i]!; d += ` Q${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2}`; }
  d += ` L${P[n - 1]![0]},${P[n - 1]![1]}`;
  return <svg viewBox={`0 0 ${W} ${H}`} className="h-[30px] w-full shrink-0" preserveAspectRatio="none" aria-hidden><path d={d} fill="none" style={{ stroke: "var(--studio-linea)" }} strokeWidth={1.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
}

/** la lancetta della confidenza */
function Lancetta({ valore, dida }: { valore: number | null; dida: string }) {
  const W = 120, H = 70, cx = W / 2, cy = 38, r = 28, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
  const arco = (da: number, a: number) => {
    const [x0, y0] = [cx + Math.cos(da) * r, cy + Math.sin(da) * r], [x1, y1] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    return `M${x0},${y0} A${r},${r} 0 ${a - da > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
  };
  const v = valore == null ? null : Math.max(0.005, Math.min(1, valore / 100));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="min-h-0 w-full flex-1" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Confidenza ${valore == null ? "non ancora calcolata" : Math.round(valore)}, ${dida}`}>
      <defs><linearGradient id="argos-lancetta" x1="0" x2="1"><stop offset="0" stopColor="#F59E0B" /><stop offset="1" stopColor="#FDE047" /></linearGradient></defs>
      <path d={arco(a0, a1)} fill="none" style={{ stroke: "var(--studio-arco)" }} strokeWidth={5} strokeLinecap="round" />
      {v != null && <path d={arco(a0, a0 + (a1 - a0) * v)} fill="none" stroke="url(#argos-lancetta)" strokeWidth={5} strokeLinecap="round" />}
      <text x={cx} y={cy} fontSize={17} fontWeight={600} style={{ fill: "var(--studio-numero)" }} textAnchor="middle" dominantBaseline="middle" fontFamily="inherit">{valore == null ? "—" : Math.round(valore)}</text>
      <text x={cx} y={cy + r * 0.59 + 9} fontSize={7.5} style={{ fill: "var(--studio-etichetta)" }} textAnchor="middle" fontFamily="inherit">{dida}</text>
    </svg>
  );
}

// ─── solo chat: la barra di che cosa ha fatto la rete ───────────────────────
function BarraRiepilogo({ r }: { r: RiepilogoSciame | null }) {
  const verificate = r && r.verificaDisponibile ? r.tracciate + r.senzaFonte : 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 bg-black/40 px-3 py-1.5 text-[11.5px] text-zinc-300" aria-label="Che cosa ha fatto la rete neurale nell'ultimo turno">
      {r ? (
        <>
          {r.candidati > 0 ? (
            <>
              <Voce icona={BookOpen} titolo="Passaggi della biblioteca letti dalla rete">{r.candidati} letti</Voce>
              <Voce icona={FileText} titolo="Passaggi dati al modello per rispondere (le fonti numerate)">{r.fonti} fonti</Voce>
              {r.ponti > 0 && <Voce icona={Link2} titolo="Documenti collegati per ponte">{r.ponti} ponti</Voce>}
              {r.concetti > 0 && <Voce icona={Brain} titolo={`${r.relazioni} relazioni fra concetti`}>{r.concetti} concetti</Voce>}
            </>
          ) : <Voce icona={BookOpen} titolo="Il turno non ha cercato nei documenti">niente documenti</Voce>}
          {r.strumenti.length > 0 && <Voce icona={Wrench} titolo={[...new Set(r.strumenti)].join(", ")}>{r.strumenti.length} {r.strumenti.length === 1 ? "strumento" : "strumenti"}</Voce>}
          {r.verificaDisponibile && verificate > 0 && (
            <Voce icona={ShieldCheck} titolo={`${r.senzaFonte} frasi senza una fonte${r.nonVerificabili ? `, ${r.nonVerificabili} non verificabili` : ""}`}>{r.tracciate}/{verificate} frasi con fonte</Voce>
          )}
          {r.secondi != null && <Voce icona={Timer} titolo="Durata del turno">{durata(r.secondi * 1000)}{r.tokens ? ` · ${token(r.tokens)} token` : ""}</Voce>}
        </>
      ) : <span className="text-zinc-500">nessun turno ancora: la rete è nascosta, la trovi con «Mostra la rete»</span>}
    </div>
  );
}

function Voce({ icona: Icona, titolo, children }: { icona: typeof BookOpen; titolo: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1" title={titolo}>
      <Icona className="h-3.5 w-3.5 text-violet-300/80" aria-hidden />
      <span>{children}</span>
    </span>
  );
}
