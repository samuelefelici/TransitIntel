/**
 * I gestori (tappa 6.11, migrazione 0044): le aziende che gestiscono le
 * linee. Le regole, senza database.
 *
 * Chi programma può farlo per più aziende: un consorzio per i suoi
 * consorziati. Nei GTFS ogni gestore è un'agenzia (agency.txt) e ogni linea
 * è di uno di loro (routes.txt).
 *   - Una linea dice il suo gestore con l'identificativo (agency_id). Se non
 *     ne dice uno, o ne dice uno che non è nell'elenco, vale il predefinito.
 *   - Senza gestori vale per tutte le linee l'azienda dell'installazione
 *     (Amministrazione › Azienda), come prima.
 *   - agency.txt elenca solo i gestori che hanno almeno una linea.
 *
 * Questo modulo non importa niente: lo usano le rotte, il salvataggio
 * (lib/gestori-store.ts), i due GTFS e i test.
 */

export interface Gestore {
  /** l'identificativo: quello del GTFS (agency_id) e quello che sta sulle linee */
  gestore: string;
  nome: string;
  sito: string;
  telefono: string | null;
  email: string | null;
  /** la pagina delle tariffe (agency_fare_url) */
  tariffeUrl: string | null;
  /** il gestore delle linee che non ne dicono uno: al più uno */
  predefinito: boolean;
}

export const MASSIMO_GESTORI = 60;

/** Dell'azienda, quello che serve quando è lei l'agenzia. */
export interface AziendaPerIlGtfs {
  gtfsAgencyId: string;
  ragioneSociale: string;
  sito: string | null;
  telefono: string | null;
}

/** Le colonne di agency.txt, nell'ordine in cui si scrivono. */
export const COLONNE_AGENZIA = [
  "agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone", "agency_fare_url", "agency_email",
] as const;
export type AgenziaNelGtfs = Record<(typeof COLONNE_AGENZIA)[number], string> & {
  /** true se non è un gestore dell'elenco: è l'azienda dell'installazione */
  daAzienda: boolean;
};

const COMUNE = { agency_timezone: "Europe/Rome", agency_lang: "it" };

/** Un gestore come agenzia del GTFS. Un campo che manca resta vuoto: lo dice la validazione, non si inventa. */
export function agenziaDelGestore(g: Gestore): AgenziaNelGtfs {
  return {
    agency_id: g.gestore, agency_name: g.nome, agency_url: g.sito, ...COMUNE,
    agency_phone: g.telefono ?? "", agency_fare_url: g.tariffeUrl ?? "", agency_email: g.email ?? "",
    daAzienda: false,
  };
}

/** L'azienda dell'installazione come agenzia del GTFS: vale quando non ci sono gestori. */
export function agenziaDellAzienda(azienda: AziendaPerIlGtfs): AgenziaNelGtfs {
  return {
    agency_id: azienda.gtfsAgencyId, agency_name: azienda.ragioneSociale, agency_url: azienda.sito ?? "", ...COMUNE,
    agency_phone: azienda.telefono ?? "", agency_fare_url: "", agency_email: "",
    daAzienda: true,
  };
}

/** Il gestore predefinito: quello segnato; se nessuno lo è (non dovrebbe succedere), il primo. Null se l'elenco è vuoto. */
export function gestorePredefinito(gestori: readonly Gestore[]): Gestore | null {
  return gestori.find((g) => g.predefinito) ?? gestori[0] ?? null;
}

/**
 * Il gestore di una linea: il suo, se è nell'elenco; altrimenti il
 * predefinito, e `assegnato` dice di no. Null se non ci sono gestori.
 */
export function gestoreDellaLinea(agencyId: string | null | undefined, gestori: readonly Gestore[]): { gestore: Gestore; assegnato: boolean } | null {
  const suo = agencyId ? gestori.find((g) => g.gestore === agencyId) : undefined;
  if (suo) return { gestore: suo, assegnato: true };
  const p = gestorePredefinito(gestori);
  return p ? { gestore: p, assegnato: false } : null;
}

