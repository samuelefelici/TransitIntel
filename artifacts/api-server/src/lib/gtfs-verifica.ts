/**
 * Il controllo di un GTFS prima di consegnarlo (PR 3.4).
 *
 * Il GTFS esportato da Planning Studio va a Regione, open data, fornitori di
 * AVM e bigliettazione: chi lo riceve lo passa al suo validatore, e un file
 * che non regge si scopre lì, settimane dopo. Qui si controlla prima, sulle
 * righe che stanno per finire nello zip, con le regole che i validatori
 * applicano più spesso (le obbligatorie del formato e qualche controllo di
 * buon senso). Non sostituisce il validatore ufficiale: ferma gli errori che
 * renderebbero il file inutilizzabile e segnala quelli che lo renderebbero
 * strano.
 *
 *   errori   il file così non va consegnato: l'export si ferma (si può
 *            forzare, sapendo che cosa si consegna);
 *   avvisi   il file è valido ma qualcosa non torna: si consegna e si dice.
 *
 * Funzioni pure, senza database: le righe sono quelle già pronte per i CSV.
 */
import { distanzaDalTracciato, ENTRO_KM, posizioniSulTracciato, tracciatoDa, type Tracciato } from "./netex-tratte";

export type Riga = Record<string, string | number | null | undefined>;
export interface FileGtfs { colonne: string[]; righe: Riga[] }
export type Gtfs = Record<string, FileGtfs>;

export interface Problema {
  codice: string;
  file: string;
  /** che cosa non va, detto per chi deve correggerlo */
  messaggio: string;
  /** quante righe */
  quante: number;
  /** al più 5 identificativi di esempio */
  esempi: string[];
}
export interface EsitoVerifica { errori: Problema[]; avvisi: Problema[] }

const ORARIO = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const DATA = /^\d{8}$/;
const URL_VALIDO = /^https?:\/\/[^\s",<>]+$/;
/* route_type: i sette di base, filobus e monorotaia, e i tipi estesi (100-1702) */
const TIPI_DI_LINEA = new Set([0, 1, 2, 3, 4, 5, 6, 7, 11, 12]);
/* sopra questa velocità fra due fermate consecutive c'è un orario o una posizione sbagliata */
const KMH_MASSIMI = 120;
/* oltre questa distanza (km) dal tracciato della sua corsa una fermata si segnala, come fanno i validatori */
const DISTANTE_KM = 0.1;

const testo = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();
const secondi = (v: unknown): number | null => {
  const m = ORARIO.exec(testo(v));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};
function dataValida(v: unknown): boolean {
  const s = testo(v);
  if (!DATA.test(s)) return false;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10).replace(/-/g, "") === s;
}
function fusoValido(tz: string): boolean {
  try { new Intl.DateTimeFormat("it-IT", { timeZone: tz }); return true; } catch { return false; }
}
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Raccoglie i problemi dello stesso tipo in una riga sola, con qualche esempio. */
class Raccolta {
  private readonly mappa = new Map<string, Problema>();
  aggiungi(codice: string, file: string, messaggio: string, esempio?: string): void {
    const chiave = `${codice}|${file}`;
    let p = this.mappa.get(chiave);
    if (!p) { p = { codice, file, messaggio, quante: 0, esempi: [] }; this.mappa.set(chiave, p); }
    p.quante++;
    if (esempio !== undefined && p.esempi.length < 5 && !p.esempi.includes(esempio)) p.esempi.push(esempio);
  }
  elenco(): Problema[] { return [...this.mappa.values()]; }
}

/** Gli id doppi di una colonna, uno per id ripetuto. */
function doppi(righe: Riga[], colonna: string, errori: Raccolta, file: string, cosa: string): Set<string> {
  const visti = new Set<string>();
  for (const r of righe) {
    const id = testo(r[colonna]);
    if (!id) { errori.aggiungi(`${colonna}_vuoto`, file, `${cosa} senza ${colonna}`); continue; }
    if (visti.has(id)) errori.aggiungi(`${colonna}_doppio`, file, `${cosa} con lo stesso ${colonna}`, id);
    visti.add(id);
  }
  return visti;
}

