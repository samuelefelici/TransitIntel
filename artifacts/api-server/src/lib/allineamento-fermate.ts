/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE FERMATE DEL PROGETTO RISPETTO A QUELLE DELLA CARTOGRAFIA
 * ───────────────────────────────────────────────────────────────────────────
 * Le fermate importate dal GTFS aziendale non sempre cadono sul simbolo della
 * fermata disegnato sulla mappa (Mapbox, dati OpenStreetMap). Qui, per ogni
 * fermata, si sceglie la fermata bus della mappa più vicina entro un raggio e
 * si misura lo scarto: quanti metri e in che direzione.
 *
 * Il riepilogo distingue i due casi che chiedono rimedi diversi:
 *  - scarto SISTEMATICO: tutte spostate più o meno della stessa quantità nella
 *    stessa direzione → errore di conversione delle coordinate a monte, da
 *    correggere in blocco;
 *  - scarto SPARSO: ogni fermata per conto suo → posizioni rilevate male, da
 *    vedere caso per caso.
 *
 * Due fermate della mappa quasi alla stessa distanza (i due lati della strada)
 * rendono l'abbinamento AMBIGUO: lo si dice, e una fermata ambigua non si
 * sposta mai da sola.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface FermataMappa {
  lat: number;
  lon: number;
  nome: string | null;
}

export interface Abbinamento {
  mappa: FermataMappa;
  distanzaM: number;
  /** metri verso est (+) / ovest (−) e verso nord (+) / sud (−), dalla fermata alla mappa */
  estM: number;
  nordM: number;
  /** direzione in gradi, 0 = nord, 90 = est */
  gradi: number;
  direzione: string;
  /** un'altra fermata della mappa è quasi alla stessa distanza */
  ambigua: boolean;
  /** la seconda candidata, se c'è, per farla vedere all'operatore */
  alternativa: (FermataMappa & { distanzaM: number }) | null;
}

/** Sotto questo scarto la fermata è già "sul simbolo": niente da fare. */
export const GIA_CENTRATA_M = 3;
/** Se la seconda candidata è entro questi metri dalla prima, non si sceglie. */
export const MARGINE_AMBIGUITA_M = 6;

const R = 6_371_000;
const rad = Math.PI / 180;

export function vettore(daLat: number, daLon: number, aLat: number, aLon: number): { estM: number; nordM: number } {
  return {
    estM: (aLon - daLon) * rad * Math.cos(((daLat + aLat) / 2) * rad) * R,
    nordM: (aLat - daLat) * rad * R,
  };
}

const PUNTI = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"];
export function direzioneDa(gradi: number): string {
  return PUNTI[Math.round((((gradi % 360) + 360) % 360) / 45) % 8];
}

/** La fermata della mappa da abbinare: la più vicina entro il raggio. */
export function abbina(lat: number, lon: number, candidate: FermataMappa[], raggioM: number): Abbinamento | null {
  const misurate = candidate
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map(c => {
      const v = vettore(lat, lon, c.lat, c.lon);
      return { c, ...v, d: Math.hypot(v.estM, v.nordM) };
    })
    .filter(x => x.d <= raggioM)
    .sort((a, b) => a.d - b.d);
  if (misurate.length === 0) return null;
  const [p, s] = misurate;
  const gradi = ((Math.atan2(p.estM, p.nordM) / rad) + 360) % 360;
  const ambigua = !!s && s.d - p.d <= MARGINE_AMBIGUITA_M && p.d > GIA_CENTRATA_M;
  return {
    mappa: p.c, distanzaM: p.d, estM: p.estM, nordM: p.nordM,
    gradi, direzione: direzioneDa(gradi), ambigua,
    alternativa: s ? { ...s.c, distanzaM: s.d } : null,
  };
}

export interface Riepilogo {
  controllate: number;
  abbinate: number;
  giaCentrate: number;
  ambigue: number;
  medianaM: number | null;
  massimoM: number | null;
  /** media dei vettori (solo abbinamenti non ambigui) */
  medio: { estM: number; nordM: number; m: number; direzione: string } | null;
  sistematico: boolean;
  nota: string;
}

