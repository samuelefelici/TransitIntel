/**
 * NeTEx con il profilo italiano, livello 1 (tappa 6.2), e livello 3 con le
 * tariffe (tappa 6.40, lib/netex-tariffe.ts) quando il GTFS le porta.
 *
 * Il livello 1 del profilo italiano coincide con il profilo europeo per
 * l'informazione ai passeggeri, EPIP (UNI CEN/TS 16614-4:2021). Riferimenti:
 * «Linee guida per la compilazione del profilo italiano del NeTEx» v4.0.1
 * (11 marzo 2024) e lo schema EPIP pubblicato con il profilo italiano
 * (assets/netex-epip/, dal repository 5Tsrl/netex-italian-profile).
 *
 * Si costruisce dal GTFS consegnabile (lib/gtfs-consegnabile.ts): la
 * stessa versione del programma, la stessa azienda, gli stessi codici stabili,
 * lo stesso controllo. Qui solo la traduzione, pura: niente database.
 *
 *   PublicationDelivery
 *     CompositeFrame  EU_PI_NETWORK_OFFER, con il Codespace e la validità
 *       ResourceFrame        EU_PI_COMMON    gli operatori: l'azienda, o i
 *                                            gestori che hanno linee (6.12)
 *       SiteFrame            EU_PI_STOP      le fermate (StopPlace con una Quay)
 *       ServiceFrame         EU_PI_NETWORK   rete, linee, punti di fermata,
 *                                            tratte col tracciato (ServiceLink,
 *                                            6.42), assegnazioni, sequenze di
 *                                            fermate
 *       ServiceCalendarFrame EU_PI_CALENDAR  un ServiceCalendar: un DayType per
 *                                            servizio, il suo periodo di esercizio
 *                                            (UicOperatingPeriod coi giorni validi)
 *                                            e l'assegnazione che li lega (6.41)
 *       TimetableFrame       EU_PI_TIMETABLE le corse, con gli orari
 *       FareFrame            EU_PI_FARE      le tariffe (livello 3), e nello
 *                                            ServiceFrame le zone tariffarie
 *
 * Identificativi (linee guida, 4.2.1): [nazione]:[codice locale]:[Tipo]:[codice]
 * e, se c'è, :[fornitore]. Il codice è quello stabile della 3.1, ripulito per
 * stare nei caratteri ammessi (pezzoId): resta lo stesso da un export
 * all'altro. Le sequenze di fermate prendono il nome dalla linea,
 * dalla direzione e da un'impronta della sequenza, così sono stabili anche loro.
 *
 * Come quelli della Regione (tappa 6.19c), se l'azienda li indica:
 *   [prefisso]:IT:[codice locale]:[Tipo]:[prefisso dei codici]_[codice]
 * per esempio epd:IT:ITI3:Line:ABC_1/3. Il prefisso va davanti a tutti gli
 * identificativi, contenitori compresi; quello dei codici davanti a ogni
 * codice tranne gli operatori (il codice del gestore) e la rete, che ha il
 * suo codice. Senza: IT:ITI3:Line:1/3, e la rete col codice dell'azienda.
 */
import { createHash } from "node:crypto";
import type { Gtfs, Riga } from "./gtfs-verifica";
import { tariffeNetex, type ConteggiTariffeNetex, type TariffePerNetex } from "./netex-tariffe";
import { posList, stessaStrada, tracciatoDa, trattePercorso, type Tracciato, type Tratta } from "./netex-tratte";