/**
 * Controlla il GTFS. `oggi` (AAAAMMGG) serve a dire se il file è già scaduto.
 */
export function verificaGtfs(g: Gtfs, oggi: string = new Date().toISOString().slice(0, 10).replace(/-/g, "")): EsitoVerifica {
  const errori = new Raccolta(), avvisi = new Raccolta();
  const righe = (f: string): Riga[] => g[f]?.righe ?? [];
  for (const f of ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"]) {
    if (!g[f]) errori.aggiungi("file_mancante", f, "manca un file obbligatorio");
    else if (righe(f).length === 0) errori.aggiungi("file_vuoto", f, "un file obbligatorio non ha righe");
  }
  if (!g["calendar.txt"]?.righe.length && !g["calendar_dates.txt"]?.righe.length) {
    errori.aggiungi("nessun_calendario", "calendar.txt", "né calendar.txt né calendar_dates.txt hanno righe: nessuna corsa ha un giorno di servizio");
  }

  /* agency */
  const agenzie = doppi(righe("agency.txt"), "agency_id", errori, "agency.txt", "un'azienda");
  for (const a of righe("agency.txt")) {
    if (!testo(a.agency_name)) errori.aggiungi("agency_name_vuoto", "agency.txt", "l'azienda non ha un nome", testo(a.agency_id));
    if (!URL_VALIDO.test(testo(a.agency_url))) {
      errori.aggiungi("agency_url_non_valido", "agency.txt", "manca il sito dell'azienda (agency_url è obbligatorio): si imposta in Amministrazione › Azienda", testo(a.agency_id));
    }
    if (!fusoValido(testo(a.agency_timezone))) errori.aggiungi("agency_timezone_non_valido", "agency.txt", "il fuso orario non è valido", testo(a.agency_timezone));
  }

  /* stops */
  const fermate = doppi(righe("stops.txt"), "stop_id", errori, "stops.txt", "una fermata");
  const posizione = new Map<string, { lat: number; lon: number }>();
  for (const s of righe("stops.txt")) {
    const id = testo(s.stop_id), lat = Number(s.stop_lat), lon = Number(s.stop_lon);
    if (!testo(s.stop_name)) errori.aggiungi("stop_name_vuoto", "stops.txt", "una fermata non ha un nome", id);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      errori.aggiungi("coordinate_non_valide", "stops.txt", "una fermata ha coordinate non valide", id);
    } else if (lat === 0 && lon === 0) {
      errori.aggiungi("coordinate_zero", "stops.txt", "una fermata è nel punto 0,0 (coordinate mancanti)", id);
    } else posizione.set(id, { lat, lon });
  }

  /* routes */
  const linee = doppi(righe("routes.txt"), "route_id", errori, "routes.txt", "una linea");
  for (const r of righe("routes.txt")) {
    const id = testo(r.route_id);
    if (agenzie.size > 1 || testo(r.agency_id)) {
      if (!agenzie.has(testo(r.agency_id))) errori.aggiungi("agency_id_sconosciuto", "routes.txt", "una linea è di un'azienda che non è in agency.txt", id);
    }
    if (!testo(r.route_short_name) && !testo(r.route_long_name)) errori.aggiungi("route_senza_nome", "routes.txt", "una linea non ha né nome breve né nome lungo", id);
    const tipo = Number(r.route_type);
    if (!Number.isInteger(tipo) || !(TIPI_DI_LINEA.has(tipo) || (tipo >= 100 && tipo <= 1702))) {
      errori.aggiungi("route_type_non_valido", "routes.txt", "una linea ha un tipo (route_type) non valido", id);
    }
  }

  /* calendari: quali servizi hanno almeno un giorno */
  const servizi = new Set<string>(), serviziConGiorni = new Set<string>();
  for (const c of righe("calendar.txt")) {
    const id = testo(c.service_id);
    servizi.add(id);
    if (!dataValida(c.start_date) || !dataValida(c.end_date)) errori.aggiungi("data_non_valida", "calendar.txt", "un calendario ha una data non valida", id);
    else if (testo(c.start_date) > testo(c.end_date)) errori.aggiungi("calendario_rovesciato", "calendar.txt", "un calendario finisce prima di cominciare", id);
    else if (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].some((d) => Number(c[d]) === 1)) serviziConGiorni.add(id);
  }
  for (const d of righe("calendar_dates.txt")) {
    const id = testo(d.service_id);
    servizi.add(id);
    if (!dataValida(d.date)) errori.aggiungi("data_non_valida", "calendar_dates.txt", "un'eccezione di calendario ha una data non valida", id);
    else if (Number(d.exception_type) === 1) serviziConGiorni.add(id);
  }

  /* trips */
  const corse = doppi(righe("trips.txt"), "trip_id", errori, "trips.txt", "una corsa");
  const forme = new Set(righe("shapes.txt").map((s) => testo(s.shape_id)));
  const lineeUsate = new Set<string>(), formeUsate = new Set<string>();
  for (const t of righe("trips.txt")) {
    const id = testo(t.trip_id);
    if (!linee.has(testo(t.route_id))) errori.aggiungi("route_id_sconosciuto", "trips.txt", "una corsa è di una linea che non è in routes.txt", id);
    lineeUsate.add(testo(t.route_id));
    const servizio = testo(t.service_id);
    if (!servizi.has(servizio)) errori.aggiungi("service_id_sconosciuto", "trips.txt", "una corsa ha un calendario (service_id) che non è né in calendar.txt né in calendar_dates.txt", id);
    else if (!serviziConGiorni.has(servizio)) avvisi.aggiungi("servizio_senza_giorni", "trips.txt", "una corsa ha un calendario senza nessun giorno di servizio: non circola mai", id);
    const forma = testo(t.shape_id);
    if (forma) {
      formeUsate.add(forma);
      if (!forme.has(forma)) errori.aggiungi("shape_id_sconosciuto", "trips.txt", "una corsa ha un percorso (shape_id) che non è in shapes.txt", id);
    }
  }

  /* stop_times, corsa per corsa */
  const perCorsa = new Map<string, Riga[]>();
  const fermateUsate = new Set<string>();
  for (const st of righe("stop_times.txt")) {
    const corsa = testo(st.trip_id), fermata = testo(st.stop_id);
    if (!corse.has(corsa)) { errori.aggiungi("trip_id_sconosciuto", "stop_times.txt", "un orario è di una corsa che non è in trips.txt", corsa); continue; }
    if (!fermate.has(fermata)) errori.aggiungi("stop_id_sconosciuto", "stop_times.txt", "un orario è a una fermata che non è in stops.txt", `${corsa} @ ${fermata}`);
    fermateUsate.add(fermata);
    let l = perCorsa.get(corsa);
    if (!l) { l = []; perCorsa.set(corsa, l); }
    l.push(st);
  }
  for (const id of corse) {
    const l = perCorsa.get(id) ?? [];
    if (l.length < 2) { errori.aggiungi("corsa_senza_orari", "stop_times.txt", "una corsa ha meno di due fermate con orario", id); continue; }
    l.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    let prima: number | null = null, sequenza = -Infinity, precedente: Riga | null = null;
    const primoOrario = secondi(l[0]!.departure_time) ?? secondi(l[0]!.arrival_time);
    const ultimoOrario = secondi(l[l.length - 1]!.arrival_time) ?? secondi(l[l.length - 1]!.departure_time);
    if (primoOrario === null || ultimoOrario === null) errori.aggiungi("capolinea_senza_orario", "stop_times.txt", "una corsa non ha l'orario al primo o all'ultimo capolinea", id);
    for (const st of l) {
      const seq = Number(st.stop_sequence);
      if (!Number.isInteger(seq) || seq <= sequenza) errori.aggiungi("stop_sequence_non_crescente", "stop_times.txt", "in una corsa la sequenza delle fermate (stop_sequence) non cresce", id);
      sequenza = seq;
      const arr = secondi(st.arrival_time), par = secondi(st.departure_time);
      if ((testo(st.arrival_time) && arr === null) || (testo(st.departure_time) && par === null)) {
        errori.aggiungi("orario_non_valido", "stop_times.txt", "un orario non è nella forma HH:MM:SS", id);
        continue;
      }
      if (arr !== null && par !== null && par < arr) errori.aggiungi("partenza_prima_dell_arrivo", "stop_times.txt", "a una fermata la partenza è prima dell'arrivo", id);
      const qui = arr ?? par;
      if (qui !== null) {
        if (prima !== null && qui < prima) errori.aggiungi("orari_all_indietro", "stop_times.txt", "in una corsa l'orario torna indietro da una fermata alla successiva", id);
        /* velocità fra due fermate con orario: un orario o una posizione sbagliati */
        if (prima !== null && precedente) {
          const a = posizione.get(testo(precedente.stop_id)), b = posizione.get(testo(st.stop_id));
          const ore = (qui - prima) / 3600;
          if (a && b && ore > 0 && km(a, b) / ore > KMH_MASSIMI) {
            avvisi.aggiungi("velocita_impossibile", "stop_times.txt", `fra due fermate consecutive la corsa andrebbe a più di ${KMH_MASSIMI} km/h`, id);
          }
        }
        prima = par ?? qui;
        precedente = st;
      }
    }
  }

  verificaTracciati(righe, perCorsa, posizione, avvisi);

  /* quello che non usa nessuno */
  for (const s of righe("stops.txt")) {
    if (!fermateUsate.has(testo(s.stop_id))) avvisi.aggiungi("fermata_non_usata", "stops.txt", "una fermata non è servita da nessuna corsa", testo(s.stop_id));
  }
  for (const r of righe("routes.txt")) {
    if (!lineeUsate.has(testo(r.route_id))) avvisi.aggiungi("linea_senza_corse", "routes.txt", "una linea non ha corse", testo(r.route_id));
  }
  for (const f of forme) if (!formeUsate.has(f)) avvisi.aggiungi("percorso_non_usato", "shapes.txt", "un percorso non è usato da nessuna corsa", f);

  /* il periodo del file */
  for (const fi of righe("feed_info.txt")) {
    const inizio = testo(fi.feed_start_date), fine = testo(fi.feed_end_date);
    if ((inizio && !dataValida(inizio)) || (fine && !dataValida(fine))) errori.aggiungi("data_non_valida", "feed_info.txt", "il periodo del file ha una data non valida");
    else if (inizio && fine && inizio > fine) errori.aggiungi("periodo_rovesciato", "feed_info.txt", "il periodo del file finisce prima di cominciare");
    else if (fine && fine < oggi) avvisi.aggiungi("file_scaduto", "feed_info.txt", `il periodo del file è già finito (${fine})`);
  }

  verificaTariffe(righe, fermate, linee, errori);

  return { errori: errori.elenco(), avvisi: avvisi.elenco() };
}


