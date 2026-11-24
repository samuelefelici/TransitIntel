/**
 * I punti di riposo dei turni guida (tappa 7.22) nella pagina Azienda: il
 * modulo e il corpo per l'API (/api/admin/punti-riposo). Le regole vere sono
 * nell'API; qui solo quello che serve a scrivere bene il modulo.
 */

export interface PuntoDiRiposo {
  id: string;
  nome: string;
  conServizi: boolean;
  fermate: string[];
  nota: string;
  /** le fermate che non ci sono nel feed in esercizio: il calcolo non le troverà */
  fermateNonTrovate: string[];
}

export interface ModuloPunto {
  nome: string;
  conServizi: boolean;
  /** una fermata per riga, come la scrive il GTFS */
  fermate: string;
  nota: string;
}

export const MODULO_PUNTO_VUOTO: ModuloPunto = { nome: "", conServizi: false, fermate: "", nota: "" };

export const moduloPuntoDa = (p: PuntoDiRiposo): ModuloPunto =>
  ({ nome: p.nome, conServizi: p.conServizi, fermate: p.fermate.join("\n"), nota: p.nota });

/** Le fermate del modulo: una per riga (anche separate da punto e virgola), senza righe vuote né doppioni. */
export function fermateDelModulo(testo: string): string[] {
  const viste = new Set<string>();
  return testo.split(/[\n;]/).map((f) => f.trim()).filter((f) => {
    const k = f.toUpperCase();
    if (!f || viste.has(k)) return false;
    viste.add(k);
    return true;
  });
}

export const corpoPunto = (m: ModuloPunto) =>
  ({ nome: m.nome.trim(), conServizi: m.conServizi, fermate: fermateDelModulo(m.fermate), nota: m.nota.trim() });

/** Che cosa manca prima di salvare; vuoto se il modulo va bene. */
export function erroriPunto(m: ModuloPunto): string[] {
  const errori: string[] = [];
  if (!m.nome.trim()) errori.push("Scrivi il nome del luogo.");
  if (m.nome.trim().length > 120) errori.push("Il nome è al più di 120 caratteri.");
  const fermate = fermateDelModulo(m.fermate);
  if (fermate.length === 0) errori.push("Scrivi almeno una fermata: il calcolo riconosce il luogo dalle sue fermate.");
  if (fermate.length > 50) errori.push("Al più 50 fermate.");
  if (fermate.some((f) => f.length > 120)) errori.push("Il nome di una fermata è al più di 120 caratteri.");
  if (m.nota.trim().length > 300) errori.push("La nota è al più di 300 caratteri.");
  return errori;
}

/** Una fermata in più nel modulo (tappa 7.31, scelta dall'elenco): in fondo, se non c'è già. */
export function aggiungiFermata(testo: string, nome: string): string {
  const n = nome.trim();
  const ci = fermateDelModulo(testo);
  if (!n || ci.some((f) => f.toUpperCase() === n.toUpperCase())) return ci.join("\n");
  return [...ci, n].join("\n");
}

/** Una fermata in meno nel modulo. */
export const togliFermata = (testo: string, nome: string): string =>
  fermateDelModulo(testo).filter((f) => f.toUpperCase() !== nome.trim().toUpperCase()).join("\n");

/**
 * I nomi delle fermate trovate nel feed, una volta sola: due fermate con lo
 * stesso nome (i due lati della strada) sono lo stesso luogo per il calcolo,
 * che le riconosce dal nome. Nell'ordine dell'elenco: prima le più servite.
 */
export function nomiDelleFermate(fermate: ReadonlyArray<{ name: string; routeCount?: number }>): Array<{ nome: string; linee: number }> {
  const visti = new Map<string, { nome: string; linee: number }>();
  for (const f of fermate) {
    const nome = (f.name ?? "").trim();
    if (!nome) continue;
    const k = nome.toUpperCase();
    const gia = visti.get(k);
    if (gia) gia.linee = Math.max(gia.linee, f.routeCount ?? 0);
    else visti.set(k, { nome, linee: f.routeCount ?? 0 });
  }
  return [...visti.values()];
}

/** In breve, per la tabella: «con servizi» o «senza servizi». */
export const serviziInBreve = (p: Pick<PuntoDiRiposo, "conServizi">) => (p.conServizi ? "con servizi" : "senza servizi");
