/** I conti della pagina Oggi (pages/oggi.tsx), senza React: si provano da soli. */

/** La data di oggi a Roma, AAAA-MM-GG (il roster ragiona per giorno italiano). */
export function oggiARoma(adesso = new Date()): string {
  return adesso.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
}

export interface Kpi {
  vehiclesActive: number; tripsActive: number;
  onTimePct: number | null; avgDelaySeconds: number | null;
}
export interface ServizioLive { caronteAvailable?: boolean; kpis?: Kpi }

export interface TabelloneGiorno {
  pubblicati?: Record<string, Array<{ dssId: string; udpNome: string | null }>>;
  dutiesByDss?: Record<string, Array<{ code: string }>>;
  assignments?: Array<{ day: string; dssId: string; dutyCode: string }>;
  entries?: Array<{ day: string; category: string }>;
  violazioni?: unknown[];
}

/** Turni del giorno dal tabellone: pubblicati, assegnati, scoperti, assenze. */
export function riassuntoTurni(b: TabelloneGiorno, giorno: string) {
  const presi = new Set((b.assignments ?? []).filter(a => a.day === giorno).map(a => `${a.dssId}|${a.dutyCode}`));
  let pubblicati = 0, scoperti = 0;
  for (const p of b.pubblicati?.[giorno] ?? []) {
    for (const d of b.dutiesByDss?.[p.dssId] ?? []) {
      pubblicati++;
      if (!presi.has(`${p.dssId}|${d.code}`)) scoperti++;
    }
  }
  return {
    pubblicati,
    assegnati: presi.size,
    scoperti,
    assenze: (b.entries ?? []).filter(e => e.day === giorno && e.category === "assenza").length,
    violazioni: (b.violazioni ?? []).length,
    unita: (b.pubblicati?.[giorno] ?? []).length,
  };
}
