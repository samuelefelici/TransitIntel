/**
 * L'azienda che usa questa installazione, com'è arrivata con la sessione
 * (/api/auth/me; nell'API lib/azienda.ts, tabella public.azienda).
 *
 * Qui non c'è nessun nome di azienda: un'installazione ancora da compilare ha
 * i valori neutri, e la pagina Amministrazione › Azienda serve a metterci
 * quelli veri. Funzioni pure, coi loro test.
 */

export interface Azienda {
  /** il nome per esteso */
  ragioneSociale: string;
  /** il nome corto, quello che si dice */
  nome: string;
  sito: string | null;
  telefono: string | null;
  /** l'agency_id dei GTFS esportati */
  gtfsAgencyId: string;
  /** la città principale del servizio */
  citta: string | null;
  regione: string | null;
  /** dove si aprono le mappe di tutta la rete */
  centro: { lat: number; lng: number; zoom: number };
  /** la provincia degli import ISTAT, tre cifre («042»), o null (tappa 6.1) */
  provinciaIstat: string | null;
  /** il codice locale (NUTS) degli identificativi NeTEx, per le Marche «ITI3» (tappa 6.2) */
  netexCodiceLocale: string | null;
  /** il fornitore in fondo agli identificativi NeTEx, se la Regione lo chiede */
  netexFornitore: string | null;
  /** gli identificativi NeTEx come quelli della Regione (tappa 6.19c): prefisso («epd»), prefisso dei codici, codice della rete */
  netexPrefisso: string | null;
  netexPrefissoCodici: string | null;
  netexCodiceRete: string | null;
  /** il riferimento della regola regionale delle tariffe extraurbane, mostrato accanto al calcolo; null: non compare (tappa 6.24) */
  tariffeRiferimento: string | null;
  /**
   * Nel canale dell'AVM, al più quante cifre ha la matricola di una vettura dell'azienda (le altre sono
   * delle consorziate); null: tutte le vetture del canale sono sue (tappa 6.5)
   */
  avmMatricolaCifre: number | null;
  /** false finché l'amministratore non ha compilato la pagina */
  compilata: boolean;
}

/** Gli stessi valori neutri dell'API: il centro è sull'Italia. */
export const AZIENDA_DA_COMPILARE: Azienda = Object.freeze({
  ragioneSociale: "Azienda di trasporto",
  nome: "Azienda",
  sito: null,
  telefono: null,
  gtfsAgencyId: "azienda",
  citta: null,
  regione: null,
  centro: Object.freeze({ lat: 42.5, lng: 12.5, zoom: 5.5 }),
  provinciaIstat: null,
  netexCodiceLocale: null,
  netexFornitore: null,
  netexPrefisso: null,
  netexPrefissoCodici: null,
  netexCodiceRete: null,
  tariffeRiferimento: null,
  avmMatricolaCifre: null,
  compilata: false,
});

