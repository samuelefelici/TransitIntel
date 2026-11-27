/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA SOSTA MINIMA AL CAPOLINEA — un dato del progetto, le regole
 * ───────────────────────────────────────────────────────────────────────────
 * Lo scheduler concatenava due corse allo stesso capolinea anche con 0′ di
 * sosta (i 3′ fissi del codice valevano solo fra fermate diverse): la 22/24
 * che arriva a Brecce Bianche alle 08:10 e riparte alle 08:10 era un giro
 * buono. Cavour, dove si regola, e un capolinea periferico avevano lo stesso
 * margine: nessuno.
 *
 * Qui la sosta minima diventa un dato, in minuti (0–60):
 *   · della FERMATA di capolinea (ps_stops.attributes.sostaMinimaMin),
 *   · del NODO, per tutte le sue fermate (ps_stop_clusters.attributes),
 *   · del PROGETTO, per tutti gli altri capolinea
 *     (ps_projects.agency_settings.sostaMinimaCapolineaMin).
 * Vince il più specifico: fermata, poi nodo, poi progetto. Senza nessuno
 * dei tre il giro resta com'era (0′ allo stesso capolinea).
 *
 * Funzioni pure: le letture e le rotte stanno in soste-minime-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const SOSTA_MINIMA_MAX = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un valore di sosta: intero 0–60, null = togli; undefined = non valido. */
export function minutiSosta(x: unknown): number | null | undefined {
  if (x === null) return null;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > SOSTA_MINIMA_MAX) return undefined;
  return x;
}

export interface ModificheSoste {
  /** undefined = non si tocca; null = si toglie */
  predefinitaMin?: number | null;
  nodi: { id: string; minuti: number | null }[];
  fermate: { id: string; minuti: number | null }[];
}

/** Il corpo del PUT: fail closed su ogni valore o id non valido. */
export function leggiModificheSoste(body: unknown): { ok: true; m: ModificheSoste } | { ok: false; errore: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const m: ModificheSoste = { nodi: [], fermate: [] };
  if ("predefinitaMin" in b) {
    const v = minutiSosta(b.predefinitaMin);
    if (v === undefined) return { ok: false, errore: `predefinitaMin: un intero da 0 a ${SOSTA_MINIMA_MAX}, o null per toglierla` };
    m.predefinitaMin = v;
  }
  for (const [chiave, dove] of [["nodi", m.nodi], ["fermate", m.fermate]] as const) {
    const lista = b[chiave];
    if (lista === undefined) continue;
    if (!Array.isArray(lista) || lista.length > 500) return { ok: false, errore: `${chiave}: un elenco (al massimo 500)` };
    const visti = new Set<string>();
    for (const x of lista) {
      const id = String((x as any)?.id ?? "").toLowerCase();
      const v = minutiSosta((x as any)?.minuti);
      if (!UUID.test(id)) return { ok: false, errore: `${chiave}: id non valido` };
      if (v === undefined) return { ok: false, errore: `${chiave}: minuti da 0 a ${SOSTA_MINIMA_MAX}, o null per toglierla` };
      if (visti.has(id)) return { ok: false, errore: `${chiave}: id ripetuto` };
      visti.add(id);
      dove.push({ id, minuti: v });
    }
  }
  if (m.predefinitaMin === undefined && !m.nodi.length && !m.fermate.length) return { ok: false, errore: "niente da cambiare" };
  return { ok: true, m };
}

export interface SosteDelProgetto {
  predefinita: number | null;
  perFermata: Map<string, number>;
  perNodo: Map<string, number>;
  /** fermata → nodo */
  nodoDi: Map<string, string>;
}

export type FonteSosta = "fermata" | "nodo" | "progetto";

/** La sosta minima di una fermata di capolinea, e da dove viene (null = nessun dato). */
export function sostaEffettiva(stopId: string, s: SosteDelProgetto): { minuti: number; fonte: FonteSosta } | null {
  const f = s.perFermata.get(stopId);
  if (f !== undefined) return { minuti: f, fonte: "fermata" };
  const nodo = s.nodoDi.get(stopId);
  const n = nodo ? s.perNodo.get(nodo) : undefined;
  if (n !== undefined) return { minuti: n, fonte: "nodo" };
  return s.predefinita != null ? { minuti: s.predefinita, fonte: "progetto" } : null;
}

/** Per il solver: le soste delle fermate indicate (solo quelle con un dato). */
export function sostePerFermate(stopIds: Iterable<string>, s: SosteDelProgetto): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of stopIds) {
    const e = sostaEffettiva(id, s);
    if (e) out[id] = e.minuti;
  }
  return out;
}
