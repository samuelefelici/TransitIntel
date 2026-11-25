/**
 * La pagina di accesso, come pagina di presentazione (tappe 7.34 e 7.35).
 *
 * Chi non è entrato vede che cos'è Cerbero, in italiano o in inglese:
 * - la Terra a punti che gira (components/accesso/Globo.tsx), accanto al
 *   titolo e non sotto (tappa 7.36);
 * - Argos, il nucleo: un RAG multiagente, che lavora davanti a chi guarda
 *   con lo stesso crawler 3D della console, su una domanda d'esempio
 *   (components/accesso/ArgosInDiretta.tsx);
 * - il ciclo del lavoro, gli otto moduli con le loro piccole animazioni
 *   (components/accesso/Visivi.tsx), la sicurezza.
 * I testi sono in lib/accesso.ts: dicono solo quello che l'app fa davvero,
 * con titoli corti e i nomi dei sistemi in inglese anche in italiano.
 *
 * L'accesso sta in un riquadro che entra da destra: email e password, poi,
 * se è attiva, la verifica in due passaggi col codice dell'app o un codice di
 * recupero. Si apre dai pulsanti «Accedi», e da solo quando si arriva su una
 * pagina interna (un segnalibro, un link, la sessione scaduta).
 *
 * La logica è quella di prima (hooks/use-auth.tsx): dopo un accesso riuscito
 * la pagina mostra una conferma breve e poi avvisa l'app con l'evento
 * «auth:login-sequence-done», che smonta il login e apre la pagina chiesta.
 * La lingua scelta resta nel browser («cerbero-lingua»); l'app dopo
 * l'accesso resta in italiano. Con «riduci il movimento» del sistema le
 * animazioni sono ferme.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  motion, AnimatePresence, useInView, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform,
} from "framer-motion";
import { useLocation } from "wouter";
import {
  AlertTriangle, ArrowDown, ArrowRight, Bot, CalendarClock, ClipboardCheck, Database, DatabaseBackup, Eye, EyeOff,
  Fingerprint, History, KeyRound, Library, LockKeyhole, LogIn, Radio, Route, Send, ShieldCheck, UserCog, Users, X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTema } from "@/hooks/use-tema";
import { SceltaTemaCompatta } from "@/components/layout/SceltaTema";
import Globo from "@/components/accesso/Globo";
import ArgosInDiretta from "@/components/accesso/ArgosInDiretta";
import VisivoModulo from "@/components/accesso/Visivi";
import {
  LINGUE, TESTI, codiceCompleto, erroreInLingua, linguaIniziale, nomeDiBenvenuto, saluto,
  type Lingua, type Pilastro, type TestiLanding, type Titolo,
} from "@/lib/accesso";
import logoImg from "/logosidebar.png";
import "@/styles/landing.css";

const CARATTERI = "https://fonts.googleapis.com/css2?family=Mona+Sans:wdth,wght@75..125,200..900&family=Reddit+Mono:wght@400..600&display=swap";
const MORBIDO = [0.2, 0.7, 0.2, 1] as const;
const ICONE_CICLO = [Route, CalendarClock, Send, Users, Radio, ClipboardCheck];
const ICONE_SICUREZZA = [Fingerprint, UserCog, History, DatabaseBackup];
const ICONE_PILASTRI: Record<Pilastro["chiave"], typeof Bot> = { squadra: Bot, biblioteca: Library, dati: Database, guardiano: ShieldCheck };
const CHIAVE_LINGUA = "cerbero-lingua";

/** I caratteri della pagina, solo quando la pagina c'è. */
function useCaratteri() {
  useEffect(() => {
    if (document.querySelector(`link[data-caratteri="landing"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = CARATTERI;
    l.dataset.caratteri = "landing";
    document.head.appendChild(l);
  }, []);
}

function useLingua(): [Lingua, (l: Lingua) => void] {
  const [lingua, setLingua] = useState<Lingua>(() => {
    let salvata: string | null = null;
    try { salvata = window.localStorage.getItem(CHIAVE_LINGUA); } catch { /* niente archivio: si usa il browser */ }
    return linguaIniziale(salvata, typeof navigator !== "undefined" ? navigator.language : null);
  });
  const cambia = useCallback((l: Lingua) => {
    setLingua(l);
    try { window.localStorage.setItem(CHIAVE_LINGUA, l); } catch { /* resta per questa visita */ }
  }, []);
  return [lingua, cambia];
}

function scorriA(id: string, fermo: boolean) {
  document.getElementById(id)?.scrollIntoView({ behavior: fermo ? "auto" : "smooth", block: "start" });
}

export default function LoginPage() {
  const { user } = useAuth();
  const { tema } = useTema();
  const [location] = useLocation();
  const fermo = useReducedMotion() ?? false;
  const [lingua, cambiaLingua] = useLingua();
  const t = TESTI[lingua];
  useCaratteri();

  /* arrivati su una pagina interna: si vuole entrare, il riquadro è già aperto */
  const [aperto, setAperto] = useState(() => location !== "/" && location !== "/login");
  const [entrato, setEntrato] = useState<string | null>(null);
  const daDove = useRef<HTMLElement | null>(null);

  const apri = useCallback(() => {
    daDove.current = document.activeElement as HTMLElement | null;
    setAperto(true);
  }, []);
  const chiudi = useCallback(() => {
    setAperto(false);
    window.setTimeout(() => daDove.current?.focus?.(), 0);
  }, []);

  /* accesso riuscito: una conferma breve, poi l'app (che aspetta questo evento per smontare il login).
   * Il timer non si annulla: anche se la pagina sparisse prima, l'app deve ricevere l'evento. */
  const conferma = useCallback((email: string) => {
    setEntrato(email);
    window.setTimeout(() => {
      window.dispatchEvent(new Event("auth:login-sequence-done"));
    }, fermo ? 350 : 1600);
  }, [fermo]);

  return (
    <div className="landing" lang={lingua}>
      <div className="landing-contenuto" aria-hidden={aperto || undefined} inert={aperto || undefined}>
        <Barra t={t} lingua={lingua} cambiaLingua={cambiaLingua} fermo={fermo} onAccedi={apri} />
        <main>
          <Eroe t={t} lingua={lingua} tema={tema} fermo={fermo} onAccedi={apri} />
          <Nastro voci={t.nastro} />
          <Argos t={t} lingua={lingua} tema={tema} fermo={fermo} />
          <Ciclo t={t} fermo={fermo} />
          <Moduli t={t} fermo={fermo} />
          <Sicurezza t={t} fermo={fermo} />
          <Invito t={t} fermo={fermo} onAccedi={apri} />
        </main>
        <Piede t={t} />
      </div>

      <AnimatePresence>
        {aperto && <Cassetto t={t} lingua={lingua} fermo={fermo} onChiudi={chiudi} onEntrato={conferma} />}
      </AnimatePresence>

      <AnimatePresence>
        {entrato !== null && (
          <motion.div
            className="landing-conferma"
            role="status"
            aria-live="polite"
            initial={fermo ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            <div className="text-center">
              <svg width="88" height="88" viewBox="0 0 88 88" className="mx-auto overflow-visible" aria-hidden>
                {!fermo && [0, 1].map((k) => (
                  <motion.circle
                    key={k}
                    cx="44" cy="44" r="30"
                    fill="none" stroke="var(--l-ciano)" strokeWidth="1"
                    initial={{ scale: 1, opacity: 0.8 }}
                    animate={{ scale: 1.9, opacity: 0 }}
                    transition={{ duration: 1.4, delay: 0.2 + k * 0.45, repeat: Infinity, ease: "easeOut" }}
                    style={{ transformOrigin: "44px 44px" }}
                  />
                ))}
                <circle cx="44" cy="44" r="30" fill="none" stroke="var(--l-bordo)" strokeWidth="1" />
                <motion.path
                  d="M31 45 L40 54 L58 34"
                  fill="none"
                  stroke="var(--l-ciano-2)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={fermo ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
                />
              </svg>
              <p className="landing-mono mt-7" style={{ color: "var(--l-testo-2)" }}>{t.accesso.confermato}</p>
              <p className="landing-titolo-sezione mt-3" style={{ fontSize: "clamp(30px, 4vw, 48px)" }}>
                {saluto(nomeDiBenvenuto(user?.fullName, user?.email ?? entrato), lingua)}
              </p>
              <div className="landing-conferma-barra mx-auto mt-7"><span /></div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── la barra in alto ─────────────────────────────────────────────────────── */
function SceltaLingua({ lingua, cambia, etichetta }: { lingua: Lingua; cambia: (l: Lingua) => void; etichetta: string }) {
  return (
    <div role="group" aria-label={etichetta} className="landing-lingua landing-mono">
      {LINGUE.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={lingua === l} onClick={() => cambia(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function Barra({ t, lingua, cambiaLingua, fermo, onAccedi }: {
  t: TestiLanding; lingua: Lingua; cambiaLingua: (l: Lingua) => void; fermo: boolean; onAccedi: () => void;
}) {
  const { scrollY } = useScroll();
  const [scorsa, setScorsa] = useState(false);
  useMotionValueEvent(scrollY, "change", (v) => setScorsa(v > 24));
  const voci: Array<[string, string]> = [["argos", t.barra.argos], ["ciclo", t.barra.ciclo], ["moduli", t.barra.moduli], ["sicurezza", t.barra.sicurezza]];
  return (
    <motion.header
      className="landing-barra"
      data-scorsa={scorsa ? "1" : "0"}
      initial={fermo ? false : { y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, delay: 0.2, ease: MORBIDO }}
    >
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-8 lg:px-14">
        <a href="#inizio" onClick={(e) => { e.preventDefault(); scorriA("inizio", fermo); }} className="flex min-w-0 items-center gap-3" aria-label={t.barra.torna}>
          <img src={logoImg} alt="" className="h-9 w-auto" />
          <span className="hidden leading-tight min-[420px]:block">
            <span className="block text-[15px] font-semibold tracking-[0.2em]">CERBERO</span>
            <span className="landing-mono block" style={{ fontSize: 9.5, letterSpacing: "0.18em", color: "var(--l-testo-3)" }}>Transportation management</span>
          </span>
        </a>
        <nav className="hidden items-center gap-8 lg:flex" aria-label={t.barra.sezioni}>
          {voci.map(([id, testo]) => (
            <a key={id} href={`#${id}`} className="landing-voce landing-mono" onClick={(e) => { e.preventDefault(); scorriA(id, fermo); }}>{testo}</a>
          ))}
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <SceltaLingua lingua={lingua} cambia={cambiaLingua} etichetta={t.barra.lingua} />
          <SceltaTemaCompatta />
          <button type="button" onClick={onAccedi} className="landing-bottone" style={{ height: 40, padding: "0 16px", fontSize: 11.5 }}>
            <LogIn className="h-4 w-4" aria-hidden />{t.barra.accedi}
          </button>
        </div>
      </div>
    </motion.header>
  );
}