export interface OpzioniNetex {
  /** il codice locale (NUTS) dell'identificativo: per le Marche «ITI3» */
  codiceLocale: string;
  /** il fornitore dei dati in fondo agli identificativi (facoltativo) */
  fornitore: string | null;
  /** il prefisso davanti a ogni identificativo, come «epd» della Regione (facoltativo, tappa 6.19c) */
  prefisso?: string | null;
  /** il prefisso davanti a ogni codice, come «ABC» (→ «ABC_1/3»), tranne operatori e rete */
  prefissoCodici?: string | null;
  /** il codice della rete, come «RETE_TPL_ABC»; senza, quello dell'azienda */
  codiceRete?: string | null;
  /** chi trasmette il file (ParticipantRef) */
  partecipante: string;
  /** il nome dell'azienda e i suoi contatti: è l'operatore, se non ci sono gestori, e dà il nome ai contenitori del file */
  azienda: { ragioneSociale: string; nome: string; sito: string | null; telefono: string | null; codice: string };
  /**
   * I gestori delle linee (tappa 6.12), se l'azienda ne ha: ognuno è un
   * operatore, e ogni linea porta il suo (quello che dice agency_id in
   * routes.txt). Vuoto o assente: un operatore solo, l'azienda, come prima.
   */
  operatori?: readonly OperatoreNetex[];
  /** il codice dell'operatore delle linee che non ne dicono uno dell'elenco: il gestore predefinito */
  operatorePrincipale?: string;
  /** quando è stato fatto il file */
  adesso: Date;
  /** una descrizione per chi lo riceve */
  descrizione?: string;
  /**
   * Quello che il livello 3 vuole oltre ai file tariffari del GTFS (tappa
   * 6.40). Con questo e coi titoli nel GTFS il file ha le tariffe; senza,
   * resta di livello 1.
   */
  tariffe?: TariffePerNetex | null;
}

/** Un operatore del NeTEx: un gestore, coi suoi contatti. */
export interface OperatoreNetex {
  codice: string;
  nome: string;
  sito: string | null;
  telefono: string | null;
  email: string | null;
}

export interface ConteggiNetex {
  fermate: number; linee: number; sequenze: number; corse: number; orari: number; tipiDiGiorno: number; giorni: number;
  /** le corse senza giorni di servizio, lasciate fuori */
  corseSenzaGiorni: number;
  /** gli operatori scritti nel file: uno, se non ci sono gestori */
  operatori: number;
  /** le tratte col tracciato (ServiceLink, tappa 6.42) */
  tratte: number;
  /** le coppie di fermate consecutive dei percorsi senza tracciato: lì chi legge il file traccia una linea retta */
  tratteSenzaTracciato: number;
  /** le tariffe del livello 3; null se il file è di livello 1 */
  tariffe: ConteggiTariffeNetex | null;
}

/* ── Piccoli attrezzi ────────────────────────────────────────────────────── */

