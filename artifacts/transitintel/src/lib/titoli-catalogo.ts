/**
 * Il catalogo dei titoli di viaggio (tappa 6.9): i biglietti e gli
 * abbonamenti dell'azienda, da cui si riempie un feed nella pagina Tariffe.
 * Lo gestisce l'amministratore dalla pagina Azienda.
 * API: /api/admin/titoli, e nella pagina Tariffe /api/fares/products/…
 * I conti stanno qui.
 */
import type { Rete } from "@/lib/reti";

export const TIPI_TITOLO = ["single", "return", "abbonamento_settimanale", "abbonamento_mensile", "abbonamento_annuale"] as const;
export type TipoTitolo = (typeof TIPI_TITOLO)[number];

export const NOME_TIPO: Record<TipoTitolo, string> = {
  single: "Biglietto di corsa semplice",
  return: "Biglietto di andata e ritorno",
  abbonamento_settimanale: "Abbonamento settimanale",
  abbonamento_mensile: "Abbonamento mensile",
  abbonamento_annuale: "Abbonamento annuale",
};
export const TIPO_IN_BREVE: Record<TipoTitolo, string> = {
  single: "Corsa semplice", return: "Andata e ritorno", abbonamento_settimanale: "Settimanale", abbonamento_mensile: "Mensile", abbonamento_annuale: "Annuale",
};
export const eBiglietto = (tipo: string): boolean => tipo === "single" || tipo === "return";

/** Un titolo del catalogo, come lo dà e lo vuole l'API. */
export interface TitoloCatalogo {
  titolo: string;
  nome: string;
  rete: string;
  tipo: TipoTitolo;
  categoria: string;
  prezzo: number;
  durataMinuti: number | null;
  /** solo per i titoli extraurbani col prezzo per fascia chilometrica */
  fascia: number | null;
  /** il biglietto con cui si calcola il prezzo di una corsa sulla sua rete urbana */
  diRiferimento: boolean;
  ordine: number;
}
export interface ElencoTitoli { titoli: TitoloCatalogo[]; massimo: number }

/** Un prezzo come si scrive: «1,35», «1236,00». Senza punto delle migliaia: è anche quello che si riscrive nel modulo. */
export const euro = (n: number): string => n.toFixed(2).replace(".", ",");

/** Una durata a parole: «60 minuti», «24 ore», «7 giorni», «un anno». */
export function durataInParole(minuti: number | null): string {
  if (minuti === null) return "—";
  if (minuti % 525600 === 0) return minuti === 525600 ? "un anno" : `${minuti / 525600} anni`;
  if (minuti % 1440 === 0) return minuti === 1440 ? "un giorno" : `${(minuti / 1440).toLocaleString("it-IT")} giorni`;
  if (minuti % 60 === 0 && minuti > 120) return `${minuti / 60} ore`;
  return minuti === 1 ? "un minuto" : `${minuti.toLocaleString("it-IT")} minuti`;
}

/** Il riassunto sotto il titolo della scheda: quanti titoli, quanti biglietti e quanti abbonamenti. */
export function riassuntoCatalogo(titoli: readonly TitoloCatalogo[]): string {
  if (titoli.length === 0) return "Il catalogo è vuoto: nella pagina Tariffe un feed si riempie solo dei biglietti extraurbani, uno per fascia chilometrica.";
  const biglietti = titoli.filter((t) => eBiglietto(t.tipo)).length;
  const abbonamenti = titoli.length - biglietti;
  const n = (quanti: number, uno: string, tanti: string) => (quanti === 1 ? `un ${uno}` : `${quanti.toLocaleString("it-IT")} ${tanti}`);
  const parti = [biglietti > 0 ? n(biglietti, "biglietto", "biglietti") : "", abbonamenti > 0 ? n(abbonamenti, "abbonamento", "abbonamenti") : ""].filter(Boolean);
  return `${titoli.length === 1 ? "Un titolo" : `${titoli.length.toLocaleString("it-IT")} titoli`}: ${parti.join(" e ")}.`;
}

