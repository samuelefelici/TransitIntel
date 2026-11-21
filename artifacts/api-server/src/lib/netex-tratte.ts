/**
 * Le tratte fra due fermate col loro tracciato, per i ServiceLink del NeTEx
 * (tappa 6.42). Pure: niente database.
 *
 * Il tracciato viene da shapes.txt del GTFS consegnabile. Ogni fermata del
 * percorso si proietta sul tracciato, in ordine: la fermata dopo non può
 * cadere prima di quella prima, così un percorso che ripassa sulla stessa
 * strada (andata e ritorno, anelli) mette ogni fermata sul passaggio giusto.
 * Due fermate a pochi metri, con la seconda appena prima della prima (due
 * paline ai lati della strada), cadono nello stesso punto (tappa 6.43).
 * Fra due fermate consecutive la tratta è il pezzo di tracciato fra le due
 * proiezioni: il punto della prima, i vertici in mezzo, il punto della
 * seconda.
 *
 * Non si usa shape_dist_traveled: nei percorsi importati è quello del file
 * d'origine, in km o in metri, e in quelli disegnati in Planning Studio
 * manca (lib/km-programmati.ts dice lo stesso).
 *
 * Senza tracciato, o con una fermata lontana dal tracciato (più di
 * ENTRO_KM), quella tratta non c'è: chi legge il file unisce le due fermate
 * in linea retta, come prima. Lo stesso controllo dà gli avvisi del GTFS
 * sulle fermate fuori dal tracciato (lib/gtfs-verifica.ts, tappa 6.43).
 *
 * Linee guida del profilo italiano v5.0.1, par. 5.2.5.5 (ServiceLinks), e
 * Appendice A (OpenTripPlanner usa le geometrie degli archi fra le fermate).
 */
import type { Riga } from "./gtfs-verifica";

/** Oltre questa distanza dal tracciato (km) una fermata non ci sta: il tracciato è di un'altra strada. */
export const ENTRO_KM = 0.3;
/** Le proiezioni più vicine che si tengono per fermata, fra cui scegliere quella in ordine. */
const CANDIDATE = 8;
/**
 * Quanto una fermata può cadere prima della precedente (km) e restare in
 * ordine: due paline vicine, la seconda appena prima della prima. Le due
 * finiscono nello stesso punto. Molto meno della distanza fra due passaggi
 * sulla stessa strada, che è di centinaia di metri.
 */
export const INDIETRO_KM = 0.05;

/** Un tracciato: i punti (lat, lon) in ordine e la distanza percorsa a ogni punto, in km. */
export interface Tracciato { punti: Array<[number, number]>; km: number[] }

const RAGGIO_KM = 6371.0088;
const rad = (g: number) => (g * Math.PI) / 180;

/** La distanza fra due punti (lat, lon), in km. */
export function distanzaKm(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * RAGGIO_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Il tracciato dalle righe di shapes.txt di una forma (in qualunque ordine); null con meno di due punti buoni. */
export function tracciatoDa(righe: readonly Riga[]): Tracciato | null {
  const punti = righe
    .map((r) => ({ seq: Number(r.shape_pt_sequence), lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon) }))
    .filter((p) => Number.isFinite(p.seq) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .sort((x, y) => x.seq - y.seq)
    .map((p): [number, number] => [p.lat, p.lon]);
  if (punti.length < 2) return null;
  const km = [0];
  for (let i = 1; i < punti.length; i++) km.push(km[i - 1]! + distanzaKm(punti[i - 1]!, punti[i]!));
  return { punti, km };
}

/** Il punto del tracciato a una distanza percorsa (km), interpolato fra due vertici. */
export function puntoA(t: Tracciato, d: number): [number, number] {
  const fine = t.km[t.km.length - 1]!;
  const x = Math.max(0, Math.min(fine, d));
  /* il primo vertice oltre x (ricerca binaria) */
  let lo = 0, hi = t.km.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t.km[m]! < x) lo = m + 1; else hi = m; }
  if (lo === 0) return t.punti[0]!;
  const a = t.punti[lo - 1]!, b = t.punti[lo]!;
  const tratto = t.km[lo]! - t.km[lo - 1]!;
  const f = tratto > 0 ? (x - t.km[lo - 1]!) / tratto : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * Il pezzo di tracciato fra due distanze percorse (km): il punto alla prima,
 * i vertici in mezzo, il punto alla seconda; la lunghezza in metri. Null se
 * le distanze non vanno avanti (dati che non tornano).
 */
