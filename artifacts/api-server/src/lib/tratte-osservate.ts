/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE TRATTE OSSERVATE — le regole del calcolo unico
 * ───────────────────────────────────────────────────────────────────────────
 * Un solo modo di trasformare i passaggi SIRI in tempi di percorrenza fra
 * fermate consecutive, usato dalla pagina «Tempi di percorrenza», da Planning
 * Studio e da Argos: tre calcoli diversi davano tre numeri diversi per la
 * stessa tratta, e nessuno sapeva quale fosse quello giusto.
 *
 * Qui stanno le regole pure (collaudabili senza database); la lettura è in
 * tratte-osservate-db.ts.
 *
 * ── La sosta di regolazione ──
 * SIRI registra a ogni fermata l'ARRIVO del mezzo (il primo rilevamento nel
 * raggio). Il tempo fra due arrivi contiene quindi la sosta alla fermata di
 * partenza. Di solito è la salita e discesa dei passeggeri, e fa parte del
 * viaggio; ma dove i bus si fermano a regolare — Piazza Cavour è il caso
 * vero: +4′ misurati su un tratto da 51″ — la sosta è un'attesa, non un
 * tempo che serve per andare da A a B. Dal GPS si ricava quando il mezzo è
 * davvero ripartito; la sosta fino a SOSTA_NORMALE_S resta nel tratto,
 * l'eccedenza si toglie e si dichiara.
 *
 * ── Le fasce orarie ──
 * Il tempo di un tratto dipende dall'ora: le ore di punta non sono la
 * morbida. Si usa l'ora della corsa quando ha abbastanza campioni, altrimenti
 * la sua fascia, e solo in ultimo la giornata intera.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from "drizzle-orm";

/** La sosta che resta nel tratto: oltre questa è regolazione, non viaggio. */
export const SOSTA_NORMALE_S = 60;

/** Entro quanti metri dalla fermata il mezzo è considerato ancora lì. */
export const RAGGIO_SOSTA_M = 30;

/** Le fasce orarie, contigue e senza buchi (0–24; dopo mezzanotte = notte). */
export const FASCE = [
  { codice: "notte", etichetta: "Notte e primo mattino (0–6)", da: 0, a: 6 },
  { codice: "punta_mattino", etichetta: "Punta del mattino (6–9)", da: 6, a: 9 },
  { codice: "morbida", etichetta: "Morbida (9–13)", da: 9, a: 13 },
  { codice: "pranzo", etichetta: "Pranzo (13–16)", da: 13, a: 16 },
  { codice: "punta_pomeriggio", etichetta: "Punta del pomeriggio (16–19)", da: 16, a: 19 },
  { codice: "sera", etichetta: "Sera (19–24)", da: 19, a: 24 },
] as const;

export type CodiceFascia = (typeof FASCE)[number]["codice"];

/** La fascia di un'ora. Le ore oltre le 24 del GTFS (24:20 = 00:20 della
 *  giornata dopo) cadono nella notte, come le 0–6. */
export function fasciaDi(ora: number): CodiceFascia {
  const h = ((Math.floor(ora) % 24) + 24) % 24;
  return (FASCE.find(f => h >= f.da && h < f.a) ?? FASCE[0]).codice;
}

export function etichettaFascia(codice: string | null | undefined): string | null {
  return FASCE.find(f => f.codice === codice)?.etichetta ?? null;
}

/** La stessa regola di fasciaDi, in SQL, su una colonna ora (0–23). Generata
 *  da FASCE: una definizione sola, due linguaggi. */
export function fasciaSql(ora: SQL): SQL {
  const rami = FASCE.map(f => sql`WHEN ${ora} >= ${f.da} AND ${ora} < ${f.a} THEN ${f.codice}`);
  return sql`(CASE ${sql.join(rami, sql` `)} ELSE ${FASCE[0].codice} END)`;
}

/** La parte di sosta che non è viaggio. */
export function sostaEccedente(sostaS: number | null | undefined): number {
  if (sostaS == null || !Number.isFinite(sostaS)) return 0;
  return Math.max(0, sostaS - SOSTA_NORMALE_S);
}

/** Le giornate di esercizio di una finestra che finisce oggi (compreso). */
export function giornateFinestra(oggi: string, giorni: number): string[] {
  const n = Math.min(Math.max(Math.floor(giorni) || 1, 1), 400);
  const fine = new Date(`${oggi}T12:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(fine - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Le giornate raggruppate per classe (scuole aperte feriale, domenica…),
 *  dalla più frequente. La classificazione arriva da fuori (calendario
 *  aziendale o civile): qui si raggruppa soltanto. */
export function classiDelleGiornate(
  date: string[], classifica: (giorno: string) => { key: string; label: string },
): Array<{ key: string; label: string; giorni: string[] }> {
  const per = new Map<string, { key: string; label: string; giorni: string[] }>();
  for (const d of date) {
    const c = classifica(d);
    let g = per.get(c.key);
    if (!g) { g = { key: c.key, label: c.label, giorni: [] }; per.set(c.key, g); }
    g.giorni.push(d);
  }
  return [...per.values()].sort((a, b) => b.giorni.length - a.giorni.length || a.label.localeCompare(b.label, "it"));
}
