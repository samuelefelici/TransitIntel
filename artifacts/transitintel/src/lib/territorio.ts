/**
 * Il territorio dell'azienda nella pagina Amministrazione › Azienda (tappa
 * 6.1; nell'API lib/territorio.ts, GET e scritture su /api/admin/territorio):
 * i comuni e i luoghi di riferimento. Funzioni pure, coi loro test.
 */

export interface Comune {
  codiceIstat: string; nome: string; soppresso: boolean;
  lat: number | null; lng: number | null; areaKm2: number | null; popolazione: number | null;
  sezioneCensimento: string | null;
}
export type UsoLuogo = "punti_interesse" | "meteo" | "polo_lavoro";
export interface Luogo { id: string; nome: string; uso: UsoLuogo; lat: number; lng: number; raggioM: number | null; ordine: number }

export const USI: Array<[UsoLuogo, string, string]> = [
  ["punti_interesse", "Ricerca dei punti d'interesse", "Dove si cercano scuole, ospedali, negozi e uffici, ognuno col suo raggio."],
  ["meteo", "Meteo", "I punti di cui si legge il meteo."],
  ["polo_lavoro", "Poli di lavoro e commercio", "Zone industriali e centri commerciali che le mappe non hanno, per l'analisi della rete."],
];

/** Un numero scritto da una persona: la virgola come il punto; vuoto = null; altrimenti NaN. */
export function numeroScritto(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  return /^-?\d+([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : NaN;
}

export interface ModuloComune { codiceIstat: string; nome: string; soppresso: boolean; lat: string; lng: string; areaKm2: string; popolazione: string }
export const MODULO_COMUNE_VUOTO: ModuloComune = { codiceIstat: "", nome: "", soppresso: false, lat: "", lng: "", areaKm2: "", popolazione: "" };

export const moduloComuneDa = (c: Comune): ModuloComune => ({
  codiceIstat: c.codiceIstat, nome: c.nome, soppresso: c.soppresso,
  lat: c.lat == null ? "" : String(c.lat), lng: c.lng == null ? "" : String(c.lng),
  areaKm2: c.areaKm2 == null ? "" : String(c.areaKm2), popolazione: c.popolazione == null ? "" : String(c.popolazione),
});

/** Gli errori del modulo di un comune (vuoto = si può salvare): gli stessi limiti dell'API. */
export function erroriComune(m: ModuloComune): string[] {
  const e: string[] = [];
  if (!/^[0-9]{6}$/.test(m.codiceIstat.trim())) e.push("Codice ISTAT: sei cifre, come 042002");
  if (!m.nome.trim()) e.push("Il nome va scritto");
  else if (m.nome.trim().length > 80) e.push("Nome: al più 80 caratteri");
  const lat = numeroScritto(m.lat), lng = numeroScritto(m.lng), area = numeroScritto(m.areaKm2), pop = numeroScritto(m.popolazione);
  if ((lat == null) !== (lng == null)) e.push("Latitudine e longitudine vanno insieme");
  if (lat != null && !(lat >= -90 && lat <= 90)) e.push("Latitudine: un numero fra -90 e 90");
  if (lng != null && !(lng >= -180 && lng <= 180)) e.push("Longitudine: un numero fra -180 e 180");
  if (area != null && !(area > 0 && area < 100000)) e.push("Superficie: un numero positivo, in km²");
  if (pop != null && !(Number.isInteger(pop) && pop >= 0)) e.push("Popolazione: un numero intero");
  return e;
}

export const corpoComune = (m: ModuloComune) => ({
  nome: m.nome.trim(), soppresso: m.soppresso,
  lat: numeroScritto(m.lat), lng: numeroScritto(m.lng), areaKm2: numeroScritto(m.areaKm2), popolazione: numeroScritto(m.popolazione),
});

export interface ModuloLuogo { nome: string; uso: UsoLuogo; lat: string; lng: string; raggioM: string; ordine: string }
export const moduloLuogoVuoto = (uso: UsoLuogo): ModuloLuogo => ({ nome: "", uso, lat: "", lng: "", raggioM: uso === "punti_interesse" ? "3000" : "", ordine: "" });
export const moduloLuogoDa = (l: Luogo): ModuloLuogo => ({
  nome: l.nome, uso: l.uso, lat: String(l.lat), lng: String(l.lng), raggioM: l.raggioM == null ? "" : String(l.raggioM), ordine: String(l.ordine),
});

export function erroriLuogo(m: ModuloLuogo): string[] {
  const e: string[] = [];
  if (!m.nome.trim()) e.push("Il nome va scritto");
  else if (m.nome.trim().length > 120) e.push("Nome: al più 120 caratteri");
  const lat = numeroScritto(m.lat), lng = numeroScritto(m.lng), r = numeroScritto(m.raggioM), o = numeroScritto(m.ordine);
  if (lat == null || !(lat >= -90 && lat <= 90)) e.push("Latitudine: un numero fra -90 e 90");
  if (lng == null || !(lng >= -180 && lng <= 180)) e.push("Longitudine: un numero fra -180 e 180");
  if (m.uso === "punti_interesse" && r != null && !(Number.isInteger(r) && r >= 100 && r <= 50000)) e.push("Raggio: da 100 a 50.000 metri");
  if (o != null && !(Number.isInteger(o) && o >= 0 && o <= 99999)) e.push("Ordine: un numero intero");
  return e;
}

export const corpoLuogo = (m: ModuloLuogo) => ({
  nome: m.nome.trim(), uso: m.uso, lat: numeroScritto(m.lat), lng: numeroScritto(m.lng),
  raggioM: m.uso === "punti_interesse" ? numeroScritto(m.raggioM) : null, ordine: numeroScritto(m.ordine) ?? 0,
});

/** «43.6166, 13.5185», o «—». */
export const coordinate = (lat: number | null, lng: number | null) => (lat == null || lng == null ? "—" : `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