export function trattoFra(t: Tracciato, da: number, a: number): { punti: Array<[number, number]>; metri: number } | null {
  if (!Number.isFinite(da) || !Number.isFinite(a) || a <= da) return null;
  const punti: Array<[number, number]> = [puntoA(t, da)];
  for (let i = 0; i < t.km.length; i++) if (t.km[i]! > da && t.km[i]! < a) punti.push(t.punti[i]!);
  punti.push(puntoA(t, a));
  let km = 0;
  for (let i = 1; i < punti.length; i++) km += distanzaKm(punti[i - 1]!, punti[i]!);
  return { punti, metri: Math.round(km * 1000) };
}

/** La polilinea come la vuole gml:posList: «lon lat lon lat …», sei decimali. */
export const posList = (punti: ReadonlyArray<readonly [number, number]>): string =>
  punti.map(([lat, lon]) => `${lon.toFixed(6)} ${lat.toFixed(6)}`).join(" ");

const KM_PER_GRADO = (RAGGIO_KM * Math.PI) / 180;

/**
 * Dove cade ogni fermata sul tracciato: la distanza percorsa (km) della sua
 * proiezione, o null se la fermata non ha posizione o è lontana dal
 * tracciato. Le distanze vanno avanti con le fermate.
 *
 * Per ogni fermata si tengono le proiezioni sui tratti dove la distanza
 * dal tracciato ha un minimo (una per passaggio sulla stessa strada), poi
 * si sceglie la sequenza in ordine con la somma delle distanze più bassa
 * (programmazione dinamica); a parità, la proiezione che viene prima.
 */
export function posizioniSulTracciato(
  t: Tracciato, fermate: ReadonlyArray<readonly [number, number] | null>, entroKm = ENTRO_KM,
): Array<number | null> {
  const n = t.punti.length;
  /* le candidate di ogni fermata: { s: km percorsi, d: distanza dal tracciato } in ordine di s */
  const candidate = fermate.map((f): Array<{ s: number; d: number }> => {
    if (!f) return [];
    const [lat0, lon0] = f;
    const kx = KM_PER_GRADO * Math.cos(rad(lat0)), ky = KM_PER_GRADO;
    const xy = (p: readonly [number, number]) => [(p[1] - lon0) * kx, (p[0] - lat0) * ky] as const;
    const d: number[] = [], s: number[] = [];
    let b = xy(t.punti[0]!);
    for (let j = 0; j < n - 1; j++) {
      const a = b; b = xy(t.punti[j + 1]!);
      const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
      const f2 = l2 > 0 ? Math.max(0, Math.min(1, -(a[0] * vx + a[1] * vy) / l2)) : 0;
      const px = a[0] + vx * f2, py = a[1] + vy * f2;
      d.push(Math.hypot(px, py));
      s.push(t.km[j]! + (t.km[j + 1]! - t.km[j]!) * f2);
    }
    const minimi: Array<{ s: number; d: number }> = [];
    for (let j = 0; j < d.length; j++) {
      if (d[j]! > entroKm) continue;
      if ((j > 0 && d[j - 1]! < d[j]!) || (j < d.length - 1 && d[j + 1]! < d[j]!)) continue;
      /* un minimo piatto su due tratti (la fermata cade su un vertice) è un punto solo */
      const ultimo = minimi[minimi.length - 1];
      if (ultimo && Math.abs(ultimo.s - s[j]!) < 0.001) continue;
      minimi.push({ s: s[j]!, d: d[j]! });
    }
    return minimi.sort((x, y) => x.d - y.d).slice(0, CANDIDATE).sort((x, y) => x.s - y.s);
  });

  /* La sequenza in ordine più vicina al tracciato. Una fermata senza candidate,
   * o con tutte prima della fermata precedente, si salta: resta senza posizione. */
  const costo: number[][] = [], da: number[][] = [];
  const posta: number[] = [];
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i]!;
    if (!c.length) continue;
    const prima = posta.length ? posta[posta.length - 1]! : -1;
    const qui: number[] = [], via: number[] = [];
    for (let k = 0; k < c.length; k++) {
      let migliore = prima < 0 ? 0 : Infinity, quale = -1;
      if (prima >= 0) {
        const cp = candidate[prima]!;
        for (let h = 0; h < cp.length; h++) {
          if (cp[h]!.s <= c[k]!.s + INDIETRO_KM && costo[prima]![h]! < migliore) { migliore = costo[prima]![h]!; quale = h; }
        }
      }
      qui.push(migliore + c[k]!.d); via.push(quale);
    }
    if (!qui.some(Number.isFinite)) continue;
    costo[i] = qui; da[i] = via; posta.push(i);
  }
  const esito: Array<number | null> = fermate.map(() => null);
  if (!posta.length) return esito;
  /* dall'ultima fermata posta indietro */
  let p = posta.length - 1;
  let k = costo[posta[p]!]!.reduce((m, x, h, a) => (x < a[m]! ? h : m), 0);
  for (; p >= 0; p--) {
    const i = posta[p]!;
    esito[i] = candidate[i]![k]!.s;
    k = da[i]![k]!;
  }
  /* la fermata appena prima della precedente va nello stesso punto: le distanze non tornano mai indietro */
  let fin = -Infinity;
  for (let i = 0; i < esito.length; i++) {
    const x = esito[i];
    if (x == null) continue;
    if (x < fin) esito[i] = fin; else fin = x;
  }
  return esito;
}

