/**
 * Il quadro orario è cambiato dopo il calcolo dei turni? — la parte pura.
 *
 * Il ciclo pianificazione → turni macchina → turni guida si chiudeva male: in
 * Planning si sposta una corsa, si ritocca un orario, se ne cancella una, e i
 * turni salvati in Fucina non se ne accorgono. Il confronto per `updated_at`
 * non poteva vederlo — `ps_trips.updated_at` si aggiorna SOLO per il
 * calendario, per scelta, e una cancellazione non lascia nessun updated_at.
 *
 * Il registro attività del progetto Planning (`ps_project_activity_log`)
 * invece riceve OGNI scrittura, anche quelle di Argos: è la fonte giusta. Qui
 * si decide quali azioni contano come «modifica al quadro orario» e come si
 * raccontano all'operatore («3 spostamenti · 1 cancellazione»). Niente DB:
 * la lettura la fa scheduling-projects.ts, il giudizio si prova qui.
 */

/** Un'azione del registro, ridotta all'essenziale. */
export interface ModificaDelQuadro {
  action: string;
  /** ISO */
  at: string;
}

/** Lo stato del quadro a livello di progetto: quando è cambiato l'ultima
 *  volta e se il pacchetto dati (feed materializzato) è più vecchio. */
export interface QuadroProgetto {
  psProjectId: string;
  /** ISO dell'ultima modifica al quadro (registro + timestamp tabelle) */
  modificatoIl: string | null;
  /** l'azione del registro che l'ha causata, se è lei la più recente */
  ultimaAzione: string | null;
  /** ISO della materializzazione del feed che il progetto usa */
  feedSincronizzatoIl: string | null;
  /** true = il feed è più vecchio dell'ultima modifica: ri-ottimizzare ora userebbe il quadro vecchio */
  feedSuperato: boolean;
}

/** Lo stato del quadro rispetto a un piano calcolato a `calcolatoIl`. */
export interface QuadroStato {
  /** true = almeno una modifica al quadro dopo il calcolo */
  superato: boolean;
  modificheDopo: number;
  /** ISO dell'ultima modifica dopo il calcolo (null se nessuna) */
  ultimaModificaIl: string | null;
  /** «3 spostamenti · 2 ritocchi d'orario · 1 cancellazione» */
  riassunto: string;
}

/**
 * Le azioni del registro che toccano il quadro orario. Stesso elenco usato
 * dalla SQL (vedi QUADRO_ACTIONS in scheduling-projects.ts): se cambi qui,
 * cambia anche lì.
 */
export function eModificaDelQuadro(action: string): boolean {
  return (
    action.startsWith("trip.")
    || action.startsWith("ps.trip")
    || action.startsWith("ps.calendar.")
    || action.startsWith("ps.variant.")
    || action.startsWith("validity.")
    || action === "ps.shape.save"
    || action === "ps.route.delete"
  );
}

type Famiglia =
  | "spostamenti" | "ritocchi d'orario" | "corse nuove" | "cancellazioni"
  | "validità e calendari" | "percorsi" | "altre modifiche";

/** Che cosa è stato fatto, in parole da operatore. */
export function famigliaDi(action: string): Famiglia {
  if (action === "trip.shift") return "spostamenti";
  if (action === "ps.trip.stop-times" || action === "ps.trips.stop-times-bulk"
      || action === "trip.retime_traffic") return "ritocchi d'orario";
  if (action === "ps.trip.create" || action === "trip.batch_create"
      || action === "trip.generate_headway" || action === "trip.prototype_missing"
      || action === "trip.blocks_from_scenario") return "corse nuove";
  if (action === "ps.trip.delete" || action === "trip.bulk_delete"
      || action === "trip.merge_twins") return "cancellazioni";
  if (action.startsWith("ps.calendar.") || action.startsWith("validity.")
      || action.startsWith("trip.exception.") || action === "trip.set_categories_bulk"
      || action === "trip.split_categories" || action === "trip.update"
      || action === "trip.bulk_update") return "validità e calendari";
  if (action.startsWith("ps.variant.") || action === "ps.shape.save"
      || action === "ps.route.delete") return "percorsi";
  return "altre modifiche";
}

/** Le famiglie che al singolare cambiano parola. */
const SINGOLARE: Partial<Record<Famiglia, string>> = {
  "spostamenti": "spostamento",
  "ritocchi d'orario": "ritocco d'orario",
  "corse nuove": "corsa nuova",
  "cancellazioni": "cancellazione",
  "altre modifiche": "altra modifica",
};

/**
 * Il giudizio: date le modifiche al quadro (qualunque ordine) e il momento
 * del calcolo, dice se il piano è superato e da che cosa. Le modifiche con
 * `at` uguale al calcolo non contano: sono la stessa transazione.
 */
export function quadroDiScenario(
  modifiche: ModificaDelQuadro[],
  calcolatoIl: string | Date | null | undefined,
): QuadroStato {
  const t0 = calcolatoIl ? new Date(calcolatoIl).getTime() : NaN;
  if (!Number.isFinite(t0)) {
    return { superato: false, modificheDopo: 0, ultimaModificaIl: null, riassunto: "" };
  }
  const dopo = modifiche.filter(m => {
    const t = new Date(m.at).getTime();
    return Number.isFinite(t) && t > t0 && eModificaDelQuadro(m.action);
  });
  if (dopo.length === 0) {
    return { superato: false, modificheDopo: 0, ultimaModificaIl: null, riassunto: "" };
  }
  const conteggi = new Map<Famiglia, number>();
  let ultima = -Infinity;
  for (const m of dopo) {
    const f = famigliaDi(m.action);
    conteggi.set(f, (conteggi.get(f) ?? 0) + 1);
    ultima = Math.max(ultima, new Date(m.at).getTime());
  }
  const voci = [...conteggi.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f, n]) => `${n} ${n === 1 ? (SINGOLARE[f] ?? f) : f}`);
  const fuori = conteggi.size - voci.length;
  return {
    superato: true,
    modificheDopo: dopo.length,
    ultimaModificaIl: new Date(ultima).toISOString(),
    riassunto: voci.join(" · ") + (fuori > 0 ? " · …" : ""),
  };
}

/** Il più recente fra più istanti ISO (null se nessuno è valido). */
export function piuRecente(...istanti: (string | null | undefined)[]): string | null {
  let best = -Infinity;
  for (const s of istanti) {
    if (!s) continue;
    const t = new Date(s).getTime();
    if (Number.isFinite(t) && t > best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}