/**
 * Le fermate e il tracciato della loro corsa (tappa 6.43). Per ogni percorso
 * (tracciato e fermate) una volta sola:
 *  - una fermata a più di 100 m dal tracciato si segnala, come fanno i
 *    validatori; oltre i 300 m, nel NeTEx le tratte che la toccano restano in
 *    linea retta (lib/netex-tratte.ts);
 *  - una fermata vicina al tracciato, ma in un punto che la corsa ha già
 *    passato prima della fermata precedente, dice che l'ordine delle fermate o
 *    il tracciato non tornano: anche lì il NeTEx non ha la tratta.
 * Negli esempi la linea, la fermata col nome e, per le lontane, i metri.
 */
function verificaTracciati(
  righe: (f: string) => Riga[], perCorsa: Map<string, Riga[]>, posizione: Map<string, { lat: number; lon: number }>, avvisi: Raccolta,
): void {
  const puntiDi = new Map<string, Riga[]>();
  for (const r of righe("shapes.txt")) {
    const k = testo(r.shape_id); const l = puntiDi.get(k); if (l) l.push(r); else puntiDi.set(k, [r]);
  }
  if (!puntiDi.size) return;
  const nomeFermata = new Map(righe("stops.txt").map((s) => [testo(s.stop_id), testo(s.stop_name)]));
  const nomeLinea = new Map(righe("routes.txt").map((r) => [testo(r.route_id), testo(r.route_short_name) || testo(r.route_id)]));
  const tracciati = new Map<string, Tracciato | null>();
  const percorsi = new Set<string>(), lontane = new Set<string>(), fuoriOrdine = new Set<string>();
  for (const t of righe("trips.txt")) {
    const forma = testo(t.shape_id), orari = perCorsa.get(testo(t.trip_id));
    if (!forma || !orari || orari.length < 2) continue;
    const fermate = orari.map((st) => testo(st.stop_id));
    const percorso = `${forma}|${fermate.join(">")}`;
    if (percorsi.has(percorso)) continue;
    percorsi.add(percorso);
    let tr = tracciati.get(forma);
    if (tr === undefined) { const r = puntiDi.get(forma); tr = r ? tracciatoDa(r) : null; tracciati.set(forma, tr); }
    if (!tr) continue;
    const pos = fermate.map((f): [number, number] | null => { const p = posizione.get(f); return p ? [p.lat, p.lon] : null; });
    const linea = nomeLinea.get(testo(t.route_id)) || testo(t.route_id);
    const dove = (f: string) => `${linea} · ${f}${nomeFermata.get(f) ? ` «${nomeFermata.get(f)}»` : ""}`;
    const distanze = pos.map((p) => (p ? distanzaDalTracciato(tr!, p) : null));
    const s = posizioniSulTracciato(tr, pos);
    fermate.forEach((f, i) => {
      const d = distanze[i];
      if (d == null) return;
      if (d > DISTANTE_KM && !lontane.has(`${forma}|${f}`)) {
        lontane.add(`${forma}|${f}`);
        avvisi.aggiungi("fermata_lontana_dal_tracciato", "stop_times.txt",
          `una fermata è a più di ${DISTANTE_KM * 1000} m dal tracciato della sua corsa (oltre ${ENTRO_KM * 1000} m, nel NeTEx le tratte che la toccano restano in linea retta)`,
          `${dove(f)}: ${Math.round(d * 1000)} m`);
      }
      if (s[i] == null && d <= ENTRO_KM && !fuoriOrdine.has(`${percorso}|${i}`)) {
        fuoriOrdine.add(`${percorso}|${i}`);
        avvisi.aggiungi("fermata_fuori_ordine_sul_tracciato", "stop_times.txt",
          "il tracciato passa da una fermata solo prima della fermata precedente: l'ordine delle fermate o il tracciato della corsa non tornano (nel NeTEx le tratte che la toccano restano in linea retta)",
          dove(f));
      }
    });
  }
}