/** La distanza (km) di un punto dal tracciato: dal punto più vicino, senza badare all'ordine. */
export function distanzaDalTracciato(t: Tracciato, p: readonly [number, number]): number {
  return t.punti.length > 1 ? distanzaDallaLinea(p, t.punti) : distanzaKm(p, t.punti[0]!);
}

/** Entro questa distanza (km) due tracciati della stessa coppia di fermate fanno la stessa strada. */
export const STESSA_STRADA_KM = 0.015;

/** La distanza (km) di un punto da una polilinea, sul piano locale attorno al punto. */
function distanzaDallaLinea(p: readonly [number, number], linea: ReadonlyArray<readonly [number, number]>): number {
  const kx = KM_PER_GRADO * Math.cos(rad(p[0])), ky = KM_PER_GRADO;
  let m = Infinity;
  for (let i = 0; i < linea.length - 1; i++) {
    const a = linea[i]!, b = linea[i + 1]!;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, vx = (b[1] - a[1]) * kx, vy = (b[0] - a[0]) * ky;
    const l2 = vx * vx + vy * vy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2)) : 0;
    m = Math.min(m, Math.hypot(ax + vx * f, ay + vy * f));
  }
  return m;
}

/**
 * Due tratte della stessa coppia di fermate fanno la stessa strada: lunghezze
 * vicine e ogni vertice di una entro STESSA_STRADA_KM dall'altra (nei due
 * sensi). Succede quando due percorsi hanno tracciati disegnati a parte sulla
 * stessa strada: nel file va una tratta sola.
 */
export function stessaStrada(a: Tratta, b: Tratta, entroKm = STESSA_STRADA_KM): boolean {
  if (Math.abs(a.metri - b.metri) > Math.max(20, 0.1 * Math.max(a.metri, b.metri))) return false;
  return a.punti.every((p) => distanzaDallaLinea(p, b.punti) <= entroKm)
    && b.punti.every((p) => distanzaDallaLinea(p, a.punti) <= entroKm);
}

/** Una tratta fra due fermate consecutive col pezzo di tracciato fra le due. */
export interface Tratta { punti: Array<[number, number]>; metri: number }

/**
 * Le tratte di un percorso: una per coppia di fermate consecutive (quindi una
 * meno delle fermate). Null dove non c'è perché una delle due fermate non sta
 * sul tracciato; «stesso_punto» dove le due fermate cadono nello stesso punto
 * del tracciato (non c'è strada fra le due da disegnare).
 */
export function trattePercorso(t: Tracciato, fermate: ReadonlyArray<readonly [number, number] | null>): Array<Tratta | "stesso_punto" | null> {
  const s = posizioniSulTracciato(t, fermate);
  const tratte: Array<Tratta | "stesso_punto" | null> = [];
  for (let i = 0; i < fermate.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    tratte.push(a == null || b == null ? null : trattoFra(t, a, b) ?? "stesso_punto");
  }
  return tratte;
}
