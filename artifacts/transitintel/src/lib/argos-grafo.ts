/**
 * Il layout delle mappe di Argos (documenti, concetti): un grafo a forze
 * scritto a mano, senza dipendenze. Deterministico: la stessa mappa esce
 * sempre uguale (niente numeri a caso), così chi la guarda ritrova i suoi
 * documenti dove li aveva lasciati.
 *
 * Si parte con i nodi su un cerchio, raggruppati per categoria (ogni
 * categoria il suo spicchio), poi qualche centinaio di passi di
 * Fruchterman-Reingold: i nodi si respingono, gli archi tirano (più forte se
 * l'affinità è alta), una gravità tiene insieme i gruppi slegati. Alla fine
 * il disegno si adatta al riquadro, con i margini per le etichette.
 */

export interface NodoGrafo { id: string | number; title: string; category: string | null; chunks: number }
export interface ArcoGrafo { source: string | number; target: string | number; weight: number; rel?: string; from?: string | number | null }
export interface Posizione { x: number; y: number }

export interface OpzioniLayout { larghezza: number; altezza: number; passi?: number }

export function disponi(nodi: readonly NodoGrafo[], archi: readonly ArcoGrafo[], o: OpzioniLayout): Map<string | number, Posizione> {
  const n = nodi.length;
  const pos = new Map<string | number, Posizione>();
  if (!n) return pos;
  const W = o.larghezza, H = o.altezza, cx = W / 2, cy = H / 2;
  // spicchi per categoria
  const categorie = [...new Set(nodi.map(x => x.category ?? ""))].sort();
  const perCat = new Map<string, number>();
  const xs = new Float64Array(n), ys = new Float64Array(n);
  nodi.forEach((nd, i) => {
    const c = nd.category ?? "";
    const k = categorie.indexOf(c);
    const j = perCat.get(c) ?? 0;
    perCat.set(c, j + 1);
    const base = (k / Math.max(1, categorie.length)) * Math.PI * 2;
    const ang = base + (j * 0.37) % (Math.PI * 2 / Math.max(1, categorie.length));
    const r = Math.min(W, H) * (0.12 + 0.2 * ((j * 7919) % 97) / 97);
    xs[i] = cx + Math.cos(ang) * r;
    ys[i] = cy + Math.sin(ang) * r;
  });
  const indice = new Map<string | number, number>(nodi.map((nd, i) => [nd.id, i]));
  const legami = archi
    .map(a => ({ s: indice.get(a.source), t: indice.get(a.target), w: Math.max(0.05, Math.min(1, a.weight || 0)) }))
    .filter((a): a is { s: number; t: number; w: number } => a.s !== undefined && a.t !== undefined && a.s !== a.t);
  // distanza ideale e gravità: la gravità a mezzo riquadro bilancia la spinta
  // di metà dei nodi, così i gruppi slegati non scappano e nessuno si schiaccia
  // sui bordi (i bordi non ci sono: alla fine il disegno si adatta al riquadro)
  const area = W * H;
  const k = Math.sqrt((0.3 * area) / n);
  const R = Math.min(W, H) / 2;
  const g = (n * k * k) / (2 * R * R);
  const passi = o.passi ?? Math.min(400, 150 + n * 2);
  let temp = R / 3;
  const dx = new Float64Array(n), dy = new Float64Array(n);
  for (let p = 0; p < passi; p++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = xs[i]! - xs[j]!, ddy = ys[i]! - ys[j]!;
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 0.01) { ddx = (i - j) * 0.1; ddy = 0.1; d2 = ddx * ddx + ddy * ddy; }
        const f = (k * k) / d2; // spinta k²/d lungo la congiungente
        dx[i]! += ddx * f; dy[i]! += ddy * f;
        dx[j]! -= ddx * f; dy[j]! -= ddy * f;
      }
    }
    for (const l of legami) {
      const ddx = xs[l.s]! - xs[l.t]!, ddy = ys[l.s]! - ys[l.t]!;
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const f = (d / k) * (0.3 + l.w); // richiamo d²/k, più forte se l'affinità è alta
      dx[l.s]! -= ddx * f; dy[l.s]! -= ddy * f;
      dx[l.t]! += ddx * f; dy[l.t]! += ddy * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i]! += (cx - xs[i]!) * g;
      dy[i]! += (cy - ys[i]!) * g;
      const d = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const s = Math.min(d, temp) / d;
      xs[i] = xs[i]! + dx[i]! * s;
      ys[i] = ys[i]! + dy[i]! * s;
    }
    temp = Math.max(0.5, temp * 0.985);
  }
  // il disegno si adatta al riquadro (margini per le etichette sotto i nodi)
  const MX = Math.min(90, W * 0.12), MT = Math.min(30, H * 0.08), MB = Math.min(46, H * 0.1);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, xs[i]!); x1 = Math.max(x1, xs[i]!); y0 = Math.min(y0, ys[i]!); y1 = Math.max(y1, ys[i]!); }
  const sx = Math.min(3, (W - 2 * MX) / Math.max(1, x1 - x0)), sy = Math.min(3, (H - MT - MB) / Math.max(1, y1 - y0));
  // stessa scala sui due assi, con un po' di elasticità per riempire il riquadro
  const s = Math.min(sx, sy), scalaX = Math.min(sx, s * 1.5), scalaY = Math.min(sy, s * 1.5);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, ccy = MT + (H - MT - MB) / 2;
  nodi.forEach((nd, i) => pos.set(nd.id, {
    x: Math.max(20, Math.min(W - 20, cx + (xs[i]! - mx) * scalaX)),
    y: Math.max(20, Math.min(H - 20, ccy + (ys[i]! - my) * scalaY)),
  }));
  return pos;
}

