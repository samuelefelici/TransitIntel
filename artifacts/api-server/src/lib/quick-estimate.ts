/**
 * Stima istantanea di risorse — l'aritmetica del «riflesso rapido».
 *
 * Il processo classico è verticale: orari → validità → UDP → turni macchina →
 * turni guida, e il costo si scopre alla FINE, quando i gradi di libertà sono
 * già spesi. Questo modulo dà il segnale di costo SUBITO, mentre l'orario
 * viene disegnato: da un insieme di corse (reali o ipotetiche) calcola in
 * O(n log n) le vetture minime per catena, le ore di servizio e le ore
 * vettura — abbastanza per CONFRONTARE scenari (cadenza 20' vs 30',
 * interlinea, fasce) prima di scegliere. Il CP-SAT resta il giudice finale:
 * qui niente km a vuoto, depositi né vincoli di cambio, quindi la stima è
 * deliberatamente OTTIMISTA (un lower bound praticabile, non un turno).
 *
 * Funzioni pure, senza DB: la rotta HTTP le alimenta, i test le inchiodano.
 */

export interface EstTrip {
  /** partenza/arrivo in MINUTI dalla mezzanotte (anche >1440 per corse oltre le 24:00) */
  start: number;
  end: number;
  /** etichetta della linea per lo spaccato (short name); opzionale */
  routeKey?: string;
}

export interface QuickEstimate {
  corse: number;
  /** Σ (arrivo − partenza), in ore con 1 decimale */
  oreServizio: number;
  /** vetture minime per CATENA: greedy sugli intervalli estesi dal turnaround */
  stimaVetture: number;
  /** Σ per vettura (ultimo arrivo − prima partenza), in ore: proxy delle ore pagate */
  stimaOreVettura: number;
  /** massima sovrapposizione di corse senza turnaround: lower bound assoluto */
  sovrapposizioneMax: number;
  primaPartenza: string;
  ultimoArrivo: string;
  perLinea: Array<{ linea: string; corse: number; oreServizio: number }>;
}

/** "7:30" / "07:30" / "25:10" / "07:30:00" → minuti dalla mezzanotte; null se illeggibile.
 *  Le ore oltre 24 sono legittime (convenzione GTFS per il servizio dopo mezzanotte). */
export function parseHM(s: unknown): number | null {
  const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 47) return null; // oltre le 47:59 è quasi certamente un dato sporco
  return h * 60 + Number(m[2]);
}

function fmtHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * La stima. turnaroundMin = minuti minimi tra l'arrivo di una corsa e la
 * partenza della successiva SULLA STESSA vettura (giro banchina). La catena è
 * "libera": si assume che una vettura possa riprendere qualsiasi corsa
 * successiva (niente geografia) — da qui l'ottimismo dichiarato.
 */
export function quickEstimate(trips: EstTrip[], turnaroundMin = 8): QuickEstimate {
  const clean = trips
    .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end))
    // una corsa che "torna indietro" scavalca la mezzanotte: si srotola
    .map((t) => (t.end < t.start ? { ...t, end: t.end + 1440 } : t))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (clean.length === 0) {
    return {
      corse: 0, oreServizio: 0, stimaVetture: 0, stimaOreVettura: 0,
      sovrapposizioneMax: 0, primaPartenza: "", ultimoArrivo: "", perLinea: [],
    };
  }

  // ── Vetture per catena: best-fit sul veicolo con l'arrivo PIÙ TARDO ancora
  // compatibile (start ≥ end + turnaround). Il conteggio minimo è lo stesso di
  // qualunque politica greedy; il best-fit in più COMPATTA le catene, quindi
  // le ore vettura stimate sono realistiche, non gonfiate.
  interface Veh { firstStart: number; lastEnd: number }
  const vehicles: Veh[] = [];
  for (const t of clean) {
    let best: Veh | null = null;
    for (const v of vehicles) {
      if (v.lastEnd + turnaroundMin <= t.start && (!best || v.lastEnd > best.lastEnd)) best = v;
    }
    if (best) best.lastEnd = t.end;
    else vehicles.push({ firstStart: t.start, lastEnd: t.end });
  }

  // ── Sovrapposizione massima (senza turnaround): quante corse sono in strada
  // CONTEMPORANEAMENTE nel momento peggiore. Nessuna catena può scendere sotto.
  const events: Array<[number, number]> = [];
  for (const t of clean) { events.push([t.start, +1], [t.end, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // a pari orario prima il -1: arrivo libera prima della partenza
  let cur = 0, overlap = 0;
  for (const [, d] of events) { cur += d; if (cur > overlap) overlap = cur; }

  const serviceMin = clean.reduce((s, t) => s + (t.end - t.start), 0);
  const vehicleMin = vehicles.reduce((s, v) => s + (v.lastEnd - v.firstStart), 0);

  const byRoute = new Map<string, { corse: number; min: number }>();
  for (const t of clean) {
    const k = t.routeKey || "(senza linea)";
    const e = byRoute.get(k) ?? { corse: 0, min: 0 };
    e.corse += 1; e.min += t.end - t.start;
    byRoute.set(k, e);
  }

  return {
    corse: clean.length,
    oreServizio: round1(serviceMin / 60),
    stimaVetture: vehicles.length,
    stimaOreVettura: round1(vehicleMin / 60),
    sovrapposizioneMax: overlap,
    primaPartenza: fmtHM(clean[0].start),
    ultimoArrivo: fmtHM(Math.max(...clean.map((t) => t.end))),
    perLinea: [...byRoute.entries()]
      .map(([linea, e]) => ({ linea, corse: e.corse, oreServizio: round1(e.min / 60) }))
      .sort((a, b) => b.corse - a.corse),
  };
}