const testo = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Un testo di una riga, senza caratteri di controllo e al più `max` caratteri, altrimenti null. */
const rigaDiTesto = (v: unknown, max: number): string | null => {
  const t = testo(v);
  return t && t.length <= max && !/[\u0000-\u001f\u007f]/.test(t) ? t : null;
};
/** Le cifre della matricola nell'AVM: un intero da 1 a 9, altrimenti null. */
const cifreValide = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9 ? v : null);
const numero = (v: unknown, min: number, max: number): number | null =>
  (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/**
 * Quello che arriva dal server o dalla memoria del browser, controllato: se
 * manca un pezzo che serve (un nome, un centro sensato) valgono i valori
 * neutri, così una risposta vecchia o rovinata non apre una mappa nel vuoto.
 */
export function aziendaValida(x: unknown): Azienda {
  const d = x && typeof x === "object" ? x as Record<string, unknown> : null;
  const c = d?.centro && typeof d.centro === "object" ? d.centro as Record<string, unknown> : null;
  const ragioneSociale = testo(d?.ragioneSociale), nome = testo(d?.nome), gtfsAgencyId = testo(d?.gtfsAgencyId);
  const lat = numero(c?.lat, -90, 90), lng = numero(c?.lng, -180, 180), zoom = numero(c?.zoom, 1, 22);
  if (!d || !ragioneSociale || !nome || !gtfsAgencyId || lat === null || lng === null || zoom === null) return AZIENDA_DA_COMPILARE;
  return {
    ragioneSociale, nome, gtfsAgencyId,
    sito: testo(d.sito), telefono: testo(d.telefono), citta: testo(d.citta), regione: testo(d.regione),
    centro: { lat, lng, zoom },
    provinciaIstat: typeof d.provinciaIstat === "string" && /^[0-9]{3}$/.test(d.provinciaIstat) ? d.provinciaIstat : null,
    netexCodiceLocale: typeof d.netexCodiceLocale === "string" && /^[A-Z]{2}[A-Z0-9]{0,3}$/.test(d.netexCodiceLocale) ? d.netexCodiceLocale : null,
    netexFornitore: typeof d.netexFornitore === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(d.netexFornitore) ? d.netexFornitore : null,
    netexPrefisso: typeof d.netexPrefisso === "string" && PREFISSO_NETEX.test(d.netexPrefisso) ? d.netexPrefisso : null,
    netexPrefissoCodici: typeof d.netexPrefissoCodici === "string" && PREFISSO_CODICI_NETEX.test(d.netexPrefissoCodici) ? d.netexPrefissoCodici : null,
    netexCodiceRete: typeof d.netexCodiceRete === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(d.netexCodiceRete) ? d.netexCodiceRete : null,
    tariffeRiferimento: rigaDiTesto(d.tariffeRiferimento, 200),
    avmMatricolaCifre: cifreValide(d.avmMatricolaCifre),
    compilata: d.compilata !== false,
  };
}

/** «Ancona / Marche», «Ancona», o niente se la città non c'è. */
export function luogoDellAzienda(a: Pick<Azienda, "citta" | "regione">): string | null {
  if (!a.citta) return null;
  return a.regione ? `${a.citta} / ${a.regione}` : a.citta;
}

/** La vista con cui si apre una mappa di tutta la rete (react-map-gl). */
export function vistaIniziale(a: Pick<Azienda, "centro">): { longitude: number; latitude: number; zoom: number } {
  return { longitude: a.centro.lng, latitude: a.centro.lat, zoom: a.centro.zoom };
}

/** Il centro delle mappe come «lng,lat», come lo vuole il parametro `proximity` delle ricerche di indirizzi. */
export function vicinoAlCentro(a: Pick<Azienda, "centro">): string {
  return `${a.centro.lng.toFixed(4)},${a.centro.lat.toFixed(4)}`;
}

/**
 * Il riquadro attorno al centro delle mappe, `km` chilometri per parte, come
 * «ovest,sud,est,nord» (il parametro `bbox` delle ricerche di indirizzi): dove
 * cercare prima, se non si sa altro del territorio.
 */
export function dintorniDelCentro(a: Pick<Azienda, "centro">, km = 80): string {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.max(Math.cos((a.centro.lat * Math.PI) / 180), 0.01));
  const t = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)).toFixed(2);
  return [t(a.centro.lng - dLng, -180, 180), t(a.centro.lat - dLat, -90, 90), t(a.centro.lng + dLng, -180, 180), t(a.centro.lat + dLat, -90, 90)].join(",");
}

/**
 * Il riferimento della regola regionale da scrivere dopo un testo del calcolo
 * delle tariffe: « — DGR … art. …», o niente se l'azienda non l'ha scritto.
 */
export function conRiferimento(a: Pick<Azienda, "tariffeRiferimento">): string {
  return a.tariffeRiferimento ? ` — ${a.tariffeRiferimento}` : "";
}

/** Il nome sui documenti stampati che ne vogliono uno corto: quello dell'azienda, se è compilata. */
export function nomeNeiDocumenti(a: Pick<Azienda, "nome" | "compilata">): string {
  return a.compilata ? a.nome : "Trasporto Pubblico Locale";
}

/** L'intestazione dei documenti stampati: «Conerobus · Trasporto Pubblico Locale». */
export function intestazioneDocumenti(a: Pick<Azienda, "nome" | "compilata">): string {
  return a.compilata ? `${a.nome} · Trasporto Pubblico Locale` : "Trasporto Pubblico Locale";
}

/* ── Gli identificativi NeTEx (tappe 6.2 e 6.19c) ─────────────────────────── */

const PREFISSO_NETEX = /^[A-Za-z][A-Za-z0-9]{0,9}$/;
const PREFISSO_CODICI_NETEX = /^[A-Za-z0-9-]{1,20}$/;

