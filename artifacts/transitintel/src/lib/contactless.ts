/**
 * Il pagamento con carta a bordo (tappa 6.38): le tariffe per tipo di rete,
 * il massimale unico, il supporto e le reti dove vale. Le scrive
 * l'amministratore dalla pagina Azienda, tutte insieme.
 * API: GET e PUT /api/admin/contactless. I conti stanno qui.
 */
import { numero } from "./fasce-km";

export const TIPI_CONTACTLESS = ["urbano", "extraurbano"] as const;
export type TipoContactless = (typeof TIPI_CONTACTLESS)[number];

export interface TariffaContactless {
  tipo: TipoContactless;
  primo: number;
  secondo: number;
  terzo: number;
  validitaMinuti: number;
  massimale: number;
}

export interface Contactless {
  massimaleUnico: number | null;
  finestraOre: number;
  supporto: string | null;
  tariffe: TariffaContactless[];
  reti: string[];
}

export interface ElencoContactless {
  contactless: Contactless;
  retiDisponibili: { rete: string; nome: string; tipo: TipoContactless }[];
  supportiDisponibili: { supporto: string; nome: string; tipo: number }[];
  limiti: { prezzo: number; validitaMinuti: number; finestraOre: number; reti: number };
}

/** Una tariffa nel modulo: tutto testo, come lo scrive chi compila. */
export interface RigaTariffa { attiva: boolean; primo: string; secondo: string; terzo: string; validita: string; massimale: string }

export interface BozzaContactless {
  massimaleUnico: string;
  finestraOre: string;
  supporto: string;
  tariffe: Record<TipoContactless, RigaTariffa>;
  reti: string[];
}

export const NOME_TIPO: Record<TipoContactless, string> = { urbano: "Urbano", extraurbano: "Extraurbano" };
const AGGETTIVO: Record<TipoContactless, string> = { urbano: "urbana", extraurbano: "extraurbana" };

/** Un prezzo come si scrive: «2,00». */
export const soldi = (n: number): string => n.toFixed(2).replace(".", ",");
const decimali = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const VUOTA: RigaTariffa = { attiva: false, primo: "", secondo: "", terzo: "", validita: "60", massimale: "" };

/** Il modulo dalle regole salvate. */
export function bozzaDa(c: Contactless): BozzaContactless {
  const riga = (tipo: TipoContactless): RigaTariffa => {
    const t = c.tariffe.find((x) => x.tipo === tipo);
    return t
      ? { attiva: true, primo: soldi(t.primo), secondo: soldi(t.secondo), terzo: soldi(t.terzo), validita: String(t.validitaMinuti), massimale: soldi(t.massimale) }
      : { ...VUOTA };
  };
  return {
    massimaleUnico: c.massimaleUnico === null ? "" : soldi(c.massimaleUnico),
    finestraOre: String(c.finestraOre),
    supporto: c.supporto ?? "",
    tariffe: { urbano: riga("urbano"), extraurbano: riga("extraurbano") },
    reti: [...c.reti].sort(),
  };
}

const intero = (s: string): number => (/^\s*\d+\s*$/.test(s) ? Number(s) : NaN);

