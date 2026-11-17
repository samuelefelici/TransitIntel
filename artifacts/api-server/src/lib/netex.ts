/**
 * NeTEx con il profilo italiano, livello 1 (tappa 6.2).
 *
 * Il livello 1 del profilo italiano coincide con il profilo europeo per
 * l'informazione ai passeggeri, EPIP (UNI CEN/TS 16614-4:2021). Riferimenti:
 * «Linee guida per la compilazione del profilo italiano del NeTEx» v4.0.1
 * (11 marzo 2024) e lo schema EPIP pubblicato con il profilo italiano
 * (assets/netex-epip/, dal repository 5Tsrl/netex-italian-profile).
 *
 * Si costruisce dal GTFS consegnabile (lib/planning-studio-export.ts): la
 * stessa versione del programma, la stessa azienda, gli stessi codici stabili,
 * lo stesso controllo. Qui solo la traduzione, pura: niente database.
 *
 *   PublicationDelivery
 *     CompositeFrame  EU_PI_NETWORK_OFFER, con il Codespace e la validità
 *       ResourceFrame        EU_PI_COMMON    l'operatore
 *       SiteFrame            EU_PI_STOP      le fermate (StopPlace con una Quay)
 *       ServiceFrame         EU_PI_NETWORK   rete, linee, punti di fermata,
 *                                            assegnazioni, sequenze di fermate
 *       ServiceCalendarFrame EU_PI_CALENDAR  un ServiceCalendar: un DayType per
 *                                            servizio e i suoi giorni
 *       TimetableFrame       EU_PI_TIMETABLE le corse, con gli orari
 *
 * Identificativi (linee guida, 4.2.1): [nazione]:[codice locale]:[Tipo]:[codice]
 * e, se c'è, :[fornitore]. Il codice è quello stabile della 3.1, ripulito per
 * stare nei caratteri ammessi (pezzoId): resta lo stesso da un export
 * all'altro. Le sequenze di fermate prendono il nome dalla linea,
 * dalla direzione e da un'impronta della sequenza, così sono stabili anche loro.
 */
import { createHash } from "node:crypto";
import type { Gtfs, Riga } from "./gtfs-verifica";

export interface OpzioniNetex {
  /** il codice locale (NUTS) dell'identificativo: per le Marche «ITI3» */
  codiceLocale: string;
  /** il fornitore dei dati in fondo agli identificativi (facoltativo) */
  fornitore: string | null;
  /** chi trasmette il file (ParticipantRef) */
  partecipante: string;
  /** il nome dell'azienda e i suoi contatti, per l'operatore */
  azienda: { ragioneSociale: string; nome: string; sito: string | null; telefono: string | null; codice: string };
  /** quando è stato fatto il file */
  adesso: Date;
  /** una descrizione per chi lo riceve */
  descrizione?: string;
}

export interface ConteggiNetex {
  fermate: number; linee: number; sequenze: number; corse: number; orari: number; tipiDiGiorno: number; giorni: number;
  /** le corse senza giorni di servizio, lasciate fuori */
  corseSenzaGiorni: number;
}

/* ── Piccoli attrezzi ────────────────────────────────────────────────────── */