const xml = (v: unknown) => String(v ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const testo = (v: unknown) => (v == null ? "" : String(v).trim());
/**
 * Un pezzo di identificativo: solo lettere, cifre, «-», «_», «.» e «/» (e
 * mai «:», che negli identificativi NeTEx separa le parti). Il punto e la
 * barra restano, come nei file della Regione («1/3», «C.D.», «46/»): lo
 * schema li ammette (gli id sono xsd:normalizedString). Un codice già pulito
 * resta com'è; uno con altri caratteri li perde e prende in coda un'impronta
 * del codice originale, così due codici diversi restano due identificativi
 * diversi, e sempre gli stessi da un export all'altro.
 */
export function pezzoId(v: unknown): string {
  const t = testo(v);
  if (/^[A-Za-z0-9_./-]+$/.test(t)) return t;
  return `${t.replace(/[^A-Za-z0-9_./-]+/g, "_") || "x"}-${createHash("sha256").update(t).digest("hex").slice(0, 8)}`;
}

/** «HH:MM:SS» di un orario GTFS che può passare le 24, e il giorno dopo. */
export function orarioNetex(t: unknown): { ora: string; giorni: number } | null {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(testo(t));
  if (!m) return null;
  const h = Number(m[1]);
  return { ora: `${String(h % 24).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`, giorni: Math.floor(h / 24) };
}

/**
 * Il periodo di esercizio di un servizio (tappa 6.41): dal primo all'ultimo
 * giorno, e un carattere per giorno, «1» se il servizio c'è e «0» se no
 * (ValidDayBits). Così lo vogliono le linee guida per OpenTripPlanner
 * (Appendice A della v5.0.1). Date «YYYY-MM-DD», in ordine.
 */
export function periodoDiEsercizio(date: readonly string[]): { dal: string; al: string; bit: string } | null {
  if (!date.length) return null;
  const si = new Set(date);
  const dal = date[0]!, al = date[date.length - 1]!;
  let bit = "";
  for (let t = Date.parse(`${dal}T12:00:00Z`), fine = Date.parse(`${al}T12:00:00Z`); t <= fine; t += 86_400_000) {
    bit += si.has(new Date(t).toISOString().slice(0, 10)) ? "1" : "0";
  }
  return { dal, al, bit };
}

/** I giorni di servizio di ogni service_id, da calendar e calendar_dates (date «YYYY-MM-DD»). */
export function giorniDiServizio(gtfs: Gtfs): Map<string, string[]> {
  const giorni = new Map<string, Set<string>>();
  const data = (s: unknown) => { const t = testo(s); return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null; };
  const set = (id: string) => { let g = giorni.get(id); if (!g) { g = new Set(); giorni.set(id, g); } return g; };
  const settimana = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (const r of gtfs["calendar.txt"]?.righe ?? []) {
    const id = testo(r.service_id), da = data(r.start_date), a = data(r.end_date);
    if (!id || !da || !a) continue;
    const g = set(id);
    for (let t = Date.parse(`${da}T12:00:00Z`), fine = Date.parse(`${a}T12:00:00Z`), n = 0; t <= fine && n < 1500; t += 86_400_000, n++) {
      const d = new Date(t);
      if (String(r[settimana[d.getUTCDay()]!]) === "1") g.add(d.toISOString().slice(0, 10));
    }
  }
  for (const r of gtfs["calendar_dates.txt"]?.righe ?? []) {
    const id = testo(r.service_id), d = data(r.date);
    if (!id || !d) continue;
    if (String(r.exception_type) === "1") set(id).add(d);
    else if (String(r.exception_type) === "2") giorni.get(id)?.delete(d);
  }
  return new Map([...giorni].map(([k, v]) => [k, [...v].sort()]));
}

const MODI: Record<string, string> = { "0": "tram", "1": "metro", "2": "rail", "3": "bus", "4": "water", "5": "cableway", "6": "telecabin", "7": "funicular", "11": "trolleyBus", "12": "rail" };
const modoDi = (routeType: unknown) => MODI[testo(routeType)] ?? (Number(routeType) >= 700 && Number(routeType) < 800 ? "bus" : "bus");

/* ── La traduzione ───────────────────────────────────────────────────────── */

export function netexDaGtfs(gtfs: Gtfs, o: OpzioniNetex): { xml: string; conteggi: ConteggiNetex } {
  const loc = pezzoId(o.codiceLocale);
  const fine = o.fornitore ? `:${pezzoId(o.fornitore)}` : "";
  /* [prefisso]:IT:[codice locale]: davanti a tutto, contenitori compresi */
  const it = `${o.prefisso ? `${pezzoId(o.prefisso)}:` : ""}IT:${loc}`;
  const davantiAiCodici = o.prefissoCodici ? `${pezzoId(o.prefissoCodici)}_` : "";
  /* gli oggetti della rete e degli orari: col prefisso dei codici */
  const id = (tipo: string, codice: unknown) => `${it}:${tipo}:${davantiAiCodici}${pezzoId(codice)}${fine}`;
  /* operatori e rete: il loro codice com'è */
  const idProprio = (tipo: string, codice: unknown) => `${it}:${tipo}:${pezzoId(codice)}${fine}`;
  const v = 'version="1"';
  const righe = (f: string): Riga[] => gtfs[f]?.righe ?? [];

  /* le corse con giorni di servizio; le altre fuori, e si contano */
  const giorni = giorniDiServizio(gtfs);
  const corseTutte = righe("trips.txt");
  const corse = corseTutte.filter((t) => (giorni.get(testo(t.service_id))?.length ?? 0) > 0);
  const servizi = [...new Set(corse.map((t) => testo(t.service_id)))].sort();
  const tuttiIGiorni = servizi.flatMap((s) => giorni.get(s) ?? []);
  const dal = tuttiIGiorni.length ? tuttiIGiorni.reduce((a, b) => (a < b ? a : b)) : o.adesso.toISOString().slice(0, 10);
  const al = tuttiIGiorni.length ? tuttiIGiorni.reduce((a, b) => (a > b ? a : b)) : dal;

  /* gli orari per corsa, in ordine */
  const orariDi = new Map<string, Riga[]>();
  for (const st of righe("stop_times.txt")) {
    const k = testo(st.trip_id); const l = orariDi.get(k); if (l) l.push(st); else orariDi.set(k, [st]);
  }
  for (const l of orariDi.values()) l.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  /* le sequenze di fermate: per linea, direzione e fermate, con un'impronta stabile */
  const sequenze = new Map<string, { id: string; linea: string; direzione: string; fermate: Riga[]; capolinea: string; forma: string }>();
  const sequenzaDi = new Map<string, string>();
  for (const t of corse) {
    const st = orariDi.get(testo(t.trip_id)) ?? [];
    if (st.length < 2) continue;
    const linea = testo(t.route_id), direzione = testo(t.direction_id) || "0";
    const firma = st.map((x) => testo(x.stop_id)).join(">");
    const k = `${linea}|${direzione}|${firma}`;
    if (!sequenze.has(k)) {
      const impronta = createHash("sha256").update(firma).digest("hex").slice(0, 8);
      sequenze.set(k, { id: `${pezzoId(linea)}-${direzione}-${impronta}`, linea, direzione, fermate: st, capolinea: testo(t.trip_headsign), forma: testo(t.shape_id) });
    }
    sequenzaDi.set(testo(t.trip_id), k);
  }
  const corseConSequenza = corse.filter((t) => sequenzaDi.has(testo(t.trip_id)));
  const fermateUsate = new Set([...sequenze.values()].flatMap((s) => s.fermate.map((x) => testo(x.stop_id))));
  const fermate = righe("stops.txt").filter((s) => fermateUsate.has(testo(s.stop_id)));
  const lineeUsate = new Set(corseConSequenza.map((t) => testo(t.route_id)));
  const linee = righe("routes.txt").filter((r) => lineeUsate.has(testo(r.route_id)));
  const modoDellaLinea = new Map(linee.map((r) => [testo(r.route_id), modoDi(r.route_type)]));

  /* Le tratte fra due fermate consecutive col loro pezzo di tracciato (tappa 6.42,
   * lib/netex-tratte.ts), dal tracciato della prima corsa di ogni sequenza. Una per
   * coppia di fermate e strada: se due sequenze fanno la stessa strada fra le stesse
   * fermate, la tratta è una; se ne fanno due diverse, la seconda prende «_2». Dove il
   * tracciato manca, o non passa dalla fermata, la tratta non c'è (e si conta); fra due
   * fermate che cadono nello stesso punto non c'è e non si conta (tappa 6.43). */
  const righeDellaForma = new Map<string, Riga[]>();
  for (const r of righe("shapes.txt")) {
    const k = testo(r.shape_id); const l = righeDellaForma.get(k); if (l) l.push(r); else righeDellaForma.set(k, [r]);
  }
  const tracciati = new Map<string, Tracciato | null>();
  const posizioneDi = new Map<string, [number, number]>();
  for (const s of fermate) {
    const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
    if (testo(s.stop_lat) && testo(s.stop_lon) && Number.isFinite(lat) && Number.isFinite(lon)) posizioneDi.set(testo(s.stop_id), [lat, lon]);
  }
  const notaDellaFermata = new Map(fermate.map((s) => [testo(s.stop_id), testo(s.stop_code) || testo(s.stop_id)]));
  const perCoppia = new Map<string, Array<{ codice: string; tratta: Tratta }>>();
  const tratte: Array<{ codice: string; da: string; a: string; tratta: Tratta }> = [];
  /* per sequenza, la tratta che parte da ogni fermata (null: nessuna) */
  const tratteDellaSequenza = new Map<string, Array<string | null>>();
  let tratteSenzaTracciato = 0;
  for (const [k, q] of sequenze) {
    let t = tracciati.get(q.forma);
    if (t === undefined) {
      const r = q.forma ? righeDellaForma.get(q.forma) : undefined;
      t = r ? tracciatoDa(r) : null;
      tracciati.set(q.forma, t);
    }
    const ids = q.fermate.map((x) => testo(x.stop_id));
    const pezzi = t ? trattePercorso(t, ids.map((s) => posizioneDi.get(s) ?? null)) : ids.slice(1).map(() => null);
    tratteDellaSequenza.set(k, pezzi.map((x, i) => {
      /* due fermate nello stesso punto del tracciato: non c'è strada da disegnare, e non manca niente */
      if (x === "stesso_punto") return null;
      if (!x) { tratteSenzaTracciato++; return null; }
      const coppia = `${ids[i]}>${ids[i + 1]}`;
      const note = perCoppia.get(coppia) ?? [];
      const uguale = note.find((y) => stessaStrada(y.tratta, x));
      if (uguale) return uguale.codice;
      /* come la Regione: «[codici]_A-[codici]_B» (il prefisso dei codici davanti a A lo mette id()) */
      const codice = `${pezzoId(ids[i])}-${davantiAiCodici}${pezzoId(ids[i + 1])}${note.length ? `_${note.length + 1}` : ""}`;
      note.push({ codice, tratta: x });
      perCoppia.set(coppia, note);
      tratte.push({ codice, da: ids[i]!, a: ids[i + 1]!, tratta: x });
      return codice;
    }));
  }

  /* Gli operatori. Senza gestori è uno, l'azienda. Coi gestori: quelli che
   * hanno almeno una linea nel file, nell'ordine dell'elenco; una linea che
   * non dice un gestore dell'elenco è del principale. */
  const gestori = o.operatori?.length ? o.operatori : null;
  const principale = gestori ? (gestori.find((x) => x.codice === o.operatorePrincipale) ?? gestori[0]!) : null;
  const gestoreDi = new Map((gestori ?? []).map((x) => [x.codice, x]));
  const gestoreDellaLinea = (r: Riga): OperatoreNetex | null => (gestori ? gestoreDi.get(testo(r.agency_id)) ?? principale : null);
  const operatoreDellaLinea = new Map(linee.map((r) => [testo(r.route_id), idProprio("Operator", gestoreDellaLinea(r)?.codice ?? o.azienda.codice)]));
  const operatori: Array<{ codice: string; nome: string; ragioneSociale: string; sito: string | null; telefono: string | null; email: string | null }> = gestori
    ? (() => {
      const usati = new Set(linee.map((r) => gestoreDellaLinea(r)!.codice));
      const scritti = gestori.filter((x) => usati.has(x.codice));
      return (scritti.length ? scritti : [principale!]).map((x) => ({ ...x, ragioneSociale: x.nome }));
    })()
    : [{ ...o.azienda, email: null }];
  const operatore = idProprio("Operator", operatori[0]!.codice);
  /* le tariffe (livello 3): dal GTFS, con le stesse fermate e le stesse linee */
  const tariffe = o.tariffe ? tariffeNetex(gtfs, o.tariffe, {
    id: (tipo, codice) => id(tipo, codice),
    frame: `${it}:FareFrame-EU_PI_FARE:${pezzoId(o.azienda.codice)}`,
    fermate: new Set(fermate.map((s) => testo(s.stop_id))),
    linee: lineeUsate,
  }) : null;
  const livello = tariffe ? "livello 3 (con le tariffe)" : "livello 1 (EPIP)";
  const out: string[] = [];
  const p = (s: string) => out.push(s);
  const posizione = (lat: unknown, lon: unknown) =>
    `<Location><Longitude>${Number(lon).toFixed(6)}</Longitude><Latitude>${Number(lat).toFixed(6)}</Latitude></Location>`;

  p('<?xml version="1.0" encoding="UTF-8"?>');
  p('<PublicationDelivery xmlns="http://www.netex.org.uk/netex" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:siri="http://www.siri.org.uk/siri" version="1.1">');
  p(`<PublicationTimestamp>${o.adesso.toISOString()}</PublicationTimestamp>`);
  p(`<ParticipantRef>${xml(o.partecipante)}</ParticipantRef>`);
  p(`<Description>${xml(o.descrizione ?? `Rete e orari di ${o.azienda.nome}, profilo italiano NeTEx ${livello}`)}</Description>`);
  p("<dataObjects>");
  p(`<CompositeFrame id="${it}:CompositeFrame-EU_PI_NETWORK_OFFER:${pezzoId(o.azienda.codice)}" ${v}>`);
  p(`<ValidBetween><FromDate>${dal}T00:00:00</FromDate><ToDate>${al}T23:59:59</ToDate></ValidBetween>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_NETWORK_OFFER" versionRef="1.0"/>');
  p(`<codespaces><Codespace id="${xml(loc.toLowerCase())}"><Xmlns>${xml(loc)}</Xmlns><XmlnsUrl>${xml(o.azienda.sito ?? "")}</XmlnsUrl><Description>Profilo italiano NeTEx</Description></Codespace></codespaces>`);
  p(`<FrameDefaults><DefaultCodespaceRef ref="${xml(loc.toLowerCase())}"/><DefaultLocale><TimeZone>Europe/Rome</TimeZone><DefaultLanguage>it</DefaultLanguage></DefaultLocale></FrameDefaults>`);
  p("<frames>");

  /* gli operatori */
  p(`<ResourceFrame id="${it}:ResourceFrame-EU_PI_COMMON:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_COMMON" versionRef="1.0"/>');
  p("<organisations>");
  for (const x of operatori) {
    /* ContactDetails c'è sempre, anche vuoto: per lo schema EPIP viene prima di
     * OrganisationType e non si può saltare (un gestore senza contatti dava un
     * file non valido) */
    p(`<Operator id="${idProprio("Operator", x.codice)}" ${v}><PublicCode>${xml(x.codice)}</PublicCode><Name>${xml(x.nome)}</Name><LegalName>${xml(x.ragioneSociale)}</LegalName>`
      + `<ContactDetails>${x.email ? `<Email>${xml(x.email)}</Email>` : ""}${x.telefono ? `<Phone>${xml(x.telefono)}</Phone>` : ""}${x.sito ? `<Url>${xml(x.sito)}</Url>` : ""}</ContactDetails>`
      + "<OrganisationType>operator</OrganisationType></Operator>");
  }
  p("</organisations>");
  p("</ResourceFrame>");

  /* le fermate: una StopPlace con una Quay per fermata del GTFS */
  p(`<SiteFrame id="${it}:SiteFrame-EU_PI_STOP:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_STOP" versionRef="1.0"/>');
  p("<stopPlaces>");
  for (const s of fermate) {
    const c = s.stop_id;
    p(`<StopPlace id="${id("StopPlace", c)}" ${v}><Name>${xml(s.stop_name)}</Name>`
      + `<Centroid>${posizione(s.stop_lat, s.stop_lon)}</Centroid>`
      + (testo(s.stop_code) ? `<PublicCode>${xml(s.stop_code)}</PublicCode>` : "")
      + "<TransportMode>bus</TransportMode><StopPlaceType>onstreetBus</StopPlaceType>"
      + `<quays><Quay id="${id("Quay", c)}" ${v}><Name>${xml(s.stop_name)}</Name><Centroid>${posizione(s.stop_lat, s.stop_lon)}</Centroid></Quay></quays>`
      + "</StopPlace>");
  }
  p("</stopPlaces>");
  p("</SiteFrame>");

  /* la rete */
  p(`<ServiceFrame id="${it}:ServiceFrame-EU_PI_NETWORK:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_NETWORK" versionRef="1.0"/>');
  p(`<Network id="${idProprio("Network", o.codiceRete || o.azienda.codice)}" ${v}><Name>${xml(`Rete ${o.azienda.nome}`)}</Name></Network>`);
  p("<lines>");
  for (const r of linee) {
    const nome = testo(r.route_long_name) || testo(r.route_short_name) || testo(r.route_id);
    p(`<Line id="${id("Line", r.route_id)}" ${v}><Name>${xml(nome)}</Name>`
      + (testo(r.route_short_name) ? `<ShortName>${xml(r.route_short_name)}</ShortName>` : "")
      + `<TransportMode>${modoDellaLinea.get(testo(r.route_id))}</TransportMode>`
      + `<PublicCode>${xml(testo(r.route_short_name) || testo(r.route_id))}</PublicCode>`
      + `<OperatorRef ref="${operatoreDellaLinea.get(testo(r.route_id)) ?? operatore}" ${v}/></Line>`);
  }
  p("</lines>");
  p("<scheduledStopPoints>");
  for (const s of fermate) {
    const zone = tariffe?.zoneDellaFermata.get(testo(s.stop_id));
    p(`<ScheduledStopPoint id="${id("ScheduledStopPoint", s.stop_id)}" ${v}><Name>${xml(s.stop_name)}</Name>${posizione(s.stop_lat, s.stop_lon)}`
      + (zone?.length ? `<tariffZones>${zone.map((z) => `<TariffZoneRef ref="${z}" ${v}/>`).join("")}</tariffZones>` : "")
      + "</ScheduledStopPoint>");
  }
  p("</scheduledStopPoints>");
  /* le tratte col tracciato (linee guida 5.0.1, par. 5.2.5.5): nome coi codici delle due
   * fermate, lunghezza in metri, la polilinea WGS84 «lon lat» */
  if (tratte.length) {
    p("<serviceLinks>");
    tratte.forEach((x, i) => p(`<ServiceLink id="${id("ServiceLink", x.codice)}" ${v}>`
      + `<Name>${xml(`${notaDellaFermata.get(x.da)}-${notaDellaFermata.get(x.a)}`)}</Name><Distance>${x.tratta.metri}</Distance>`
      + `<gml:LineString gml:id="L${i + 1}"><gml:posList>${posList(x.tratta.punti)}</gml:posList></gml:LineString>`
      + `<FromPointRef ref="${id("ScheduledStopPoint", x.da)}" ${v}/><ToPointRef ref="${id("ScheduledStopPoint", x.a)}" ${v}/></ServiceLink>`));
    p("</serviceLinks>");
  }
  /* le zone tariffarie (livello 3): le reti urbane e i nodi delle linee extraurbane */
  if (tariffe?.zone.length) { p("<tariffZones>"); tariffe.zone.forEach(p); p("</tariffZones>"); }
  p("<stopAssignments>");
  fermate.forEach((s, i) => {
    p(`<PassengerStopAssignment id="${id("PassengerStopAssignment", s.stop_id)}" ${v} order="${i + 1}">`
      + `<ScheduledStopPointRef ref="${id("ScheduledStopPoint", s.stop_id)}" ${v}/>`
      + `<StopPlaceRef ref="${id("StopPlace", s.stop_id)}" ${v}/><QuayRef ref="${id("Quay", s.stop_id)}" ${v}/></PassengerStopAssignment>`);
  });
  p("</stopAssignments>");
  p("<journeyPatterns>");
  for (const [k, q] of sequenze) {
    const avanti = tratteDellaSequenza.get(k) ?? [];
    p(`<ServiceJourneyPattern id="${id("ServiceJourneyPattern", q.id)}" ${v}>`
      + (q.capolinea ? `<Name>${xml(q.capolinea)}</Name>` : "")
      + `<RouteView><LineRef ref="${id("Line", q.linea)}" ${v}/></RouteView>`
      + "<pointsInSequence>"
      + q.fermate.map((x, i) => `<StopPointInJourneyPattern id="${id("StopPointInJourneyPattern", `${q.id}-${i + 1}`)}" ${v} order="${i + 1}">`
        + `<ScheduledStopPointRef ref="${id("ScheduledStopPoint", x.stop_id)}" ${v}/>`
        + (avanti[i] ? `<OnwardServiceLinkRef ref="${id("ServiceLink", avanti[i])}" ${v}/>` : "")
        + `<ForAlighting>${i > 0 && String(x.drop_off_type ?? "0") !== "1"}</ForAlighting>`
        + `<ForBoarding>${i < q.fermate.length - 1 && String(x.pickup_type ?? "0") !== "1"}</ForBoarding>`
        + "</StopPointInJourneyPattern>").join("")
      + "</pointsInSequence></ServiceJourneyPattern>");
  }
  p("</journeyPatterns>");
  p("</ServiceFrame>");

  /* i calendari: un tipo di giorno per servizio, il suo periodo di esercizio coi giorni validi, e
   * l'assegnazione che li lega. Il periodo e non una data per giorno: OpenTripPlanner vuole
   * OperatingPeriodRef (linee guida v5.0.1, Appendice A); i file della Regione fanno lo stesso */
  p(`<ServiceCalendarFrame id="${it}:ServiceCalendarFrame-EU_PI_CALENDAR:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_CALENDAR" versionRef="1.0"/>');
  p(`<ServiceCalendar id="${id("ServiceCalendar", o.azienda.codice)}" ${v}><FromDate>${dal}</FromDate><ToDate>${al}</ToDate>`);
  p("<dayTypes>");
  for (const s of servizi) p(`<DayType id="${id("DayType", s)}" ${v}><Name>${xml(`Servizio ${s}`)}</Name></DayType>`);
  p("</dayTypes>");
  const periodi = servizi.map((s) => ({ s, periodo: periodoDiEsercizio(giorni.get(s) ?? []) }));
  p("<operatingPeriods>");
  for (const { s, periodo } of periodi) {
    if (!periodo) continue;
    p(`<UicOperatingPeriod id="${id("UicOperatingPeriod", s)}" ${v}><FromDate>${periodo.dal}T00:00:00</FromDate>`
      + `<ToDate>${periodo.al}T23:59:59</ToDate><ValidDayBits>${periodo.bit}</ValidDayBits></UicOperatingPeriod>`);
  }
  p("</operatingPeriods>");
  p("<dayTypeAssignments>");
  periodi.forEach(({ s, periodo }, i) => {
    if (!periodo) return;
    p(`<DayTypeAssignment id="${id("DayTypeAssignment", s)}" ${v} order="${i + 1}">`
      + `<OperatingPeriodRef ref="${id("UicOperatingPeriod", s)}" ${v}/><DayTypeRef ref="${id("DayType", s)}" ${v}/></DayTypeAssignment>`);
  });
  p("</dayTypeAssignments>");
  const n = servizi.reduce((t, s) => t + (giorni.get(s)?.length ?? 0), 0);
  p("</ServiceCalendar>");
  p("</ServiceCalendarFrame>");

  /* le corse, con gli orari */
  p(`<TimetableFrame id="${it}:TimetableFrame-EU_PI_TIMETABLE:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_TIMETABLE" versionRef="1.0"/>');
  p("<vehicleJourneys>");
  let orari = 0;
  for (const t of corseConSequenza) {
    const q = sequenze.get(sequenzaDi.get(testo(t.trip_id))!)!;
    const st = orariDi.get(testo(t.trip_id))!;
    const partenza = orarioNetex(st[0]!.departure_time ?? st[0]!.arrival_time);
    if (!partenza) continue;
    const tech = pezzoId(t.trip_id);
    p(`<ServiceJourney id="${id("ServiceJourney", t.trip_id)}" ${v}>`
      + (testo(t.trip_headsign) ? `<Name>${xml(t.trip_headsign)}</Name>` : "")
      + (testo(t.trip_short_name) ? `<PrivateCode>${xml(t.trip_short_name)}</PrivateCode>` : "")
      + `<TransportMode>${modoDellaLinea.get(q.linea) ?? "bus"}</TransportMode>`
      + `<DepartureTime>${partenza.ora}</DepartureTime>`
      + (partenza.giorni ? `<DepartureDayOffset>${partenza.giorni}</DepartureDayOffset>` : "")
      + `<dayTypes><DayTypeRef ref="${id("DayType", t.service_id)}" ${v}/></dayTypes>`
      + `<ServiceJourneyPatternRef ref="${id("ServiceJourneyPattern", q.id)}" ${v}/>`
      + `<OperatorRef ref="${operatoreDellaLinea.get(q.linea) ?? operatore}" ${v}/>`
      + "<passingTimes>"
      + st.map((x, i) => {
        orari++;
        const arr = orarioNetex(x.arrival_time), par = orarioNetex(x.departure_time);
        return `<TimetabledPassingTime id="${id("TimetabledPassingTime", `${tech}-${i + 1}`)}" ${v}>`
          + `<StopPointInJourneyPatternRef ref="${id("StopPointInJourneyPattern", `${q.id}-${i + 1}`)}" ${v}/>`
          + (i > 0 && arr ? `<ArrivalTime>${arr.ora}</ArrivalTime>${arr.giorni ? `<ArrivalDayOffset>${arr.giorni}</ArrivalDayOffset>` : ""}` : "")
          + (i < st.length - 1 && par ? `<DepartureTime>${par.ora}</DepartureTime>${par.giorni ? `<DepartureDayOffset>${par.giorni}</DepartureDayOffset>` : ""}` : "")
          + "</TimetabledPassingTime>";
      }).join("")
      + "</passingTimes></ServiceJourney>");
  }
  p("</vehicleJourneys>");
  p("</TimetableFrame>");

  /* le tariffe (livello 3) */
  if (tariffe) tariffe.fareFrame.forEach(p);

  p("</frames>");
  p("</CompositeFrame>");
  p("</dataObjects>");
  p("</PublicationDelivery>");

  return {
    xml: out.join("\n") + "\n",
    conteggi: {
      fermate: fermate.length, linee: linee.length, sequenze: sequenze.size, corse: corseConSequenza.length, orari,
      tipiDiGiorno: servizi.length, giorni: n, corseSenzaGiorni: corseTutte.length - corse.length,
      operatori: operatori.length,
      tratte: tratte.length, tratteSenzaTracciato,
      tariffe: tariffe?.conteggi ?? null,
    },
  };
}
