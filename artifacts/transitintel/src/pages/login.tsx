/**
 * La pagina di accesso, come pagina di presentazione (tappa 7.34).
 *
 * Chi non è entrato vede che cos'è Cerbero: la Terra a punti che gira
 * (components/accesso/Globo.tsx), il ciclo del lavoro, gli otto moduli con
 * le loro piccole animazioni (components/accesso/Visivi.tsx) e la sicurezza.
 * I testi sono in lib/accesso.ts e dicono solo quello che l'app fa davvero.
 *
 * L'accesso sta in un riquadro che entra da destra: email e password, poi,
 * se è attiva, la verifica in due passaggi col codice dell'app o un codice di
 * recupero. Si apre dai pulsanti «Accedi», e da solo quando si arriva su una
 * pagina interna (un segnalibro, un link, la sessione scaduta).
 *
 * La logica è quella di prima (hooks/use-auth.tsx): dopo un accesso riuscito
 * la pagina mostra una conferma breve e poi avvisa l'app con l'evento
 * «auth:login-sequence-done», che smonta il login e apre la pagina chiesta.
 * Con «riduci il movimento» del sistema le animazioni sono ferme.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  motion, AnimatePresence, useInView, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform,
} from "framer-motion";
import { useLocation } from "wouter";
import {
  AlertTriangle, ArrowDown, ArrowRight, CalendarClock, ClipboardCheck, DatabaseBackup, Eye, EyeOff,
  Fingerprint, History, KeyRound, LockKeyhole, LogIn, Radio, Route, Send, UserCog, Users, X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTema } from "@/hooks/use-tema";
import { SceltaTemaCompatta } from "@/components/layout/SceltaTema";
import Globo from "@/components/accesso/Globo";
import VisivoModulo from "@/components/accesso/Visivi";
import { CICLO, MODULI, NASTRO, SICUREZZA, codiceCompleto, nomeDiBenvenuto, saluto } from "@/lib/accesso";
import logoImg from "/logosidebar.png";
import "@/styles/landing.css";

const CARATTERI = "https://fonts.googleapis.com/css2?family=Mona+Sans:wdth,wght@75..125,200..900&family=Reddit+Mono:wght@400..600&display=swap";
const MORBIDO = [0.2, 0.7, 0.2, 1] as const;
const ICONE_CICLO = [Route, CalendarClock, Send, Users, Radio, ClipboardCheck];
const ICONE_SICUREZZA = [Fingerprint, UserCog, History, DatabaseBackup];

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

function scorriA(id: string, fermo: boolean) {
  document.getElementById(id)?.scrollIntoView({ behavior: fermo ? "auto" : "smooth", block: "start" });
}

export default function LoginPage() {
  const { user } = useAuth();
  const { tema } = useTema();
  const [location] = useLocation();
  const fermo = useReducedMotion() ?? false;
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
    <div className="landing">
      <div className="landing-contenuto" aria-hidden={aperto || undefined} inert={aperto || undefined}>
        <Barra fermo={fermo} onAccedi={apri} />
        <main>
          <Eroe tema={tema} fermo={fermo} onAccedi={apri} />
          <Nastro />
          <Ciclo fermo={fermo} />
          <Moduli fermo={fermo} />
          <Sicurezza fermo={fermo} />
          <Invito fermo={fermo} onAccedi={apri} />
        </main>
        <Piede />
      </div>

      <AnimatePresence>
        {aperto && <Cassetto fermo={fermo} onChiudi={chiudi} onEntrato={conferma} />}
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
              <p className="landing-mono mt-7" style={{ color: "var(--l-testo-2)" }}>Accesso confermato</p>
              <p className="landing-titolo-sezione mt-3" style={{ fontSize: "clamp(30px, 4vw, 48px)" }}>
                {saluto(nomeDiBenvenuto(user?.fullName, user?.email ?? entrato))}
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
function Barra({ fermo, onAccedi }: { fermo: boolean; onAccedi: () => void }) {
  const { scrollY } = useScroll();
  const [scorsa, setScorsa] = useState(false);
  useMotionValueEvent(scrollY, "change", (v) => setScorsa(v > 24));
  const voci: Array<[string, string]> = [["ciclo", "Il ciclo"], ["moduli", "Moduli"], ["sicurezza", "Sicurezza"]];
  return (
    <motion.header
      className="landing-barra"
      data-scorsa={scorsa ? "1" : "0"}
      initial={fermo ? false : { y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, delay: 0.2, ease: MORBIDO }}
    >
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8 lg:px-14">
        <a href="#inizio" onClick={(e) => { e.preventDefault(); scorriA("inizio", fermo); }} className="flex items-center gap-3" aria-label="Cerbero, torna all'inizio">
          <img src={logoImg} alt="" className="h-9 w-auto" />
          <span className="leading-tight">
            <span className="block text-[15px] font-semibold tracking-[0.2em]">CERBERO</span>
            <span className="landing-mono block" style={{ fontSize: 9.5, letterSpacing: "0.18em", color: "var(--l-testo-3)" }}>Transportation management</span>
          </span>
        </a>
        <nav className="hidden items-center gap-9 md:flex" aria-label="Sezioni">
          {voci.map(([id, testo]) => (
            <a key={id} href={`#${id}`} className="landing-voce landing-mono" onClick={(e) => { e.preventDefault(); scorriA(id, fermo); }}>{testo}</a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <SceltaTemaCompatta />
          <button type="button" onClick={onAccedi} className="landing-bottone" style={{ height: 40, padding: "0 18px", fontSize: 11.5 }}>
            <LogIn className="h-4 w-4" aria-hidden />Accedi
          </button>
        </div>
      </div>
    </motion.header>
  );
}

/* ── la prima schermata ───────────────────────────────────────────────────── */
function Lettere({ testo, ritardo, fermo }: { testo: string; ritardo: number; fermo: boolean }) {
  const parole = testo.split(" ");
  let n = 0;
  return (
    <>
      {parole.map((p, i) => (
        <Fragment key={i}>
        {i > 0 && " "}
        <span className="landing-parola">
          {[...p].map((c) => {
            const k = n++;
            return (
              <motion.span
                key={k}
                className="landing-lettera"
                initial={fermo ? false : { opacity: 0, y: "0.45em", rotateX: -80 }}
                animate={{ opacity: 1, y: 0, rotateX: 0 }}
                transition={{ duration: 0.8, delay: ritardo + k * 0.028, ease: MORBIDO }}
                style={{ transformPerspective: 600 }}
              >{c}</motion.span>
            );
          })}
        </span>
        </Fragment>
      ))}
    </>
  );
}

