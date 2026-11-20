/**
 * La polimetrica della bigliettazione nella pagina Polimetriche (tappa 6.34a).
 *
 * L'API (GET /api/fares/polimetriche/ufficiale?importId=) dà le linee della
 * bigliettazione, ognuna con la sua decisione (abbinata a una linea
 * dell'azienda, esclusa, da abbinare) e, per quelle da abbinare, le linee
 * dell'import dove si ritrovano i suoi punti tariffari. Qui i conti del
 * pannello: filtri, conteggi, le voci della tendina. Niente rete.
 */

export interface Caricamento {
  caricataIl: string; caricataDa: string | null;
  filePunti: string | null; fileRighe: string | null;
  punti: number; righe: number;
}

export interface LineaUfficiale {
  linea: string;
  percorsi: number; punti: number;
  da: string | null; a: string | null;
  righe: number; forzate: number; tariffari: string[];
  abbinata: string | null; esclusa: boolean;
  /** le linee dell'import dove si ritrovano più punti, al più tre */
  candidate: { linea: string; trovati: number }[];
  proposta: string | null;
  motivo: "codice" | "punti" | null;
}

export interface LineaAzienda { codice: string; nome: string }

export interface StatoUfficiale {
  caricamento: Caricamento | null;
  linee: LineaUfficiale[];
  lineeAzienda: LineaAzienda[];
  /** le linee dell'import a cui non corrisponde nessuna linea della bigliettazione */
  senzaUfficiale: LineaAzienda[];
}

/** Una decisione, come la vuole PUT /api/fares/polimetriche/ufficiale/abbinamenti. */
export interface Decisione { lineaUfficiale: string; linea: string | null; esclusa: boolean }

export type Stato = "da_abbinare" | "abbinata" | "esclusa";
export type Filtro = "tutte" | Stato;

export const statoDellaLinea = (l: Pick<LineaUfficiale, "abbinata" | "esclusa">): Stato =>
  (l.esclusa ? "esclusa" : l.abbinata != null ? "abbinata" : "da_abbinare");

export const ETICHETTE_FILTRO: Record<Filtro, string> = {
  tutte: "Tutte", da_abbinare: "Da abbinare", abbinata: "Abbinate", esclusa: "Escluse",
};

/** Quante linee per stato, e quante di quelle da abbinare hanno una proposta. */
export function conteggi(linee: readonly LineaUfficiale[]): Record<Filtro, number> & { proposte: number } {
  const c = { tutte: linee.length, da_abbinare: 0, abbinata: 0, esclusa: 0, proposte: 0 };
  for (const l of linee) {
    const s = statoDellaLinea(l);
    c[s]++;
    if (s === "da_abbinare" && l.proposta != null) c.proposte++;
  }
  return c;
}

/** Le linee del filtro; `cerca` guarda il codice, i capolinea e la linea abbinata. */
export function filtrate(linee: readonly LineaUfficiale[], filtro: Filtro, cerca: string): LineaUfficiale[] {
  const q = cerca.trim().toLowerCase();
  return linee.filter((l) => (filtro === "tutte" || statoDellaLinea(l) === filtro)
    && (!q || [l.linea, l.da ?? "", l.a ?? "", l.abbinata ?? ""].some((t) => t.toLowerCase().includes(q))));
}

/** Perché una linea è proposta, in parole. */
export function testoProposta(l: Pick<LineaUfficiale, "proposta" | "motivo" | "candidate" | "punti">): string {
  if (l.proposta == null) return "";
  if (l.motivo === "codice") return "stesso codice";
  const c = l.candidate.find((x) => x.linea === l.proposta);
  return c ? `${c.trovati} punti su ${l.punti}` : "";
}

/**
 * Le voci della tendina di una linea: prima le linee dell'import dove si
 * ritrovano i suoi punti (con quanti), poi tutte le altre. Se è abbinata a
 * una linea che in questo import non c'è, la voce resta.
 */
export function vociPerLinea(l: LineaUfficiale, lineeAzienda: readonly LineaAzienda[]): { codice: string; etichetta: string; candidata: boolean }[] {
  const nome = new Map(lineeAzienda.map((x) => [x.codice, x.nome]));
  const voce = (codice: string, coda: string, candidata: boolean) => ({ codice, etichetta: [codice, nome.get(codice), coda].filter(Boolean).join(" · "), candidata });
  const candidate = l.candidate.filter((c) => nome.has(c.linea));
  const viste = new Set(candidate.map((c) => c.linea));
  const voci = candidate.map((c) => voce(c.linea, `${c.trovati} punti su ${l.punti}`, true));
  if (l.proposta != null && nome.has(l.proposta) && !viste.has(l.proposta)) { voci.unshift(voce(l.proposta, "stesso codice", true)); viste.add(l.proposta); }
  for (const x of lineeAzienda) if (!viste.has(x.codice)) voci.push(voce(x.codice, "", false));
  if (l.abbinata != null && !nome.has(l.abbinata)) voci.unshift({ codice: l.abbinata, etichetta: `${l.abbinata} · non è in questo import`, candidata: false });
  return voci;
}

/** Le decisioni che accettano tutte le proposte: solo per le linee ancora da abbinare. */
export function decisioniDalleProposte(linee: readonly LineaUfficiale[]): Decisione[] {
  return linee.filter((l) => statoDellaLinea(l) === "da_abbinare" && l.proposta != null)
    .map((l) => ({ lineaUfficiale: l.linea, linea: l.proposta, esclusa: false }));
}

/** Le linee come stanno dopo una decisione, senza aspettare l'API. */
export function conDecisioni(linee: readonly LineaUfficiale[], decisioni: readonly Decisione[]): LineaUfficiale[] {
  const per = new Map(decisioni.map((d) => [d.lineaUfficiale, d]));
  return linee.map((l) => {
    const d = per.get(l.linea);
    return d ? { ...l, abbinata: d.esclusa ? null : d.linea, esclusa: d.esclusa } : l;
  });
}

/** Le linee dell'import senza una linea della bigliettazione, date le decisioni. */
export function senzaCorrispondenza(linee: readonly LineaUfficiale[], lineeAzienda: readonly LineaAzienda[]): LineaAzienda[] {
  const abbinate = new Set(linee.map((l) => l.abbinata).filter((x): x is string => x != null));
  return lineeAzienda.filter((x) => !abbinate.has(x.codice));
}

/** Il riassunto del caricamento: «2.457 punti e 16.857 righe, caricati il … da …». */
export function riassuntoCaricamento(c: Caricamento): string {
  const n = (x: number) => x.toLocaleString("it-IT");
  const quando = new Date(c.caricataIl).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
  return `${n(c.punti)} punti tariffari e ${n(c.righe)} righe, caricati il ${quando}${c.caricataDa ? ` da ${c.caricataDa}` : ""}`;
}
