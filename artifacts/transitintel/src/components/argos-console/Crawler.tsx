/**
 * Il crawler di Argos: una domanda, e il ragionamento messo in scena.
 *
 * Quattro colonne, da sinistra a destra, come il lavoro vero:
 *   la domanda → la biblioteca → le fonti date al modello → la risposta.
 * Le parole che contano si staccano dalla domanda, volano verso i passaggi
 * che le contengono (un filo per ogni abbinamento), i passaggi deboli escono,
 * i concetti gettano ponti fra documenti, i passaggi scelti si spostano fra
 * le fonti numerate e alla fine ogni frase della risposta si aggancia alla
 * fonte da cui viene, con le parole in comune che fanno il viaggio inverso.
 *
 * Tutto quello che si vede viene dalla traccia di Argos (retrieval e
 * verifica): niente è inventato per l'effetto, solo rallentato per essere
 * guardato. «Salta» va dritto alla risposta; «Rivedi» rifà la scena.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowRight, BookOpen, Brain, Expand, FastForward, Globe, History, Loader2, MessageSquareText, RotateCcw, Send, Sparkles, Square, Timer, Wrench,
} from "lucide-react";
import { chiedi, console_, nomeModulo, token, type EventoDomanda } from "@/lib/argos-console";
import {
  candidatiInScena, concettiInScena, costruisciScena, durataFase, evidenzia, FASI, filiDellaFase, motivoScarto, riepilogoScena,
  tintaParola, viaPonte, type Candidato, type Filo, type Fonte, type Frase, type Ponte, type Scena, type TracciaRetrieval, type TracciaVerifica,
} from "@/lib/argos-crawler";
import { Pill, Problema } from "./comuni";

const ArgosMarkdown = lazy(() => import("@/components/argos/ArgosMarkdown"));

const ESEMPI = [
  "Quali regole valgono per il riposo fra due turni?",
  "Che cosa dice il contratto di servizio sulle penali?",
  "Come si calcola il tempo di vestizione?",
];
const TINTA_CONCETTO = { "--cat": "hsl(var(--argos-memoria))" } as CSSProperties;

interface Sessione {
  domanda: string;
  deep: boolean;
  scena: Scena | null;
  testo: string;
  strumenti: Array<{ nome: string; lato?: string }>;
  note: string[];
  verifica: TracciaVerifica | null;
  token: number | null;
  errore: string | null;
  inCorso: boolean;
}
const VUOTA: Omit<Sessione, "domanda" | "deep"> = { scena: null, testo: "", strumenti: [], note: [], verifica: null, token: null, errore: null, inCorso: true };

// ─── i fili ─────────────────────────────────────────────────────────────────
/**
 * I fili fra le àncore della scena (data-ancora), disegnati sopra le colonne.
 * Le posizioni si misurano a ogni fotogramma per un po' dopo ogni cambio
 * (le schede si spostano con le animazioni), poi solo se il palco cambia misura.
 */
function useGeometria(palco: RefObject<HTMLDivElement | null>, fili: Filo[], battito: unknown): Record<string, string> {
  const [geo, setGeo] = useState<Record<string, string>>({});
  const misura = useCallback(() => {
    const el = palco.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const out: Record<string, string> = {};
    for (const f of fili) {
      const a = el.querySelector(`[data-ancora="${CSS.escape(f.da)}"]`), b = el.querySelector(`[data-ancora="${CSS.escape(f.a)}"]`);
      if (!a || !b) continue;
      const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect();
      if (!r1.width || !r2.width) continue;
      const x = (v: number) => v - box.left, y = (v: number) => v - box.top;
      let d: string;
      const sovrapposti = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left) > 0.5 * Math.min(r1.width, r2.width);
      if (sovrapposti) { // nella stessa colonna: un arco sul fianco destro, fuori dalle schede
        const x1 = x(r1.right), y1 = y(r1.top + r1.height / 2), x2 = x(r2.right), y2 = y(r2.top + r2.height / 2);
        const c = 28 + Math.min(60, Math.abs(y2 - y1) * 0.12);
        d = `M${x1},${y1} C${x1 + c},${y1} ${x2 + c},${y2} ${x2},${y2}`;
      } else if (r2.left >= r1.right - 4) { // verso destra
        const x1 = x(r1.right), y1 = y(r1.top + r1.height / 2), x2 = x(r2.left), y2 = y(r2.top + r2.height / 2);
        const c = Math.max(30, (x2 - x1) / 2);
        d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
      } else if (r2.right <= r1.left + 4) { // verso sinistra
        const x1 = x(r1.left), y1 = y(r1.top + r1.height / 2), x2 = x(r2.right), y2 = y(r2.top + r2.height / 2);
        const c = Math.max(30, (x1 - x2) / 2);
        d = `M${x1},${y1} C${x1 - c},${y1} ${x2 + c},${y2} ${x2},${y2}`;
      } else { // in diagonale, una sopra l'altra
        const x1 = x(r1.left + r1.width / 2), y1 = y(r1.bottom), x2 = x(r2.left + r2.width / 2), y2 = y(r2.top);
        const c = Math.max(24, Math.abs(y2 - y1) / 2);
        d = `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`;
      }
      out[f.id] = d;
    }
    setGeo(g => (JSON.stringify(g) === JSON.stringify(out) ? g : out));
  }, [palco, fili]);

  useLayoutEffect(() => {
    let fine = performance.now() + 1800, id = 0;
    const giro = () => { misura(); if (performance.now() < fine) id = requestAnimationFrame(giro); };
    giro();
    const el = palco.current;
    const ro = el ? new ResizeObserver(() => { fine = performance.now() + 400; cancelAnimationFrame(id); giro(); }) : null;
    if (el && ro) ro.observe(el);
    return () => { cancelAnimationFrame(id); ro?.disconnect(); };
  }, [misura, battito, palco]);
  return geo;
}

