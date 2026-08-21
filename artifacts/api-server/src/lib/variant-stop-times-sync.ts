/**
 * RIALLINEAMENTO degli orari di una corsa alla sequenza fermate del percorso.
 *
 * Quando si modifica la sequenza di una variante (si tolgono fermate in testa,
 * se ne aggiunge una in mezzo, si riordina), le corse già a terra conservano i
 * loro ps_stop_times: senza riallineamento la corsa mostra transiti a fermate
 * che il percorso non tocca più — ed è esattamente ciò che l'operatore vede
 * aprendo «modifica corsa».
 *
 * Regole (pensate per non inventare servizio):
 *  - fermata RIMASTA  → mantiene i suoi orari, intatti;
 *  - fermata TOLTA    → il suo transito sparisce (la corsa parte/arriva dopo);
 *  - fermata NUOVA in mezzo → orario INTERPOLATO tra i due transiti noti che la
 *    circondano, in proporzione alle progressive del percorso se disponibili,
 *    altrimenti a passo uniforme;
 *  - fermata NUOVA in testa/coda → estrapolata con la velocità media della
 *    parte nota della corsa (o col passo medio tra fermate, senza progressive);
 *  - corsa che resterebbe con meno di 2 transiti noti → NON si tocca: si
 *    segnala e decide l'operatore (cancellarla o rifarla).
 * Gli orari restano monotoni: nessun arrivo prima della partenza precedente.
 *
 * Modulo PURO (nessun accesso al DB) per essere verificabile a tavolino.
 */

export interface SeqStop {
  stopId: string;
  /** progressiva lungo il percorso in metri (se nota) */
  shapeDistTraveled?: number | null;
}

export interface StopTimeRow {
  stopId: string;
  arrivalSec: number;
  departureSec: number;
  pickupType?: number;
  dropOffType?: number;
  timepoint?: number;
  shapeDistTraveled?: number | null;
}

export interface RealignResult {
  /** nuove righe in ordine di sequenza; null = corsa non rimodulabile */
  rows: StopTimeRow[] | null;
  kept: number;
  dropped: number;
  added: number;
  /** false = la corsa era già allineata: nessuna scrittura da fare */
  changed: boolean;
}

