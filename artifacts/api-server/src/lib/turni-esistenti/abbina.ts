/**
 * L'abbinamento delle corse del file dei turni con le corse del GTFS del
 * progetto (tappa 7.38).
 *
 * 1. Per numero: il file indica ogni corsa con un numero, lo stesso che chiude
 *    il codice della corsa nel GTFS dell'azienda («…_700123»). Nei feed nati da
 *    Planning Studio il codice originale è il `codice` della corsa del progetto.
 * 2. Per linea e orario, se il numero non c'è: stessa linea, stessa partenza e
 *    arrivo entro 3 minuti. Una corsa del GTFS va a una sola corsa del file.
 *
 * Funzioni pure: le corse del GTFS le passa chi chiama.
 */
import { PEZZO, type PezzoFile, type TurnoGuidaFile } from "./file";

export interface CorsaGtfs {
  tripId: string;
  /** il codice originale della corsa (dal GTFS caricato); null se non c'è */
  codice: string | null;
  /** il nome breve della linea */
  linea: string;
  partenza: number;
  arrivo: number;
}

export type Come = "numero" | "orario";

export interface CorsaDelFile {
  corsa: string;
  linea: string | null;
  partenza: number;
  arrivo: number;
  da: string;
  a: string;
  turnoMacchina: string | null;
  turnoGuida: string;
}

export interface Abbinamento {
  /** numero della corsa del file → corsa del GTFS */
  perCorsa: Map<string, { tripId: string; come: Come }>;
  /** le corse del file che non si trovano nel GTFS */
  nonTrovate: CorsaDelFile[];
  perNumero: number;
  perOrario: number;
}

/** Il numero che chiude un codice («9_Ab:Z1_700123» → «700123»), senza zeri davanti. */
export function numeroDellaCorsa(codice: string | null | undefined): string | null {
  const m = /(\d+)\s*$/.exec(String(codice ?? ""));
  if (!m) return null;
  return m[1]!.replace(/^0+(?=\d)/, "");
}

export function lineaNormale(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/\s+/g, "");
}

/** Le corse del file in un insieme di turni guida: una per numero, con la prima e l'ultima ora viste. */
export function corseDelFile(turni: TurnoGuidaFile[]): CorsaDelFile[] {
  const per = new Map<string, CorsaDelFile>();
  for (const t of turni) {
    for (const p of t.pezzi) {
      if (p.tipo !== PEZZO.inLinea || !p.corsa) continue;
      const c = per.get(p.corsa);
      if (!c) {
        per.set(p.corsa, {
          corsa: p.corsa, linea: p.linea, partenza: p.partenza, arrivo: p.arrivo,
          da: p.da, a: p.a, turnoMacchina: p.turnoMacchina, turnoGuida: t.codice,
        });
      } else {
        // la stessa corsa in due pezzi (cambio del conducente a metà corsa): tutta la corsa
        if (p.partenza < c.partenza) { c.partenza = p.partenza; c.da = p.da; }
        if (p.arrivo > c.arrivo) { c.arrivo = p.arrivo; c.a = p.a; }
      }
    }
  }
  return [...per.values()];
}

export function abbinaCorse(corse: CorsaDelFile[], gtfs: CorsaGtfs[]): Abbinamento {
  const perNumeroGtfs = new Map<string, CorsaGtfs[]>();
  const perLinea = new Map<string, CorsaGtfs[]>();
  for (const g of gtfs) {
    const n = numeroDellaCorsa(g.codice ?? g.tripId);
    if (n) { const v = perNumeroGtfs.get(n) ?? []; v.push(g); perNumeroGtfs.set(n, v); }
    const l = lineaNormale(g.linea);
    const v = perLinea.get(l) ?? []; v.push(g); perLinea.set(l, v);
  }
  const usate = new Set<string>();
  const out: Abbinamento = { perCorsa: new Map(), nonTrovate: [], perNumero: 0, perOrario: 0 };
  const daFare: CorsaDelFile[] = [];

  // 1. per numero (se più corse del GTFS hanno lo stesso numero, vince quella che parte alla stessa ora)
  for (const c of corse) {
    const cand = (perNumeroGtfs.get(numeroDellaCorsa(c.corsa) ?? "") ?? []).filter((g) => !usate.has(g.tripId));
    let scelta: CorsaGtfs | undefined;
    if (cand.length === 1) scelta = cand[0];
    else if (cand.length > 1) {
      scelta = cand.find((g) => Math.abs(g.partenza - c.partenza) <= 2)
        ?? cand.find((g) => lineaNormale(g.linea) === lineaNormale(c.linea));
    }
    if (scelta) {
      usate.add(scelta.tripId);
      out.perCorsa.set(c.corsa, { tripId: scelta.tripId, come: "numero" });
      out.perNumero++;
    } else {
      daFare.push(c);
    }
  }

  // 2. per linea e orario
  for (const c of daFare) {
    const cand = (perLinea.get(lineaNormale(c.linea)) ?? [])
      .filter((g) => !usate.has(g.tripId) && g.partenza === c.partenza && Math.abs(g.arrivo - c.arrivo) <= 3)
      .sort((a, b) => Math.abs(a.arrivo - c.arrivo) - Math.abs(b.arrivo - c.arrivo));
    const scelta = cand[0];
    if (scelta) {
      usate.add(scelta.tripId);
      out.perCorsa.set(c.corsa, { tripId: scelta.tripId, come: "orario" });
      out.perOrario++;
    } else {
      out.nonTrovate.push(c);
    }
  }
  out.nonTrovate.sort((a, b) => lineaNormale(a.linea).localeCompare(lineaNormale(b.linea), "it", { numeric: true }) || a.partenza - b.partenza);
  return out;
}

/** Un pezzo in linea è riconosciuto se la sua corsa lo è. */
export function pezzoRiconosciuto(p: PezzoFile, a: Abbinamento): string | null {
  return p.tipo === PEZZO.inLinea && p.corsa ? a.perCorsa.get(p.corsa)?.tripId ?? null : null;
}