/**
 * Come esce l'identificativo di una linea con i codici scritti nel modulo:
 * [prefisso]:IT:[codice locale]:Line:[prefisso dei codici]_[codice](:[fornitore]).
 * Serve a vederlo accanto alle caselle; null senza codice locale.
 */
export function esempioIdNetex(m: Pick<ModuloAzienda, "netexCodiceLocale" | "netexFornitore" | "netexPrefisso" | "netexPrefissoCodici">, codice = "1/3"): string | null {
  const loc = m.netexCodiceLocale.trim();
  if (!loc) return null;
  const pre = m.netexPrefisso.trim() ? `${m.netexPrefisso.trim()}:` : "";
  const pc = m.netexPrefissoCodici.trim() ? `${m.netexPrefissoCodici.trim()}_` : "";
  const fine = m.netexFornitore.trim() ? `:${m.netexFornitore.trim()}` : "";
  return `${pre}IT:${loc}:Line:${pc}${codice}${fine}`;
}

/* ── Il modulo della pagina dell'amministratore ───────────────────────────── */

/** I campi del modulo, come testo: quello che si scrive nelle caselle. */
export interface ModuloAzienda {
  ragioneSociale: string; nome: string; sito: string; telefono: string; gtfsAgencyId: string;
  citta: string; regione: string; centroLat: string; centroLng: string; zoom: string; provinciaIstat: string;
  netexCodiceLocale: string; netexFornitore: string;
  netexPrefisso: string; netexPrefissoCodici: string; netexCodiceRete: string;
  tariffeRiferimento: string;
  avmMatricolaCifre: string;
}
export type CampoAzienda = keyof ModuloAzienda;

export function moduloDa(a: Azienda): ModuloAzienda {
  /* un'installazione da compilare parte con le caselle del nome vuote: i valori neutri non sono una proposta */
  const scritto = (v: string | null) => (a.compilata ? v ?? "" : "");
  return {
    ragioneSociale: scritto(a.ragioneSociale), nome: scritto(a.nome), sito: scritto(a.sito), telefono: scritto(a.telefono),
    gtfsAgencyId: scritto(a.gtfsAgencyId), citta: scritto(a.citta), regione: scritto(a.regione),
    centroLat: String(a.centro.lat), centroLng: String(a.centro.lng), zoom: String(a.centro.zoom),
    provinciaIstat: scritto(a.provinciaIstat),
    netexCodiceLocale: scritto(a.netexCodiceLocale), netexFornitore: scritto(a.netexFornitore),
    netexPrefisso: scritto(a.netexPrefisso), netexPrefissoCodici: scritto(a.netexPrefissoCodici), netexCodiceRete: scritto(a.netexCodiceRete),
    tariffeRiferimento: scritto(a.tariffeRiferimento),
    avmMatricolaCifre: a.compilata && a.avmMatricolaCifre != null ? String(a.avmMatricolaCifre) : "",
  };
}

const decimale = (s: string): number => (/^-?\d+([.,]\d+)?$/.test(s.trim()) ? Number(s.trim().replace(",", ".")) : NaN);

/**
 * Gli errori del modulo, campo per campo (vuoto = si può salvare). Sono gli
 * stessi limiti dell'API e della tabella: qui servono a dirlo accanto alla
 * casella prima di spedire; a decidere resta il server.
 */
