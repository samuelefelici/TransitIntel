/**
 * Argos al lavoro, sulla pagina di accesso (tappa 7.36): lo stesso crawler
 * della console (lib/argos-sciame.ts) e, dove la macchina lo regge, la stessa
 * vista 3D a cervello (lib/argos-cervello3d.ts). Gira su una domanda d'esempio
 * e una biblioteca d'esempio (lib/argos-dimostrazione.ts), una domanda dopo
 * l'altra: niente richieste al server, niente dati di un'azienda.
 *
 * Accanto, la chat: la domanda, la risposta che si scrive mentre le parole
 * volano dal crawler, le fonti. Il motore parte solo quando la sezione si vede
 * e si ferma quando esce; la vista 3D si costruisce solo allora e si butta
 * quando la sezione non si vede più. Senza WebGL, o se il 3D è troppo lento,
 * resta il crawler in piano. Con «riduci il movimento» niente ripetizione: la scena
 * ferma e la risposta già scritta.
 */
import { useEffect, useRef, useState } from "react";
import { Bot, Box, User } from "lucide-react";
import { Sciame } from "@/lib/argos-sciame";
import type { Cervello3D } from "@/lib/argos-cervello3d";
import { FASI_DIMOSTRAZIONE, QUANTE_CORSE, corsaDimostrativa, mappaDimostrazione } from "@/lib/argos-dimostrazione";

type Lingua = "it" | "en";

const TESTI = {
  it: { chat: "Argos", esempio: "Domanda d'esempio su una biblioteca d'esempio", fonti: "Fonti", vista3d: "3D", vista2d: "2D", scrive: "Argos sta scrivendo", trascina: "trascina per girare il cervello" },
  en: { chat: "Argos", esempio: "Sample question on a sample library", fonti: "Sources", vista3d: "3D", vista2d: "2D", scrive: "Argos is writing", trascina: "drag to turn the brain" },
} as const;

const attesa = (ms: number, segnale: { fermo: boolean }) => new Promise<void>((ok) => {
  const t0 = performance.now();
  const passo = () => (segnale.fermo || performance.now() - t0 >= ms ? ok() : window.setTimeout(passo, Math.min(120, ms)));
  passo();
});

function prova(f: () => void): void {
  try { f(); } catch (e) { console.warn("argos sulla pagina di accesso:", e); }
}

interface StatoChat { domanda: string; risposta: string; fonti: string[]; finita: boolean }