export interface AgenzieDelGtfs {
  /** le righe di agency.txt: almeno una */
  agenzie: AgenziaNelGtfs[];
  /** l'agenzia di una linea, da quello che la linea dice (agency_id) */
  dellaLinea: (agencyId: string | null | undefined) => AgenziaNelGtfs;
  /** l'agenzia di chi non ne dice una: il gestore predefinito, o l'azienda */
  principale: AgenziaNelGtfs;
}

/**
 * Le agenzie di un GTFS, dalle linee che contiene (`agenzieDelleLinee`: quello
 * che dice ogni linea). Con i gestori: solo quelli che hanno almeno una
 * linea, nell'ordine dell'elenco; senza linee, il predefinito. Senza gestori:
 * l'azienda, per tutte.
 */
export function agenzieDelGtfs(
  azienda: AziendaPerIlGtfs, gestori: readonly Gestore[], agenzieDelleLinee: readonly (string | null | undefined)[],
): AgenzieDelGtfs {
  const p = gestorePredefinito(gestori);
  if (!p) {
    const sola = agenziaDellAzienda(azienda);
    return { agenzie: [sola], dellaLinea: () => sola, principale: sola };
  }
  const perId = new Map(gestori.map((g) => [g.gestore, agenziaDelGestore(g)]));
  const principale = perId.get(p.gestore)!;
  const dellaLinea = (agencyId: string | null | undefined) => (agencyId ? perId.get(agencyId) : undefined) ?? principale;
  const usate = new Set(agenzieDelleLinee.map((a) => dellaLinea(a).agency_id));
  const agenzie = gestori.filter((g) => usate.has(g.gestore)).map((g) => perId.get(g.gestore)!);
  return { agenzie: agenzie.length ? agenzie : [principale], dellaLinea, principale };
}

/** agency.txt: l'intestazione e una riga per agenzia, ogni campo fra virgolette. */
export function agencyTxt(agenzie: readonly AgenziaNelGtfs[]): string {
  const tra = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${COLONNE_AGENZIA.join(",")}\n${agenzie.map((a) => COLONNE_AGENZIA.map((c) => tra(a[c])).join(",")).join("\n")}\n`;
}

/**
 * Delle righe (linee, corse, somme) raggruppate per gestore: `detto` è quello
 * che la riga dice (agency_id). I gruppi sono nell'ordine dell'elenco, solo
 * per i gestori che hanno righe; una riga che non dice un gestore dell'elenco
 * va al predefinito. Senza gestori non c'è niente da ripartire.
 */
export function raggruppaPerGestore<T>(
  righe: readonly T[], gestori: readonly Gestore[], detto: (r: T) => string | null | undefined,
): Array<{ gestore: Gestore; righe: T[] }> {
  const gruppi = new Map<string, T[]>();
  for (const r of righe) {
    const g = gestoreDellaLinea(detto(r), gestori);
    if (!g) return [];
    const mio = gruppi.get(g.gestore.gestore);
    if (mio) mio.push(r); else gruppi.set(g.gestore.gestore, [r]);
  }
  return gestori.filter((g) => gruppi.has(g.gestore)).map((g) => ({ gestore: g, righe: gruppi.get(g.gestore)! }));
}

/* ── L'elenco: che cosa non va ────────────────────────────────────────────── */

/** Con almeno un gestore, il predefinito è uno solo. Vuoto se va bene. */
export function erroriGestori(gestori: readonly Gestore[]): string[] {
  const e: string[] = [];
  const visti = new Set<string>();
  for (const g of gestori) { if (visti.has(g.gestore)) e.push(`Il gestore «${g.gestore}» compare due volte.`); visti.add(g.gestore); }
  const predefiniti = gestori.filter((g) => g.predefinito).length;
  if (gestori.length > 0 && predefiniti !== 1) e.push(predefiniti === 0 ? "Un gestore deve essere il predefinito." : "Il gestore predefinito è uno solo.");
  return e;
}