export function realignStopTimes(seq: SeqStop[], old: StopTimeRow[]): RealignResult {
  const n = seq.length;
  if (n === 0 || old.length === 0) {
    return { rows: null, kept: 0, dropped: 0, added: 0, changed: false };
  }
  // Abbinamento CRONOLOGICO: si scorre la nuova sequenza e gli orari vecchi in
  // avanti insieme, agganciando ogni fermata al PROSSIMO transito con quello
  // stesso id. Così un percorso ad anello (che ripassa sulla stessa fermata)
  // aggancia il passaggio giusto: togliendo la prima A, la A rimasta prende
  // l'orario del SECONDO passaggio, non del primo. Un abbinamento "per coda"
  // avrebbe restituito orari all'indietro.
  let cursor = 0;
  const kept: (StopTimeRow | null)[] = seq.map(s => {
    for (let j = cursor; j < old.length; j++) {
      if (old[j].stopId === s.stopId) { cursor = j + 1; return old[j]; }
    }
    return null; // fermata nuova (o spostata prima di un transito già consumato)
  });
  const knownIdx: number[] = [];
  kept.forEach((r, i) => { if (r) knownIdx.push(i); });
  const keptCount = knownIdx.length;
  const dropped = old.length - keptCount;
  const added = n - keptCount;
  if (keptCount < 2) {
    // troppo poco per ricostruire un orario credibile: meglio non toccare nulla
    return { rows: null, kept: keptCount, dropped, added, changed: false };
  }

  const arr: number[] = new Array(n).fill(NaN);
  const dep: number[] = new Array(n).fill(NaN);
  for (const i of knownIdx) {
    arr[i] = kept[i]!.arrivalSec;
    dep[i] = kept[i]!.departureSec;
  }

  const distOf = (i: number) => {
    const d = seq[i]?.shapeDistTraveled;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  };
  const first = knownIdx[0], last = knownIdx[knownIdx.length - 1];

  // Passo medio della parte nota: secondi per metro se le progressive ci sono,
  // altrimenti secondi per fermata.
  const dFirst = distOf(first), dLast = distOf(last);
  const spanSec = Math.max(0, arr[last] - dep[first]);
  const secPerMeter = dFirst != null && dLast != null && dLast > dFirst
    ? spanSec / (dLast - dFirst)
    : null;
  const secPerStop = last > first ? spanSec / (last - first) : 60;

  /** tempo stimato per andare dalla fermata i alla j (j>i) */
  const gapSec = (i: number, j: number): number => {
    const di = distOf(i), dj = distOf(j);
    if (secPerMeter != null && di != null && dj != null && dj > di) {
      return (dj - di) * secPerMeter;
    }
    return (j - i) * secPerStop;
  };

  // 1) buchi INTERNI: interpolazione tra i due transiti noti che li circondano
  for (let k = 0; k < knownIdx.length - 1; k++) {
    const a = knownIdx[k], b = knownIdx[k + 1];
    if (b - a <= 1) continue;
    const t0 = dep[a], t1 = arr[b];
    const total = Math.max(0, t1 - t0);
    // pesi: progressive se ci sono per TUTTO il tratto, altrimenti uniformi
    const dA = distOf(a), dB = distOf(b);
    const useDist = dA != null && dB != null && dB > dA
      && Array.from({ length: b - a - 1 }, (_v, x) => distOf(a + 1 + x)).every(d => d != null);
    for (let i = a + 1; i < b; i++) {
      const w = useDist ? (distOf(i)! - dA!) / (dB! - dA!) : (i - a) / (b - a);
      const t = Math.round(t0 + total * w);
      arr[i] = t; dep[i] = t; // fermata aggiunta: nessuna sosta inventata
    }
  }
  // 2) TESTA: fermate nuove prima del primo transito noto
  for (let i = first - 1; i >= 0; i--) {
    const t = Math.round(arr[i + 1] - gapSec(i, i + 1));
    arr[i] = t; dep[i] = t;
  }
  // 3) CODA: fermate nuove dopo l'ultimo transito noto
  for (let i = last + 1; i < n; i++) {
    const t = Math.round(dep[i - 1] + gapSec(i - 1, i));
    arr[i] = t; dep[i] = t;
  }
  // 4) niente orari negativi e sequenza monotona (arrivo mai prima della
  //    partenza precedente): l'estrapolazione in testa può sforare la mezzanotte
  if (arr[0] < 0) {
    const shift = -arr[0];
    for (let i = 0; i < n; i++) { arr[i] += shift; dep[i] += shift; }
  }
  for (let i = 0; i < n; i++) {
    if (dep[i] < arr[i]) dep[i] = arr[i];
    if (i > 0 && arr[i] < dep[i - 1]) { arr[i] = dep[i - 1]; if (dep[i] < arr[i]) dep[i] = arr[i]; }
  }

  const rows: StopTimeRow[] = seq.map((s, i) => {
    const src = kept[i];
    return {
      stopId: s.stopId,
      arrivalSec: arr[i],
      departureSec: dep[i],
      pickupType: src?.pickupType ?? 0,
      dropOffType: src?.dropOffType ?? 0,
      timepoint: src?.timepoint ?? (src ? 1 : 0), // le fermate stimate non sono timepoint
      shapeDistTraveled: s.shapeDistTraveled ?? null,
    };
  });

  const sameShape = old.length === n
    && old.every((r, i) => r.stopId === seq[i].stopId
      && r.arrivalSec === rows[i].arrivalSec && r.departureSec === rows[i].departureSec);
  return { rows, kept: keptCount, dropped, added, changed: !sameShape };
}