/** Il raggio di un nodo, dal numero dei suoi chunk (fra 5 e 22 px). */
export function raggio(chunks: number, massimo: number): number {
  if (massimo <= 0) return 6;
  return 5 + 17 * Math.sqrt(Math.max(0, chunks) / massimo);
}

/** I vicini di un nodo (per evidenziarli al passaggio del mouse). */
export function vicini(id: string | number, archi: readonly ArcoGrafo[]): Set<string | number> {
  const out = new Set<string | number>([id]);
  for (const a of archi) {
    if (a.source === id) out.add(a.target);
    if (a.target === id) out.add(a.source);
  }
  return out;
}

/**
 * La tinta di una categoria (1–8, nell'ordine dato da Argos); 0 = «altre»
 * (nessuna categoria, o dalla nona in poi). Il colore segue la categoria, non
 * la posizione in un elenco filtrato: si passa sempre l'elenco completo.
 */
export function tintaCategoria(categoria: string | null | undefined, categorie: readonly string[]): number {
  if (!categoria) return 0;
  const i = categorie.indexOf(categoria);
  return i >= 0 && i < 8 ? i + 1 : 0;
}

/** Il nome che Argos dà ai documenti senza categoria (in fondo all'elenco della mappa). */
export const SENZA_CATEGORIA = "Senza categoria";

/**
 * L'elenco che decide le tinte, uguale a quello della mappa di Argos: le
 * categorie ufficiali nell'ordine dell'amministratore, poi quelle che stanno
 * solo sui documenti (in ordine alfabetico). «Senza categoria» resta fuori:
 * è grigia.
 */
export function elencoTinte(ufficiali: readonly string[], presenti: ReadonlyArray<string | null>): string[] {
  const out = ufficiali.filter(c => c !== SENZA_CATEGORIA);
  const extra = [...new Set(presenti.filter((c): c is string => !!c && c !== SENZA_CATEGORIA && !out.includes(c)))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return [...out, ...extra];
}

/** Le relazioni fra concetti, con il nome da mostrare e se hanno un verso. */
export const RELAZIONI: Record<string, { nome: string; verso: boolean }> = {
  prerequisito: { nome: "è prerequisito di", verso: true },
  generalizza: { nome: "generalizza", verso: true },
  applica: { nome: "applica", verso: true },
  contraddice: { nome: "contraddice", verso: false },
  correlato: { nome: "è correlato a", verso: false },
};