export default function ArgosInDiretta({ lingua, tema, fermo }: { lingua: Lingua; tema: "scuro" | "chiaro"; fermo: boolean }) {
  const t = TESTI[lingua];
  const guscio = useRef<HTMLDivElement>(null);
  const tela = useRef<HTMLCanvasElement>(null);
  const palco3d = useRef<HTMLDivElement>(null);
  const titoloFase = useRef<HTMLDivElement>(null);
  const motore = useRef<Sciame | null>(null);
  const cervello = useRef<Cervello3D | null>(null);
  const [pronto, setPronto] = useState(false);
  const [visibile, setVisibile] = useState(false);
  const [fase, setFase] = useState(0);
  const [chat, setChat] = useState<StatoChat | null>(null);
  const [vuole3d, setVuole3d] = useState(!fermo);
  const [con3d, setCon3d] = useState(false);
  const [senza3d, setSenza3d] = useState(false);

  /* la sezione si vede? (con un po' di margine, per partire prima) */
  useEffect(() => {
    const el = guscio.current;
    if (!el) return;
    const io = new IntersectionObserver(([v]) => setVisibile(!!v?.isIntersecting), { rootMargin: "120px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* il motore nasce la prima volta che la sezione si vede, e resta */
  useEffect(() => {
    if (!visibile || motore.current || !tela.current) return;
    let m: Sciame;
    try { m = new Sciame(tela.current); } catch (e) { console.warn("crawler non disponibile:", e); return; }
    motore.current = m;
    m.impostaRisposta("destra");
    setPronto(true);
  }, [visibile]);
  useEffect(() => () => { const m = motore.current; motore.current = null; if (m) prova(() => m.distruggi()); }, []);

  /* la mappa d'esempio nella lingua della pagina, il tema della pagina */
  useEffect(() => { const m = motore.current; if (m) prova(() => m.impostaMappa(mappaDimostrazione(lingua))); }, [pronto, lingua]);
  useEffect(() => { const m = motore.current; if (m) prova(() => m.impostaTema(tema === "chiaro")); }, [pronto, tema]);

  /* fuori vista si ferma; le misure seguono il palco; il titolo della fase non si copre */
  useEffect(() => { const m = motore.current; if (m) prova(() => m.pausa(!visibile)); }, [pronto, visibile]);
  useEffect(() => {
    const c = tela.current, ti = titoloFase.current;
    if (!pronto || !c) return;
    const ro = new ResizeObserver(() => {
      const m = motore.current;
      if (!m) return;
      prova(() => m.ridimensiona());
      if (ti) {
        const a = ti.getBoundingClientRect(), b = c.getBoundingClientRect();
        if (a.width > 0 && b.width > 0) prova(() => m.impostaTitolo({ x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }));
      }
    });
    ro.observe(c);
    if (ti) ro.observe(ti);
    return () => ro.disconnect();
  }, [pronto]);

  /* la fase corrente, per la barra e il titolo */
  useEffect(() => {
    if (!pronto || !visibile) return;
    const id = window.setInterval(() => { const m = motore.current; if (m) prova(() => setFase(m.pannelli().fase)); }, 250);
    return () => window.clearInterval(id);
  }, [pronto, visibile]);

  /* la vista 3D: solo quando si vede, si costruisce e si butta */
  useEffect(() => {
    if (!pronto || !visibile || !vuole3d || senza3d || fermo) return;
    const m = motore.current, box = palco3d.current;
    if (!m || !box) return;
    let finito = false, c: Cervello3D | null = null;
    import("@/lib/argos-cervello3d").then((mod) => {
      if (finito) return;
      if (!mod.webglDisponibile()) { setSenza3d(true); return; }
      c = new mod.Cervello3D(box, m, { chiaro: tema === "chiaro", onGuasto: () => { if (!finito) setSenza3d(true); } });
      cervello.current = c;
      m.impostaDisegno(false);
      setCon3d(true);
    }).catch((e) => { console.warn("vista 3D non disponibile:", e); setSenza3d(true); });
    return () => {
      finito = true;
      cervello.current = null;
      if (c) prova(() => c!.distruggi());
      prova(() => m.impostaDisegno(true));
      setCon3d(false);
    };
    /* il tema si passa sotto, senza ricostruire il cervello */
  }, [pronto, visibile, vuole3d, senza3d, fermo]);
  useEffect(() => { const c = cervello.current; if (c) prova(() => c.impostaTema(tema === "chiaro")); }, [tema, con3d]);

  /* le domande d'esempio, una dopo l'altra */
  useEffect(() => {
    if (!pronto) return;
    const m = motore.current;
    if (!m) return;
    if (fermo) {
      const c = corsaDimostrativa(0, lingua);
      setChat({ domanda: c.domanda, risposta: c.risposta, fonti: c.fonti.map((f) => f.document_title), finita: true });
      return;
    }
    if (!visibile) return;
    const segnale = { fermo: false };
    (async () => {
      for (let n = 0; !segnale.fermo; n = (n + 1) % QUANTE_CORSE) {
        const c = corsaDimostrativa(n, lingua);
        setChat({ domanda: c.domanda, risposta: "", fonti: [], finita: false });
        prova(() => m.avvia(c.domanda));
        await attesa(900, segnale); if (segnale.fermo) return;
        for (const s of c.strumenti) prova(() => m.evento({ tool: { name: s } }));
        prova(() => m.evento({ trace: c.traccia }));
        /* la ricerca si guarda: la risposta arriva quando il crawler è alla fase della risposta */
        for (let i = 0; i < 80 && !segnale.fermo; i++) {
          let f = 0;
          prova(() => { f = m.pannelli().fase; });
          if (f >= 6) break;
          await attesa(150, segnale);
        }
        const pezzi = c.risposta.split(/(\s+)/);
        let scritto = "";
        for (const p of pezzi) {
          if (segnale.fermo) return;
          scritto += p;
          prova(() => m.evento({ t: p }));
          setChat((x) => (x ? { ...x, risposta: scritto } : x));
          if (p.trim()) await attesa(85, segnale);
        }
        prova(() => m.evento({ trace: c.verifica }));
        prova(() => m.evento({ done: { tokens: 900 + n * 140 }, sources: c.fonti }));
        prova(() => m.fine("done"));
        setChat((x) => (x ? { ...x, fonti: c.fonti.map((f) => f.document_title), finita: true } : x));
        for (let i = 0; i < 60 && !segnale.fermo; i++) {
          let fatto = false;
          prova(() => { fatto = m.pannelli().finito; });
          if (fatto) break;
          await attesa(250, segnale);
        }
        await attesa(5500, segnale);
      }
    })();
    return () => { segnale.fermo = true; };
  }, [pronto, visibile, lingua, fermo]);

  const f = FASI_DIMOSTRAZIONE[Math.min(Math.max(fase, 0), FASI_DIMOSTRAZIONE.length - 1)]!;

  return (
    <div ref={guscio} className="landing-argos-studio">
      {/* la barra delle fasi */}
      <div className="landing-argos-barra">
        <span className="landing-argos-marchio"><Bot className="h-3.5 w-3.5" aria-hidden />ARGOS · multi-agent RAG</span>
        <ol className="landing-argos-fasi" aria-label="Pipeline">
          {FASI_DIMOSTRAZIONE.map((x, i) => (
            <li key={x.nome} data-stato={i === fase ? "ora" : i < fase ? "fatta" : "dopo"}>{x.nome}</li>
          ))}
        </ol>
        {!senza3d && !fermo && (
          <button type="button" className="landing-argos-vista" onClick={() => setVuole3d((v) => !v)} aria-pressed={vuole3d}>
            <Box className="h-3.5 w-3.5" aria-hidden />{vuole3d ? t.vista2d : t.vista3d}
          </button>
        )}
      </div>

      <div className="landing-argos-corpo">
        {/* il palco: il crawler in piano, e sopra la vista 3D */}
        <div className="landing-argos-palco">
          <canvas ref={tela} className="absolute inset-0 block h-full w-full" aria-hidden />
          <div ref={palco3d} className={`absolute inset-0 overflow-hidden ${con3d ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"}`} />
          <div ref={titoloFase} className="landing-argos-titolo" aria-live="polite">
            <b>{String(fase + 1).padStart(2, "0")} {f.nome}</b>
            <span>{f.frase[lingua]}</span>
          </div>
          {con3d && <span className="landing-argos-aiuto landing-mono">{t.trascina}</span>}
        </div>

        {/* la chat d'esempio */}
        <aside className="landing-argos-chat" aria-label={t.chat}>
          <div className="landing-argos-chat-testa landing-mono"><span className="landing-argos-vivo" aria-hidden />{t.esempio}</div>
          {chat && (
            <div className="landing-argos-chat-corpo">
              <div className="landing-argos-msg landing-argos-msg-io">
                <span className="landing-argos-avatar" aria-hidden><User className="h-3.5 w-3.5" /></span>
                <p>{chat.domanda}</p>
              </div>
              <div className="landing-argos-msg">
                <span className="landing-argos-avatar landing-argos-avatar-argos" aria-hidden><Bot className="h-3.5 w-3.5" /></span>
                <div>
                  {chat.risposta
                    ? <p>{chat.risposta.split(/((?:\[\d\])+)/).map((p, i) => (/^(\[\d\])+$/.test(p) ? <sup key={i}>{p.match(/\d/g)!.join(",")}</sup> : <span key={i}>{p}</span>))}{!chat.finita && <span className="landing-argos-cursore" aria-hidden />}</p>
                    : <p className="landing-argos-attesa" aria-label={t.scrive}><span /><span /><span /></p>}
                  {chat.finita && chat.fonti.length > 0 && (
                    <div className="landing-argos-fonti">
                      <span className="landing-mono">{t.fonti}</span>
                      <ol>{chat.fonti.map((x, i) => <li key={x}><sup>{i + 1}</sup>{x}</li>)}</ol>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