function Parole({ testo, ritardo, fermo, className }: { testo: string; ritardo: number; fermo: boolean; className: string }) {
  const parole = testo.split(" ");
  return (
    <>
      {parole.map((p, i) => (
        <span key={i} className="inline-block overflow-hidden align-top" style={{ paddingBottom: "0.06em" }}>
          <motion.span
            className={`inline-block ${className}`}
            initial={fermo ? false : { y: "105%" }}
            animate={{ y: 0 }}
            transition={{ duration: 0.95, delay: ritardo + i * 0.09, ease: MORBIDO }}
          >{p}</motion.span>
          {i < parole.length - 1 && <span className="inline-block">&nbsp;</span>}
        </span>
      ))}
    </>
  );
}

function Orologio() {
  const [ora, setOra] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setOra(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const giorno = ora.toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "short" });
  return (
    <div className="landing-ora landing-mono" aria-hidden>
      <span>Ora locale · {giorno}</span>
      <b>{ora.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</b>
    </div>
  );
}

function Eroe({ tema, fermo, onAccedi }: { tema: "scuro" | "chiaro"; fermo: boolean; onAccedi: () => void }) {
  const { scrollY } = useScroll();
  const testoY = useTransform(scrollY, [0, 700], [0, -140]);
  const testoO = useTransform(scrollY, [0, 520], [1, 0]);
  const globoS = useTransform(scrollY, [0, 900], [1, 1.18]);
  const globoO = useTransform(scrollY, [0, 900], [1, 0.25]);
  const entra = (ritardo: number) => fermo
    ? { initial: false as const }
    : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.8, delay: ritardo, ease: MORBIDO } };

  return (
    <section id="inizio" className="landing-eroe" aria-labelledby="landing-titolo">
      <motion.div className="absolute inset-0" style={fermo ? undefined : { scale: globoS, opacity: globoO }}>
        <Globo tema={tema} />
      </motion.div>
      <Orologio />

      <motion.div className="landing-eroe-testo" style={fermo ? undefined : { y: testoY, opacity: testoO }}>
        <motion.p {...entra(0.3)} className="landing-occhiello landing-mono">Piattaforma per il trasporto pubblico locale</motion.p>
        <h1 id="landing-titolo" className="landing-titolo mt-7">
          <span className="landing-titolo-1"><Lettere testo="Il servizio," ritardo={0.45} fermo={fermo} /></span>
          <span className="block"><Parole testo="dal piano" ritardo={0.85} fermo={fermo} className="landing-titolo-2" /></span>
          <span className="block"><Parole testo="alla strada" ritardo={1.05} fermo={fermo} className="landing-titolo-2" /></span>
        </h1>
        <motion.p {...entra(1.35)} className="landing-sotto mt-8">
          Rete, turni, personale ed esercizio in un unico sistema: quello che si programma è quello che si pubblica,
          si assegna, si guida e si rendiconta a fine mese.
        </motion.p>
        <motion.div {...entra(1.55)} className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <button type="button" className="landing-bottone" onClick={onAccedi}>
            Accedi<ArrowRight className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className="landing-bottone-vuoto" onClick={() => scorriA("ciclo", fermo)}>
            Scopri Cerbero
          </button>
        </motion.div>
      </motion.div>

      <motion.button
        type="button"
        className="landing-scorri landing-mono"
        onClick={() => scorriA("ciclo", fermo)}
        aria-label="Scorri al ciclo del lavoro"
        {...entra(2)}
      >
        <span className="flex items-center gap-2">Scorri<ArrowDown className="h-3 w-3" aria-hidden /></span>
        <span aria-hidden />
      </motion.button>
    </section>
  );
}

