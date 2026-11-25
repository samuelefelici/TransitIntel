/**
 * Argos come sfondo della sua sezione (tappe 7.36 e 7.37): il cervello 3D
 * della console (lib/argos-cervello3d.ts) a tutto schermo, guidato dallo
 * stesso crawler (lib/argos-sciame.ts) su domande d'esempio e una biblioteca
 * d'esempio (lib/argos-dimostrazione.ts), una dopo l'altra. La telecamera
 * segue di poco il mouse. Niente chat: in un angolo solo la fase e la domanda
 * d'esempio, per dire che cosa sta facendo.
 *
 * Il motore parte solo quando la sezione si vede e si ferma quando esce; il
 * 3D si costruisce solo allora e si butta quando la sezione non si vede più.
 * Il 3D è per gli schermi larghi, come nella console; sul telefono o senza
 * WebGL resta il crawler in piano, che si sposta anche lui di poco col mouse.
 * Se il 3D si ferma perché il computer è troppo lento, lo sfondo resta fermo:
 * il crawler in piano a tutto schermo lì sarebbe ancora più pesante. Con
 * «riduci il movimento» la scena è ferma. Niente richieste al server, niente
 * dati di un'azienda.
 */
import { useEffect, useRef, useState } from "react";
import { Sciame } from "@/lib/argos-sciame";
import type { Cervello3D } from "@/lib/argos-cervello3d";
import { FASI_DIMOSTRAZIONE, QUANTE_CORSE, corsaDimostrativa, mappaDimostrazione } from "@/lib/argos-dimostrazione";

type Lingua = "it" | "en";

const ESEMPIO: Record<Lingua, string> = { it: "Domanda d'esempio", en: "Sample question" };

const attesa = (ms: number, segnale: { fermo: boolean }) => new Promise<void>((ok) => {
  const t0 = performance.now();
  const passo = () => (segnale.fermo || performance.now() - t0 >= ms ? ok() : window.setTimeout(passo, Math.min(120, ms)));
  passo();
});

function prova(f: () => void): void {
  try { f(); } catch (e) { console.warn("argos sulla pagina di accesso:", e); }
}

