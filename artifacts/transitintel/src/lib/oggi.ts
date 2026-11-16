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
  entries?: Array<{ day: string; driverId: string; category: string; code: string }>;
  /** forzata: assegnata lo stesso, sapendolo (il roster la mostra a parte) */
  violazioni?: Array<{ forzata?: boolean }>;
}

/** Il riposo della rotazione è una voce di assenza nel catalogo, ma non è una persona che manca. */
const RIPOSO = "R";

/** Turni del giorno dal tabellone: pubblicati, assegnati, scoperti; persone assenti e a riposo. */
export function riassuntoTurni(b: TabelloneGiorno, giorno: string) {
  const presi = new Set((b.assignments ?? []).filter(a => a.day === giorno).map(a => `${a.dssId}|${a.dutyCode}`));
  let pubblicati = 0, scoperti = 0;
  for (const p of b.pubblicati?.[giorno] ?? []) {
    for (const d of b.dutiesByDss?.[p.dssId] ?? []) {
      pubblicati++;
      if (!presi.has(`${p.dssId}|${d.code}`)) scoperti++;
    }
  }
  const voci = (b.entries ?? []).filter(e => e.day === giorno && e.category === "assenza");
  return {
    pubblicati,
    assegnati: presi.size,
    scoperti,
    /* per persona: due voci dello stesso conducente nello stesso giorno sono un'assenza */
    assenze: new Set(voci.filter(e => e.code !== RIPOSO).map(e => e.driverId)).size,
    riposi: new Set(voci.filter(e => e.code === RIPOSO).map(e => e.driverId)).size,
    /* quelle già forzate il roster le mostra a parte, non da controllare */
    violazioni: (b.violazioni ?? []).filter(v => !v.forzata).length,
    unita: (b.pubblicati?.[giorno] ?? []).length,
  };
}

/** La giornata di esercizio in breve (GET /api/esercizio/oggi, tappa 4.9). */
export interface EsercizioInBreve {
  giorno: string;
  giornata: null | {
    stato: "preparata" | "congelata" | "chiusa"; ricostruita: boolean; chiusaIl: string | null;
    programmate: number; effettuate: number; presunte: number; parziali: number; soppresse: number;
    daDecidere: number; daVerificare: number; aggiunte: number;
    /** null finché l'AVM non ha fatto una proposta */
    visteAvm: number | null; quotaVisteAvm: number | null;
  };
  daChiudere: { totale: number; giorni: Array<{ giorno: string; stato: string }> };
}

/** Il riquadro del consuntivo: come dire lo stato della giornata, e le giornate rimaste aperte. */
export function riassuntoEsercizio(d: EsercizioInBreve) {
  const g = d.giornata;
  /* la giornata si congela al suo inizio (le 03:00): prima è solo preparata */
  const stato = !g ? null : g.stato === "chiusa" ? "chiusa" : g.stato === "congelata" ? "in corso" : "non ancora cominciata";
  return {
    stato,
    confermate: g ? g.programmate - g.daDecidere : 0,
    daChiudere: d.daChiudere.totale,
    /* la più vecchia: le giornate arrivano in ordine di data */
    dal: d.daChiudere.giorni[0]?.giorno ?? null,
  };
}