export function riepiloga(controllate: number, abb: (Abbinamento | null)[]): Riepilogo {
  const ok = abb.filter((a): a is Abbinamento => !!a);
  const buone = ok.filter(a => !a.ambigua);
  const dist = ok.map(a => a.distanzaM).sort((x, y) => x - y);
  const mediana = dist.length ? dist[Math.floor(dist.length / 2)] : null;
  let medio: Riepilogo["medio"] = null;
  let sistematico = false;
  if (buone.length) {
    const e = buone.reduce((t, a) => t + a.estM, 0) / buone.length;
    const n = buone.reduce((t, a) => t + a.nordM, 0) / buone.length;
    const m = Math.hypot(e, n);
    const gradi = ((Math.atan2(e, n) / rad) + 360) % 360;
    medio = { estM: e, nordM: n, m, direzione: direzioneDa(gradi) };
    // sparsa intorno al vettore medio: se è piccola rispetto al vettore,
    // lo spostamento è lo stesso per tutte
    const dispersione = buone.reduce((t, a) => t + Math.hypot(a.estM - e, a.nordM - n), 0) / buone.length;
    sistematico = buone.length >= 5 && m >= GIA_CENTRATA_M && dispersione <= 0.5 * m;
  }
  const giaCentrate = ok.filter(a => a.distanzaM <= GIA_CENTRATA_M).length;
  const nota = ok.length === 0
    ? "Nessuna fermata della mappa vicino a queste fermate: allarga il raggio o controlla che la zona abbia fermate disegnate."
    : giaCentrate === ok.length
      ? `Tutte sul simbolo della mappa (entro ${GIA_CENTRATA_M} m): niente da spostare.`
      : sistematico
      ? `Scarto SISTEMATICO: in media ${medio!.m.toFixed(1)} m verso ${medio!.direzione}. Sembra un errore di conversione delle coordinate a monte: si corregge in blocco.`
      : `Scarto SPARSO (mediana ${mediana!.toFixed(1)} m, direzioni diverse): posizioni rilevate fermata per fermata, da vedere caso per caso.`;
  return {
    controllate, abbinate: ok.length, giaCentrate, ambigue: ok.filter(a => a.ambigua).length,
    medianaM: mediana, massimoM: dist.length ? dist[dist.length - 1] : null,
    medio, sistematico, nota,
  };
}

/** Le fermate bus di una risposta tilequery (layer transit_stop_label). */
export function fermateDaTilequery(j: unknown): FermataMappa[] {
  const feats = Array.isArray((j as any)?.features) ? (j as any).features : [];
  const out: FermataMappa[] = [];
  for (const f of feats) {
    const p = f?.properties ?? {};
    const bus = p.mode === "bus" || p.maki === "bus" || p.mode === "tram" || p.mode === "trolleybus";
    if (!bus || p.stop_type === "entrance") continue;
    const lon = Number(f?.geometry?.coordinates?.[0]), lat = Number(f?.geometry?.coordinates?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ lat, lon, nome: typeof p.name === "string" ? p.name : null });
  }
  return out;
}

/* ── La cartografia: Mapbox Streets v8, la stessa della mappa dell'editor ── */

/** Raggio di ricerca: abbastanza per uno scarto vero, non tanto da prendere
 *  la fermata dell'isolato accanto. */
export const RAGGIO_DEFAULT_M = 40;
export const RAGGIO_MIN_M = 10;
export const RAGGIO_MAX_M = 80;
/** Uno spostamento scelto a mano oltre questo non è un centraggio: si rifiuta. */
export const SPOSTAMENTO_MAX_M = 80;
/** Fermate per richiesta: ogni fermata è una chiamata a Mapbox, a consumo. */
export const MAX_FERMATE = 200;
const CONCORRENZA = 4;