/* ── le lettere del titolo, che entrano una per una ───────────────────────── */
function Lettere({ testo, ritardo, fermo }: { testo: string; ritardo: number; fermo: boolean }) {
  return (
    <>
      {[...testo].map((c, i) => (
        <motion.span
          key={i}
          className="inline-block"
          initial={fermo ? false : { opacity: 0, y: "0.4em", rotateX: -80 }}
          animate={{ opacity: 1, y: 0, rotateX: 0 }}
          transition={{ duration: 0.8, delay: ritardo + i * 0.05, ease: MORBIDO }}
          style={{ transformPerspective: 600 }}
        >{c}</motion.span>
      ))}
    </>
  );
}

function Orologio({ lingua, etichetta }: { lingua: Lingua; etichetta: string }) {
  const [ora, setOra] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setOra(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const locale = lingua === "en" ? "en-GB" : "it-IT";
  const giorno = ora.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "short" });
  return (
    <div className="landing-ora landing-mono" aria-hidden>
      <span>{etichetta} · {giorno}</span>
      <b>{ora.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b>
    </div>
  );
}

/* ── la prima schermata ───────────────────────────────────────────────────── */
function Eroe({ t, lingua, tema, fermo, onAccedi }: { t: TestiLanding; lingua: Lingua; tema: "scuro" | "chiaro"; fermo: boolean; onAccedi: () => void }) {
  const { scrollY } = useScroll();
  const testoY = useTransform(scrollY, [0, 700], [0, -120]);
  const testoO = useTransform(scrollY, [0, 560], [1, 0]);
  const globoS = useTransform(scrollY, [0, 900], [1, 1.12]);
  const globoO = useTransform(scrollY, [0, 900], [1, 0.3]);
  const entra = (ritardo: number) => fermo
    ? { initial: false as const }
    : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.8, delay: ritardo, ease: MORBIDO } };

  return (
    <section id="inizio" className="landing-eroe" aria-labelledby="landing-titolo">
      {/* il globo sta a destra (sul telefono in alto): il testo non ci va sopra */}
      <motion.div className="landing-eroe-globo" style={fermo ? undefined : { scale: globoS, opacity: globoO }}>
        <Globo tema={tema} lingua={lingua} />
      </motion.div>
      <Orologio lingua={lingua} etichetta={t.eroe.ora} />

      <div className="landing-eroe-griglia">
        <motion.div className="landing-eroe-testo" style={fermo ? undefined : { y: testoY, opacity: testoO }}>
          <motion.p {...entra(0.3)} className="landing-occhiello landing-mono" style={{ justifyContent: "flex-start" }}>{t.eroe.occhiello}</motion.p>
          <h1 id="landing-titolo" className="landing-titolo mt-6">
            <span className="landing-titolo-1"><Lettere testo="CERBERO" ritardo={0.45} fermo={fermo} /></span>
            <motion.span {...entra(0.95)} className="landing-titolo-2 landing-titolo-piccolo">{t.eroe.sottotitolo}</motion.span>
          </h1>
          <motion.p {...entra(1.2)} className="landing-sotto mt-7">{t.eroe.testo}</motion.p>
          <motion.div {...entra(1.4)} className="mt-10 flex flex-wrap items-center gap-4">
            <button type="button" className="landing-bottone" onClick={onAccedi}>
              {t.eroe.accedi}<ArrowRight className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" className="landing-bottone-vuoto" onClick={() => scorriA("argos", fermo)}>
              {t.eroe.scopri}
            </button>
          </motion.div>
        </motion.div>
      </div>

      <motion.button
        type="button"
        className="landing-scorri landing-mono"
        onClick={() => scorriA("argos", fermo)}
        aria-label={t.eroe.scorriEtichetta}
        {...entra(1.9)}
      >
        <span className="flex items-center gap-2">{t.eroe.scorri}<ArrowDown className="h-3 w-3" aria-hidden /></span>
        <span aria-hidden />
      </motion.button>
    </section>
  );
}