function Fili({ fili, geo, tintaDi }: { fili: Filo[]; geo: Record<string, string>; tintaDi: (f: Filo) => number | "concetto" }) {
  return (
    <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" aria-hidden>
      <AnimatePresence>
        {fili.map(f => {
          const d = geo[f.id];
          if (!d) return null;
          const t = tintaDi(f);
          const stile: CSSProperties = t === "concetto" ? { stroke: "hsl(var(--argos-memoria))" } : {};
          return (
            <motion.path key={f.id} d={d} fill="none" data-cat={t === "concetto" ? undefined : t} className={t === "concetto" ? undefined : "argos-cat-tratto"}
              style={{ ...stile, strokeWidth: f.tipo === "frase" ? 2.4 : 1.7, strokeLinecap: "round", strokeDasharray: f.tipo === "ponte" ? "5 4" : undefined }}
              initial={f.tipo === "ponte" ? { opacity: 0 } : { pathLength: 0, opacity: 0 }}
              animate={f.tipo === "ponte" ? { opacity: 0.8 } : { pathLength: 1, opacity: f.debole ? 0.13 : 0.75 }}
              exit={{ opacity: 0, transition: { duration: 0.25 } }}
              transition={{ duration: 0.75, ease: "easeInOut" }} />
          );
        })}
      </AnimatePresence>
    </svg>
  );
}

/** Le parole in viaggio: una pastiglia che corre lungo il filo, da un'àncora all'altra. */
function Viaggi({ fili, geo, tintaDi, giro }: { fili: Filo[]; geo: Record<string, string>; tintaDi: (f: Filo) => number | "concetto"; giro: number }) {
  const [partiti, setPartiti] = useState<Filo[]>([]);
  // i viaggi partono quando i fili cambiano (una volta sola per filo), non a ogni misura
  const chiave = fili.map(f => f.id).join("|");
  // (dipende da `chiave`, non da `fili`: un nuovo array con gli stessi fili non fa ripartire i viaggi)
  useEffect(() => { setPartiti(fili.filter(f => f.etichetta && f.tipo !== "ponte").slice(0, 18)); }, [chiave, giro]);
  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden>
      {partiti.map((f, i) => {
        const d = geo[f.id];
        if (!d) return null;
        const t = tintaDi(f);
        return (
          <motion.span key={`${f.id}-${giro}`}
            className="argos-parola argos-parola-mini absolute left-0 top-0 whitespace-nowrap shadow-md"
            data-cat={t === "concetto" ? undefined : t}
            style={{ ...(t === "concetto" ? TINTA_CONCETTO : {}), offsetPath: `path("${d}")`, offsetRotate: "0deg" } as CSSProperties}
            initial={{ offsetDistance: "0%", opacity: 0 }}
            animate={{ offsetDistance: "100%", opacity: [0, 1, 1, 0] }}
            transition={{ duration: f.tipo === "frase" ? 1.1 : 0.95, delay: 0.2 + i * 0.07, ease: "easeInOut" }}>
            {f.etichetta}
          </motion.span>
        );
      })}
    </div>
  );
}