export function raggioValido(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || v === null || v === "" || v === undefined) return RAGGIO_DEFAULT_M;
  return Math.min(RAGGIO_MAX_M, Math.max(RAGGIO_MIN_M, Math.round(n)));
}

const cache = new Map<string, { at: number; fermate: FermataMappa[] }>();
const TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 2000;

export type Recupero = (url: string) => Promise<unknown>;

/** Le fermate bus disegnate sulla mappa entro 'raggioM' dal punto. */
export async function fermateMappaVicino(
  lat: number, lon: number, raggioM: number, token: string, recupera: Recupero,
): Promise<FermataMappa[]> {
  const chiave = `${lat.toFixed(6)},${lon.toFixed(6)},${raggioM}`;
  const hit = cache.get(chiave);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.fermate;
  // un po' di margine: la tilequery misura sul punto della feature, noi pure,
  // ma la seconda candidata appena fuori serve per dire "ambigua"
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lon},${lat}.json`
    + `?radius=${raggioM + MARGINE_AMBIGUITA_M}&limit=20&layers=transit_stop_label`
    + `&access_token=${encodeURIComponent(token)}`;
  const fermate = fermateDaTilequery(await recupera(url));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(chiave, { at: Date.now(), fermate });
  return fermate;
}

/** Un messaggio d'errore non porta mai il token fuori (log, risposta, chat). */
export function senzaToken(msg: string): string {
  return msg.replace(/access_token=[^&\s"']+/g, "access_token=***");
}

/** Svuota la cache (per i test). */
export function svuotaCache(): void { cache.clear(); }

/** Esegue 'lavoro' su ogni elemento, al massimo 'n' alla volta, nell'ordine. */
export async function aGruppi<T, R>(elementi: T[], n: number, lavoro: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(elementi.length);
  let prossimo = 0;
  const operai = Array.from({ length: Math.max(1, Math.min(n, elementi.length)) }, async () => {
    while (prossimo < elementi.length) {
      const i = prossimo++;
      out[i] = await lavoro(elementi[i]);
    }
  });
  await Promise.all(operai);
  return out;
}

export interface FermataProgetto { id: string; codice: string | null; nome: string; lat: number; lon: number }

export interface EsitoFermata {
  stopId: string;
  codice: string | null;
  nome: string;
  lat: number;
  lon: number;
  esito: "centrata" | "da_spostare" | "ambigua" | "nessuna_sulla_mappa" | "errore";
  abbinamento: Abbinamento | null;
  errore?: string;
}

/** Il controllo completo: per ogni fermata la sua candidata sulla mappa. Un
 *  errore di Mapbox su una fermata la marca 'errore', non ferma le altre — ma
 *  se cadono tutte la chiamata fallisce (meglio nessun dato che uno falso). */
export async function verificaAllineamento(
  fermate: FermataProgetto[], raggioM: number, token: string, recupera: Recupero,
): Promise<{ fermate: EsitoFermata[]; riepilogo: Riepilogo }> {
  const esiti = await aGruppi(fermate, CONCORRENZA, async (f): Promise<EsitoFermata> => {
    const base = { stopId: f.id, codice: f.codice, nome: f.nome, lat: f.lat, lon: f.lon };
    try {
      const a = abbina(f.lat, f.lon, await fermateMappaVicino(f.lat, f.lon, raggioM, token, recupera), raggioM);
      const esito = !a ? "nessuna_sulla_mappa"
        : a.distanzaM <= GIA_CENTRATA_M ? "centrata"
          : a.ambigua ? "ambigua" : "da_spostare";
      return { ...base, esito, abbinamento: a };
    } catch (e: any) {
      return { ...base, esito: "errore", abbinamento: null, errore: senzaToken(String(e?.message ?? e)).slice(0, 200) };
    }
  });
  if (esiti.length > 0 && esiti.every(e => e.esito === "errore")) {
    throw new Error(`cartografia non raggiungibile: ${esiti[0].errore}`);
  }
  return { fermate: esiti, riepilogo: riepiloga(fermate.length, esiti.map(e => e.abbinamento)) };
}
