/**
 * La pagina di accesso (tappa 7.33).
 *
 * A sinistra che cos'è Cerbero: il ciclo del lavoro dell'azienda, dal
 * programma al consuntivo del mese (lib/accesso.ts), e quello che gli sta
 * accanto. A destra l'accesso: email e password, poi, se è attiva, la
 * verifica in due passaggi con il codice dell'app o un codice di recupero.
 *
 * La logica è quella di prima (hooks/use-auth.tsx): dopo un accesso riuscito
 * la pagina mostra una conferma breve e poi avvisa l'app con l'evento
 * «auth:login-sequence-done», che smonta il login e apre la pagina chiesta.
 * Il fondo è una griglia in prospettiva in WebGL; i colori seguono il tema
 * chiaro o scuro (styles/accesso.css).
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { AlertTriangle, Eye, EyeOff, KeyRound, LockKeyhole } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTema } from "@/hooks/use-tema";
import { SceltaTemaCompatta } from "@/components/layout/SceltaTema";
import GrigliaProspettica from "@/components/accesso/GrigliaProspettica";
import { ACCANTO, CICLO, codiceCompleto, nomeDiBenvenuto, saluto } from "@/lib/accesso";
import logoImg from "/logosidebar.png";
import "@/styles/accesso.css";

const CARATTERI = "https://fonts.googleapis.com/css2?family=Mona+Sans:wght@300..800&family=Reddit+Mono:wght@400..600&display=swap";

/** I caratteri della pagina, solo quando la pagina c'è. */
function useCaratteri() {
  useEffect(() => {
    if (document.querySelector(`link[data-caratteri="accesso"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = CARATTERI;
    l.dataset.caratteri = "accesso";
    document.head.appendChild(l);
  }, []);
}

export default function LoginPage() {
  const { login, loginMfa, user } = useAuth();
  const { tema } = useTema();
  const fermo = useReducedMotion() ?? false;
  useCaratteri();

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
  const [entrato, setEntrato] = useState(false);
  const [scossa, setScossa] = useState(0);

  const sbagliato = useCallback((messaggio: string) => {
    setAttesa(false);
    setErrore(messaggio);
    setScossa((n) => n + 1);
  }, []);

  /* accesso riuscito: una conferma breve, poi l'app (che aspetta questo evento per smontare il login).
   * Il timer non si annulla: anche se la pagina sparisse prima, l'app deve ricevere l'evento. */
  const conferma = useCallback(() => {
    setAttesa(false);
    setEntrato(true);
    window.setTimeout(() => {
      window.dispatchEvent(new Event("auth:login-sequence-done"));
    }, fermo ? 350 : 1500);
  }, [fermo]);

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
    conferma();
  }, [login, email, password, sbagliato, conferma]);

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
    conferma();
  }, [biglietto, codice, usaRecupero, loginMfa, sbagliato, conferma]);

  const entra = (ritardo: number) => fermo
    ? { initial: false as const }
    : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay: ritardo, ease: [0.2, 0.7, 0.2, 1] as const } };

  const anno = new Date().getFullYear();

  return (
    <div className="accesso">
      <div className="accesso-fondo" aria-hidden />
      <GrigliaProspettica tema={tema} />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] max-w-[1440px] flex-col px-4 sm:px-8 lg:px-14">
        <header className="flex items-center justify-between py-6">
          <div className="flex items-center gap-3">
            <img src={logoImg} alt="" className="h-9 w-auto" />
            <div className="leading-tight">
              <div className="text-[15px] font-semibold tracking-[0.18em]">CERBERO</div>
              <div className="accesso-etichetta" style={{ fontSize: 10, letterSpacing: "1.4px" }}>Transportation management</div>
            </div>
          </div>
          <SceltaTemaCompatta />
        </header>

        <main className="grid flex-1 items-start gap-12 pb-12 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,430px)] lg:gap-16 lg:pt-10">
          {/* ── Che cos'è Cerbero ─────────────────────────────────────────── */}
          <section className="order-2 min-w-0 lg:order-1" aria-labelledby="accesso-titolo">
            <motion.p {...entra(0.05)} className="accesso-etichetta">Piattaforma per il trasporto pubblico locale</motion.p>
            <motion.h1 {...entra(0.12)} id="accesso-titolo" className="accesso-titolo mt-5">
              Il servizio,<br />dal piano <em>alla strada</em>
            </motion.h1>
            <motion.p {...entra(0.22)} className="accesso-tesi mt-6">
              Rete, turni, personale ed esercizio in un unico sistema: quello che si programma è quello che si pubblica,
              si assegna, si guida e si rendiconta a fine mese.
            </motion.p>

            <motion.div {...entra(0.32)} className="mt-12">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 className="accesso-etichetta">Il ciclo del lavoro</h2>
                <span className="accesso-etichetta hidden sm:inline" style={{ color: "var(--a-testo-3)" }}>dal programma al consuntivo</span>
              </div>
              <ol className="accesso-ciclo">
                {CICLO.map((t) => (
                  <li key={t.numero} className="accesso-tappa">
                    <span className="accesso-tappa-numero">{t.numero}</span>
                    <h3>{t.titolo}</h3>
                    <p>{t.testo}</p>
                  </li>
                ))}
              </ol>
            </motion.div>

            <motion.div {...entra(0.42)} className="mt-10">
              <h2 className="accesso-etichetta mb-4">Accanto, tutto l'anno</h2>
              <dl className="accesso-accanto">
                {ACCANTO.map((a) => (
                  <div key={a.titolo}>
                    <dt>{a.titolo}</dt>
                    <dd>{a.testo}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          </section>

          {/* ── L'accesso ─────────────────────────────────────────────────── */}
          <section className="order-1 lg:sticky lg:top-10 lg:order-2" aria-label="Accesso">
            <motion.div {...entra(0.18)}>
              <motion.div
                key={scossa}
                animate={scossa && !fermo ? { x: [0, -8, 8, -6, 6, 0] } : undefined}
                transition={{ duration: 0.45 }}
                className="accesso-guscio"
              >
                <div className="accesso-carta">
                  {biglietto ? (
                    <form onSubmit={verifica} className="space-y-5" aria-describedby="accesso-codice-aiuto" noValidate>
                      <div>
                        <p className="accesso-etichetta flex items-center gap-2"><KeyRound className="h-3.5 w-3.5" aria-hidden />Secondo passaggio</p>
                        <h2 className="mt-3 text-[26px] font-semibold tracking-[-0.02em]">Verifica in due passaggi</h2>
                        <p id="accesso-codice-aiuto" className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--a-testo-2)" }}>
                          {usaRecupero
                            ? "Scrivi uno dei codici di recupero che hai salvato quando hai attivato la verifica. Ognuno vale una volta."
                            : "Scrivi il codice a sei cifre che vedi adesso nell'app di autenticazione sul telefono."}
                        </p>
                      </div>
                      <div>
                        <label htmlFor="accesso-codice" className="accesso-etichetta mb-2 block">{usaRecupero ? "Codice di recupero" : "Codice"}</label>
                        <input
                          id="accesso-codice"
                          value={codice}
                          onChange={(e) => setCodice(e.target.value)}
                          inputMode={usaRecupero ? "text" : "numeric"}
                          autoComplete="one-time-code"
                          autoFocus
                          maxLength={usaRecupero ? 12 : 7}
                          placeholder={usaRecupero ? "XXXXX-XXXXX" : "000000"}
                          className="accesso-campo accesso-campo-codice"
                          required
                        />
                      </div>
                      <Errore testo={errore} />
                      <button type="submit" className="accesso-bottone" disabled={attesa || (!usaRecupero && !codiceCompleto(codice)) || (usaRecupero && codice.trim().length < 6)}>
                        {attesa ? <><span className="accesso-girandola" aria-hidden />Verifico</> : "Verifica e accedi"}
                      </button>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <button type="button" className="accesso-link" onClick={() => { setUsaRecupero(!usaRecupero); setCodice(""); setErrore(null); }}>
                          {usaRecupero ? "Usa il codice dell'app" : "Ho perso il telefono: codice di recupero"}
                        </button>
                        <button type="button" className="accesso-link" onClick={() => { setBiglietto(null); setErrore(null); }}>
                          Indietro
                        </button>
                      </div>
                    </form>
                  ) : (
                    <form onSubmit={accedi} className="space-y-5">
                      <div>
                        <p className="accesso-etichetta flex items-center gap-2"><LockKeyhole className="h-3.5 w-3.5" aria-hidden />Area riservata</p>
                        <h2 className="mt-3 text-[26px] font-semibold tracking-[-0.02em]">Accedi a Cerbero</h2>
                        <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--a-testo-2)" }}>
                          Con le credenziali che ti ha dato l'amministratore della tua azienda.
                        </p>
                      </div>
                      <div>
                        <label htmlFor="accesso-email" className="accesso-etichetta mb-2 block">Email</label>
                        <input
                          id="accesso-email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          autoComplete="username"
                          autoFocus
                          placeholder="nome@azienda.it"
                          className="accesso-campo"
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="accesso-password" className="accesso-etichetta mb-2 block">Password</label>
                        <div className="relative">
                          <input
                            id="accesso-password"
                            type={mostra ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                            className="accesso-campo pr-12"
                            required
                          />
                          <button
                            type="button"
                            onClick={() => setMostra(!mostra)}
                            className="accesso-icona absolute right-1 top-1/2 -translate-y-1/2"
                            aria-label={mostra ? "Nascondi la password" : "Mostra la password"}
                            aria-pressed={mostra}
                          >
                            {mostra ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                          </button>
                        </div>
                      </div>
                      <Errore testo={errore} />
                      <button type="submit" className="accesso-bottone" disabled={attesa}>
                        {attesa ? <><span className="accesso-girandola" aria-hidden />Verifico</> : "Accedi"}
                      </button>
                    </form>
                  )}

                  <div className="accesso-filo mt-7" />
                  <ul className="mt-4 space-y-1.5 text-[12.5px]" style={{ color: "var(--a-testo-3)" }}>
                    <li>Connessione cifrata e sessione legata a questo browser.</li>
                    <li>Verifica in due passaggi per i ruoli che la richiedono.</li>
                  </ul>
                </div>
              </motion.div>
            </motion.div>
          </section>
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t py-5" style={{ borderColor: "var(--a-bordo-tenue)" }}>
          <span className="accesso-etichetta" style={{ color: "var(--a-testo-3)" }}>© {anno} Cerbero</span>
          <span className="accesso-etichetta" style={{ color: "var(--a-testo-3)" }}>Accesso riservato al personale autorizzato</span>
        </footer>
      </div>

      <AnimatePresence>
        {entrato && (
          <motion.div
            className="accesso-conferma"
            role="status"
            aria-live="polite"
            initial={fermo ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35 }}
          >
            <div className="text-center">
              <svg width="56" height="56" viewBox="0 0 56 56" className="mx-auto" aria-hidden>
                <circle cx="28" cy="28" r="26" fill="none" stroke="var(--a-bordo)" strokeWidth="1" />
                <motion.path
                  d="M17 29 L25 37 L40 20"
                  fill="none"
                  stroke="var(--a-menta)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={fermo ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
                />
              </svg>
              <p className="accesso-etichetta mt-6">Accesso confermato</p>
              <p className="mt-3 text-[34px] font-semibold tracking-[-0.02em]">
                {saluto(nomeDiBenvenuto(user?.fullName, user?.email ?? email))}
              </p>
              <div className="accesso-conferma-barra mx-auto mt-6"><span /></div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Errore({ testo }: { testo: string | null }) {
  return (
    <div aria-live="assertive">
      {testo && (
        <div role="alert" className="accesso-errore">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{testo}</span>
        </div>
      )}
    </div>
  );
}
