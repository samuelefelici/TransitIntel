/**
 * NeTEx con il profilo italiano, livello 1 (tappa 6.2): la traduzione dal GTFS
 * consegnabile, e il file che ne esce passato allo schema EPIP del profilo
 * italiano con xmllint (se c'è: in CI sì).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { giorniDiServizio, netexDaGtfs, orarioNetex, periodoDiEsercizio, pezzoId } from "../lib/netex";
import { validaNetex, SCHEMA_EPIP } from "../lib/netex-validazione";
import type { Gtfs } from "../lib/gtfs-verifica";

const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });

/** Un GTFS piccolo: due linee, una corsa dopo la mezzanotte, un servizio con un'eccezione. */
export const GTFS_DI_PROVA: Gtfs = {
  "agency.txt": file(["agency_id"], [{ agency_id: "conerobus" }]),
  "stops.txt": file(["stop_id", "stop_name", "stop_lat", "stop_lon"], [
    { stop_id: "S1", stop_name: "Stazione FS", stop_lat: 43.6075, stop_lon: 13.4977, stop_code: "1001" },
    { stop_id: "S2", stop_name: "Piazza Cavour & Corso", stop_lat: 43.6166, stop_lon: 13.5185 },
    { stop_id: "S3", stop_name: "Passetto", stop_lat: 43.6185, stop_lon: 13.5320 },
    { stop_id: "S9", stop_name: "Fermata non usata", stop_lat: 43.5, stop_lon: 13.4 },
  ]),
  "routes.txt": file(["route_id", "route_short_name", "route_long_name", "route_type"], [
    { route_id: "L1", route_short_name: "1/4", route_long_name: "Stazione - Passetto", route_type: 3 },
    { route_id: "L2 bis", route_short_name: "2", route_long_name: "", route_type: 3 },
  ]),
  "trips.txt": file(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"], [
    { route_id: "L1", service_id: "FER", trip_id: "T1", trip_headsign: "Passetto", direction_id: 0 },
    { route_id: "L1", service_id: "FER", trip_id: "T2", trip_headsign: "Passetto", direction_id: 0 },
    { route_id: "L1", service_id: "FES", trip_id: "T3", trip_headsign: "Stazione", direction_id: 1 },
    { route_id: "L2 bis", service_id: "FER", trip_id: "T4", trip_headsign: "Passetto", direction_id: 0 },
    { route_id: "L2 bis", service_id: "VUOTO", trip_id: "T5", trip_headsign: "Passetto", direction_id: 0 },
  ]),
  "stop_times.txt": file(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], [
    { trip_id: "T1", arrival_time: "07:00:00", departure_time: "07:00:00", stop_id: "S1", stop_sequence: 1 },
    { trip_id: "T1", arrival_time: "07:08:00", departure_time: "07:09:00", stop_id: "S2", stop_sequence: 2 },
    { trip_id: "T1", arrival_time: "07:15:00", departure_time: "07:15:00", stop_id: "S3", stop_sequence: 3 },
    { trip_id: "T2", arrival_time: "23:50:00", departure_time: "23:50:00", stop_id: "S1", stop_sequence: 1 },
    { trip_id: "T2", arrival_time: "23:58:00", departure_time: "23:59:00", stop_id: "S2", stop_sequence: 2 },
    { trip_id: "T2", arrival_time: "24:05:00", departure_time: "24:05:00", stop_id: "S3", stop_sequence: 3 },
    { trip_id: "T3", arrival_time: "10:00:00", departure_time: "10:00:00", stop_id: "S3", stop_sequence: 1 },
    { trip_id: "T3", arrival_time: "10:12:00", departure_time: "10:12:00", stop_id: "S1", stop_sequence: 2 },
    { trip_id: "T4", arrival_time: "08:00:00", departure_time: "08:00:00", stop_id: "S2", stop_sequence: 1 },
    { trip_id: "T4", arrival_time: "08:06:00", departure_time: "08:06:00", stop_id: "S3", stop_sequence: 2 },
    { trip_id: "T5", arrival_time: "09:00:00", departure_time: "09:00:00", stop_id: "S2", stop_sequence: 1 },
    { trip_id: "T5", arrival_time: "09:06:00", departure_time: "09:06:00", stop_id: "S3", stop_sequence: 2 },
  ]),
  "calendar.txt": file(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], [
    { service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: "20261108" },
  ]),
  "calendar_dates.txt": file(["service_id", "date", "exception_type"], [
    { service_id: "FER", date: "20261104", exception_type: 2 },
    { service_id: "FES", date: "20261108", exception_type: 1 },
  ]),
};

