/**
 * ═══════════════════════════════════════════════════════════════════════════
 * La scala del ritardo — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Una scala di colori sbagliata non dà errore: dà una mappa. Qui si fissano le
 * sole cose che un occhio non può verificare da solo — che il verso sia quello
 * giusto (rosso = ritardo, blu = anticipo, e non il contrario), che agli
 * estremi non ricominci da capo, e che il grigio resti riservato a "non si sa".
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  coloreRitardo, statoScarto, fmtScarto, etichettaScarto, legendaRitardo,
  COLORE_IGNOTO, SOGLIA_RITARDO_S, SOGLIA_ANTICIPO_S, CAPISALDI,
} from "../lib/delay-scale";

const rosso = (c: string) => parseInt(c.slice(1, 3), 16);
const verde = (c: string) => parseInt(c.slice(3, 5), 16);
const blu = (c: string) => parseInt(c.slice(5, 7), 16);

/** Tinta in gradi, 0 = rosso, 120 = verde, 240 = blu. */
function tinta(c: string): number {
  const r = rosso(c) / 255, g = verde(c) / 255, b = blu(c) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/** Quanto è chiaro, 0..1. */
const luce = (c: string) => (rosso(c) + verde(c) + blu(c)) / 765;

describe("il verso della scala", () => {
  it("in orario è verde", () => {
    const c = coloreRitardo(0);
    expect(verde(c)).toBeGreaterThan(rosso(c));
    expect(verde(c)).toBeGreaterThan(blu(c));
  });

  it("il ritardo va verso il rosso, l'anticipo verso il blu", () => {
    const tardi = coloreRitardo(700);
    const presto = coloreRitardo(-240);
    expect(rosso(tardi)).toBeGreaterThan(blu(tardi));
    expect(blu(presto)).toBeGreaterThan(rosso(presto));
  });

  /* Il verso è la sola cosa che, se invertita, produce comunque una mappa
   * plausibile: tutti i colori ci sono, solo sui mezzi sbagliati.
   *
   * La proprietà da fissare NON è "il canale rosso cresce" — l'ambra è più
   * chiara del rosso e quel canale scende, pur essendo l'ambra più vicina
   * all'orario. È la TINTA che non deve mai risalire, dal blu al verde al
   * rosso: è quella che l'occhio legge come "di quanto si sta sbagliando". */
  it("la tinta scende sempre, dal blu al verde al rosso", () => {
    let precedente = Infinity;
    for (let s = -400; s <= 1000; s += 10) {
      const h = tinta(coloreRitardo(s));
      expect(h).toBeLessThanOrEqual(precedente + 0.5); // mezzo grado di tolleranza
      precedente = h;
    }
  });

  /* Arrivati al rosso la tinta non può scendere oltre: da lì in poi il
   * peggioramento si dice scurendo, altrimenti un quarto d'ora di ritardo
   * sarebbe indistinguibile da dieci minuti. */
  it("oltre il rosso continua a peggiorare scurendo", () => {
    expect(tinta(coloreRitardo(600))).toBeCloseTo(tinta(coloreRitardo(900)), 0);
    expect(luce(coloreRitardo(900))).toBeLessThan(luce(coloreRitardo(600)));
  });

  it("più si è in anticipo più il blu domina", () => {
    const scarti = [-60, -180, -300].map(s => coloreRitardo(s));
    for (const c of scarti) expect(blu(c)).toBeGreaterThan(verde(c) * 0.5);
    expect(rosso(scarti[2])).toBeLessThan(rosso(scarti[0]));
  });
});

describe("gli estremi e il mezzo", () => {
  it("interpola fra due capisaldi invece di saltare", () => {
    const a = coloreRitardo(0), m = coloreRitardo(30), b = coloreRitardo(60);
    expect(m).not.toBe(a);
    expect(m).not.toBe(b);
    expect(rosso(m)).toBeGreaterThan(rosso(a));
    expect(rosso(m)).toBeLessThan(rosso(b));
  });

  /* Oltre l'ultimo caposaldo il colore resta quello: senza il blocco, mezz'ora
   * di ritardo "ricomincerebbe" da un altro colore e sembrerebbe meno grave. */
  it("oltre gli estremi resta fermo invece di ricominciare", () => {
    expect(coloreRitardo(900)).toBe(coloreRitardo(5_000));
    expect(coloreRitardo(-300)).toBe(coloreRitardo(-5_000));
  });

  it("ogni caposaldo dà esattamente il suo colore", () => {
    for (const c of CAPISALDI) expect(coloreRitardo(c.sec)).toBe(c.colore);
  });
});

describe("quando non si sa", () => {
  it("il grigio è riservato all'assenza di dato", () => {
    expect(coloreRitardo(null)).toBe(COLORE_IGNOTO);
    expect(coloreRitardo(undefined)).toBe(COLORE_IGNOTO);
    expect(coloreRitardo(NaN)).toBe(COLORE_IGNOTO);
    expect(statoScarto(null)).toBe("ignoto");
  });

  /* Il grigio non deve MAI uscire da uno scarto vero: se uscisse, una corsa
   * regolarissima si mescolerebbe a quelle senza dati. */
  it("nessuno scarto vero produce il grigio", () => {
    for (let s = -1200; s <= 2400; s += 7) {
      expect(coloreRitardo(s)).not.toBe(COLORE_IGNOTO);
    }
  });
});

describe("le soglie e le parole", () => {
  it("le soglie sono quelle della puntualità: da -1' a +5'", () => {
    expect(SOGLIA_ANTICIPO_S).toBe(-60);
    expect(SOGLIA_RITARDO_S).toBe(300);
    expect(statoScarto(300)).toBe("orario");
    expect(statoScarto(301)).toBe("ritardo");
    expect(statoScarto(-60)).toBe("orario");
    expect(statoScarto(-61)).toBe("anticipo");
  });

  it("lo scarto si legge in minuti e secondi, col segno", () => {
    expect(fmtScarto(150)).toBe('+2\'30"');
    expect(fmtScarto(-65)).toBe('-1\'05"');
    expect(fmtScarto(0)).toBe('+0\'00"');
    expect(fmtScarto(null)).toBe("—");
  });

  /* Il colore da solo non può dire che l'anticipo è un guasto: il blu è
   * freddo, e freddo si legge come "innocuo". Lo dicono le parole. */
  it("l'anticipo è detto per quello che è, non solo colorato", () => {
    expect(etichettaScarto(-180)).toMatch(/anticipo/i);
    expect(etichettaScarto(-180)).toMatch(/prima di chi lo aspetta/i);
    expect(etichettaScarto(0)).toMatch(/orario esatto/i);
    expect(etichettaScarto(420)).toMatch(/ritardo di 7'00"/);
  });
});

describe("la legenda", () => {
  /* Esce dal server insieme ai colori che spiega: se la disegnasse la pagina
   * per conto suo, basterebbe ritoccare un caposaldo perché la legenda menta. */
  it("descrive gli stessi capisaldi che colorano la mappa", () => {
    const l = legendaRitardo();
    expect(l.tacche).toHaveLength(CAPISALDI.length);
    for (const t of l.tacche) expect(coloreRitardo(t.sec)).toBe(t.colore);
    expect(l.tacche.find(t => t.sec === 0)!.etichetta).toBe("in orario");
    expect(l.sogliaRitardoSec).toBe(SOGLIA_RITARDO_S);
    expect(l.nota).toMatch(/non vuol dire/i);
  });
});
