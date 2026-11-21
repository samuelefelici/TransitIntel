/**
 * Gli orari impossibili fra due fermate, uno per riga (tappa 6.44). Pura:
 * niente database.
 *
 * Il controllo del GTFS (lib/gtfs-verifica.ts) li conta come avviso
 * «velocita_impossibile»: fra due fermate consecutive con orario la corsa
 * andrebbe a più di KMH_MASSIMI km/h. Qui lo stesso conto, tratta per tratta,
 * per chi deve correggerli: la linea, la corsa e la sua partenza, le due
 * fermate, gli orari, i secondi, i km in linea d'aria e la velocità.
 *
 * Sui dati veri gli orari sbagliati arrivano già così dalla fonte
 * dell'azienda: le fermate a minuto intero non tornano fra loro, e quelle in
 * mezzo vi sono distribuite in proporzione alla distanza. Correggerli è una
 * decisione di chi pianifica (cambia l'orario pubblicato), meglio ancora nel
 * sistema che li produce. Quindi qui nessuna correzione: l'elenco, e per ogni
 * corsa, se c'è, una corsa sana dello stesso percorso (stessa linea e stesse
 * fermate) da usare come riferimento in Planning Studio, Percorrenze › «Ricalcola
 * esistenti» (trips/retime), che ne copia i tempi tenendo ferma la partenza.
 */
import { KMH_MASSIMI, km, secondi, type Gtfs, type Riga } from "./gtfs-verifica";

export interface TrattaImpossibile {
  linea: string;
  corsa: string;
  /** la partenza della corsa dal primo capolinea */
  partenza: string;
  da: { fermata: string; nome: string; orario: string };
  a: { fermata: string; nome: string; orario: string };
  secondi: number;
  /** in linea d'aria fra le due fermate */
  km: number;
  kmh: number;
  /** una corsa dello stesso percorso senza orari impossibili, con la partenza più vicina; null se non c'è */
  riferimento: { corsa: string; partenza: string } | null;
}

const testo = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();