export default function ArgosSfondo({ lingua, tema, fermo }: { lingua: Lingua; tema: "scuro" | "chiaro"; fermo: boolean }) {
  const guscio = useRef<HTMLDivElement>(null);
  const tela = useRef<HTMLCanvasElement>(null);
  const palco3d = useRef<HTMLDivElement>(null);
  const motore = useRef<Sciame | null>(null);
  const cervello = useRef<Cervello3D | null>(null);
  const [pronto, setPronto] = useState(false);
  const [visibile, setVisibile] = useState(false);
  const [con3d, setCon3d] = useState(false);
  const [senza3d, setSenza3d] = useState(false);
  /* il 3D si è fermato perché il computer è lento: lo sfondo resta fermo, la pagina resta leggera */
  const [lento, setLento] = useState(false);
  const [fase, setFase] = useState(0);
  const [domanda, setDomanda] = useState("");

  /* la sezione si vede? (con un po' di margine, per partire prima) */
  useEffect(() => {
    const el = guscio.current;
    if (!el) return;
    const io = new IntersectionObserver(([v]) => setVisibile(!!v?.isIntersecting), { rootMargin: "160px 0px" });
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

  /* la biblioteca d'esempio nella lingua della pagina, il tema della pagina */
  useEffect(() => { const m = motore.current; if (m) prova(() => m.impostaMappa(mappaDimostrazione(lingua))); }, [pronto, lingua]);
  useEffect(() => {
    const m = motore.current;
    if (m) prova(() => m.impostaTema(tema === "chiaro"));
    const c = cervello.current;
    if (c) prova(() => c.impostaTema(tema === "chiaro"));
  }, [pronto, tema, con3d]);

  /* fuori vista si ferma; le misure seguono la sezione */
  useEffect(() => { const m = motore.current; if (m) prova(() => m.pausa(!visibile || lento)); }, [pronto, visibile, lento]);
  useEffect(() => {
    const c = tela.current;
    if (!pronto || !c) return;
    const ro = new ResizeObserver(() => {
      const m = motore.current;
      if (m) prova(() => m.ridimensiona());
      const c3 = cervello.current;
      if (c3) prova(() => c3.ridimensiona());
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [pronto]);

  /* la fase corrente, per la didascalia */
  useEffect(() => {
    if (!pronto || !visibile) return;
    const id = window.setInterval(() => { const m = motore.current; if (m) prova(() => setFase(m.pannelli().fase)); }, 300);
    return () => window.clearInterval(id);
  }, [pronto, visibile]);

  /* il cervello 3D: solo quando la sezione si vede, si costruisce e si butta.
   * Come nella console, solo sugli schermi larghi: sul telefono resta il crawler in piano. */
  useEffect(() => {
    if (!pronto || !visibile || senza3d || fermo) return;
    if (!window.matchMedia?.("(min-width: 1024px)").matches) return;
    const m = motore.current, box = palco3d.current;
    if (!m || !box) return;
    let finito = false, c: Cervello3D | null = null;
    import("@/lib/argos-cervello3d").then((mod) => {
      if (finito) return;
      if (!mod.webglDisponibile()) { setSenza3d(true); return; }
      c = new mod.Cervello3D(box, m, {
        chiaro: tema === "chiaro",
        onGuasto: (perche) => { if (finito) return; setSenza3d(true); if (perche === "lento") setLento(true); },
      });
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
    /* il tema passa sotto, senza ricostruire il cervello */
  }, [pronto, visibile, senza3d, fermo]);

  /* segue il mouse: in 3D gira la telecamera; in piano il disegno si sposta di poco */
  useEffect(() => {
    if (!pronto || !visibile || fermo || lento) return;
    let x = 0, y = 0, id = 0;
    const applica = () => {
      id = 0;
      const c = cervello.current, piano = tela.current;
      if (c) prova(() => c.impostaSguardo(x, y));
      if (piano) piano.style.transform = con3d ? "" : `translate3d(${(-x * 16).toFixed(1)}px, ${(-y * 10).toFixed(1)}px, 0) scale(1.04)`;
    };
    const segui = (e: PointerEvent) => {
      x = (e.clientX / window.innerWidth - 0.5) * 2;
      y = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!id) id = requestAnimationFrame(applica);
    };
    window.addEventListener("pointermove", segui, { passive: true });
    return () => { window.removeEventListener("pointermove", segui); if (id) cancelAnimationFrame(id); };
  }, [pronto, visibile, fermo, con3d, lento]);

  /* le domande d'esempio, una dopo l'altra */
  useEffect(() => {
    if (!pronto) return;
    const m = motore.current;
    if (!m) return;
    if (fermo || lento) { setDomanda(corsaDimostrativa(0, lingua).domanda); return; }
    if (!visibile) return;
    const segnale = { fermo: false };
    (async () => {
      for (let n = 0; !segnale.fermo; n = (n + 1) % QUANTE_CORSE) {
        const c = corsaDimostrativa(n, lingua);
        setDomanda(c.domanda);
        prova(() => m.avvia(c.domanda));
        await attesa(900, segnale); if (segnale.fermo) return;
        for (const s of c.strumenti) prova(() => m.evento({ tool: { name: s } }));
        prova(() => m.evento({ trace: c.traccia }));
        /* la risposta arriva quando il crawler è alla fase della risposta */
        for (let i = 0; i < 80 && !segnale.fermo; i++) {
          let f = 0;
          prova(() => { f = m.pannelli().fase; });
          if (f >= 6) break;
          await attesa(150, segnale);
        }
        for (const p of c.risposta.split(/(\s+)/)) {
          if (segnale.fermo) return;
          prova(() => m.evento({ t: p }));
          if (p.trim()) await attesa(85, segnale);
        }
        prova(() => m.evento({ trace: c.verifica }));
        prova(() => m.evento({ done: { tokens: 900 + n * 140 }, sources: c.fonti }));
        prova(() => m.fine("done"));
        for (let i = 0; i < 60 && !segnale.fermo; i++) {
          let fatto = false;
          prova(() => { fatto = m.pannelli().finito; });
          if (fatto) break;
          await attesa(250, segnale);
        }
        await attesa(4500, segnale);
      }
    })();
    return () => { segnale.fermo = true; };
  }, [pronto, visibile, lingua, fermo, lento]);

  const f = FASI_DIMOSTRAZIONE[Math.min(Math.max(fase, 0), FASI_DIMOSTRAZIONE.length - 1)]!;

  return (
    <div ref={guscio} className="landing-argos-sfondo" aria-hidden>
      {/* resta fermo sullo schermo mentre si scorre la sezione: è lo sfondo */}
      <div className="landing-argos-fisso">
        <canvas ref={tela} className="landing-argos-piano" />
        <div ref={palco3d} className="landing-argos-3d" />
        {domanda && (
          <div className="landing-argos-didascalia landing-mono">
            <span className="landing-argos-fase"><span className="landing-argos-vivo" />{String(fase + 1).padStart(2, "0")} {f.nome} · {f.frase[lingua]}</span>
            <span className="landing-argos-domanda">{ESEMPIO[lingua]} · «{domanda}»</span>
          </div>
        )}
      </div>
    </div>
  );
}