/** I titoli raggruppati per rete, nell'ordine delle reti; in fondo quelli di una rete che non è più nell'elenco. */
export function titoliPerRete(titoli: readonly TitoloCatalogo[], reti: readonly Pick<Rete, "rete">[]): { rete: string; titoli: TitoloCatalogo[] }[] {
  const ordine = [...reti.map((r) => r.rete), ...new Set(titoli.map((t) => t.rete).filter((rete) => !reti.some((r) => r.rete === rete)))];
  return ordine.map((rete) => ({ rete, titoli: titoli.filter((t) => t.rete === rete) })).filter((g) => g.titoli.length > 0);
}

/** L'identificativo che si propone per un nome: «Biglietto Urbano Pesaro 60 min» → «biglietto_urbano_pesaro_60_min». */
export function idDaNome(nome: string): string {
  return nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[_0-9]+|_+$/g, "").slice(0, 60).replace(/_+$/g, "");
}

/* il modulo di un titolo: tutto testo, come lo scrive chi compila */
export interface ModuloTitolo {
  titolo: string; nome: string; rete: string; tipo: TipoTitolo; categoria: string;
  prezzo: string; durata: string; fascia: string; diRiferimento: boolean; ordine: string;
}
export const moduloVuoto = (rete: string): ModuloTitolo => ({
  titolo: "", nome: "", rete, tipo: "single", categoria: "ordinario", prezzo: "", durata: "", fascia: "", diRiferimento: false, ordine: "",
});
export const moduloDa = (t: TitoloCatalogo): ModuloTitolo => ({
  titolo: t.titolo, nome: t.nome, rete: t.rete, tipo: t.tipo, categoria: t.categoria,
  prezzo: euro(t.prezzo), durata: t.durataMinuti === null ? "" : String(t.durataMinuti),
  fascia: t.fascia === null ? "" : String(t.fascia), diRiferimento: t.diRiferimento, ordine: String(t.ordine),
});

const numero = (s: string): number => {
  const t = s.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
};
const decimali = (n: number, cifre: number) => Math.abs(n * 10 ** cifre - Math.round(n * 10 ** cifre)) < 1e-6;

/** L'identificativo con cui si salva un titolo nuovo: quello scritto, o quello ricavato dal nome. */
export const idDelModulo = (m: ModuloTitolo): string => m.titolo.trim() || idDaNome(m.nome);