const OPZIONI = {
  codiceLocale: "ITI3", fornitore: null, partecipante: "conerobus",
  azienda: { ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411", codice: "conerobus" },
  adesso: new Date("2026-11-17T08:00:00Z"),
};

describe("NeTEx: i pezzi", () => {
  it("gli orari oltre la mezzanotte vanno al giorno dopo", () => {
    expect(orarioNetex("07:05:00")).toEqual({ ora: "07:05:00", giorni: 0 });
    expect(orarioNetex("24:05:00")).toEqual({ ora: "00:05:00", giorni: 1 });
    expect(orarioNetex("49:10")).toEqual({ ora: "01:10:00", giorni: 2 });
    expect(orarioNetex("")).toBeNull();
  });

  it("i pezzi degli identificativi: un codice pulito resta com'è; gli altri si puliscono e prendono un'impronta", () => {
    expect(pezzoId("T1")).toBe("T1");
    expect(pezzoId("L2 bis")).toMatch(/^L2_bis-[0-9a-f]{8}$/);
    // «/» e «.» restano, come nei file della Regione (tappa 6.19c): «46» e «46/» restano diversi
    expect(pezzoId("46")).toBe("46");
    expect(pezzoId("46/")).toBe("46/");
    expect(pezzoId("1/3")).toBe("1/3");
    expect(pezzoId("C.D.")).toBe("C.D.");
    // «:» non entra mai: separa le parti dell'identificativo
    expect(pezzoId("623_CodUdp:D1318_364081")).toMatch(/^623_CodUdp_D1318_364081-[0-9a-f]{8}$/);
    expect(pezzoId("àè")).toMatch(/^_-[0-9a-f]{8}$/);
    expect(pezzoId("L2 bis")).toBe(pezzoId("L2 bis"));
  });

  it("il periodo di esercizio: dal primo all'ultimo giorno, un bit per giorno (tappa 6.41)", () => {
    expect(periodoDiEsercizio(["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"])).toEqual({ dal: "2026-11-02", al: "2026-11-06", bit: "11011" });
    expect(periodoDiEsercizio(["2026-11-08"])).toEqual({ dal: "2026-11-08", al: "2026-11-08", bit: "1" });
    /* attraverso il cambio dell'ora e la fine del mese */
    expect(periodoDiEsercizio(["2026-10-24", "2026-10-26", "2026-11-01"])?.bit).toBe("101000001");
    expect(periodoDiEsercizio([])).toBeNull();
  });

  it("i giorni di servizio: calendar con le eccezioni di calendar_dates", () => {
    const g = giorniDiServizio(GTFS_DI_PROVA);
    expect(g.get("FER")).toEqual(["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]);
    expect(g.get("FES")).toEqual(["2026-11-08"]);
    expect(g.get("VUOTO")).toBeUndefined();
  });
});

describe("NeTEx: il file", () => {
  const { xml, conteggi } = netexDaGtfs(GTFS_DI_PROVA, OPZIONI);

  it("conta quello che c'è; le corse senza giorni restano fuori, e si dicono", () => {
    expect(conteggi).toEqual({ fermate: 3, linee: 2, sequenze: 3, corse: 4, orari: 10, tipiDiGiorno: 2, giorni: 5, corseSenzaGiorni: 1, operatori: 1, tariffe: null });
    expect(xml).not.toContain("Fermata non usata");
  });

  it("gli identificativi del profilo: IT:codice locale:Tipo:codice, stabili", () => {
    expect(xml).toMatch(/<Line id="IT:ITI3:Line:L2_bis-[0-9a-f]{8}" version="1">/);
    expect(xml).toContain('<ServiceJourney id="IT:ITI3:ServiceJourney:T1" version="1">');
    // senza prefisso, nemmeno i contenitori ne hanno uno (prima avevano sempre «epd:»)
    expect(xml).toContain('id="IT:ITI3:CompositeFrame-EU_PI_NETWORK_OFFER:conerobus"');
    expect(xml).not.toContain("epd:");
    expect(xml).toContain('<Network id="IT:ITI3:Network:conerobus" version="1">');
    expect(netexDaGtfs(GTFS_DI_PROVA, OPZIONI).xml).toBe(xml);
    // con il fornitore, in fondo
    expect(netexDaGtfs(GTFS_DI_PROVA, { ...OPZIONI, fornitore: "ATMA" }).xml).toMatch(/<Line id="IT:ITI3:Line:L2_bis-[0-9a-f]{8}:ATMA" version="1">/);
  });

  it("il calendario come lo vuole OpenTripPlanner: un periodo di esercizio per tipo di giorno, e l'assegnazione che lo richiama", () => {
    expect(xml).toContain('<UicOperatingPeriod id="IT:ITI3:UicOperatingPeriod:FER" version="1"><FromDate>2026-11-02T00:00:00</FromDate><ToDate>2026-11-06T23:59:59</ToDate><ValidDayBits>11011</ValidDayBits></UicOperatingPeriod>');
    expect(xml).toContain('<UicOperatingPeriod id="IT:ITI3:UicOperatingPeriod:FES" version="1"><FromDate>2026-11-08T00:00:00</FromDate><ToDate>2026-11-08T23:59:59</ToDate><ValidDayBits>1</ValidDayBits></UicOperatingPeriod>');
    expect(xml).toContain('<DayTypeAssignment id="IT:ITI3:DayTypeAssignment:FER" version="1" order="1"><OperatingPeriodRef ref="IT:ITI3:UicOperatingPeriod:FER" version="1"/><DayTypeRef ref="IT:ITI3:DayType:FER" version="1"/></DayTypeAssignment>');
    expect(xml.match(/<DayTypeAssignment /g)?.length).toBe(2);
    expect(xml).not.toContain("<Date>");
    expect(xml.indexOf("<operatingPeriods>")).toBeLessThan(xml.indexOf("<dayTypeAssignments>"));
  });

  it("i testi sono scappati, gli orari dopo la mezzanotte hanno il giorno dopo", () => {
    expect(xml).toContain("<Name>Piazza Cavour &amp; Corso</Name>");
    expect(xml).toMatch(/<ArrivalTime>00:05:00<\/ArrivalTime><ArrivalDayOffset>1<\/ArrivalDayOffset>/);
  });

  it("passa lo schema EPIP del profilo italiano (in CI xmllint è obbligatorio)", async () => {
    expect(existsSync(SCHEMA_EPIP)).toBe(true);
    const esito = await validaNetex(xml);
    if (esito.stato === "senza_xmllint" && !process.env.NETEX_SCHEMA_OBBLIGATORIO) return;
    expect(esito).toEqual({ stato: "valido", errori: [] });
  });

  it("uno sbagliato non passa, e l'errore si legge", async () => {
    const esito = await validaNetex(xml.replace("<ParticipantRef>", "<Sconosciuto>x</Sconosciuto><ParticipantRef>"));
    if (esito.stato === "senza_xmllint") return;
    expect(esito.stato).toBe("non_valido");
    expect(esito.errori[0]).toMatch(/Sconosciuto/);
  });
});

/* ── Tappa 6.12: un operatore per gestore ─────────────────────────────────── */

describe("NeTEx: gli operatori", () => {
  const UNO = { codice: "UNO", nome: "Autolinee Uno S.p.A.", sito: "https://uno.example", telefono: "071 000001", email: "info@uno.example" };
  const DUE = { codice: "DUE", nome: "Due, Bus & Co.", sito: "https://due.example", telefono: null, email: null };
  const TRE = { codice: "TRE", nome: "Tre Trasporti", sito: "https://tre.example", telefono: null, email: null };
  /** Lo stesso GTFS, con il gestore scritto su ogni linea. */
  const conGestori = (perLinea: Record<string, string | undefined>): Gtfs => ({
    ...GTFS_DI_PROVA,
    "routes.txt": file(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
      GTFS_DI_PROVA["routes.txt"]!.righe.map((r) => ({ ...r, agency_id: perLinea[String(r.route_id)] ?? "" }) as Record<string, string | number>)),
  });
  const operatori = (xml: string) => [...xml.matchAll(/<Operator id="([^"]+)"/g)].map((m) => m[1]);
  const diLinea = (xml: string) => Object.fromEntries([...xml.matchAll(/<Line id="IT:ITI3:Line:([^"]+)"[^>]*>.*?<OperatorRef ref="([^"]+)"/g)].map((m) => [m[1]!.replace(/-[0-9a-f]{8}$/, ""), m[2]]));
  const diCorsa = (xml: string) => Object.fromEntries([...xml.matchAll(/<ServiceJourney id="IT:ITI3:ServiceJourney:([^"]+)"[^>]*>.*?<OperatorRef ref="([^"]+)"/g)].map((m) => [m[1], m[2]]));

  it("senza gestori il file è quello di prima, byte per byte: un operatore, l'azienda", () => {
    const prima = netexDaGtfs(GTFS_DI_PROVA, OPZIONI).xml;
    expect(netexDaGtfs(GTFS_DI_PROVA, { ...OPZIONI, operatori: [] }).xml).toBe(prima);
    expect(netexDaGtfs(conGestori({ L1: "UNO", "L2 bis": "DUE" }), OPZIONI).xml).toBe(prima);
    expect(operatori(prima)).toEqual(["IT:ITI3:Operator:conerobus"]);
    expect(prima).toContain('<Operator id="IT:ITI3:Operator:conerobus" version="1"><PublicCode>conerobus</PublicCode><Name>Conerobus</Name><LegalName>Conerobus S.p.A.</LegalName>'
      + "<ContactDetails><Phone>+39 071 2837411</Phone><Url>https://www.conerobus.it</Url></ContactDetails><OrganisationType>operator</OrganisationType></Operator>");
  });

  it("coi gestori: un operatore per ognuno che ha linee, e ogni linea e ogni corsa col suo", () => {
    const { xml, conteggi } = netexDaGtfs(conGestori({ L1: "DUE", "L2 bis": "UNO" }), { ...OPZIONI, operatori: [UNO, DUE, TRE], operatorePrincipale: "UNO" });
    /* nell'ordine dell'elenco, e senza quello che non ha linee */
    expect(operatori(xml)).toEqual(["IT:ITI3:Operator:UNO", "IT:ITI3:Operator:DUE"]);
    expect(conteggi.operatori).toBe(2);
    expect(diLinea(xml)).toEqual({ L1: "IT:ITI3:Operator:DUE", L2_bis: "IT:ITI3:Operator:UNO" });
    expect(diCorsa(xml)).toEqual({ T1: "IT:ITI3:Operator:DUE", T2: "IT:ITI3:Operator:DUE", T3: "IT:ITI3:Operator:DUE", T4: "IT:ITI3:Operator:UNO" });
    /* i contatti del gestore: la posta, il telefono, il sito; i nomi scappati */
    expect(xml).toContain('<Operator id="IT:ITI3:Operator:UNO" version="1"><PublicCode>UNO</PublicCode><Name>Autolinee Uno S.p.A.</Name><LegalName>Autolinee Uno S.p.A.</LegalName>'
      + "<ContactDetails><Email>info@uno.example</Email><Phone>071 000001</Phone><Url>https://uno.example</Url></ContactDetails><OrganisationType>operator</OrganisationType></Operator>");
    expect(xml).toContain("<Name>Due, Bus &amp; Co.</Name>");
    /* chi trasmette e i contenitori restano dell'azienda */
    expect(xml).toContain("<ParticipantRef>conerobus</ParticipantRef>");
    expect(xml).toContain('id="IT:ITI3:ResourceFrame-EU_PI_COMMON:conerobus"');
    expect(xml).not.toContain("IT:ITI3:Operator:conerobus");
  });

  it("una linea che non dice un gestore dell'elenco è del principale", () => {
    const { xml } = netexDaGtfs(conGestori({ L1: "ATMA", "L2 bis": undefined }), { ...OPZIONI, operatori: [UNO, DUE], operatorePrincipale: "DUE" });
    expect(operatori(xml)).toEqual(["IT:ITI3:Operator:DUE"]);
    expect(diLinea(xml)).toEqual({ L1: "IT:ITI3:Operator:DUE", L2_bis: "IT:ITI3:Operator:DUE" });
    /* senza dire chi è il principale vale il primo dell'elenco */
    expect(operatori(netexDaGtfs(conGestori({}), { ...OPZIONI, operatori: [UNO, DUE] }).xml)).toEqual(["IT:ITI3:Operator:UNO"]);
  });

  it("un gestore solo: è lui l'operatore di tutto, al posto dell'azienda", () => {
    const { xml, conteggi } = netexDaGtfs(conGestori({ L1: "UNO", "L2 bis": "UNO" }), { ...OPZIONI, operatori: [UNO], operatorePrincipale: "UNO" });
    expect(operatori(xml)).toEqual(["IT:ITI3:Operator:UNO"]);
    expect(conteggi.operatori).toBe(1);
    expect(new Set(Object.values(diCorsa(xml)))).toEqual(new Set(["IT:ITI3:Operator:UNO"]));
  });

  it("con più operatori passa lo schema EPIP del profilo italiano (in CI xmllint è obbligatorio)", async () => {
    const { xml } = netexDaGtfs(conGestori({ L1: "DUE", "L2 bis": "UNO" }), { ...OPZIONI, operatori: [UNO, DUE, TRE], operatorePrincipale: "UNO" });
    const esito = await validaNetex(xml);
    if (esito.stato === "senza_xmllint" && !process.env.NETEX_SCHEMA_OBBLIGATORIO) return;
    expect(esito).toEqual({ stato: "valido", errori: [] });
  });
});

/* ── Tappa 6.19c: gli identificativi come quelli della Regione ───────────── */

describe("NeTEx: gli identificativi come quelli della Regione", () => {
  /** Lo stesso GTFS con i codici di linea della Regione Marche: «1/3» e «C.D.». */
  const COME_LA_REGIONE: Gtfs = {
    ...GTFS_DI_PROVA,
    "routes.txt": file(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"], [
      { route_id: "1/3", agency_id: "ATMA", route_short_name: "1/3", route_long_name: "Piazza IV Novembre - Posatora", route_type: 3 },
      { route_id: "C.D.", agency_id: "ATMA", route_short_name: "C.D.", route_long_name: "", route_type: 3 },
    ]),
    "trips.txt": file(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"],
      GTFS_DI_PROVA["trips.txt"]!.righe.map((t) => ({ ...t, route_id: t.route_id === "L1" ? "1/3" : "C.D." }) as Record<string, string | number>)),
  };
  const ATMA = { codice: "ATMA", nome: "Atma Scpa", sito: null, telefono: null, email: null };
  const REGIONE = { ...OPZIONI, prefisso: "epd", prefissoCodici: "ATMA", codiceRete: "RETE_TPL_ATMA", operatori: [ATMA], operatorePrincipale: "ATMA" };
  const { xml } = netexDaGtfs(COME_LA_REGIONE, REGIONE);
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!).filter((i) => i !== "iti3");
  const refs = [...xml.matchAll(/ ref="([^"]+)"/g)].map((m) => m[1]!).filter((r) => !r.startsWith("epip:") && r !== "iti3");

  it("le linee e le fermate come nei file della Regione: epd:IT:ITI3:Tipo:ATMA_codice", () => {
    expect(xml).toContain('<Line id="epd:IT:ITI3:Line:ATMA_1/3" version="1">');
    expect(xml).toContain('<Line id="epd:IT:ITI3:Line:ATMA_C.D." version="1">');
    expect(xml).toContain('<ScheduledStopPoint id="epd:IT:ITI3:ScheduledStopPoint:ATMA_S1" version="1">');
    expect(xml).toContain('<StopPlace id="epd:IT:ITI3:StopPlace:ATMA_S1" version="1">');
    expect(xml).toContain('<PassengerStopAssignment id="epd:IT:ITI3:PassengerStopAssignment:ATMA_S1" version="1"');
  });

  it("l'operatore col codice del gestore e la rete col suo codice, senza il prefisso dei codici", () => {
    expect(xml).toContain('<Operator id="epd:IT:ITI3:Operator:ATMA" version="1">');
    expect(xml).toContain('<Network id="epd:IT:ITI3:Network:RETE_TPL_ATMA" version="1">');
    expect(xml).toContain('<OperatorRef ref="epd:IT:ITI3:Operator:ATMA" version="1"/>');
  });

  it("il prefisso davanti a tutti gli identificativi, contenitori compresi", () => {
    expect(ids.length).toBeGreaterThan(50);
    expect(ids.filter((i) => !i.startsWith("epd:IT:ITI3:"))).toEqual([]);
    expect(xml).toContain('id="epd:IT:ITI3:CompositeFrame-EU_PI_NETWORK_OFFER:conerobus"');
  });

  it("ogni riferimento porta a un oggetto del file, e nessun identificativo si ripete", () => {
    const definiti = new Set(ids);
    expect(definiti.size).toBe(ids.length);
    expect(refs.filter((r) => !definiti.has(r))).toEqual([]);
  });

  it("col fornitore, il fornitore resta in fondo", () => {
    expect(netexDaGtfs(COME_LA_REGIONE, { ...REGIONE, fornitore: "RM" }).xml).toContain('<Line id="epd:IT:ITI3:Line:ATMA_1/3:RM" version="1">');
  });

  it("passa lo schema EPIP anche con la «/», il «.» e i prefissi", async () => {
    const esito = await validaNetex(xml);
    if (esito.stato === "senza_xmllint" && !process.env.NETEX_SCHEMA_OBBLIGATORIO) return;
    expect(esito).toEqual({ stato: "valido", errori: [] });
  });
});
