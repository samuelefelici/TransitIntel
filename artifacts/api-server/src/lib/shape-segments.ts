/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SPEZZARE IL TRACCIATO FERMATA PER FERMATA
 * ───────────────────────────────────────────────────────────────────────────
 * Il feed dà il percorso come una polilinea sola, dal capolinea al capolinea.
 * Per colorare la corsa in base al ritardo serve invece un tratto per ogni
 * coppia di fermate consecutive: è fra due fermate che il ritardo cambia, ed
 * è lì che si vede dove il mezzo lo ha preso.
 *
 * ── La trappola: le linee che ripassano ──
 *
 * Cercare per ogni fermata il punto più vicino sull'intera polilinea sembra
 * ovvio e sbaglia su ogni linea che ripassa vicino a sé stessa — un anello,
 * un'andata e ritorno sulla stessa strada, un capolinea servito due volte. Il
 * punto più vicino può cadere sul passaggio SBAGLIATO, e il tratto risultante
 * torna indietro attraversando mezza città.
 *
 * Per questo la ricerca è VINCOLATA a procedere: ogni fermata si proietta
 * soltanto sulla parte di tracciato che viene dopo la fermata precedente. Il
 * percorso così ricostruito è monotòno per costruzione.
 *
 * ── Quando non si può ──
 *
 * Se una fermata finisce comunque lontana dal tracciato — coordinate sbagliate
 * nel feed, oppure un tracciato che quel tratto non lo copre — il tratto si
 * dichiara `attendibile: false` invece di disegnare una linea inventata. Chi
 * guarda deve poter distinguere la strada vera da una congiungente.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Un punto del tracciato, nell'ordine GeoJSON: [longitudine, latitudine]. */
export type PuntoLonLat = [number, number];

export interface FermataConPosizione {
  lat: number | null;
  lon: number | null;
}

/** Oltre questa distanza dal tracciato la proiezione non è credibile. */
export const LONTANO_DAL_TRACCIATO_M = 200;
/** Sotto questa distanza l'aggancio è già buono: non serve cercare oltre. */
const VICINO_M = 25;
/** Di quanto ci si deve allontanare per dichiarare superato il passaggio buono. */
const ALLONTANAMENTO_M = 50;

const R = 6_371_000;
const rad = Math.PI / 180;

/** Metri fra due punti (equirettangolare: alle distanze urbane basta e avanza). */
export function metri(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
  const y = (bLat - aLat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * Proietta un punto su un segmento. Restituisce il punto proiettato, quanto
 * dista e in che frazione del segmento cade.
 */
function proiettaSuSegmento(
  lat: number, lon: number,
  aLat: number, aLon: number, bLat: number, bLon: number,
): { lat: number; lon: number; distanza: number; t: number } {
  /* Si lavora in metri locali: in gradi, un grado di longitudine ad Ancona
   * vale 3/4 di uno di latitudine, e la perpendicolare cadrebbe storta. */
  const k = Math.cos(((aLat + bLat) / 2) * rad);
  const ax = 0, ay = 0;
  const bx = (bLon - aLon) * rad * k * R, by = (bLat - aLat) * rad * R;
  const px = (lon - aLon) * rad * k * R, py = (lat - aLat) * rad * R;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * bx + (py - ay) * by) / len2));
  const qx = bx * t, qy = by * t;
  return {
    lat: aLat + (bLat - aLat) * t,
    lon: aLon + (bLon - aLon) * t,
    distanza: Math.sqrt((px - qx) ** 2 + (py - qy) ** 2),
    t,
  };
}

/** Dove cade una fermata lungo il tracciato: indice di segmento e frazione. */
export interface Ancoraggio {
  /** indice del segmento del tracciato (da `punti[i]` a `punti[i+1]`) */
  i: number;
  /** frazione dentro quel segmento, 0..1 */
  t: number;
  lat: number;
  lon: number;
  /** distanza fra la fermata e la sua proiezione, in metri */
  distanzaM: number;
}

/**
 * Àncora le fermate al tracciato, in avanti.
 *
 * La ricerca parte dall'àncora precedente e non torna mai indietro: è ciò che
 * impedisce a una fermata di agganciarsi al passaggio sbagliato su una linea
 * che ripassa vicino a sé stessa.
 */
