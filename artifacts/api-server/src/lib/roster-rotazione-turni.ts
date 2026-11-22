/**
 * La rotazione dei turni (PR 7.8, migrazione 0061): la regola, senza database.
 *
 * Un gruppo di rotazione (roster_gruppi_turni) ha N posti; ogni posto dice
 * quale turno guida si fa nei giorni feriali, il sabato e la domenica (o
 * festivo). Ogni conducente del gruppo ha una posizione (1, 2, …). Il tempo
 * è diviso in periodi secondo la cadenza del deposito:
 *   - settimanale: da lunedì a domenica;
 *   - semimensile: dal 1° al 15 e dal 16 alla fine del mese.
 * Nel periodo della data di riferimento del gruppo la posizione p è sul posto
 * p; a ogni periodo dopo, ognuno passa al posto successivo (dall'ultimo si
 * torna al primo).
 *
 * Il turno del giorno si assegna solo se quel giorno il conducente è libero
 * (in servizio, senza voci né altri turni), se il posto ha un turno per quel
 * tipo di giorno, se quel codice è pubblicato quel giorno in un solo turno
 * guida e se nessun altro ce l'ha già. Il resto si dice, col motivo.
 */
export type Cadenza = "settimanale" | "semimensile";
export type TipoGiorno = "feriale" | "sabato" | "domenica";

export interface Posto { feriale: string | null; sabato: string | null; domenica: string | null }

const MS_GIORNO = 86_400_000;
const utc = (g: string) => Date.parse(`${g}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Il primo giorno del periodo che contiene `giorno`. */
export function inizioPeriodo(giorno: string, cadenza: Cadenza): string {
  if (cadenza === "semimensile") return `${giorno.slice(0, 8)}${Number(giorno.slice(8, 10)) <= 15 ? "01" : "16"}`;
  const t = utc(giorno);
  return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * MS_GIORNO);
}

/** Quanti periodi ci sono fra il periodo di `riferimento` e quello di `giorno` (negativo prima). */
export function periodiFra(riferimento: string, giorno: string, cadenza: Cadenza): number {
  if (cadenza === "semimensile") {
    const meta = (g: string) => (Number(g.slice(0, 4)) * 12 + Number(g.slice(5, 7)) - 1) * 2 + (Number(g.slice(8, 10)) <= 15 ? 0 : 1);
    return meta(giorno) - meta(riferimento);
  }
  return Math.round((utc(inizioPeriodo(giorno, cadenza)) - utc(inizioPeriodo(riferimento, cadenza))) / (7 * MS_GIORNO));
}

/** Il posto (1…n) della posizione `posizione` dopo `periodi` periodi. */
export function postoDi(posizione: number, periodi: number, n: number): number {
  return (((posizione - 1 + periodi) % n) + n) % n + 1;
}

export interface MembroRotazione {
  id: string;
  nome: string;
  posizione: number | null;
  /** i giorni in cui può ricevere un turno: in servizio, senza voci, senza altri turni */
  liberi: Set<string>;
}

export interface TurnoTrovato { dssId: string; codice: string }
export type Ricerca = TurnoTrovato | "non_pubblicato" | "ambiguo";

export interface AssegnazioneProposta { giorno: string; driverId: string; nome: string; posto: number; codice: string; dssId: string }
export type MotivoNonFatta = "non_pubblicato" | "ambiguo" | "gia_assegnato" | "senza_posizione" | "posizione_oltre";
export interface NonFatta { giorno: string | null; driverId: string; nome: string; posto: number | null; codice: string | null; motivo: MotivoNonFatta }

export interface Ingresso {
  posti: Posto[];
  membri: MembroRotazione[];
  giorni: string[];
  riferimento: string;
  cadenza: Cadenza;
  tipoDi: (giorno: string) => TipoGiorno;
  /** il turno pubblicato quel giorno con quel codice */
  cerca: (giorno: string, codice: string) => Ricerca;
  /** chi ha già quel turno quel giorno (null se nessuno) */
  occupato: (giorno: string, t: TurnoTrovato) => string | null;
}

/** La proposta: le assegnazioni della rotazione nei giorni dati, e quelle che non si possono fare. */
export function rotazione(x: Ingresso): { assegnazioni: AssegnazioneProposta[]; nonFatte: NonFatta[] } {
  const n = x.posti.length;
  const assegnazioni: AssegnazioneProposta[] = [];
  const nonFatte: NonFatta[] = [];
  if (!n) return { assegnazioni, nonFatte };
  const presi = new Set<string>();
  const membri = [...x.membri].sort((a, b) => (a.posizione ?? 1e9) - (b.posizione ?? 1e9) || a.nome.localeCompare(b.nome, "it"));
  for (const m of membri) {
    if (m.posizione === null) { nonFatte.push({ giorno: null, driverId: m.id, nome: m.nome, posto: null, codice: null, motivo: "senza_posizione" }); continue; }
    if (m.posizione > n) { nonFatte.push({ giorno: null, driverId: m.id, nome: m.nome, posto: null, codice: null, motivo: "posizione_oltre" }); continue; }
  }
  for (const g of [...x.giorni].sort()) {
    const k = periodiFra(x.riferimento, g, x.cadenza);
    const tipo = x.tipoDi(g);
    for (const m of membri) {
      if (m.posizione === null || m.posizione > n || !m.liberi.has(g)) continue;
      const posto = postoDi(m.posizione, k, n);
      const codice = x.posti[posto - 1]![tipo];
      if (!codice) continue;
      const trovato = x.cerca(g, codice);
      if (trovato === "non_pubblicato" || trovato === "ambiguo") {
        nonFatte.push({ giorno: g, driverId: m.id, nome: m.nome, posto, codice, motivo: trovato });
        continue;
      }
      const chiave = `${g}|${trovato.dssId}|${trovato.codice}`;
      const altro = x.occupato(g, trovato);
      if (presi.has(chiave) || (altro && altro !== m.id)) {
        nonFatte.push({ giorno: g, driverId: m.id, nome: m.nome, posto, codice, motivo: "gia_assegnato" });
        continue;
      }
      presi.add(chiave);
      assegnazioni.push({ giorno: g, driverId: m.id, nome: m.nome, posto, codice: trovato.codice, dssId: trovato.dssId });
    }
  }
  return { assegnazioni, nonFatte };
}