/* ── il nastro ────────────────────────────────────────────────────────────── */
function Nastro({ voci }: { voci: readonly string[] }) {
  const rovescio = [...voci].reverse();
  return (
    <div className="landing-nastro landing-mono" aria-hidden>
      <div className="landing-nastro-traccia">
        {[...voci, ...voci].map((v, i) => <span key={i} className="landing-nastro-voce">{v}</span>)}
      </div>
      <div className="landing-nastro-traccia landing-nastro-traccia-2">
        {[...rovescio, ...rovescio].map((v, i) => <span key={i} className="landing-nastro-voce">{v}</span>)}
      </div>
    </div>
  );
}

/* ── le testate delle sezioni: l'occhiello, il titolo, il testo ─────────────── */
function Rivela({ children, fermo, ritardo = 0, className, sposta = 28 }: {
  children: React.ReactNode; fermo: boolean; ritardo?: number; className?: string; sposta?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={fermo ? false : { opacity: 0, y: sposta }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.9, delay: ritardo, ease: MORBIDO }}
    >
      {children}
    </motion.div>
  );
}

function Testata({ id, occhiello, titolo, testo, fermo, centrata }: {
  id: string; occhiello: string; titolo: Titolo; testo: string; fermo: boolean; centrata?: boolean;
}) {
  return (
    <>
      <Rivela fermo={fermo}>
        <p className="landing-occhiello landing-mono" style={centrata ? undefined : { justifyContent: "flex-start" }}>{occhiello}</p>
      </Rivela>
      <Rivela fermo={fermo} ritardo={0.08}>
        <h2 id={id} className="landing-titolo-sezione mt-6">{titolo.prima} <em>{titolo.evidenza}</em></h2>
      </Rivela>
      <Rivela fermo={fermo} ritardo={0.16}><p className={`landing-paragrafo mt-6 ${centrata ? "mx-auto" : ""}`}>{testo}</p></Rivela>
    </>
  );
}