export function ancoraFermate(
  tracciato: PuntoLonLat[], fermate: FermataConPosizione[],
): Array<Ancoraggio | null> {
  const esiti: Array<Ancoraggio | null> = [];
  if (tracciato.length < 2) return fermate.map(() => null);

  let daI = 0, daT = 0;
  for (const f of fermate) {
    if (f.lat == null || f.lon == null) { esiti.push(null); continue; }
    let best: Ancoraggio | null = null;
    for (let i = daI; i < tracciato.length - 1; i++) {
      const [aLon, aLat] = tracciato[i];
      const [bLon, bLat] = tracciato[i + 1];
      const p = proiettaSuSegmento(f.lat, f.lon, aLat, aLon, bLat, bLon);
      /* Nel segmento da cui si riparte non si può tornare prima del punto già
       * raggiunto, altrimenti il tratto avrebbe lunghezza negativa. */
      const t = i === daI ? Math.max(p.t, daT) : p.t;
      const pLat = aLat + (bLat - aLat) * t;
      const pLon = aLon + (bLon - aLon) * t;
      const dist = metri(f.lat, f.lon, pLat, pLon);
      if (!best || dist < best.distanzaM) {
        best = { i, t, lat: pLat, lon: pLon, distanzaM: dist };
      } else if (best.distanzaM <= VICINO_M && dist > best.distanzaM + ALLONTANAMENTO_M) {
        /* Trovato un buon aggancio e ora ci si sta allontanando: ci si ferma
         * al PRIMO passaggio buono. Continuare fino in fondo porterebbe, su
         * un anello, ad agganciare il secondo passaggio dalle stesse parti —
         * magari più vicino di qualche metro, e a un'ora di distanza. */
        break;
      }
    }
    if (best) { daI = best.i; daT = best.t; }
    esiti.push(best);
  }
  return esiti;
}

export interface Tratto {
  /** i punti del tratto, dalla fermata di partenza a quella di arrivo */
  punti: PuntoLonLat[];
  /** false = ricavato unendo le fermate in linea retta, non è la strada */
  attendibile: boolean;
  /** metri percorsi sul tratto, 0 se non calcolabile */
  metri: number;
}

/**
 * Spezza il tracciato nei tratti fra fermate consecutive. Restituisce sempre
 * `fermate.length - 1` tratti: dove il tracciato non aiuta, il tratto è la
 * congiungente fra le due fermate ed è dichiarato non attendibile, perché una
 * retta fra due fermate TAGLIA LE CURVE e non è la strada.
 */
export function spezzaPerFermate(
  tracciato: PuntoLonLat[], fermate: FermataConPosizione[],
): Tratto[] {
  const tratti: Tratto[] = [];
  if (fermate.length < 2) return tratti;
  const ancore = ancoraFermate(tracciato, fermate);

  for (let k = 0; k < fermate.length - 1; k++) {
    const a = ancore[k], b = ancore[k + 1];
    const fa = fermate[k], fb = fermate[k + 1];

    const rettaPossibile = fa.lat != null && fa.lon != null && fb.lat != null && fb.lon != null;
    const retta: Tratto = {
      punti: rettaPossibile ? [[fa.lon!, fa.lat!], [fb.lon!, fb.lat!]] : [],
      attendibile: false,
      metri: rettaPossibile ? metri(fa.lat!, fa.lon!, fb.lat!, fb.lon!) : 0,
    };

    /* Una proiezione lontana vuol dire che quel tratto il tracciato non lo
     * copre: meglio la congiungente dichiarata tale che un pezzo di strada
     * altrui disegnato come se fosse questo. */
    if (!a || !b || a.distanzaM > LONTANO_DAL_TRACCIATO_M || b.distanzaM > LONTANO_DAL_TRACCIATO_M) {
      tratti.push(retta);
      continue;
    }

    const punti: PuntoLonLat[] = [[a.lon, a.lat]];
    for (let i = a.i + 1; i <= b.i; i++) punti.push(tracciato[i]);
    punti.push([b.lon, b.lat]);

    /* Due fermate sullo stesso segmento, o sulla stessa coordinata: il tratto
     * degenererebbe in un punto e la mappa non disegnerebbe nulla. */
    const dedup = punti.filter((p, i) => i === 0
      || p[0] !== punti[i - 1][0] || p[1] !== punti[i - 1][1]);
    if (dedup.length < 2) { tratti.push(retta); continue; }

    let lung = 0;
    for (let i = 1; i < dedup.length; i++) {
      lung += metri(dedup[i - 1][1], dedup[i - 1][0], dedup[i][1], dedup[i][0]);
    }
    tratti.push({ punti: dedup, attendibile: true, metri: lung });
  }
  return tratti;
}
