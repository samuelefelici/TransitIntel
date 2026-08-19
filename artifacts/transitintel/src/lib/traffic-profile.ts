/**
 * Profilo TRAFFICO condiviso della zona Percorrenze (e di chi genera corse):
 * coefficienti di rallentamento per fascia oraria, distinti per gruppo-giorno,
 * e la matematica comune «archi scalati per la fascia d'ingresso» usata sia
 * dalla moltiplicazione a cadenza sia dal ricalcolo delle percorrenze.
 * Stessa formula del server (trips/generate e trips/retime): l'anteprima
 * client corrisponde esattamente a ciò che verrà salvato.
 */

/** Gruppo-giorno del profilo traffico. */
export type TrafficGroup = "feriale" | "sabato" | "domenica";

export const TRAFFIC_GROUP_LABEL: Record<TrafficGroup, string> = {
  feriale: "Lun–Ven", sabato: "Sabato", domenica: "Domenica",
};

/** Profilo di default dei coefficienti di rallentamento per fascia oraria,
 * distinto per gruppo-giorno (il traffico è molto diverso tra feriale, sabato e
 * domenica). Proposta modificabile in anteprima. */
export function defaultCoeffForHour(h: number, group: TrafficGroup = "feriale"): number {
  const hh = ((h % 24) + 24) % 24;
  if (group === "domenica") {
    // domenica: traffico quasi assente, lievissimi picchi tarda mattina/sera
    if (hh === 11 || hh === 19) return 1.05;
    return 1.0;
  }
  if (group === "sabato") {
    // sabato: niente picco pendolare, picco commerciale mattina + pomeriggio
    if (hh === 10 || hh === 11) return 1.12;
    if (hh === 17 || hh === 18) return 1.15;
    if (hh === 12 || hh === 16 || hh === 19) return 1.08;
    return 1.0;
  }
  // feriale (lun-ven): picchi pendolari mattina e sera
  if (hh === 7 || hh === 8) return 1.25;
  if (hh === 18) return 1.3;
  if (hh === 17) return 1.2;
  if (hh === 9 || hh === 13) return 1.15;
  if (hh === 12 || hh === 14 || hh === 19) return 1.1;
  return 1.0;
}

/* Conversioni orario GTFS (consentono >24:00 per corse dopo mezzanotte) */
export function ttToSec(t: string): number {
  const q = t.split(":").map(Number);
  return (q[0] || 0) * 3600 + (q[1] || 0) * 60 + (q[2] || 0);
}
export function ttSecToHms(x: number): string {
  const s = Math.max(0, Math.round(x));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Orari finali di una corsa ancorata a `dep`: archi del profilo relativo
 * (relArr/relDep, ancorati alla prima partenza del riferimento) scalati per
 * il coefficiente della fascia oraria in cui il bus ENTRA nell'arco.
 * `coeffByHour` null/vuoto = nessuna variazione. Identica al server. */
export function scaleRunTimes(
  dep: number,
  relArr: number[],
  relDep: number[],
  coeffByHour: Record<number, number> | null,
): { arr: number[]; dep: number[] } {
  const n = relArr.length;
  const arr: number[] = new Array(n), depT: number[] = new Array(n);
  arr[0] = dep + relArr[0];
  depT[0] = dep + relDep[0];
  for (let i = 1; i < n; i++) {
    const arcSec = relArr[i] - relDep[i - 1];
    const dwell = relDep[i] - relArr[i];
    const c = coeffByHour ? (coeffByHour[Math.floor(depT[i - 1] / 3600)] ?? 1) : 1;
    arr[i] = depT[i - 1] + Math.round(arcSec * c);
    depT[i] = arr[i] + dwell;
  }
  return { arr, dep: depT };
}