/* ── il nastro ────────────────────────────────────────────────────────────── */
function Nastro() {
  const voci = [...NASTRO, ...NASTRO];
  const rovescio = [...NASTRO].reverse();
  return (
    <div className="landing-nastro landing-mono" aria-hidden>
      <div className="landing-nastro-traccia">
        {voci.map((v, i) => <span key={i} className="landing-nastro-voce">{v}</span>)}
      </div>
      <div className="landing-nastro-traccia landing-nastro-traccia-2">
        {[...rovescio, ...rovescio].map((v, i) => <span key={i} className="landing-nastro-voce">{v}</span>)}
      </div>
    </div>
  );
}

/* ── i titoli delle sezioni ───────────────────────────────────────────────── */
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

function Testata({ occhiello, titolo, evidenza, testo, fermo }: {
  occhiello: string; titolo: string; evidenza: string; testo: string; fermo: boolean;
}) {
  return (
    <>
      <Rivela fermo={fermo}><p className="landing-occhiello landing-mono" style={{ justifyContent: "flex-start" }}>{occhiello}</p></Rivela>
      <Rivela fermo={fermo} ritardo={0.08}>
        <h2 className="landing-titolo-sezione mt-6">{titolo} <em>{evidenza}</em></h2>
      </Rivela>
      <Rivela fermo={fermo} ritardo={0.16}><p className="landing-paragrafo mt-6">{testo}</p></Rivela>
    </>
  );
}

/* ── il ciclo del lavoro ──────────────────────────────────────────────────── */
function Tappa({ indice, fermo }: { indice: number; fermo: boolean }) {
  const t = CICLO[indice]!;
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
        <span className="landing-tappa-numero landing-mono">Tappa {t.numero}</span>
        <h3>{t.titolo}</h3>
        <p>{t.testo}</p>
      </div>
    </motion.li>
  );
}