/* ── Argos, il nucleo ─────────────────────────────────────────────────────── */
function Argos({ t, lingua, tema, fermo }: { t: TestiLanding; lingua: Lingua; tema: "scuro" | "chiaro"; fermo: boolean }) {
  const a = t.argos;
  return (
    <section id="argos" className="landing-sezione landing-argos scroll-mt-16" aria-labelledby="landing-argos">
      <div className="relative mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <div className="grid items-end gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
          <div>
            <Testata id="landing-argos" occhiello={a.occhiello} titolo={a.titolo} testo={a.testo} fermo={fermo} />
          </div>
          <div className="landing-pilastri">
            {a.pilastri.map((p, i) => {
              const Icona = ICONE_PILASTRI[p.chiave];
              return (
                <Rivela key={p.chiave} fermo={fermo} ritardo={i * 0.08} className="landing-pilastro">
                  <span className="landing-pilastro-icona"><Icona className="h-4 w-4" aria-hidden /></span>
                  <h3>{p.titolo}</h3>
                  <p>{p.testo}</p>
                </Rivela>
              );
            })}
          </div>
        </div>
        <Rivela fermo={fermo} ritardo={0.1} sposta={40} className="mt-14">
          <ArgosInDiretta lingua={lingua} tema={tema} fermo={fermo} />
        </Rivela>
      </div>
    </section>
  );
}