const xml = (v: unknown) => String(v ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const testo = (v: unknown) => (v == null ? "" : String(v).trim());
/**
 * Un pezzo di identificativo: solo lettere, cifre, «-» e «_» (e mai «:», che
 * negli identificativi NeTEx separa le parti). Un codice già pulito resta
 * com'è; uno con altri caratteri li perde e prende in coda un'impronta del
 * codice originale, così «46» e «46/» restano due identificativi diversi, e
 * sempre gli stessi da un export all'altro.
 */
export function pezzoId(v: unknown): string {
  const t = testo(v);
  if (/^[A-Za-z0-9_-]+$/.test(t)) return t;
  return `${t.replace(/[^A-Za-z0-9_-]+/g, "_") || "x"}-${createHash("sha256").update(t).digest("hex").slice(0, 8)}`;
}

/** «HH:MM:SS» di un orario GTFS che può passare le 24, e il giorno dopo. */
export function orarioNetex(t: unknown): { ora: string; giorni: number } | null {
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(testo(t));
  if (!m) return null;
  const h = Number(m[1]);
  return { ora: `${String(h % 24).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`, giorni: Math.floor(h / 24) };
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
  const id = (tipo: string, codice: unknown) => `IT:${loc}:${tipo}:${pezzoId(codice)}${fine}`;
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
  const sequenze = new Map<string, { id: string; linea: string; direzione: string; fermate: Riga[]; capolinea: string }>();
  const sequenzaDi = new Map<string, string>();
  for (const t of corse) {
    const st = orariDi.get(testo(t.trip_id)) ?? [];
    if (st.length < 2) continue;
    const linea = testo(t.route_id), direzione = testo(t.direction_id) || "0";
    const firma = st.map((x) => testo(x.stop_id)).join(">");
    const k = `${linea}|${direzione}|${firma}`;
    if (!sequenze.has(k)) {
      const impronta = createHash("sha256").update(firma).digest("hex").slice(0, 8);
      sequenze.set(k, { id: `${pezzoId(linea)}-${direzione}-${impronta}`, linea, direzione, fermate: st, capolinea: testo(t.trip_headsign) });
    }
    sequenzaDi.set(testo(t.trip_id), k);
  }
  const corseConSequenza = corse.filter((t) => sequenzaDi.has(testo(t.trip_id)));
  const fermateUsate = new Set([...sequenze.values()].flatMap((s) => s.fermate.map((x) => testo(x.stop_id))));
  const fermate = righe("stops.txt").filter((s) => fermateUsate.has(testo(s.stop_id)));
  const lineeUsate = new Set(corseConSequenza.map((t) => testo(t.route_id)));
  const linee = righe("routes.txt").filter((r) => lineeUsate.has(testo(r.route_id)));
  const modoDellaLinea = new Map(linee.map((r) => [testo(r.route_id), modoDi(r.route_type)]));

  const operatore = id("Operator", o.azienda.codice);
  const out: string[] = [];
  const p = (s: string) => out.push(s);
  const posizione = (lat: unknown, lon: unknown) =>
    `<Location><Longitude>${Number(lon).toFixed(6)}</Longitude><Latitude>${Number(lat).toFixed(6)}</Latitude></Location>`;

  p('<?xml version="1.0" encoding="UTF-8"?>');
  p('<PublicationDelivery xmlns="http://www.netex.org.uk/netex" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:siri="http://www.siri.org.uk/siri" version="1.1">');
  p(`<PublicationTimestamp>${o.adesso.toISOString()}</PublicationTimestamp>`);
  p(`<ParticipantRef>${xml(o.partecipante)}</ParticipantRef>`);
  p(`<Description>${xml(o.descrizione ?? `Rete e orari di ${o.azienda.nome}, profilo italiano NeTEx livello 1 (EPIP)`)}</Description>`);
  p("<dataObjects>");
  p(`<CompositeFrame id="epd:IT:${loc}:CompositeFrame-EU_PI_NETWORK_OFFER:${pezzoId(o.azienda.codice)}" ${v}>`);
  p(`<ValidBetween><FromDate>${dal}T00:00:00</FromDate><ToDate>${al}T23:59:59</ToDate></ValidBetween>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_NETWORK_OFFER" versionRef="1.0"/>');
  p(`<codespaces><Codespace id="${xml(loc.toLowerCase())}"><Xmlns>${xml(loc)}</Xmlns><XmlnsUrl>${xml(o.azienda.sito ?? "")}</XmlnsUrl><Description>Profilo italiano NeTEx</Description></Codespace></codespaces>`);
  p(`<FrameDefaults><DefaultCodespaceRef ref="${xml(loc.toLowerCase())}"/><DefaultLocale><TimeZone>Europe/Rome</TimeZone><DefaultLanguage>it</DefaultLanguage></DefaultLocale></FrameDefaults>`);
  p("<frames>");

  /* l'operatore */
  p(`<ResourceFrame id="epd:IT:${loc}:ResourceFrame-EU_PI_COMMON:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_COMMON" versionRef="1.0"/>');
  p("<organisations>");
  p(`<Operator id="${operatore}" ${v}><PublicCode>${xml(o.azienda.codice)}</PublicCode><Name>${xml(o.azienda.nome)}</Name><LegalName>${xml(o.azienda.ragioneSociale)}</LegalName>`
    + (o.azienda.sito || o.azienda.telefono ? `<ContactDetails>${o.azienda.telefono ? `<Phone>${xml(o.azienda.telefono)}</Phone>` : ""}${o.azienda.sito ? `<Url>${xml(o.azienda.sito)}</Url>` : ""}</ContactDetails>` : "")
    + "<OrganisationType>operator</OrganisationType></Operator>");
  p("</organisations>");
  p("</ResourceFrame>");

  /* le fermate: una StopPlace con una Quay per fermata del GTFS */
  p(`<SiteFrame id="epd:IT:${loc}:SiteFrame-EU_PI_STOP:${pezzoId(o.azienda.codice)}" ${v}>`);
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
  p(`<ServiceFrame id="epd:IT:${loc}:ServiceFrame-EU_PI_NETWORK:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_NETWORK" versionRef="1.0"/>');
  p(`<Network id="${id("Network", o.azienda.codice)}" ${v}><Name>${xml(`Rete ${o.azienda.nome}`)}</Name></Network>`);
  p("<lines>");
  for (const r of linee) {
    const nome = testo(r.route_long_name) || testo(r.route_short_name) || testo(r.route_id);
    p(`<Line id="${id("Line", r.route_id)}" ${v}><Name>${xml(nome)}</Name>`
      + (testo(r.route_short_name) ? `<ShortName>${xml(r.route_short_name)}</ShortName>` : "")
      + `<TransportMode>${modoDellaLinea.get(testo(r.route_id))}</TransportMode>`
      + `<PublicCode>${xml(testo(r.route_short_name) || testo(r.route_id))}</PublicCode>`
      + `<OperatorRef ref="${operatore}" ${v}/></Line>`);
  }
  p("</lines>");
  p("<scheduledStopPoints>");
  for (const s of fermate) {
    p(`<ScheduledStopPoint id="${id("ScheduledStopPoint", s.stop_id)}" ${v}><Name>${xml(s.stop_name)}</Name>${posizione(s.stop_lat, s.stop_lon)}</ScheduledStopPoint>`);
  }
  p("</scheduledStopPoints>");
  p("<stopAssignments>");
  fermate.forEach((s, i) => {
    p(`<PassengerStopAssignment id="${id("PassengerStopAssignment", s.stop_id)}" ${v} order="${i + 1}">`
      + `<ScheduledStopPointRef ref="${id("ScheduledStopPoint", s.stop_id)}" ${v}/>`
      + `<StopPlaceRef ref="${id("StopPlace", s.stop_id)}" ${v}/><QuayRef ref="${id("Quay", s.stop_id)}" ${v}/></PassengerStopAssignment>`);
  });
  p("</stopAssignments>");
  p("<journeyPatterns>");
  for (const q of sequenze.values()) {
    p(`<ServiceJourneyPattern id="${id("ServiceJourneyPattern", q.id)}" ${v}>`
      + (q.capolinea ? `<Name>${xml(q.capolinea)}</Name>` : "")
      + `<RouteView><LineRef ref="${id("Line", q.linea)}" ${v}/></RouteView>`
      + "<pointsInSequence>"
      + q.fermate.map((x, i) => `<StopPointInJourneyPattern id="${id("StopPointInJourneyPattern", `${q.id}-${i + 1}`)}" ${v} order="${i + 1}">`
        + `<ScheduledStopPointRef ref="${id("ScheduledStopPoint", x.stop_id)}" ${v}/>`
        + `<ForAlighting>${i > 0 && String(x.drop_off_type ?? "0") !== "1"}</ForAlighting>`
        + `<ForBoarding>${i < q.fermate.length - 1 && String(x.pickup_type ?? "0") !== "1"}</ForBoarding>`
        + "</StopPointInJourneyPattern>").join("")
      + "</pointsInSequence></ServiceJourneyPattern>");
  }
  p("</journeyPatterns>");
  p("</ServiceFrame>");

  /* i calendari: un tipo di giorno per servizio, e i suoi giorni */
  p(`<ServiceCalendarFrame id="epd:IT:${loc}:ServiceCalendarFrame-EU_PI_CALENDAR:${pezzoId(o.azienda.codice)}" ${v}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_CALENDAR" versionRef="1.0"/>');
  p(`<ServiceCalendar id="${id("ServiceCalendar", o.azienda.codice)}" ${v}><FromDate>${dal}</FromDate><ToDate>${al}</ToDate>`);
  p("<dayTypes>");
  for (const s of servizi) p(`<DayType id="${id("DayType", s)}" ${v}><Name>${xml(`Servizio ${s}`)}</Name></DayType>`);
  p("</dayTypes>");
  p("<dayTypeAssignments>");
  let n = 0;
  for (const s of servizi) {
    for (const g of giorni.get(s) ?? []) {
      n++;
      p(`<DayTypeAssignment id="${id("DayTypeAssignment", `${s}-${g}`)}" ${v} order="${n}"><Date>${g}</Date><DayTypeRef ref="${id("DayType", s)}" ${v}/></DayTypeAssignment>`);
    }
  }
  p("</dayTypeAssignments>");
  p("</ServiceCalendar>");
  p("</ServiceCalendarFrame>");

  /* le corse, con gli orari */
  p(`<TimetableFrame id="epd:IT:${loc}:TimetableFrame-EU_PI_TIMETABLE:${pezzoId(o.azienda.codice)}" ${v}>`);
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
      + `<OperatorRef ref="${operatore}" ${v}/>`
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

  p("</frames>");
  p("</CompositeFrame>");
  p("</dataObjects>");
  p("</PublicationDelivery>");

  return {
    xml: out.join("\n") + "\n",
    conteggi: {
      fermate: fermate.length, linee: linee.length, sequenze: sequenze.size, corse: corseConSequenza.length, orari,
      tipiDiGiorno: servizi.length, giorni: n, corseSenzaGiorni: corseTutte.length - corse.length,
    },
  };
}