/** Che cosa non va nel modulo, in parole; vuoto se si può salvare. */
export function erroriTitolo(m: ModuloTitolo, nuovo: boolean, reti: readonly Pick<Rete, "rete" | "tipo">[]): string[] {
  const e: string[] = [];
  const nome = m.nome.trim();
  if (!nome) e.push("Scrivi il nome del titolo.");
  else if (nome.length > 120) e.push("Il nome è troppo lungo: al più 120 caratteri.");
  else if (/["\p{Cc}]/u.test(nome)) e.push("Nel nome non vanno le virgolette doppie: finisce nei file del GTFS.");
  if (nuovo && !/^[a-z][a-z0-9_]{1,59}$/.test(idDelModulo(m))) {
    e.push("L'identificativo ha solo lettere minuscole, cifre e trattini bassi, e comincia con una lettera: per esempio «pesaro_60min».");
  }
  const rete = reti.find((r) => r.rete === m.rete);
  if (!rete) e.push("Scegli la rete del titolo.");
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(m.categoria.trim())) e.push("La categoria ha solo lettere minuscole, cifre e trattini bassi: per esempio «studente».");
  const prezzo = numero(m.prezzo);
  if (Number.isNaN(prezzo)) e.push("Scrivi il prezzo.");
  else if (!decimali(prezzo, 2)) e.push("Il prezzo ha al più due decimali.");
  else if (prezzo > 99999.99) e.push("Il prezzo è al più 99.999,99 €.");
  if (m.durata.trim() && !(/^\d{1,7}$/.test(m.durata.trim()) && Number(m.durata) >= 1 && Number(m.durata) <= 5256000)) e.push("La durata è un numero intero di minuti, da 1 in su.");
  if (m.fascia.trim()) {
    if (!(/^\d{1,2}$/.test(m.fascia.trim()) && Number(m.fascia) >= 1 && Number(m.fascia) <= 60)) e.push("La fascia è un numero da 1 a 60.");
    else if (rete && rete.tipo !== "extraurbano") e.push("Solo un titolo extraurbano ha un prezzo per fascia chilometrica.");
  }
  if (m.diRiferimento && rete && (rete.tipo !== "urbano" || m.tipo !== "single")) {
    e.push("Il biglietto di riferimento può essere solo un biglietto di corsa semplice di una rete urbana.");
  }
  if (m.ordine.trim() && !/^\d{1,5}$/.test(m.ordine.trim())) e.push("L'ordine è un numero da 0 a 99999.");
  return e;
}

const campi = (m: ModuloTitolo) => ({
  nome: m.nome.trim(), rete: m.rete, tipo: m.tipo, categoria: m.categoria.trim(), prezzo: numero(m.prezzo),
  durataMinuti: m.durata.trim() ? Number(m.durata.trim()) : null, fascia: m.fascia.trim() ? Number(m.fascia.trim()) : null,
  diRiferimento: m.diRiferimento, ...(m.ordine.trim() ? { ordine: Number(m.ordine.trim()) } : {}),
});

/** Il corpo di POST /api/admin/titoli. */
export const corpoNuovoTitolo = (m: ModuloTitolo) => ({ titolo: idDelModulo(m), ...campi(m) });
/** Il corpo di PUT /api/admin/titoli/:titolo. */
export const corpoModificaTitolo = (m: ModuloTitolo) => campi(m);

/* ── nella pagina Tariffe: il feed rispetto al catalogo ─────────────────── */

export interface TitoloDiverso { id: string; differenze: string[] }
export interface ConfrontoColCatalogo { mancanti: number; diversi: TitoloDiverso[]; uguali: number; doppioni: number }

/** La domanda prima di allineare; null se non c'è niente da allineare. */
export function domandaAllinea(c: Pick<ConfrontoColCatalogo, "diversi">): string | null {
  const n = c.diversi.length;
  if (n === 0) return null;
  const primi = c.diversi.slice(0, 8).map((d) => `• ${d.id}: ${d.differenze.join("; ")}`);
  const resto = n > 8 ? [`• … e altri ${n - 8}`] : [];
  const quanti = n === 1 ? "Un titolo del feed è diverso" : `${n.toLocaleString("it-IT")} titoli del feed sono diversi`;
  return `${quanti} dal catalogo dell'azienda o dalle fasce chilometriche:\n${[...primi, ...resto].join("\n")}\n\nLi porto ai nomi, ai prezzi e alle durate del catalogo?`;
}

/** L'esito del confronto in una frase, per l'avviso. */
export function riassuntoConfronto(c: ConfrontoColCatalogo): string {
  const parti = [
    c.diversi.length === 0 ? "I titoli del feed sono come nel catalogo" : "",
    c.mancanti > 0 ? `${c.mancanti === 1 ? "manca un titolo" : `mancano ${c.mancanti.toLocaleString("it-IT")} titoli`} del catalogo` : "",
    c.doppioni > 0 ? `${c.doppioni === 1 ? "c'è un doppione" : `ci sono ${c.doppioni.toLocaleString("it-IT")} doppioni`}` : "",
  ].filter(Boolean);
  const frase = parti.join("; ");
  return `${frase.charAt(0).toUpperCase()}${frase.slice(1)}.`;
}
