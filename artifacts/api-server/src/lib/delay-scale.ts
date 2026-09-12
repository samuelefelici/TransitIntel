/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA SCALA DEL RITARDO: ROSSO → VERDE → BLU
 * ───────────────────────────────────────────────────────────────────────────
 * Un colore per ogni scarto dall'orario: rosso il ritardo, verde l'orario
 * esatto, blu l'anticipo. Serve alla mappa, alla tabella delle fermate e ai
 * marcatori dei mezzi — e deve essere UNA, perché tre definizioni della stessa
 * scala divergono al primo ritocco e fanno sembrare in ritardo sulla mappa un
 * mezzo che la tabella accanto dichiara in orario.
 *
 * Per questo la scala sta qui, dalla parte del server, ed è il server a dire
 * di che colore va disegnata ogni cosa. Non è una scelta di stile: dove passa
 * il confine fra "in orario" e "in ritardo" è una convenzione di esercizio,
 * la stessa su cui si calcola la puntualità.
 *
 * ── Perché la scala non è simmetrica ──
 *
 * I ritardi arrivano a un quarto d'ora, gli anticipi quasi mai oltre i cinque
 * minuti: una scala simmetrica sprecherebbe metà dei colori e schiaccerebbe
 * tutti i ritardi veri sullo stesso rosso.
 *
 * ── E perché il blu NON vuol dire "meglio" ──
 *
 * Un mezzo in anticipo è un guasto di servizio più grave di un piccolo
 * ritardo: chi arriva alla fermata all'ora giusta lo trova già passato. Il blu
 * è freddo, non buono — e l'etichetta lo dice a parole, perché il colore da
 * solo non basta a dirlo.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Oltre questo scarto si è in ritardo (convenzione TPL, come la puntualità). */
export const SOGLIA_RITARDO_S = 300;
/** Sotto questo scarto si è in anticipo. */
export const SOGLIA_ANTICIPO_S = -60;

/** Il grigio di "non si sa": mai usato per uno scarto vero. */
export const COLORE_IGNOTO = "#64748b";

/* I capisaldi della scala. Fra due capisaldi il colore si interpola; oltre
 * gli estremi resta quello dell'estremo — un ritardo di mezz'ora non deve
 * "ricominciare" da un altro colore. */
interface Caposaldo { sec: number; colore: string }

export const CAPISALDI: Caposaldo[] = [
  { sec: -300, colore: "#1e3a8a" }, // blu scuro: cinque minuti avanti
  { sec: -180, colore: "#3b82f6" }, // blu
  { sec: -60, colore: "#22d3ee" },  // ciano: la soglia dell'anticipo
  { sec: 0, colore: "#10b981" },    // verde: orario esatto
  { sec: 60, colore: "#a3e635" },   // lime: ancora dentro
  { sec: 300, colore: "#f59e0b" },  // ambra: la soglia del ritardo
  { sec: 600, colore: "#ef4444" },  // rosso
  { sec: 900, colore: "#7f1d1d" },  // rosso scuro: un quarto d'ora
];

function daEsadecimale(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function aEsadecimale(r: number, g: number, b: number): string {
  const h = (x: number) => Math.round(Math.min(255, Math.max(0, x)))
    .toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Il colore di uno scarto, interpolato fra i capisaldi. */
export function coloreRitardo(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return COLORE_IGNOTO;
  const primo = CAPISALDI[0], ultimo = CAPISALDI[CAPISALDI.length - 1];
  if (sec <= primo.sec) return primo.colore;
  if (sec >= ultimo.sec) return ultimo.colore;
  for (let i = 1; i < CAPISALDI.length; i++) {
    const a = CAPISALDI[i - 1], b = CAPISALDI[i];
    if (sec > b.sec) continue;
    const t = (sec - a.sec) / (b.sec - a.sec);
    const [ar, ag, ab] = daEsadecimale(a.colore);
    const [br, bg, bb] = daEsadecimale(b.colore);
    return aEsadecimale(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
  }
  return ultimo.colore;
}

export type StatoScarto = "anticipo" | "orario" | "ritardo" | "ignoto";

export function statoScarto(sec: number | null | undefined): StatoScarto {
  if (sec == null || !Number.isFinite(sec)) return "ignoto";
  if (sec > SOGLIA_RITARDO_S) return "ritardo";
  if (sec < SOGLIA_ANTICIPO_S) return "anticipo";
  return "orario";
}

/** "+2'30\"" / "-1'05\"" / "in orario" — la forma corta, per le tabelle. */
export function fmtScarto(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const segno = sec < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(sec));
  return `${segno}${Math.floor(abs / 60)}'${String(abs % 60).padStart(2, "0")}"`;
}

/** La frase per esteso: un colore da solo non dice che l'anticipo è un guasto. */
export function etichettaScarto(sec: number | null | undefined): string {
  const st = statoScarto(sec);
  if (st === "ignoto") return "Scarto non noto";
  const abs = Math.abs(Math.round(sec!));
  const m = Math.floor(abs / 60), s = abs % 60;
  const durata = m > 0 ? `${m}'${String(s).padStart(2, "0")}"` : `${s}"`;
  if (st === "ritardo") return `In ritardo di ${durata}`;
  if (st === "anticipo") return `In anticipo di ${durata} — passa prima di chi lo aspetta`;
  if (Math.round(sec!) === 0) return "In orario esatto";
  return sec! > 0 ? `In orario (${durata} di ritardo)` : `In orario (${durata} di anticipo)`;
}

export interface TintaRitardo {
  colore: string;
  stato: StatoScarto;
  etichetta: string;
  scarto: string;
}

export function tintaRitardo(sec: number | null | undefined): TintaRitardo {
  return {
    colore: coloreRitardo(sec),
    stato: statoScarto(sec),
    etichetta: etichettaScarto(sec),
    scarto: fmtScarto(sec),
  };
}

/**
 * La legenda, pronta da disegnare. Esce dal server insieme ai dati perché
 * altrimenti la legenda e i colori che spiega sarebbero due cose diverse, e
 * basta ritoccare un caposaldo perché la legenda menta.
 */
export function legendaRitardo(): {
  tacche: Array<{ sec: number; colore: string; etichetta: string }>;
  sogliaRitardoSec: number;
  sogliaAnticipoSec: number;
  nota: string;
} {
  return {
    tacche: CAPISALDI.map(c => ({
      sec: c.sec, colore: c.colore,
      etichetta: c.sec === 0 ? "in orario" : fmtScarto(c.sec),
    })),
    sogliaRitardoSec: SOGLIA_RITARDO_S,
    sogliaAnticipoSec: SOGLIA_ANTICIPO_S,
    nota: "Rosso il ritardo, verde l'orario, blu l'anticipo. Il blu non vuol dire "
      + "«meglio»: un mezzo in anticipo passa prima di chi lo aspetta, ed è un guasto "
      + "di servizio più grave di un piccolo ritardo.",
  };
}