export function erroriDelModulo(m: ModuloAzienda): Partial<Record<CampoAzienda, string>> {
  const e: Partial<Record<CampoAzienda, string>> = {};
  const obbligatorio = (campo: CampoAzienda, max: number) => {
    const v = m[campo].trim();
    if (!v) e[campo] = "Va compilato";
    else if (v.length > max) e[campo] = `Al più ${max} caratteri`;
  };
  obbligatorio("ragioneSociale", 120);
  obbligatorio("nome", 40);
  obbligatorio("citta", 60);
  if (m.regione.trim().length > 60) e.regione = "Al più 60 caratteri";
  if (m.sito.trim() && !/^https?:\/\/[^\s",<>]{1,200}$/.test(m.sito.trim())) e.sito = "Deve cominciare con http:// o https://, senza spazi né virgole";
  if (m.telefono.trim() && !/^[0-9+() ./-]{3,40}$/.test(m.telefono.trim())) e.telefono = "Solo cifre, spazi e + ( ) . / -";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(m.gtfsAgencyId.trim())) e.gtfsAgencyId = "Solo lettere, cifre e . _ - (al più 40)";
  const lat = decimale(m.centroLat), lng = decimale(m.centroLng), zoom = decimale(m.zoom);
  if (!(lat >= -90 && lat <= 90)) e.centroLat = "Un numero fra -90 e 90";
  if (!(lng >= -180 && lng <= 180)) e.centroLng = "Un numero fra -180 e 180";
  if (!(zoom >= 3 && zoom <= 18)) e.zoom = "Un numero fra 3 e 18";
  if (m.provinciaIstat.trim() && !/^[0-9]{3}$/.test(m.provinciaIstat.trim())) e.provinciaIstat = "Tre cifre, come 042";
  if (m.netexCodiceLocale.trim() && !/^[A-Z]{2}[A-Z0-9]{0,3}$/.test(m.netexCodiceLocale.trim())) e.netexCodiceLocale = "Un codice NUTS in maiuscolo, come ITI3";
  if (m.netexFornitore.trim() && !/^[A-Za-z0-9_-]{1,40}$/.test(m.netexFornitore.trim())) e.netexFornitore = "Lettere, cifre, - e _ (al più 40)";
  if (m.netexPrefisso.trim() && !PREFISSO_NETEX.test(m.netexPrefisso.trim())) e.netexPrefisso = "Una lettera e poi lettere o cifre (al più 10), come epd";
  if (m.netexPrefissoCodici.trim() && !PREFISSO_CODICI_NETEX.test(m.netexPrefissoCodici.trim())) e.netexPrefissoCodici = "Lettere, cifre e - (al più 20), come ABC";
  if (m.netexCodiceRete.trim() && !/^[A-Za-z0-9_-]{1,40}$/.test(m.netexCodiceRete.trim())) e.netexCodiceRete = "Lettere, cifre, - e _ (al più 40)";
  if (m.tariffeRiferimento.trim().length > 200) e.tariffeRiferimento = "Al più 200 caratteri";
  if (m.avmMatricolaCifre.trim() && !/^[1-9]$/.test(m.avmMatricolaCifre.trim())) e.avmMatricolaCifre = "Un numero da 1 a 9, oppure vuoto";
  return e;
}

/** Il corpo della richiesta di salvataggio: testi puliti, facoltativi vuoti a null, numeri veri. */
export function datiDaSalvare(m: ModuloAzienda) {
  const facoltativo = (s: string) => (s.trim() ? s.trim() : null);
  return {
    ragioneSociale: m.ragioneSociale.trim(), nome: m.nome.trim(), sito: facoltativo(m.sito), telefono: facoltativo(m.telefono),
    gtfsAgencyId: m.gtfsAgencyId.trim(), citta: m.citta.trim(), regione: facoltativo(m.regione),
    centroLat: decimale(m.centroLat), centroLng: decimale(m.centroLng), zoom: decimale(m.zoom),
    provinciaIstat: facoltativo(m.provinciaIstat),
    netexCodiceLocale: facoltativo(m.netexCodiceLocale), netexFornitore: facoltativo(m.netexFornitore),
    netexPrefisso: facoltativo(m.netexPrefisso), netexPrefissoCodici: facoltativo(m.netexPrefissoCodici),
    netexCodiceRete: facoltativo(m.netexCodiceRete),
    tariffeRiferimento: facoltativo(m.tariffeRiferimento),
    avmMatricolaCifre: m.avmMatricolaCifre.trim() ? Number(m.avmMatricolaCifre.trim()) : null,
  };
}

/* ── Le vetture dell'azienda nel canale dell'AVM (tappa 6.5) ───────────────── */

/**
 * Se la matricola (come la pubblica il canale dell'AVM) è di una vettura
 * dell'azienda: numerica, con al più `cifre` cifre. Senza cifre, tutte le
 * vetture del canale sono dell'azienda. È la stessa regola dell'API
 * (lib/vetture-azienda.ts), dallo stesso dato.
 */
export function eDellAzienda(ref: string | null | undefined, cifre: number | null): boolean {
  if (cifre === null) return true;
  const r = String(ref ?? "").trim();
  return /^\d+$/.test(r) && r.length <= cifre;
}

/** Il modulo è diverso da quello salvato? */
export function moduloCambiato(a: ModuloAzienda, b: ModuloAzienda): boolean {
  return (Object.keys(a) as CampoAzienda[]).some(k => a[k].trim() !== b[k].trim());
}