/** Le tratte con un orario impossibile, in ordine di linea, partenza e fermata. */
export function orariImpossibili(g: Gtfs): TrattaImpossibile[] {
  const righe = (f: string): Riga[] => g[f]?.righe ?? [];
  const posizione = new Map<string, { lat: number; lon: number }>();
  const nome = new Map<string, string>();
  for (const s of righe("stops.txt")) {
    const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
    nome.set(testo(s.stop_id), testo(s.stop_name));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) posizione.set(testo(s.stop_id), { lat, lon });
  }
  const nomeLinea = new Map(righe("routes.txt").map((r) => [testo(r.route_id), testo(r.route_short_name) || testo(r.route_id)]));
  const lineaDi = new Map(righe("trips.txt").map((t) => [testo(t.trip_id), testo(t.route_id)]));
  const perCorsa = new Map<string, Riga[]>();
  for (const st of righe("stop_times.txt")) {
    const c = testo(st.trip_id);
    if (!lineaDi.has(c)) continue;
    const l = perCorsa.get(c); if (l) l.push(st); else perCorsa.set(c, [st]);
  }

  const tratte: Array<Omit<TrattaImpossibile, "riferimento">> = [];
  const percorsoDi = new Map<string, string>(), partenzaDi = new Map<string, number>();
  const corseSbagliate = new Set<string>();
  for (const [corsa, l] of perCorsa) {
    if (l.length < 2) continue;
    l.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const linea = lineaDi.get(corsa)!;
    percorsoDi.set(corsa, `${linea}|${l.map((x) => testo(x.stop_id)).join(">")}`);
    const p0 = secondi(l[0]!.departure_time) ?? secondi(l[0]!.arrival_time);
    if (p0 !== null) partenzaDi.set(corsa, p0);
    /* lo stesso conto del controllo: le fermate con un orario valido, dalla partenza della precedente all'arrivo di questa */
    let prima: number | null = null, precedente: Riga | null = null, orarioPrima = "";
    for (const st of l) {
      const arr = secondi(st.arrival_time), par = secondi(st.departure_time);
      if ((testo(st.arrival_time) && arr === null) || (testo(st.departure_time) && par === null)) continue;
      const qui = arr ?? par;
      if (qui === null) continue;
      if (prima !== null && precedente) {
        const a = posizione.get(testo(precedente.stop_id)), b = posizione.get(testo(st.stop_id));
        const ore = (qui - prima) / 3600;
        if (a && b && ore > 0 && km(a, b) / ore > KMH_MASSIMI) {
          const d = km(a, b);
          corseSbagliate.add(corsa);
          tratte.push({
            linea: nomeLinea.get(linea) || linea, corsa, partenza: testo(l[0]!.departure_time) || testo(l[0]!.arrival_time),
            da: { fermata: testo(precedente.stop_id), nome: nome.get(testo(precedente.stop_id)) ?? "", orario: orarioPrima },
            a: { fermata: testo(st.stop_id), nome: nome.get(testo(st.stop_id)) ?? "", orario: testo(st.arrival_time) || testo(st.departure_time) },
            secondi: qui - prima, km: Math.round(d * 1000) / 1000, kmh: Math.round(d / ore),
          });
        }
      }
      prima = par ?? qui;
      orarioPrima = testo(st.departure_time) || testo(st.arrival_time);
      precedente = st;
    }
  }

  /* le corse sane di ogni percorso, per il riferimento */
  const sane = new Map<string, string[]>();
  for (const [corsa, percorso] of percorsoDi) {
    if (corseSbagliate.has(corsa) || !partenzaDi.has(corsa)) continue;
    const l = sane.get(percorso); if (l) l.push(corsa); else sane.set(percorso, [corsa]);
  }
  const riferimentoDi = new Map<string, TrattaImpossibile["riferimento"]>();
  for (const corsa of corseSbagliate) {
    const candidati = sane.get(percorsoDi.get(corsa)!) ?? [];
    const p = partenzaDi.get(corsa) ?? 0;
    let scelta: string | null = null;
    for (const c of candidati) {
      const d = Math.abs(partenzaDi.get(c)! - p), ds = scelta === null ? Infinity : Math.abs(partenzaDi.get(scelta)! - p);
      if (d < ds || (d === ds && scelta !== null && partenzaDi.get(c)! < partenzaDi.get(scelta)!)) scelta = c;
    }
    const prima = scelta ? perCorsa.get(scelta)![0]! : null;
    riferimentoDi.set(corsa, scelta && prima ? { corsa: scelta, partenza: testo(prima.departure_time) || testo(prima.arrival_time) } : null);
  }

  return tratte
    .map((t) => ({ ...t, riferimento: riferimentoDi.get(t.corsa) ?? null }))
    .sort((x, y) => x.linea.localeCompare(y.linea, "it", { numeric: true }) || (partenzaDi.get(x.corsa) ?? 0) - (partenzaDi.get(y.corsa) ?? 0)
      || x.corsa.localeCompare(y.corsa) || x.da.orario.localeCompare(y.da.orario));
}

/** Una cella per Excel in italiano: separatore «;», virgola decimale, e mai una formula (= + - @ davanti). */
function cella(v: unknown): string {
  if (v == null) return "";
  let s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const INTESTAZIONE_ORARI_IMPOSSIBILI = [
  "linea", "corsa", "partenza_corsa", "da_fermata", "da_nome", "orario_da", "a_fermata", "a_nome", "orario_a",
  "secondi", "km_in_linea_d_aria", "km_h", "corsa_di_riferimento", "partenza_riferimento",
];

/** L'elenco in CSV, col BOM perché Excel legga gli accenti. */
export function csvOrariImpossibili(tratte: readonly TrattaImpossibile[]): string {
  const righe = tratte.map((t) => [
    t.linea, t.corsa, t.partenza, t.da.fermata, t.da.nome, t.da.orario, t.a.fermata, t.a.nome, t.a.orario,
    t.secondi, t.km, t.kmh, t.riferimento?.corsa ?? "", t.riferimento?.partenza ?? "",
  ].map(cella).join(";"));
  return "\uFEFF" + [INTESTAZIONE_ORARI_IMPOSSIBILI.join(";"), ...righe].join("\r\n") + "\r\n";
}
