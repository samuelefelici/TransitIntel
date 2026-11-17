/**
 * NeTEx con il profilo italiano, livello 1 (tappa 6.2): la traduzione dal GTFS
 * consegnabile, e il file che ne esce passato allo schema EPIP del profilo
 * italiano con xmllint (se c'è: in CI sì).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { giorniDiServizio, netexDaGtfs, orarioNetex, pezzoId } from "../lib/netex";
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
    // «46» e «46/» restano diversi; «:» non entra mai
    expect(pezzoId("46")).toBe("46");
    expect(pezzoId("46/")).toMatch(/^46_-[0-9a-f]{8}$/);
    expect(pezzoId("623_CodUdp:D1318_364081")).toMatch(/^623_CodUdp_D1318_364081-[0-9a-f]{8}$/);
    expect(pezzoId("àè")).toMatch(/^_-[0-9a-f]{8}$/);
    expect(pezzoId("46/")).toBe(pezzoId("46/"));
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
    expect(conteggi).toEqual({ fermate: 3, linee: 2, sequenze: 3, corse: 4, orari: 10, tipiDiGiorno: 2, giorni: 5, corseSenzaGiorni: 1 });
    expect(xml).not.toContain("Fermata non usata");
  });

  it("gli identificativi del profilo: IT:codice locale:Tipo:codice, stabili", () => {
    expect(xml).toMatch(/<Line id="IT:ITI3:Line:L2_bis-[0-9a-f]{8}" version="1">/);
    expect(xml).toContain('<ServiceJourney id="IT:ITI3:ServiceJourney:T1" version="1">');
    expect(xml).toContain('id="epd:IT:ITI3:CompositeFrame-EU_PI_NETWORK_OFFER:conerobus"');
    expect(netexDaGtfs(GTFS_DI_PROVA, OPZIONI).xml).toBe(xml);
    // con il fornitore, in fondo
    expect(netexDaGtfs(GTFS_DI_PROVA, { ...OPZIONI, fornitore: "ATMA" }).xml).toMatch(/<Line id="IT:ITI3:Line:L2_bis-[0-9a-f]{8}:ATMA" version="1">/);
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
