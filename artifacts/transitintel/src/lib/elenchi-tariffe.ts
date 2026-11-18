/**
 * Gli elenchi di partenza delle tariffe (tappa 6.10): i tipi dell'API
 * /api/admin/elenchi-tariffe, le bozze della scheda in Amministrazione ›
 * Azienda (categorie e supporti) e i valori di partenza del modulo «Feed
 * Info». Chi figura come agenzia nei GTFS sta in lib/gestori.ts (tappa 6.11).
 * Senza React: si prova da solo.
 */

export interface CategoriaCatalogo { categoria: string; nome: string; predefinita: boolean; url: string | null }
export interface SupportoCatalogo { supporto: string; nome: string; tipo: number }

/** Un'agenzia come sta in agency.txt. GET /api/fares/agency dà quella di chi non ne dice una: il gestore predefinito, o l'azienda. */
export interface AgenziaNelGtfs {
  agency_id: string; agency_name: string; agency_url: string; agency_timezone: string; agency_lang: string;
  agency_phone: string; agency_fare_url: string; agency_email: string;
  /** true se non è un gestore dell'elenco: è l'azienda dell'installazione */
  daAzienda: boolean;
}

export interface ElenchiTariffe {
  categorie: CategoriaCatalogo[];
  supporti: SupportoCatalogo[];
  tipiSupporto: { tipo: number; nome: string }[];
}

/* ── Le bozze: quello che si scrive nelle caselle ─────────────────────────── */

/* `nuova`: la riga è stata aggiunta ora, e solo di queste si scrive l'identificativo (quello di una riga salvata non cambia) */
export interface RigaCategoria { categoria: string; nome: string; predefinita: boolean; url: string; nuova?: boolean }
export interface RigaSupporto { supporto: string; nome: string; tipo: string; nuova?: boolean }

export const bozzaCategorie = (l: readonly CategoriaCatalogo[]): RigaCategoria[] =>
  l.map((c) => ({ categoria: c.categoria, nome: c.nome, predefinita: c.predefinita, url: c.url ?? "" }));
export const bozzaSupporti = (l: readonly SupportoCatalogo[]): RigaSupporto[] =>
  l.map((s) => ({ supporto: s.supporto, nome: s.nome, tipo: String(s.tipo) }));

/** La prima categoria di un elenco vuoto è la predefinita. */
export const categoriaNuova = (b: readonly RigaCategoria[]): RigaCategoria => ({ categoria: "", nome: "", predefinita: b.length === 0, url: "", nuova: true });
export const supportoNuovo = (): RigaSupporto => ({ supporto: "", nome: "", tipo: "1", nuova: true });

const ID = /^[a-z][a-z0-9_]{1,39}$/;
const INDIRIZZO = /^https?:\/\/[^\s",<>]{1,200}$/;

const doppione = (valori: readonly string[]): string | null => {
  const visti = new Set<string>();
  for (const v of valori) { if (v && visti.has(v)) return v; visti.add(v); }
  return null;
};
const nomeNonVa = (nome: string): string | null => {
  const n = nome.trim();
  if (!n) return "manca il nome";
  if (n.length > 120) return "il nome ha al più 120 caratteri";
  if (n.includes('"')) return "il nome non può contenere virgolette";
  return null;
};

/* ── Che cosa non va, prima di salvare ────────────────────────────────────── */

export function erroriCategorie(b: readonly RigaCategoria[]): string[] {
  const e: string[] = [];
  b.forEach((r, i) => {
    const dove = `Riga ${i + 1}`;
    if (!ID.test(r.categoria.trim())) e.push(`${dove}: l'identificativo ha solo lettere minuscole, cifre e trattini bassi, per esempio «studente».`);
    const n = nomeNonVa(r.nome); if (n) e.push(`${dove}: ${n}.`);
    if (r.url.trim() && !INDIRIZZO.test(r.url.trim())) e.push(`${dove}: la pagina comincia con http:// o https://.`);
  });
  const d = doppione(b.map((r) => r.categoria.trim()));
  if (d) e.push(`La categoria «${d}» compare due volte.`);
  const predefinite = b.filter((r) => r.predefinita).length;
  if (b.length > 0 && predefinite !== 1) e.push(predefinite === 0 ? "Scegli la categoria predefinita: vale per i titoli che non ne dicono un'altra." : "La categoria predefinita è una sola.");
  return e;
}

export function erroriSupporti(b: readonly RigaSupporto[]): string[] {
  const e: string[] = [];
  b.forEach((r, i) => {
    const dove = `Riga ${i + 1}`;
    if (!ID.test(r.supporto.trim())) e.push(`${dove}: l'identificativo ha solo lettere minuscole, cifre e trattini bassi, per esempio «app_mobile».`);
    const n = nomeNonVa(r.nome); if (n) e.push(`${dove}: ${n}.`);
    if (!/^[0-4]$/.test(r.tipo)) e.push(`${dove}: scegli il tipo.`);
  });
  const d = doppione(b.map((r) => r.supporto.trim()));
  if (d) e.push(`Il supporto «${d}» compare due volte.`);
  return e;
}

/* ── Quello che si manda all'API ──────────────────────────────────────────── */

const oNiente = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export const corpoCategorie = (b: readonly RigaCategoria[]): { categorie: CategoriaCatalogo[] } => ({
  categorie: b.map((r) => ({ categoria: r.categoria.trim(), nome: r.nome.trim(), predefinita: r.predefinita, url: oNiente(r.url) })),
});
export const corpoSupporti = (b: readonly RigaSupporto[]): { supporti: SupportoCatalogo[] } => ({
  supporti: b.map((r) => ({ supporto: r.supporto.trim(), nome: r.nome.trim(), tipo: Number(r.tipo) })),
});

/** Vero se la bozza dice una cosa diversa da quello che è salvato. */
export const cambiato = (bozza: unknown, salvato: unknown): boolean => JSON.stringify(bozza) !== JSON.stringify(salvato);

/* ── Frasi ────────────────────────────────────────────────────────────────── */

/** I valori che il modulo «Feed Info» propone in un feed che non li ha ancora. */
export interface PartenzaFeedInfo { feedPublisherName: string; feedPublisherUrl: string; feedContactEmail: string; feedContactUrl: string }
export function partenzaFeedInfo(a: AgenziaNelGtfs | null): PartenzaFeedInfo {
  return {
    feedPublisherName: a?.agency_name ?? "", feedPublisherUrl: a?.agency_url ?? "",
    feedContactEmail: a?.agency_email ?? "", feedContactUrl: a?.agency_url ?? "",
  };
}

/** Da dove viene un nodo del catalogo di un feed, in parole. «atma_2013» è il nome che aveva la copia dall'elenco prima della 6.10. */
export function fonteDelNodo(fonte: string | null | undefined): string {
  if (!fonte) return "—";
  if (fonte === "manual") return "a mano";
  if (fonte === "catalogo" || fonte === "atma_2013") return "elenco dell'azienda";
  return fonte;
}