function Ciclo({ fermo }: { fermo: boolean }) {
  const elenco = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: elenco, offset: ["start 65%", "end 55%"] });
  const avanzamento = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.4 });
  return (
    <section id="ciclo" className="landing-sezione scroll-mt-16" aria-labelledby="landing-ciclo">
      <div className="mx-auto grid max-w-[1440px] gap-14 px-4 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-24 lg:px-14">
        <div className="lg:sticky lg:top-32 lg:self-start" id="landing-ciclo">
          <Testata
            fermo={fermo}
            occhiello="Il ciclo del lavoro"
            titolo="Dal programma"
            evidenza="al consuntivo del mese."
            testo="Sei tappe, nell'ordine del menu e del lavoro dell'azienda. Quello che esce da una tappa è quello che entra nella successiva: niente copie, niente fogli a parte."
          />
        </div>
        <div ref={elenco} className="relative">
          <div className="landing-ciclo-binario" aria-hidden>
            <motion.div style={{ scaleY: fermo ? 1 : avanzamento }} />
          </div>
          <ol>
            {CICLO.map((t, i) => <Tappa key={t.numero} indice={i} fermo={fermo} />)}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ── i moduli ─────────────────────────────────────────────────────────────── */
function Moduli({ fermo }: { fermo: boolean }) {
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
        <div className="max-w-3xl" id="landing-moduli">
          <Testata
            fermo={fermo}
            occhiello="Dentro Cerbero"
            titolo="Otto moduli,"
            evidenza="gli stessi dati."
            testo="Una corsa cambiata in Planning Studio è la stessa che arriva ai turni, al roster, all'esercizio e al consuntivo. Ogni modulo lavora sul programma in vigore."
          />
        </div>
        <div className="landing-moduli mt-14">
          {MODULI.map((m, i) => (
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
                  <div className="landing-modulo-visivo"><VisivoModulo chiave={m.chiave} fermo={fermo} /></div>
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
function Sicurezza({ fermo }: { fermo: boolean }) {
  return (
    <section id="sicurezza" className="landing-sezione scroll-mt-16" aria-labelledby="landing-sicurezza" style={{ paddingTop: 0 }}>
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <div className="max-w-3xl" id="landing-sicurezza">
          <Testata
            fermo={fermo}
            occhiello="Sicurezza"
            titolo="Chi entra,"
            evidenza="e che cosa può fare."
            testo="I dati di un'azienda di trasporto sono anche i dati di chi ci lavora. Cerbero li tratta così."
          />
        </div>
        <div className="landing-sicurezza mt-14">
          {SICUREZZA.map((s, i) => {
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
function Invito({ fermo, onAccedi }: { fermo: boolean; onAccedi: () => void }) {
  return (
    <section className="landing-sezione" style={{ paddingTop: 0 }} aria-labelledby="landing-invito">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-14">
        <Rivela fermo={fermo} className="landing-invito" sposta={40}>
          <div className="landing-aurora" aria-hidden />
          <div className="landing-invito-griglia" aria-hidden />
          <p className="landing-occhiello landing-mono">Area riservata</p>
          <h2 id="landing-invito" className="landing-titolo-sezione mx-auto mt-6 max-w-4xl">
            Il servizio di domani <em>si prepara oggi.</em>
          </h2>
          <p className="landing-paragrafo mx-auto mt-6">
            Entra con le credenziali che ti ha dato l'amministratore della tua azienda.
          </p>
          <div className="mt-10 flex justify-center">
            <button type="button" className="landing-bottone" onClick={onAccedi}>
              Accedi a Cerbero<ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </Rivela>
      </div>
    </section>
  );
}

function Piede() {
  const anno = new Date().getFullYear();
  return (
    <footer className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-t px-4 py-8 sm:px-8 lg:px-14" style={{ borderColor: "var(--l-bordo-tenue)" }}>
      <span className="flex items-center gap-3">
        <img src={logoImg} alt="" className="h-7 w-auto opacity-80" />
        <span className="landing-mono" style={{ color: "var(--l-testo-3)" }}>© {anno} Cerbero</span>
      </span>
      <span className="landing-mono" style={{ color: "var(--l-testo-3)" }}>Accesso riservato al personale autorizzato</span>
    </footer>
  );
}

/* ── il riquadro dell'accesso ─────────────────────────────────────────────── */
function Cassetto({ fermo, onChiudi, onEntrato }: { fermo: boolean; onChiudi: () => void; onEntrato: (email: string) => void }) {
  const { login, loginMfa } = useAuth();
  const riquadro = useRef<HTMLElement>(null);

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
    setErrore(messaggio);
    setScossa((n) => n + 1);
  }, []);

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
          <button type="button" className="landing-icona" onClick={onChiudi} aria-label="Chiudi l'accesso">
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
                  <p className="landing-mono flex items-center gap-2" style={{ color: "var(--l-ciano)" }}><KeyRound className="h-3.5 w-3.5" aria-hidden />Secondo passaggio</p>
                  <h2 id="landing-accesso-titolo" className="landing-titolo-sezione mt-4" style={{ fontSize: 34 }}>Verifica in due passaggi</h2>
                  <p id="accesso-codice-aiuto" className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--l-testo-2)" }}>
                    {usaRecupero
                      ? "Scrivi uno dei codici di recupero che hai salvato quando hai attivato la verifica. Ognuno vale una volta."
                      : "Scrivi il codice a sei cifre che vedi adesso nell'app di autenticazione sul telefono."}
                  </p>
                </div>
                <div>
                  <label htmlFor="accesso-codice" className="landing-etichetta">{usaRecupero ? "Codice di recupero" : "Codice"}</label>
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
                  {attesa ? <><span className="landing-girandola" aria-hidden />Verifico</> : "Verifica e accedi"}
                </button>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button type="button" className="landing-link" onClick={() => { setUsaRecupero(!usaRecupero); setCodice(""); setErrore(null); }}>
                    {usaRecupero ? "Usa il codice dell'app" : "Ho perso il telefono: codice di recupero"}
                  </button>
                  <button type="button" className="landing-link" onClick={() => { setBiglietto(null); setErrore(null); }}>
                    Indietro
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={accedi} className="space-y-6">
                <div>
                  <p className="landing-mono flex items-center gap-2" style={{ color: "var(--l-ciano)" }}><LockKeyhole className="h-3.5 w-3.5" aria-hidden />Area riservata</p>
                  <h2 id="landing-accesso-titolo" className="landing-titolo-sezione mt-4" style={{ fontSize: 34 }}>Accedi a Cerbero</h2>
                  <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--l-testo-2)" }}>
                    Con le credenziali che ti ha dato l'amministratore della tua azienda.
                  </p>
                </div>
                <div>
                  <label htmlFor="accesso-email" className="landing-etichetta">Email</label>
                  <input
                    id="accesso-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    placeholder="nome@azienda.it"
                    className="landing-campo"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="accesso-password" className="landing-etichetta">Password</label>
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
                      aria-label={mostra ? "Nascondi la password" : "Mostra la password"}
                      aria-pressed={mostra}
                    >
                      {mostra ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                    </button>
                  </div>
                </div>
                <Errore testo={errore} />
                <button type="submit" className="landing-bottone w-full" disabled={attesa}>
                  {attesa ? <><span className="landing-girandola" aria-hidden />Verifico</> : "Accedi"}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>

        <ul className="space-y-1.5 border-t px-6 py-6 text-[12.5px] sm:px-10" style={{ borderColor: "var(--l-bordo-tenue)", color: "var(--l-testo-3)" }}>
          <li>Connessione cifrata e sessione legata a questo browser.</li>
          <li>Verifica in due passaggi per i ruoli che la richiedono.</li>
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