/** Un problema in una riga, con i primi esempi: per le intestazioni dell'export e per i dati aperti. */
export const rigaDelProblema = (p: Problema, esempi = 2): string =>
  `${p.messaggio} (${p.quante})${p.esempi.length ? `: ${p.esempi.slice(0, esempi).join(", ")}` : ""}`;

/**
 * Le tariffe (GTFS Fares v2, tappa 6.37): ogni riferimento fra i file deve
 * trovare la riga a cui punta. Senza file tariffari non c'è niente da
 * controllare. I file li fa Cerbero coerenti: un errore qui è un difetto.
 */
function verificaTariffe(righe: (f: string) => Riga[], fermate: Set<string>, linee: Set<string>, errori: Raccolta): void {
  const ci = (f: string) => righe(f).length > 0;
  if (!["fare_products.txt", "fare_leg_rules.txt", "networks.txt", "areas.txt"].some(ci)) return;
  const categorie = doppi(righe("rider_categories.txt"), "rider_category_id", errori, "rider_categories.txt", "una categoria di passeggero");
  const supporti = doppi(righe("fare_media.txt"), "fare_media_id", errori, "fare_media.txt", "un supporto");
  const reti = doppi(righe("networks.txt"), "network_id", errori, "networks.txt", "una rete");
  const aree = doppi(righe("areas.txt"), "area_id", errori, "areas.txt", "un'area");
  const prodotti = new Set<string>();
  for (const p of righe("fare_products.txt")) {
    const id = testo(p.fare_product_id);
    if (!id) { errori.aggiungi("fare_product_id_vuoto", "fare_products.txt", "un titolo senza fare_product_id"); continue; }
    prodotti.add(id);
    const cat = testo(p.rider_category_id), sup = testo(p.fare_media_id);
    if (cat && !categorie.has(cat)) errori.aggiungi("categoria_inesistente", "fare_products.txt", "un titolo con una categoria di passeggero che non c'è", id);
    if (sup && !supporti.has(sup)) errori.aggiungi("supporto_inesistente", "fare_products.txt", "un titolo con un supporto che non c'è", id);
    const prezzo = Number(p.amount);
    if (!Number.isFinite(prezzo) || prezzo < 0) errori.aggiungi("prezzo_non_valido", "fare_products.txt", "un titolo senza un prezzo valido", id);
  }
  const conRete = new Set<string>();
  for (const r of righe("route_networks.txt")) {
    const rete = testo(r.network_id), linea = testo(r.route_id);
    if (!reti.has(rete)) errori.aggiungi("rete_inesistente", "route_networks.txt", "una linea assegnata a una rete che non c'è", linea);
    if (!linee.has(linea)) errori.aggiungi("linea_inesistente", "route_networks.txt", "una rete con una linea che non c'è", linea);
    if (conRete.has(linea)) errori.aggiungi("linea_in_due_reti", "route_networks.txt", "una linea in due reti", linea);
    conRete.add(linea);
  }
  for (const a of righe("stop_areas.txt")) {
    if (!aree.has(testo(a.area_id))) errori.aggiungi("area_inesistente", "stop_areas.txt", "una fermata in un'area che non c'è", testo(a.area_id));
    if (!fermate.has(testo(a.stop_id))) errori.aggiungi("fermata_inesistente", "stop_areas.txt", "un'area con una fermata che non c'è", testo(a.stop_id));
  }
  const gruppi = new Set<string>();
  for (const r of righe("fare_leg_rules.txt")) {
    const rete = testo(r.network_id), da = testo(r.from_area_id), a = testo(r.to_area_id), p = testo(r.fare_product_id);
    if (rete && !reti.has(rete)) errori.aggiungi("regola_rete_inesistente", "fare_leg_rules.txt", "una regola su una rete che non c'è", rete);
    if ((da && !aree.has(da)) || (a && !aree.has(a))) errori.aggiungi("regola_area_inesistente", "fare_leg_rules.txt", "una regola fra aree che non ci sono", `${da} → ${a}`);
    if (!prodotti.has(p)) errori.aggiungi("regola_titolo_inesistente", "fare_leg_rules.txt", "una regola con un titolo che non c'è", p);
    if (testo(r.leg_group_id)) gruppi.add(testo(r.leg_group_id));
  }
  /* i trasbordi: gruppi e titoli che ci sono; transfer_count solo (e sempre) dentro lo stesso gruppo; il tipo della durata se c'è una durata */
  for (const t of righe("fare_transfer_rules.txt")) {
    const da = testo(t.from_leg_group_id), a = testo(t.to_leg_group_id), p = testo(t.fare_product_id);
    const chi = `${da} → ${a}`;
    if ((da && !gruppi.has(da)) || (a && !gruppi.has(a))) errori.aggiungi("trasbordo_gruppo_inesistente", "fare_transfer_rules.txt", "un trasbordo fra gruppi di tratte che non ci sono", chi);
    if (p && !prodotti.has(p)) errori.aggiungi("trasbordo_titolo_inesistente", "fare_transfer_rules.txt", "un trasbordo con un titolo che non c'è", p);
    const conteggio = testo(t.transfer_count);
    if (da === a && da && !/^(-1|[1-9]\d*)$/.test(conteggio)) errori.aggiungi("trasbordo_senza_conteggio", "fare_transfer_rules.txt", "un trasbordo dentro lo stesso gruppo senza transfer_count", chi);
    if (da !== a && conteggio) errori.aggiungi("trasbordo_conteggio_vietato", "fare_transfer_rules.txt", "un trasbordo fra gruppi diversi con transfer_count", chi);
    if (testo(t.duration_limit) && !/^[0-3]$/.test(testo(t.duration_limit_type))) errori.aggiungi("trasbordo_durata_senza_tipo", "fare_transfer_rules.txt", "un trasbordo con una durata senza duration_limit_type", chi);
    if (!/^[0-2]$/.test(testo(t.fare_transfer_type))) errori.aggiungi("trasbordo_tipo_non_valido", "fare_transfer_rules.txt", "un trasbordo senza un fare_transfer_type valido", chi);
  }
}