/* ── il ciclo del lavoro ──────────────────────────────────────────────────── */
function Tappa({ t, indice, fermo }: { t: TestiLanding; indice: number; fermo: boolean }) {
  const tappa = t.ciclo.tappe[indice]!;
  const Icona = ICONE_CICLO[indice] ?? Route;
  const ref = useRef<HTMLLIElement>(null);
  const acceso = useInView(ref, { margin: "-35% 0px -45% 0px" });
  return (
    <motion.li
      ref={ref}
      className="landing-tappa"
      data-acceso={acceso ? "1" : "0"}
      initial={fermo ? false : { opacity: 0, x: 30 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.8, ease: MORBIDO }}
    >
      <span className="landing-tappa-icona"><Icona className="h-5 w-5" aria-hidden /></span>
      <div>
        <span className="landing-tappa-numero landing-mono">{t.ciclo.tappa} {tappa.numero}</span>
        <h3>{tappa.titolo}</h3>
        <p>{tappa.testo}</p>
      </div>
    </motion.li>
  );
}

function Ciclo({ t, fermo }: { t: TestiLanding; fermo: boolean }) {
  const elenco = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: elenco, offset: ["start 65%", "end 55%"] });
  const avanzamento = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.4 });
  return (
    <section id="ciclo" className="landing-sezione scroll-mt-16" aria-labelledby="landing-ciclo">
      <div className="mx-auto grid max-w-[1440px] gap-14 px-4 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-24 lg:px-14">
        <div className="lg:sticky lg:top-32 lg:self-start">
          <Testata id="landing-ciclo" occhiello={t.ciclo.occhiello} titolo={t.ciclo.titolo} testo={t.ciclo.testo} fermo={fermo} />
        </div>
        <div ref={elenco} className="relative">
          <div className="landing-ciclo-binario" aria-hidden>
            <motion.div style={{ scaleY: fermo ? 1 : avanzamento }} />
          </div>
          <ol>
            {t.ciclo.tappe.map((tp, i) => <Tappa key={tp.numero} t={t} indice={i} fermo={fermo} />)}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ── i moduli ─────────────────────────────────────────────────────────────── */
function Moduli({ t, fermo }: { t: TestiLanding; fermo: boolean }) {
  /* la luce segue il puntatore e la scheda si inclina appena: niente stato, solo stile */
  const muovi = (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    if (!fermo) el.style.transform = `perspective(900px) rotateX(${((0.5 - y) * 5).toFixed(2)}deg) rotateY(${((x - 0.5) * 6).toFixed(2)}deg)`;
  };
  const esci = (e: React.PointerEvent<HTMLElement>) => { e.currentTarget.style.transform = ""; };
  return (
    <section id="moduli" className="landing-sezione scroll-mt-16" aria-labelledby="landing-moduli" style={{ paddingTop: 0 }}>
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <div className="max-w-3xl">
          <Testata id="landing-moduli" occhiello={t.moduli.occhiello} titolo={t.moduli.titolo} testo={t.moduli.testo} fermo={fermo} />
        </div>
        <div className="landing-moduli mt-14">
          {t.moduli.elenco.map((m, i) => (
            <motion.div
              key={m.chiave}
              className="flex"
              initial={fermo ? false : { opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.8, delay: (i % 4) * 0.08, ease: MORBIDO }}
            >
              <article className="landing-modulo w-full" onPointerMove={muovi} onPointerLeave={esci}>
                <div className="landing-modulo-dentro">
                  <div className="landing-modulo-visivo"><VisivoModulo chiave={m.chiave} fermo={fermo} etichette={t.visivi} /></div>
                  <span className="landing-modulo-sotto landing-mono">{m.sotto}</span>
                  <h3>{m.titolo}</h3>
                  <p>{m.testo}</p>
                </div>
              </article>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── la sicurezza ─────────────────────────────────────────────────────────── */
function Sicurezza({ t, fermo }: { t: TestiLanding; fermo: boolean }) {
  return (
    <section id="sicurezza" className="landing-sezione scroll-mt-16" aria-labelledby="landing-sicurezza" style={{ paddingTop: 0 }}>
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <div className="max-w-3xl">
          <Testata id="landing-sicurezza" occhiello={t.sicurezza.occhiello} titolo={t.sicurezza.titolo} testo={t.sicurezza.testo} fermo={fermo} />
        </div>
        <div className="landing-sicurezza mt-14">
          {t.sicurezza.elenco.map((s, i) => {
            const Icona = ICONE_SICUREZZA[i] ?? Fingerprint;
            return (
              <Rivela key={s.titolo} fermo={fermo} ritardo={i * 0.1}>
                <span className="landing-sigillo"><Icona className="h-6 w-6" aria-hidden /></span>
                <h3>{s.titolo}</h3>
                <p>{s.testo}</p>
              </Rivela>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ── l'invito finale ──────────────────────────────────────────────────────── */
function Invito({ t, fermo, onAccedi }: { t: TestiLanding; fermo: boolean; onAccedi: () => void }) {
  return (
    <section className="landing-sezione" style={{ paddingTop: 0 }} aria-labelledby="landing-invito">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <Rivela fermo={fermo} className="landing-invito" sposta={40}>
          <div className="landing-aurora" aria-hidden />
          <div className="landing-invito-griglia" aria-hidden />
          <div className="mx-auto max-w-4xl">
            <Testata id="landing-invito" occhiello={t.invito.occhiello} titolo={t.invito.titolo} testo={t.invito.testo} fermo={fermo} centrata />
          </div>
          <div className="mt-10 flex justify-center">
            <button type="button" className="landing-bottone" onClick={onAccedi}>
              {t.invito.bottone}<ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </Rivela>
      </div>
    </section>
  );
}

function Piede({ t }: { t: TestiLanding }) {
  const anno = new Date().getFullYear();
  return (
    <footer className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-t px-4 py-8 sm:px-8 lg:px-14" style={{ borderColor: "var(--l-bordo-tenue)" }}>
      <span className="flex items-center gap-3">
        <img src={logoImg} alt="" className="h-7 w-auto opacity-80" />
        <span className="landing-mono" style={{ color: "var(--l-testo-3)" }}>© {anno} Cerbero</span>
      </span>
      <span className="landing-mono" style={{ color: "var(--l-testo-3)" }}>{t.piede.riservato}</span>
    </footer>
  );
}

/* ── il riquadro dell'accesso ─────────────────────────────────────────────── */
function Cassetto({ t, lingua, fermo, onChiudi, onEntrato }: {
  t: TestiLanding; lingua: Lingua; fermo: boolean; onChiudi: () => void; onEntrato: (email: string) => void;
}) {
  const { login, loginMfa } = useAuth();
  const riquadro = useRef<HTMLElement>(null);
  const a = t.accesso;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mostra, setMostra] = useState(false);
  /* il messaggio del server: credenziali, blocco dopo troppi tentativi, codice sbagliato */
  const [errore, setErrore] = useState<string | null>(null);
  /* password giusta e verifica attiva: il biglietto per il secondo passo */
  const [biglietto, setBiglietto] = useState<string | null>(null);
  const [codice, setCodice] = useState("");
  const [usaRecupero, setUsaRecupero] = useState(false);
  const [attesa, setAttesa] = useState(false);
  const [scossa, setScossa] = useState(0);

  /* Esc chiude; Tab resta dentro il riquadro */
  useEffect(() => {
    const tasto = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onChiudi(); return; }
      if (e.key !== "Tab" || !riquadro.current) return;
      const fuochi = riquadro.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, a[href]");
      if (fuochi.length === 0) return;
      const primo = fuochi[0]!, ultimo = fuochi[fuochi.length - 1]!;
      if (e.shiftKey && document.activeElement === primo) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primo.focus(); }
    };
    window.addEventListener("keydown", tasto);
    return () => window.removeEventListener("keydown", tasto);
  }, [onChiudi]);

  const sbagliato = useCallback((messaggio: string) => {
    setAttesa(false);
    setErrore(erroreInLingua(messaggio, lingua));
    setScossa((n) => n + 1);
  }, [lingua]);

  const accedi = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setErrore(null);
    setAttesa(true);
    const r = await login(email, password);
    if (!r.ok) {
      if ("mfaBiglietto" in r) {
        setAttesa(false);
        setBiglietto(r.mfaBiglietto);
        setCodice("");
        setUsaRecupero(false);
        return;
      }
      sbagliato(r.error);
      return;
    }
    setAttesa(false);
    onEntrato(email);
  }, [login, email, password, sbagliato, onEntrato]);

  const verifica = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!biglietto) return;
    setErrore(null);
    setAttesa(true);
    const prova = usaRecupero ? { recupero: codice.trim() } : { codice: codice.replace(/\s+/g, "") };
    const r = await loginMfa(biglietto, prova);
    if (!r.ok) {
      /* biglietto scaduto (5 minuti): si torna a email e password */
      if (/scaduto/i.test(r.error ?? "")) setBiglietto(null);
      sbagliato(r.error ?? "Codice non valido");
      return;
    }
    setAttesa(false);
    onEntrato(email);
  }, [biglietto, codice, usaRecupero, loginMfa, sbagliato, onEntrato, email]);

  return (
    <>
      <motion.div
        className="landing-velo"
        onClick={onChiudi}
        aria-hidden
        initial={fermo ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35 }}
      />
      <motion.aside
        ref={riquadro}
        className="landing-cassetto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="landing-accesso-titolo"
        initial={fermo ? false : { x: "100%" }}
        animate={{ x: 0 }}
        exit={fermo ? { opacity: 0 } : { x: "100%", transition: { duration: 0.32, ease: [0.4, 0, 1, 1] } }}
        transition={{ type: "spring", stiffness: 260, damping: 32 }}
      >
        <div className="flex items-center justify-between px-6 pt-6 sm:px-10">
          <span className="flex items-center gap-3">
            <img src={logoImg} alt="" className="h-8 w-auto" />
            <span className="text-[14px] font-semibold tracking-[0.2em]">CERBERO</span>
          </span>
          <button type="button" className="landing-icona" onClick={onChiudi} aria-label={a.chiudi}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <motion.div
          className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-10"
          initial={fermo ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15, ease: MORBIDO }}
        >
          <motion.div
            key={scossa}
            animate={scossa && !fermo ? { x: [0, -8, 8, -6, 6, 0] } : undefined}
            transition={{ duration: 0.45 }}
          >
            {biglietto ? (
              <form onSubmit={verifica} className="space-y-6" aria-describedby="accesso-codice-aiuto" noValidate>
                <div>
                  <p className="landing-mono flex items-center gap-2" style={{ color: "var(--l-ciano)" }}><KeyRound className="h-3.5 w-3.5" aria-hidden />{a.secondo}</p>
                  <h2 id="landing-accesso-titolo" className="landing-titolo-sezione mt-4" style={{ fontSize: 34 }}>{a.titoloMfa}</h2>
                  <p id="accesso-codice-aiuto" className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--l-testo-2)" }}>
                    {usaRecupero ? a.aiutoRecupero : a.aiutoCodice}
                  </p>
                </div>
                <div>
                  <label htmlFor="accesso-codice" className="landing-etichetta">{usaRecupero ? a.codiceRecupero : a.codice}</label>
                  <input
                    id="accesso-codice"
                    value={codice}
                    onChange={(e) => setCodice(e.target.value)}
                    inputMode={usaRecupero ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={usaRecupero ? 12 : 7}
                    placeholder={usaRecupero ? "XXXXX-XXXXX" : "000000"}
                    className="landing-campo landing-campo-codice"
                    required
                  />
                </div>
                <Errore testo={errore} />
                <button type="submit" className="landing-bottone w-full" disabled={attesa || (!usaRecupero && !codiceCompleto(codice)) || (usaRecupero && codice.trim().length < 6)}>
                  {attesa ? <><span className="landing-girandola" aria-hidden />{a.verifico}</> : a.verifica}
                </button>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button type="button" className="landing-link" onClick={() => { setUsaRecupero(!usaRecupero); setCodice(""); setErrore(null); }}>
                    {usaRecupero ? a.usaApp : a.persoTelefono}
                  </button>
                  <button type="button" className="landing-link" onClick={() => { setBiglietto(null); setErrore(null); }}>
                    {a.indietro}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={accedi} className="space-y-6">
                <div>
                  <p className="landing-mono flex items-center gap-2" style={{ color: "var(--l-ciano)" }}><LockKeyhole className="h-3.5 w-3.5" aria-hidden />{a.area}</p>
                  <h2 id="landing-accesso-titolo" className="landing-titolo-sezione mt-4" style={{ fontSize: 34 }}>{a.titolo}</h2>
                  <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--l-testo-2)" }}>{a.sotto}</p>
                </div>
                <div>
                  <label htmlFor="accesso-email" className="landing-etichetta">{a.email}</label>
                  <input
                    id="accesso-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    placeholder={a.segnaposto}
                    className="landing-campo"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="accesso-password" className="landing-etichetta">{a.password}</label>
                  <div className="relative">
                    <input
                      id="accesso-password"
                      type={mostra ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="landing-campo pr-12"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setMostra(!mostra)}
                      className="landing-icona landing-icona-nuda absolute right-1.5 top-1/2 -translate-y-1/2"
                      aria-label={mostra ? a.nascondi : a.mostra}
                      aria-pressed={mostra}
                    >
                      {mostra ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                    </button>
                  </div>
                </div>
                <Errore testo={errore} />
                <button type="submit" className="landing-bottone w-full" disabled={attesa}>
                  {attesa ? <><span className="landing-girandola" aria-hidden />{a.verifico}</> : a.accedi}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>

        <ul className="space-y-1.5 border-t px-6 py-6 text-[12.5px] sm:px-10" style={{ borderColor: "var(--l-bordo-tenue)", color: "var(--l-testo-3)" }}>
          {a.note.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </motion.aside>
    </>
  );
}

function Errore({ testo }: { testo: string | null }) {
  return (
    <div aria-live="assertive">
      {testo && (
        <div role="alert" className="landing-errore">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{testo}</span>
        </div>
      )}
    </div>
  );
}
