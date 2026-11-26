/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RICALCARE UN TRATTO SUL TRACCIATO DI UN'ALTRA LINEA
 * ───────────────────────────────────────────────────────────────────────────
 * Lo snap stradale (OSRM) conosce i sensi unici delle auto, non le deroghe dei
 * bus: un senso vietato che il bus percorre lo fa girare intorno all'isolato.
 * Una retta fra le due fermate taglia invece le case. La strada vera, però,
 * quasi sempre c'è già nel progetto: un'altra linea fa lo stesso tratto, col
 * suo tracciato (quello del GTFS aziendale, o disegnato da un operatore).
 *
 * Qui si cerca, fra i tracciati del progetto, quello che passa dalla fermata
 * A e POI dalla fermata B (vicino a entrambe, nello stesso verso), si ritaglia
 * il pezzo fra le due e lo si restituisce con i suoi punti intermedi. Chi lo
 * salva li mette come waypoint del tratto a mano libera: l'editor lo ridisegna
 * uguale e non lo ri-snappa su strada.
 *
 * Se nessun tracciato copre il tratto, il risultato è null: chi chiama deve
 * dirlo, non ripiegare in silenzio su una congiungente.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { ancoraFermate, metri, type PuntoLonLat } from "./shape-segments";

/** Entro questa distanza dal tracciato una fermata si considera servita da lì. */
export const TOLLERANZA_AGGANCIO_M = 30;
/** Un ricalco più lungo di così rispetto alla retta è un giro, non il tratto. */
const FATTORE_MAX = 4;
const MARGINE_MAX_M = 300;
/** Semplificazione dei punti intermedi: abbastanza per seguire le curve. */
const SEMPLIFICA_M = 3;
export const MAX_PUNTI_INTERMEDI = 60;

export interface TracciatoCandidato {
  variantId: string;
  linea: string;        // nome breve della linea, per dire all'operatore da dove viene
  percorso: string;     // nome della variante
  coordinate: PuntoLonLat[];
}

export interface Ricalco {
  /** Dal punto della fermata A al punto della fermata B, punti intermedi compresi. */
  punti: PuntoLonLat[];
  /** I soli punti intermedi (senza le due fermate), già semplificati. */
  intermedi: PuntoLonLat[];
  metri: number;
  variantId: string;
  linea: string;
  percorso: string;
}

const lunghezza = (p: PuntoLonLat[]): number => {
  let m = 0;
  for (let i = 1; i < p.length; i++) m += metri(p[i - 1][1], p[i - 1][0], p[i][1], p[i][0]);
  return m;
};

/** Distanza di un punto da un segmento, in metri (equirettangolare locale). */
function distanzaDaSegmento(p: PuntoLonLat, a: PuntoLonLat, b: PuntoLonLat): number {
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111_320, ky = 110_540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Douglas–Peucker: tiene i punti che spostano la linea di più di 'tol' metri. */
export function semplifica(punti: PuntoLonLat[], tol: number): PuntoLonLat[] {
  if (punti.length <= 2) return punti.slice();
  const tieni = new Array(punti.length).fill(false);
  tieni[0] = tieni[punti.length - 1] = true;
  const pila: [number, number][] = [[0, punti.length - 1]];
  while (pila.length) {
    const [i, j] = pila.pop()!;
    let max = -1, k = -1;
    for (let m = i + 1; m < j; m++) {
      const d = distanzaDaSegmento(punti[m], punti[i], punti[j]);
      if (d > max) { max = d; k = m; }
    }
    if (k >= 0 && max > tol) { tieni[k] = true; pila.push([i, k], [k, j]); }
  }
  return punti.filter((_, i) => tieni[i]);
}

/** Inizi dei passaggi del tracciato vicino al punto: un indice per ogni volta
 *  che la linea ci passa (un anello o un'andata-ritorno ci passa due volte). */
function passaggi(coord: PuntoLonLat[], p: PuntoLonLat, tol: number): number[] {
  const out: number[] = [];
  let dentro = false;
  for (let i = 0; i < coord.length - 1; i++) {
    const vicino = distanzaDaSegmento(p, coord[i], coord[i + 1]) <= tol;
    if (vicino && !dentro) out.push(i);
    dentro = vicino;
  }
  return out;
}

/** Il pezzo di UN tracciato fra A e B, se lo copre nel verso giusto. */
export function ritaglia(
  coord: PuntoLonLat[], a: PuntoLonLat, b: PuntoLonLat, tol = TOLLERANZA_AGGANCIO_M,
): { punti: PuntoLonLat[]; metri: number } | null {
  if (coord.length < 2) return null;
  const retta = metri(a[1], a[0], b[1], b[0]);
  let migliore: { punti: PuntoLonLat[]; metri: number } | null = null;
  for (const inizio of passaggi(coord, a, tol)) {
    const parte = coord.slice(inizio);
    const [ea, eb] = ancoraFermate(parte, [{ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }]);
    if (!ea || !eb || ea.distanzaM > tol || eb.distanzaM > tol) continue;
    if (eb.i < ea.i || (eb.i === ea.i && eb.t <= ea.t)) continue;
    const grezzi: PuntoLonLat[] = [a, [ea.lon, ea.lat]];
    for (let i = ea.i + 1; i <= eb.i; i++) grezzi.push(parte[i]);
    grezzi.push([eb.lon, eb.lat], b);
    const punti = grezzi.filter((p, i) => i === 0 || p[0] !== grezzi[i - 1][0] || p[1] !== grezzi[i - 1][1]);
    const m = lunghezza(punti);
    if (m > retta * FATTORE_MAX + MARGINE_MAX_M) continue;
    if (!migliore || m < migliore.metri) migliore = { punti, metri: m };
  }
  return migliore;
}

/** Fra tutti i tracciati, il ricalco più corto del tratto A→B; null se nessuno lo copre. */
export function ricalcaTratto(
  candidati: TracciatoCandidato[], a: PuntoLonLat, b: PuntoLonLat,
): Ricalco | null {
  let migliore: Ricalco | null = null;
  for (const c of candidati) {
    const r = ritaglia(c.coordinate, a, b);
    if (!r || (migliore && r.metri >= migliore.metri)) continue;
    let tol = SEMPLIFICA_M;
    let semplici = semplifica(r.punti, tol);
    while (semplici.length - 2 > MAX_PUNTI_INTERMEDI) { tol *= 2; semplici = semplifica(r.punti, tol); }
    migliore = {
      punti: semplici, intermedi: semplici.slice(1, -1), metri: r.metri,
      variantId: c.variantId, linea: c.linea, percorso: c.percorso,
    };
  }
  return migliore;
}

/** Le coordinate di un LineString salvato, solo se tutte numeriche e plausibili. */
export function coordinateValide(geometry: unknown): PuntoLonLat[] {
  const cs = (geometry as any)?.type === "LineString" ? (geometry as any).coordinates : null;
  if (!Array.isArray(cs)) return [];
  const out: PuntoLonLat[] = [];
  for (const c of cs) {
    const lng = Number(c?.[0]), lat = Number(c?.[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90) out.push([lng, lat]);
  }
  return out;
}