// ─── i pezzi della scena ────────────────────────────────────────────────────
function Testo({ testo, termini, scena }: { testo: string; termini: string[]; scena: Scena }) {
  return (
    <>
      {evidenzia(testo, termini).map((p, i) => p.termine
        ? <mark key={i} className="argos-segno" data-cat={tintaParola(p.termine, scena)}>{p.testo}</mark>
        : <span key={i}>{p.testo}</span>)}
    </>
  );
}

function Passaggio({ c, scena, stato, numero, acceso, compatto }: {
  c: Candidato | Ponte | Fonte; scena: Scena; stato: "nuovo" | "tenuto" | "scartato" | "ponte" | "fonte"; numero?: number; acceso?: boolean; compatto?: boolean;
}) {
  const candidato = "status" in c ? c : null;
  const ponte = "via" in c ? c : null;
  const motivo = candidato && stato === "scartato" ? motivoScarto(candidato.status) : null;
  const score = "score" in c ? c.score : null;
  return (
    <motion.article layout layoutId={`c:${c.id}`} data-ancora={`c:${c.id}`}
      initial={{ opacity: 0, x: -14 }} animate={{ opacity: stato === "scartato" ? 0.42 : 1, x: 0 }} exit={{ opacity: 0 }}
      transition={{ layout: { type: "spring", stiffness: 170, damping: 24 }, duration: 0.35 }}
      className={`relative rounded-lg border bg-card px-2.5 py-2 text-[11px] shadow-sm ${acceso ? "ring-2 ring-primary" : ""} ${stato === "fonte" ? "border-primary/50" : "border-border"}`}>
      <div className="flex items-start gap-2">
        {numero != null && (
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground" aria-label={`Fonte ${numero}`}>{numero}</span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`min-w-0 flex-1 truncate font-semibold ${stato === "scartato" ? "line-through decoration-1" : ""}`} title={c.title ?? ""}>{c.title ?? "Passaggio"}</span>
            {score != null && <span className="shrink-0 tabular-nums text-muted-foreground" title="Somiglianza con la domanda">{score.toFixed(2)}</span>}
          </div>
          {c.section && <div className="truncate text-muted-foreground" title={c.section}>{c.section}</div>}
        </div>
      </div>
      {!compatto && c.snippet && (
        <p className="mt-1 line-clamp-2 leading-snug text-foreground/85"><Testo testo={c.snippet} termini={scena.termini} scena={scena} /></p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {candidato && scena.termini.filter(t => (candidato.hits?.[t] ?? 0) > 0).map(t => (
          <span key={t} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" data-cat={tintaParola(t, scena)}>
            <span className="argos-cat-punto argos-mini" aria-hidden />{t}{(candidato.hits[t] ?? 0) > 1 ? ` ×${candidato.hits[t]}` : ""}
          </span>
        ))}
        {stato === "tenuto" && candidato?.final_rank != null && <Pill tinta="ok">tenuto · {candidato.final_rank}°</Pill>}
        {motivo && <Pill tinta="neutro">{motivo}</Pill>}
        {ponte && <Pill tinta="memoria">ponte {viaPonte(ponte)}</Pill>}
        {"daPonte" in c && c.daPonte && <Pill tinta="memoria">da un ponte</Pill>}
      </div>
    </motion.article>
  );
}

function Colonna({ n, titolo, icona, nota, children }: { n: number; titolo: string; icona: ReactNode; nota?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <header className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full border border-border bg-card text-[11px] font-bold">{n}</span>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{icona}{titolo}</h3>
        {nota && <span className="ml-auto text-[11px] text-muted-foreground">{nota}</span>}
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Fasi({ fase, scena, giro, lento }: { fase: number; scena: Scena | null; giro: number; lento: boolean }) {
  return (
    <div>
      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Le fasi del ragionamento">
        {FASI.map((f, i) => {
          const fatta = i < fase, ora = i === fase;
          const ms = scena ? durataFase(f.chiave, scena) * (lento ? 1.6 : 1) : 0;
          return (
            <li key={f.chiave} aria-current={ora ? "step" : undefined}
              className={`relative overflow-hidden rounded-lg border px-2 py-1.5 text-[11px] ${ora ? "border-primary bg-primary/10" : "border-border"} ${!fatta && !ora ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-1.5 font-semibold"><span className="tabular-nums text-muted-foreground">{i + 1}</span>{f.titolo}</div>
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-muted" aria-hidden>
                {fatta && <span className="block h-full w-full bg-primary" />}
                {ora && (ms ? <motion.span key={`${i}-${giro}`} className="block h-full bg-primary" initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: ms / 1000, ease: "linear" }} />
                  : <span className="block h-full w-full bg-primary" />)}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 min-h-[1.75rem]" aria-live="polite">
        <AnimatePresence mode="wait">
          {fase >= 0 && (
            <motion.p key={fase} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}
              className="text-sm font-medium md:text-base">
              {FASI[fase]!.testo}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── il crawler ─────────────────────────────────────────────────────────────
export default function Crawler() {
  const [domanda, setDomanda] = useState("");
  const [deep, setDeep] = useState(false);
  const [lento, setLento] = useState(false);
  const [s, setS] = useState<Sessione | null>(null);
  const [fase, setFase] = useState(-1);
  const [giro, setGiro] = useState(0);
  const [staccate, setStaccate] = useState(false);
  const [frase, setFrase] = useState<number | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const palco = useRef<HTMLDivElement>(null);
  const stop = useRef<AbortController | null>(null);
  const registro = useQuery({ queryKey: ["argos-console", "registro"], queryFn: console_.registro, staleTime: 300_000 });

  useEffect(() => () => stop.current?.abort(), []);

  const scena = s?.scena ?? null;
  const chiaveFase = fase >= 0 ? FASI[fase]!.chiave : null;

  // la regia: ogni fase resta in scena il suo tempo, poi la successiva
  useEffect(() => {
    if (!scena || fase < 0 || fase >= FASI.length - 1) return;
    const t = setTimeout(() => setFase(f => f + 1), durataFase(FASI[fase]!.chiave, scena) * (lento ? 1.6 : 1));
    return () => clearTimeout(t);
  }, [scena, fase, giro, lento]);
  useEffect(() => {
    if (fase !== 0) { setStaccate(fase > 0); return; }
    setStaccate(false);
    const t = setTimeout(() => setStaccate(true), lento ? 1000 : 650);
    return () => clearTimeout(t);
  }, [fase, giro, lento]);

  // a risposta verificata: un giro automatico sulle frasi agganciate
  const agganciate = useMemo(() => (s?.verifica?.claims ?? []).map((c, i) => ({ c, i })).filter(x => x.c.traced && x.c.source != null), [s?.verifica]);
  useEffect(() => {
    if (fase !== FASI.length - 1 || !agganciate.length) { setTour(null); return; }
    let k = 0;
    setTour(agganciate[0]!.i);
    const t = setInterval(() => {
      k += 1;
      if (k >= Math.min(agganciate.length, 6)) { clearInterval(t); setTour(null); return; }
      setTour(agganciate[k]!.i);
    }, lento ? 2000 : 1500);
    return () => clearInterval(t);
  }, [fase, agganciate, giro, lento]);

  const fai = useCallback(async (testo: string) => {
    const q = testo.trim();
    if (!q || s?.inCorso) return;
    stop.current?.abort();
    const ctl = new AbortController();
    stop.current = ctl;
    setS({ domanda: q, deep, ...VUOTA });
    setFase(-1); setFrase(null); setTour(null); setGiro(g => g + 1);
    const su = (ev: EventoDomanda) => {
      setS(prev => {
        if (!prev) return prev;
        if ("trace" in ev) {
          const t = ev.trace as Record<string, any>;
          if (t?.kind === "retrieval") {
            try { return { ...prev, scena: costruisciScena(t as TracciaRetrieval) }; } catch { return prev; }
          }
          if (t?.kind === "verify") return { ...prev, verifica: t as TracciaVerifica };
          return prev;
        }
        if ("t" in ev) return { ...prev, testo: prev.testo + ev.t };
        if ("reset" in ev) return { ...prev, testo: "" };
        if ("tool" in ev) return { ...prev, strumenti: [...prev.strumenti, { nome: ev.tool.name, lato: ev.tool.lato }] };
        if ("note" in ev) return { ...prev, note: [...prev.note, ev.note] };
        if ("error" in ev) return { ...prev, errore: ev.error, inCorso: false };
        if ("done" in ev) return { ...prev, token: typeof ev.tokens === "number" ? ev.tokens : null, inCorso: false };
        return prev;
      });
    };
    try {
      await chiedi(q, deep, su, ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) setS(prev => (prev ? { ...prev, errore: e instanceof Error ? e.message : String(e) } : prev));
    } finally {
      setS(prev => (prev ? { ...prev, inCorso: false } : prev));
    }
  }, [deep, s?.inCorso]);

  // la traccia arriva: si alza il sipario
  const haScena = !!scena;
  useEffect(() => { if (haScena) setFase(0); }, [haScena]);

  const dopoSelezione = fase >= 2;
  const candidati = useMemo(() => (scena ? candidatiInScena(scena, dopoSelezione) : []), [scena, dopoSelezione]);
  const visibili = useMemo(() => new Set(candidati.map(c => c.id)), [candidati]);
  const tenuti = useMemo(() => new Set(scena?.tenuti.map(c => c.id) ?? []), [scena]);
  const inFonti = fase >= 4;
  const idFonti = useMemo(() => new Set(scena?.fonti.map(f => f.id) ?? []), [scena]);
  const fraseAttiva = frase ?? tour;
  const claim: Frase | null = fraseAttiva != null ? s?.verifica?.claims[fraseAttiva] ?? null : null;
  const fonteAccesa = claim?.source != null ? scena?.fonti.find(f => f.n === claim.source)?.id ?? null : null;

  const fili = useMemo<Filo[]>(() => {
    if (!scena || !chiaveFase) return [];
    return filiDellaFase(scena, chiaveFase, visibili, chiaveFase === "risposta" && claim && fraseAttiva != null
      ? { indice: fraseAttiva, fonte: claim.source, parole: claim.words } : null);
  }, [scena, chiaveFase, visibili, claim, fraseAttiva]);
  const tintaDi = useCallback((f: Filo): number | "concetto" => (f.tipo === "parola" && f.termine && scena ? tintaParola(f.termine, scena) : "concetto"), [scena]);
  const geo = useGeometria(palco, fili, `${fase}-${giro}-${staccate}-${fraseAttiva}-${s?.testo.length ? 1 : 0}-${s?.verifica ? 1 : 0}`);

  const nomeStrumento = useCallback((n: string) => {
    const c = registro.data?.capacita.find(x => x.name === n);
    return c ? `${nomeModulo(c.modulo)} · ${n}` : n;
  }, [registro.data]);

  const mostraRisposta = fase >= FASI.length - 1 || (!!s && !scena && (!!s.testo || !s.inCorso));
  const riepilogo = scena ? riepilogoScena(scena, s?.verifica ?? null) : null;
  const tempoRicerca = scena ? Object.values(scena.tempi).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
  const parole = s?.testo ? s.testo.trim().split(/\s+/).length : 0;

  const schermoIntero = () => {
    const el = palco.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  return (
    <div className="space-y-4">
      <form onSubmit={e => { e.preventDefault(); void fai(domanda); }}
        className="rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <label className="sr-only" htmlFor="argos-crawler-domanda">La domanda</label>
          <input id="argos-crawler-domanda" value={domanda} onChange={e => setDomanda(e.target.value)} maxLength={4000}
            placeholder="Fai una domanda ad Argos e guarda come ci arriva…"
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs" title="Analisi profonda: modello più capace, più passaggi e più strumenti. Costa di più.">
              <input type="checkbox" checked={deep} onChange={e => setDeep(e.target.checked)} />Analisi profonda
            </label>
            {s?.inCorso ? (
              <button type="button" onClick={() => stop.current?.abort()}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-border px-4 text-sm font-semibold hover:bg-muted">
                <Square className="h-4 w-4" aria-hidden />Ferma
              </button>
            ) : (
              <button type="submit" disabled={!domanda.trim()}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                <Send className="h-4 w-4" aria-hidden />Chiedi
              </button>
            )}
          </div>
        </div>
        {!s && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground">Per esempio:</span>
            {ESEMPI.map(e => (
              <button key={e} type="button" onClick={() => { setDomanda(e); void fai(e); }}
                className="rounded-full border border-border px-2.5 py-0.5 hover:bg-muted">{e}</button>
            ))}
          </div>
        )}
      </form>

      {!s ? (
        <div className="argos-palco grid place-items-center rounded-xl border border-border px-6 py-16 text-center">
          <div className="max-w-xl">
            <Sparkles className="mx-auto mb-3 h-8 w-8 text-primary" aria-hidden />
            <h2 className="text-lg font-semibold">Il ragionamento, in scena</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Fai una domanda: vedrai Argos staccare le parole che contano, cercarle in biblioteca, scartare i passaggi deboli,
              collegare documenti diversi attraverso i concetti, passare le fonti al modello e agganciare ogni frase della risposta
              alla fonte da cui viene. Documenti, dati di Cerbero e, se serve, il web.
            </p>
          </div>
        </div>
      ) : (
        <div className="argos-palco rounded-xl border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {s.inCorso ? <Pill tinta="info"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />Argos sta lavorando</Pill>
                : s.errore ? <Pill tinta="errore">Interrotta</Pill>
                : scena && fase < FASI.length - 1 ? <Pill tinta="ok">Risposta pronta · la scena continua</Pill> : <Pill tinta="ok">Fatto</Pill>}
              {s.deep && <Pill tinta="memoria">Analisi profonda</Pill>}
              {scena?.memoria && <Pill tinta="memoria"><History className="h-3 w-3" aria-hidden />Ha richiamato una risposta simile</Pill>}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => setLento(l => !l)} aria-pressed={lento}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${lento ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}>
                <Timer className="h-3.5 w-3.5" aria-hidden />Ritmo da presentazione
              </button>
              {scena && fase < FASI.length - 1 && (
                <button type="button" onClick={() => setFase(FASI.length - 1)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted">
                  <FastForward className="h-3.5 w-3.5" aria-hidden />Salta alla risposta
                </button>
              )}
              {scena && fase === FASI.length - 1 && (
                <button type="button" onClick={() => { setFase(0); setGiro(g => g + 1); setFrase(null); }} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />Rivedi la scena
                </button>
              )}
              <button type="button" onClick={schermoIntero} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted">
                <Expand className="h-3.5 w-3.5" aria-hidden />Schermo intero
              </button>
            </div>
          </div>

          {scena && <div className="mb-4"><Fasi fase={fase} scena={scena} giro={giro} lento={lento} /></div>}
          {s.errore && <div className="mb-3"><Problema errore={s.errore} /></div>}
          {s.note.length > 0 && <div className="mb-3 text-[11px] text-muted-foreground">{s.note[s.note.length - 1]}</div>}

          <LayoutGroup>
            <div ref={palco} className="relative grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
              <Fili fili={fili} geo={geo} tintaDi={tintaDi} />
              <Viaggi fili={fili} geo={geo} tintaDi={tintaDi} giro={giro} />

              {/* 1. la domanda */}
              <Colonna n={1} titolo="La domanda" icona={<MessageSquareText className="h-3.5 w-3.5" aria-hidden />}>
                <p className="rounded-lg border border-border bg-card p-3 text-base font-medium leading-relaxed md:text-lg">
                  {scena && fase >= 0 ? (() => {
                    const giaMosse = new Set<string>();
                    return evidenzia(s.domanda, scena.termini).map((p, i) => {
                      if (!p.termine) return <span key={i}>{p.testo}</span>;
                      const prima = !giaMosse.has(p.termine);
                      giaMosse.add(p.termine);
                      return prima && !staccate
                        ? <motion.mark key={i} layoutId={`parola-${p.termine}-${giro}`} className="argos-segno" data-cat={tintaParola(p.termine, scena)}>{p.testo}</motion.mark>
                        : <mark key={i} className="argos-segno" data-cat={tintaParola(p.termine, scena)}>{p.testo}</mark>;
                    });
                  })() : s.domanda}
                </p>
                {scena && (
                  <div className="rounded-lg border border-dashed border-border p-3">
                    <div className="mb-2 text-[11px] font-semibold text-muted-foreground">Le parole che contano</div>
                    <ul className="flex flex-col items-start gap-2">
                      {staccate && scena.termini.map(t => (
                        <li key={t} className="flex items-center gap-2">
                          <motion.span layoutId={`parola-${t}-${giro}`} data-ancora={`t:${t}`} data-cat={tintaParola(t, scena)} className="argos-parola"
                            transition={{ type: "spring", stiffness: 140, damping: 18 }}>
                            {t}
                            {fase >= 1 && <span className="text-[10px] font-medium text-muted-foreground" title={`in ${scena.dove[t]?.length ?? 0} passaggi`}>· {scena.dove[t]?.length ?? 0}</span>}
                          </motion.span>
                        </li>
                      ))}
                      {!scena.termini.length && <li className="text-[11px] text-muted-foreground">Nessuna parola chiave: la ricerca va sul significato.</li>}
                    </ul>
                  </div>
                )}
                {scena && fase >= 3 && concettiInScena(scena).length > 0 && (
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border border-dashed border-border p-3">
                    <div className="mb-2 text-[11px] font-semibold text-muted-foreground">I concetti che collegano</div>
                    <ul className="flex flex-col items-start gap-2">
                      {concettiInScena(scena).map((k, i) => (
                        <motion.li key={k.id} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.08 }}>
                          <span data-ancora={`k:${k.id}`} className="argos-parola argos-parola-tratteggio" style={TINTA_CONCETTO}>
                            <Brain className="h-3 w-3" aria-hidden />{k.name}
                          </span>
                        </motion.li>
                      ))}
                    </ul>
                  </motion.div>
                )}
                {!scena && s.inCorso && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Argos legge la domanda…</div>}
              </Colonna>

              {/* 2. la biblioteca */}
              <Colonna n={2} titolo="In biblioteca" icona={<BookOpen className="h-3.5 w-3.5" aria-hidden />}
                nota={scena && fase >= 1 ? (dopoSelezione ? `${scena.tenuti.length} tenuti su ${scena.candidati.length}` : `${scena.candidati.length} passaggi letti`) : undefined}>
                {scena && fase >= 1 && (
                  <>
                    {[...candidati.filter(c => !dopoSelezione || tenuti.has(c.id)), null, ...candidati.filter(c => dopoSelezione && !tenuti.has(c.id))].map((c, i) => {
                      if (c === null) {
                        // i ponti arrivano dopo i passaggi tenuti, prima degli scartati
                        return fase === 3 ? scena.ponti.map(p => (
                          <motion.div key={`ponte-${p.id}`} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                            <Passaggio c={p} scena={scena} stato="ponte" />
                          </motion.div>
                        )) : null;
                      }
                      const diventataFonte = inFonti && idFonti.has(c.id);
                      if (diventataFonte) {
                        const f = scena.fonti.find(x => x.id === c.id)!;
                        return (
                          <motion.div key={`ombra-${c.id}`} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                            className="flex items-center gap-1.5 rounded-lg border border-dashed border-primary/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                            <ArrowRight className="h-3 w-3 text-primary" aria-hidden /><span className="truncate">{c.title}</span><span className="ml-auto shrink-0 font-semibold text-primary">Fonte {f.n}</span>
                          </motion.div>
                        );
                      }
                      return (
                        <motion.div key={c.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: fase === 1 ? i * 0.12 : 0 }}>
                          <Passaggio c={c} scena={scena} compatto={dopoSelezione && !tenuti.has(c.id)}
                            stato={!dopoSelezione ? "nuovo" : tenuti.has(c.id) ? "tenuto" : "scartato"} />
                        </motion.div>
                      );
                    })}
                  </>
                )}
                {scena && fase >= 1 && scena.candidati.length > candidati.length && (
                  <div className="text-[11px] text-muted-foreground">e altri {scena.candidati.length - candidati.length} passaggi letti e lasciati indietro</div>
                )}
                {scena && fase >= 1 && !scena.candidati.length && (
                  <div className="rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground">Nessun passaggio abbastanza vicino: Argos risponde con i dati e gli strumenti.</div>
                )}
              </Colonna>

              {/* 3. le fonti */}
              <Colonna n={3} titolo="Al modello" icona={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
                nota={scena ? `${scena.fonti.length} fonti` : undefined}>
                {scena && (inFonti ? (
                  <>
                    {scena.fonti.map(f => {
                      const c = scena.candidati.find(x => x.id === f.id) ?? scena.ponti.find(x => x.id === f.id) ?? f;
                      return (
                        <motion.div key={f.id} layout>
                          <Passaggio c={c} scena={scena} stato="fonte" numero={f.n} acceso={fonteAccesa === f.id} compatto={fase >= 5} />
                        </motion.div>
                      );
                    })}
                    {scena.memoria && (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground" data-tinta="memoria">
                        <History className="h-3.5 w-3.5 argos-tinta" aria-hidden />Più una risposta data in passato a una domanda simile
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">Il modello riceve i passaggi numerati e deve citarli: «[Fonte 1]», «[Fonte 2]»…</p>
                  </>
                ) : (
                  Array.from({ length: Math.max(1, scena.fonti.length) }, (_, i) => (
                    <div key={i} className="grid h-14 place-items-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
                      {scena.fonti.length ? `Fonte ${i + 1}` : "Nessun passaggio: solo dati e strumenti"}
                    </div>
                  ))
                ))}
                {s.strumenti.length > 0 && (
                  <div className="rounded-lg border border-border bg-card p-2.5">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"><Wrench className="h-3.5 w-3.5" aria-hidden />Ha consultato anche</div>
                    <ul className="flex flex-wrap gap-1">
                      {s.strumenti.map((t, i) => (
                        <motion.li key={i} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                          <Pill tinta={t.lato === "server" ? "info" : "avviso"}>{t.lato === "server" ? <Globe className="h-3 w-3" aria-hidden /> : null}{nomeStrumento(t.nome)}</Pill>
                        </motion.li>
                      ))}
                    </ul>
                  </div>
                )}
              </Colonna>

              {/* 4. la risposta */}
              <Colonna n={4} titolo="La risposta" icona={<MessageSquareText className="h-3.5 w-3.5" aria-hidden />}
                nota={s.verifica ? `${s.verifica.traced}/${s.verifica.total} frasi agganciate` : undefined}>
                {mostraRisposta ? (
                  <>
                    {s.testo ? (
                      <div className="max-h-[26rem] overflow-auto rounded-lg border border-border bg-card p-3 text-sm leading-relaxed">
                        <Suspense fallback={<p className="whitespace-pre-wrap">{s.testo}</p>}><ArgosMarkdown>{s.testo}</ArgosMarkdown></Suspense>
                        {s.inCorso && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle" aria-hidden />}
                      </div>
                    ) : s.inCorso ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Il modello sta scrivendo…</div>
                    ) : null}
                    {s.verifica && s.verifica.claims.length > 0 && (
                      <div className="rounded-lg border border-border bg-card p-2.5">
                        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                          <span>Da dove viene ogni frase</span>
                          <span className="tabular-nums">{Math.round((s.verifica.traced / Math.max(1, s.verifica.total)) * 100)}%</span>
                        </div>
                        <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted" data-tinta="ok">
                          <motion.div className="argos-barra h-full" initial={{ width: 0 }} animate={{ width: `${(s.verifica.traced / Math.max(1, s.verifica.total)) * 100}%` }} transition={{ duration: 0.8 }} />
                        </div>
                        <ul className="space-y-1">
                          {s.verifica.claims.map((c, i) => (
                            <li key={i}>
                              <button type="button" data-ancora={`f:${i}`}
                                onMouseEnter={() => setFrase(i)} onMouseLeave={() => setFrase(null)} onFocus={() => setFrase(i)} onBlur={() => setFrase(null)}
                                className={`w-full rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${fraseAttiva === i ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"}`}>
                                <span className="line-clamp-2">{c.text}</span>
                                <span className="mt-1 flex flex-wrap items-center gap-1">
                                  {c.traced && c.source != null ? <Pill tinta="ok">Fonte {c.source}{c.cited ? " · citata" : ""}</Pill>
                                    : <Pill tinta="neutro">{s.strumenti.length ? "dai dati o dal ragionamento" : "non agganciata"}</Pill>}
                                  {c.words.slice(0, 3).map(w => <span key={w} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{w}</span>)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground">
                    {s.inCorso ? (
                      <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        {parole ? `Il modello sta già scrivendo: ${parole} parole finora` : "In attesa delle fonti…"}</span>
                    ) : "La risposta è pronta: arriva alla fine della scena."}
                  </div>
                )}
              </Colonna>
            </div>
          </LayoutGroup>

          {riepilogo && fase >= FASI.length - 1 && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="mt-5 grid gap-2 border-t border-border pt-4 text-center sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["passaggi letti", riepilogo.letti], ["fonti date al modello", riepilogo.tenuti], ["ponti fra documenti", riepilogo.ponti],
                ["concetti in gioco", riepilogo.concetti], ["frasi agganciate", `${riepilogo.verificate}/${riepilogo.frasi}`],
                ["ricerca", tempoRicerca ? `${(tempoRicerca / 1000).toFixed(1)} s` : "—"],
              ].map(([e, v]) => (
                <div key={String(e)} className="rounded-lg bg-muted/50 px-2 py-2">
                  <div className="text-xl font-bold tabular-nums">{v}</div>
                  <div className="text-[11px] text-muted-foreground">{e}</div>
                </div>
              ))}
              {s.token != null && <div className="text-[11px] text-muted-foreground sm:col-span-3 lg:col-span-6">{token(s.token)} token per questa risposta</div>}
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}