/** Quello che non torna nel modulo; vuoto se si può salvare. */
export function erroriBozza(b: BozzaContactless, e: Pick<ElencoContactless, "retiDisponibili" | "limiti">): string[] {
  const errori: string[] = [];
  const prezzo = (testo: string, cosa: string, zero: boolean): number => {
    const n = numero(testo);
    if (Number.isNaN(n)) { errori.push(`${cosa}: scrivi un prezzo, come «2,00»`); return NaN; }
    if (!zero && n <= 0) errori.push(`${cosa}: maggiore di zero`);
    else if (n > e.limiti.prezzo) errori.push(`${cosa}: al più ${soldi(e.limiti.prezzo)} €`);
    else if (!decimali(n)) errori.push(`${cosa}: al più due decimali`);
    return n;
  };
  const massimali: { tipo: TipoContactless; massimale: number }[] = [];
  for (const tipo of TIPI_CONTACTLESS) {
    const r = b.tariffe[tipo];
    if (!r.attiva) continue;
    const chi = `Tariffa ${AGGETTIVO[tipo]}`;
    const primo = prezzo(r.primo, `${chi}, primo viaggio`, false);
    prezzo(r.secondo, `${chi}, secondo viaggio`, true);
    prezzo(r.terzo, `${chi}, terzo viaggio`, true);
    const massimale = prezzo(r.massimale, `${chi}, massimale`, false);
    const validita = intero(r.validita);
    if (Number.isNaN(validita) || validita < 1 || validita > e.limiti.validitaMinuti) errori.push(`${chi}, validità: minuti interi da 1 a ${e.limiti.validitaMinuti}`);
    if (!Number.isNaN(primo) && !Number.isNaN(massimale) && massimale < primo) errori.push(`${chi}: il massimale è più basso del primo viaggio`);
    if (!Number.isNaN(massimale)) massimali.push({ tipo, massimale });
  }
  if (b.massimaleUnico.trim()) {
    const unico = prezzo(b.massimaleUnico, "Massimale unico", false);
    const alto = massimali.reduce<{ tipo: TipoContactless; massimale: number } | null>((m, x) => (!m || x.massimale > m.massimale ? x : m), null);
    if (!Number.isNaN(unico) && alto && unico < alto.massimale) errori.push(`Il massimale unico è più basso del massimale della tariffa ${AGGETTIVO[alto.tipo]}`);
  }
  const finestra = intero(b.finestraOre);
  if (Number.isNaN(finestra) || finestra < 1 || finestra > e.limiti.finestraOre) errori.push(`Finestra: ore intere da 1 a ${e.limiti.finestraOre}`);
  for (const r of b.reti) {
    const rete = e.retiDisponibili.find((x) => x.rete === r);
    if (!rete) errori.push(`La rete «${r}» non c'è più: ricarica la pagina`);
    else if (!b.tariffe[rete.tipo].attiva) errori.push(`La carta è attiva su «${rete.nome}»: serve la tariffa ${AGGETTIVO[rete.tipo]}`);
  }
  return errori;
}

/** Il corpo di PUT /api/admin/contactless. Si chiama solo se `erroriBozza` è vuoto. */
export function corpoDa(b: BozzaContactless): Contactless {
  return {
    massimaleUnico: b.massimaleUnico.trim() ? numero(b.massimaleUnico) : null,
    finestraOre: intero(b.finestraOre),
    supporto: b.supporto || null,
    tariffe: TIPI_CONTACTLESS.filter((t) => b.tariffe[t].attiva).map((tipo) => {
      const r = b.tariffe[tipo];
      return { tipo, primo: numero(r.primo), secondo: numero(r.secondo), terzo: numero(r.terzo), validitaMinuti: intero(r.validita), massimale: numero(r.massimale) };
    }),
    reti: [...b.reti].sort(),
  };
}

/* le regole in una forma sola, per confrontarle: «2» e «2,00» sono la stessa cosa */
const inChiaro = (c: Contactless) => JSON.stringify([
  c.massimaleUnico, c.finestraOre, c.supporto, [...c.reti].sort(),
  TIPI_CONTACTLESS.map((tipo) => {
    const t = c.tariffe.find((x) => x.tipo === tipo);
    return t ? [t.primo, t.secondo, t.terzo, t.validitaMinuti, t.massimale] : null;
  }),
]);

/** Se il modulo dice qualcosa di diverso da quello salvato. */
export const bozzaCambiata = (b: BozzaContactless, c: Contactless): boolean => inChiaro(corpoDa(b)) !== inChiaro(c);

/** Una tariffa in una riga: «1° viaggio 2,00 € (vale 60 minuti) · 2° 2,00 € · 3° 1,00 € · al massimo 5,00 € in 24 ore». */
export function tariffaInBreve(t: TariffaContactless, finestraOre: number): string {
  return `1° viaggio ${soldi(t.primo)} € (vale ${t.validitaMinuti} minuti) · 2° ${soldi(t.secondo)} € · 3° ${soldi(t.terzo)} € · al massimo ${soldi(t.massimale)} € in ${finestraOre} ore`;
}

/** Lo stato in una frase: dove vale, o che non vale. */
export function riassunto(c: Contactless, e: Pick<ElencoContactless, "retiDisponibili">): string {
  if (!c.reti.length || !c.tariffe.length) return "Il pagamento con carta non è attivo: nel GTFS non c'è.";
  const nomi = c.reti.map((r) => e.retiDisponibili.find((x) => x.rete === r)?.nome ?? r);
  const elenco = nomi.length === 1 ? nomi[0] : `${nomi.slice(0, -1).join(", ")} e ${nomi[nomi.length - 1]}`;
  return `Attivo su ${elenco}.`;
}
