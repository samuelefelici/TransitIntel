/**
 * I gestori (tappa 6.11): chi programma può farlo per più aziende, e nei
 * GTFS ogni gestore è un'agenzia e ogni linea è di uno di loro. Prima
 * l'agenzia era una sola.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agencyTxt, agenziaDelGestore, agenziaDellAzienda, agenzieDelGtfs, erroriGestori, gestoreDellaLinea, gestorePredefinito, type Gestore,
} from "../lib/gestori";
import { AssegnaGestore, erroreGestore, ModificaGestore, NuovoGestore } from "../lib/gestori-store";
import { firmaDi } from "../lib/dati-aperti";
import { netexDelGtfs } from "../lib/gtfs-consegnabile";
import type { Gtfs } from "../lib/gtfs-verifica";
import { AZIENDA_DA_COMPILARE, type Azienda } from "../lib/azienda";
import { ELENCHI_DI_PRIMA } from "./helpers/elenchi-di-prova";
import { CONSORZIATI, GESTORE_DI_PRIMA } from "./helpers/gestori-di-prova";

const AZIENDA = { gtfsAgencyId: "conerobus", ragioneSociale: "Conerobus S.p.A.", sito: "https://www.conerobus.it", telefono: "+39 071 2837411" };
const [UNO, DUE, TRE] = CONSORZIATI as [Gestore, Gestore, Gestore];

describe("il gestore di una linea", () => {
  it("il suo, se è nell'elenco; altrimenti il predefinito, e si sa che non è assegnato", () => {
    expect(gestoreDellaLinea("DUE", CONSORZIATI)).toEqual({ gestore: DUE, assegnato: true });
    expect(gestoreDellaLinea("UNO", CONSORZIATI)).toEqual({ gestore: UNO, assegnato: true });
    for (const detto of [null, undefined, "", "ATMA", "due"]) expect(gestoreDellaLinea(detto, CONSORZIATI), String(detto)).toEqual({ gestore: UNO, assegnato: false });
  });

  it("senza gestori non ce n'è nessuno", () => {
    expect(gestoreDellaLinea("ATMA", [])).toBeNull();
    expect(gestorePredefinito([])).toBeNull();
  });

  it("il predefinito è quello segnato; se manca il segno, il primo", () => {
    expect(gestorePredefinito([{ ...UNO, predefinito: false }, { ...DUE, predefinito: true }])?.gestore).toBe("DUE");
    expect(gestorePredefinito([{ ...UNO, predefinito: false }, DUE])?.gestore).toBe("UNO");
  });
});

describe("le agenzie di un GTFS", () => {
  it("senza gestori l'agenzia è l'azienda, per tutte le linee, e quello che non si sa resta vuoto", () => {
    const a = agenzieDelGtfs(AZIENDA, [], ["ATMA", null, "X"]);
    expect(a.agenzie).toEqual([{
      agency_id: "conerobus", agency_name: "Conerobus S.p.A.", agency_url: "https://www.conerobus.it", agency_timezone: "Europe/Rome",
      agency_lang: "it", agency_phone: "+39 071 2837411", agency_fare_url: "", agency_email: "", daAzienda: true,
    }]);
    expect([a.dellaLinea("ATMA").agency_id, a.dellaLinea(null).agency_id, a.principale.agency_id]).toEqual(["conerobus", "conerobus", "conerobus"]);
    const nuova = agenziaDellAzienda({ gtfsAgencyId: "azienda", ragioneSociale: "Azienda di trasporto", sito: null, telefono: null });
    expect([nuova.agency_url, nuova.agency_phone]).toEqual(["", ""]);
  });

  it("con un gestore solo, agency.txt è la riga che era nel codice, byte per byte", () => {
    const a = agenzieDelGtfs(AZIENDA, [GESTORE_DI_PRIMA], ["ATMA", "ATMA", null]);
    expect(agencyTxt(a.agenzie)).toBe(ELENCHI_DI_PRIMA.agencyTxt);
    expect(a.principale.daAzienda).toBe(false);
  });

  it("con più gestori: solo quelli che hanno almeno una linea, nell'ordine dell'elenco", () => {
    const a = agenzieDelGtfs(AZIENDA, CONSORZIATI, ["TRE", "UNO", "TRE"]);
    expect(a.agenzie.map((x) => x.agency_id)).toEqual(["UNO", "TRE"]);
    expect(a.dellaLinea("TRE")).toEqual(agenziaDelGestore(TRE));
  });

  it("una linea che non dice un gestore dell'elenco è del predefinito, che così entra in agency.txt", () => {
    const a = agenzieDelGtfs(AZIENDA, CONSORZIATI, ["DUE", "ATMA", null]);
    expect(a.agenzie.map((x) => x.agency_id)).toEqual(["UNO", "DUE"]);
    expect([a.dellaLinea("ATMA").agency_id, a.dellaLinea(null).agency_id, a.dellaLinea("DUE").agency_id]).toEqual(["UNO", "UNO", "DUE"]);
  });

  it("un GTFS senza linee ha comunque un'agenzia: il predefinito", () => {
    expect(agenzieDelGtfs(AZIENDA, CONSORZIATI, []).agenzie.map((x) => x.agency_id)).toEqual(["UNO"]);
    expect(agenzieDelGtfs(AZIENDA, CONSORZIATI, []).principale.agency_name).toBe("Autolinee Uno S.p.A.");
  });

  it("agency.txt con più righe: una per agenzia, i campi fra virgolette, la virgola nel nome non rompe la riga", () => {
    const testo = agencyTxt(agenzieDelGtfs(AZIENDA, CONSORZIATI, ["UNO", "DUE"]).agenzie);
    expect(testo.split("\n")).toEqual([
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url,agency_email",
      '"UNO","Autolinee Uno S.p.A.","https://uno.example","Europe/Rome","it","071 000001","","info@uno.example"',
      '"DUE","Due, Bus & Co.","https://due.example","Europe/Rome","it","","https://due.example/tariffe",""',
      "",
    ]);
  });
});

describe("le regole dell'elenco", () => {
  it("con almeno un gestore il predefinito è uno, e nessun identificativo compare due volte", () => {
    expect(erroriGestori([])).toEqual([]);
    expect(erroriGestori(CONSORZIATI)).toEqual([]);
    expect(erroriGestori([{ ...UNO, predefinito: false }, DUE])).toEqual(["Un gestore deve essere il predefinito."]);
    expect(erroriGestori([UNO, { ...DUE, predefinito: true }])).toEqual(["Il gestore predefinito è uno solo."]);
    expect(erroriGestori([UNO, { ...UNO, predefinito: false }])).toEqual(["Il gestore «UNO» compare due volte."]);
  });
});

describe("quello che si può salvare", () => {
  const messaggio = (schema: { safeParse: (x: unknown) => any }, corpo: unknown) => { const p = schema.safeParse(corpo); return p.success ? "" : erroreGestore(p.error); };
  const nuovo = { gestore: "UNO", nome: "Autolinee Uno S.p.A.", sito: "https://uno.example", telefono: "071 000001", email: "info@uno.example", tariffeUrl: null };

  it("un gestore nuovo: i campi facoltativi vuoti diventano «nessuno»", () => {
    expect(NuovoGestore.parse({ ...nuovo, nome: " Uno ", telefono: " ", email: "", tariffeUrl: "" }))
      .toEqual({ gestore: "UNO", nome: "Uno", sito: "https://uno.example", telefono: null, email: null, tariffeUrl: null });
    expect(NuovoGestore.safeParse({ gestore: "UNO", nome: "Uno", sito: "https://uno.example" }).success).toBe(true);
  });

  it("quello che non va lo dice", () => {
    expect(messaggio(NuovoGestore, { ...nuovo, gestore: "Uno Due" })).toMatch(/^identificativo/);
    expect(messaggio(NuovoGestore, { ...nuovo, nome: 'Uno "bus"' })).toMatch(/virgolette/);
    expect(messaggio(NuovoGestore, { ...nuovo, sito: "uno.example" })).toMatch(/http/);
    expect(messaggio(NuovoGestore, { ...nuovo, email: "info" })).toMatch(/posta/);
    expect(messaggio(NuovoGestore, { ...nuovo, telefono: "zero" })).toMatch(/telefono/);
    expect(messaggio(NuovoGestore, { ...nuovo, predefinito: true })).toBe("Campo non previsto: predefinito");
  });

  it("la modifica: tutto tranne l'identificativo; il predefinito si sceglie, non si toglie", () => {
    expect(ModificaGestore.parse({ nome: "Uno", telefono: "" })).toEqual({ nome: "Uno", telefono: null });
    expect(ModificaGestore.parse({ predefinito: true })).toEqual({ predefinito: true });
    expect(messaggio(ModificaGestore, { predefinito: false })).toBe("Il predefinito si sceglie, non si toglie: scegline un altro");
    expect(messaggio(ModificaGestore, { gestore: "ALTRO" })).toBe("Campo non previsto: gestore");
  });

  it("l'assegnazione alle linee: un gestore (o nessuno) e almeno una linea", () => {
    const linea = "e6b00000-0000-4000-8000-000000000031";
    expect(AssegnaGestore.safeParse({ gestore: "UNO", linee: [linea] }).success).toBe(true);
    expect(AssegnaGestore.safeParse({ gestore: null, linee: [linea] }).success).toBe(true);
    expect(messaggio(AssegnaGestore, { gestore: "UNO", linee: [] })).toBe("scegli almeno una linea");
    expect(messaggio(AssegnaGestore, { gestore: "UNO", linee: ["x"] })).toBe("una linea non è valida");
    expect(messaggio(AssegnaGestore, { gestore: "un gestore", linee: [linea] })).toMatch(/^identificativo/);
    expect(AssegnaGestore.safeParse({ linee: [linea] }).success).toBe(false);
  });
});

describe("i dati aperti: quando il GTFS pubblicato si rifà", () => {
  const V = { versioneId: "e6b00000-0000-4000-8000-0000000000a1", feedId: "e6b00000-0000-4000-8000-0000000000a2" };
  const A: Azienda = { ...AZIENDA_DA_COMPILARE, ...AZIENDA, nome: "Conerobus", compilata: true };

  it("senza gestori la firma è quella di prima: i file già pubblicati non si rifanno", () => {
    expect(firmaDi("gtfs", V, A, [])).toBe(firmaDi("gtfs", V, A));
    expect(firmaDi("netex", V, A, [])).toBe(firmaDi("netex", V, A));
  });

  it("i gestori cambiano il GTFS e il NeTEx: sono le agenzie dell'uno e gli operatori dell'altro", () => {
    for (const tipo of ["gtfs", "netex"] as const) {
      const base = firmaDi(tipo, V, A, CONSORZIATI);
      expect(base, tipo).not.toBe(firmaDi(tipo, V, A, []));
      expect(firmaDi(tipo, V, A, [{ ...UNO, nome: "Uno" }, DUE, TRE]), tipo).not.toBe(base);
      expect(firmaDi(tipo, V, A, [UNO, DUE]), tipo).not.toBe(base);
      expect(firmaDi(tipo, V, A, [{ ...UNO, predefinito: false }, { ...DUE, predefinito: true }, TRE]), tipo).not.toBe(base);
      expect(firmaDi(tipo, V, A, CONSORZIATI.map((g) => ({ ...g }))), tipo).toBe(base);
    }
  });

  it("la posta di un gestore finisce solo nel NeTEx: il GTFS consegnabile non si rifà", () => {
    const conAltraPosta = [{ ...UNO, email: "altra@uno.example" }, DUE, TRE];
    expect(firmaDi("gtfs", V, A, conAltraPosta)).toBe(firmaDi("gtfs", V, A, CONSORZIATI));
    expect(firmaDi("netex", V, A, conAltraPosta)).not.toBe(firmaDi("netex", V, A, CONSORZIATI));
  });
});

describe("il NeTEx del consegnabile (tappa 6.12): gli operatori sono i gestori", () => {
  const A: Azienda = { ...AZIENDA_DA_COMPILARE, ...AZIENDA, nome: "Conerobus", compilata: true, netexCodiceLocale: "ITI3" };
  const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });
  /** Due linee con una corsa ciascuna: una dice un gestore dell'elenco, l'altra uno che non c'è. */
  const GTFS: Gtfs = {
    "agency.txt": file(["agency_id"], [{ agency_id: "UNO" }, { agency_id: "DUE" }]),
    "stops.txt": file(["stop_id", "stop_name", "stop_lat", "stop_lon"], [
      { stop_id: "S1", stop_name: "Stazione", stop_lat: 43.6, stop_lon: 13.5 }, { stop_id: "S2", stop_name: "Centro", stop_lat: 43.61, stop_lon: 13.51 }]),
    "routes.txt": file(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"], [
      { route_id: "L1", agency_id: "DUE", route_short_name: "1", route_long_name: "Stazione - Centro", route_type: 3 },
      { route_id: "L2", agency_id: "ATMA", route_short_name: "2", route_long_name: "Centro - Stazione", route_type: 3 }]),
    "trips.txt": file(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"], [
      { route_id: "L1", service_id: "FER", trip_id: "T1", trip_headsign: "Centro", direction_id: 0 },
      { route_id: "L2", service_id: "FER", trip_id: "T2", trip_headsign: "Stazione", direction_id: 0 }]),
    "stop_times.txt": file(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], [
      { trip_id: "T1", arrival_time: "07:00:00", departure_time: "07:00:00", stop_id: "S1", stop_sequence: 1 },
      { trip_id: "T1", arrival_time: "07:10:00", departure_time: "07:10:00", stop_id: "S2", stop_sequence: 2 },
      { trip_id: "T2", arrival_time: "08:00:00", departure_time: "08:00:00", stop_id: "S2", stop_sequence: 1 },
      { trip_id: "T2", arrival_time: "08:10:00", departure_time: "08:10:00", stop_id: "S1", stop_sequence: 2 }]),
    "calendar.txt": file(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], [
      { service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: "20261106" }]),
    "calendar_dates.txt": file(["service_id", "date", "exception_type"], []),
  };
  const adesso = new Date("2026-11-18T08:00:00Z");
  const operatori = (xml: string) => [...xml.matchAll(/<Operator id="IT:ITI3:Operator:([^"]+)"/g)].map((m) => m[1]);
  const delleLinee = (xml: string) => [...xml.matchAll(/<Line id="IT:ITI3:Line:([^"]+)"[^>]*>.*?<OperatorRef ref="IT:ITI3:Operator:([^"]+)"/g)].map((m) => [m[1], m[2]]);

  it("senza gestori l'operatore è l'azienda", () => {
    const { xml, conteggi } = netexDelGtfs(GTFS, A, [], adesso);
    expect([operatori(xml), conteggi.operatori]).toEqual([["conerobus"], 1]);
    expect(delleLinee(xml)).toEqual([["L1", "conerobus"], ["L2", "conerobus"]]);
  });

  it("coi gestori ogni linea porta il suo; quella che ne dice uno fuori elenco è del predefinito", () => {
    const { xml, conteggi } = netexDelGtfs(GTFS, A, CONSORZIATI, adesso);
    expect([operatori(xml), conteggi.operatori]).toEqual([["UNO", "DUE"], 2]);
    expect(delleLinee(xml)).toEqual([["L1", "DUE"], ["L2", "UNO"]]);
    /* chi trasmette resta l'azienda */
    expect(xml).toContain("<ParticipantRef>conerobus</ParticipantRef>");
  });

  it("il predefinito è quello segnato, non il primo dell'elenco", () => {
    const { xml } = netexDelGtfs(GTFS, A, [{ ...UNO, predefinito: false }, DUE, { ...TRE, predefinito: true }], adesso);
    expect(delleLinee(xml)).toEqual([["L1", "DUE"], ["L2", "TRE"]]);
    expect(operatori(xml)).toEqual(["DUE", "TRE"]);
  });
});

describe("la migrazione 0044", () => {
  const sqlMigrazione = readFileSync(join(__dirname, "../../../../lib/db/migrations/0044_i_gestori.sql"), "utf8");

  it("l'agenzia unica che c'era diventa il primo gestore, predefinito, solo se l'elenco è vuoto", () => {
    expect(sqlMigrazione).toContain(
      "INSERT INTO public.gestori (gestore, nome, sito, telefono, email, tariffe_url, predefinito, ordine)\n"
      + "SELECT a.agency_id, a.nome, a.sito, a.telefono, a.email, a.tariffe_url, true, 10\n"
      + "  FROM public.agenzia_gtfs a\n WHERE NOT EXISTS (SELECT 1 FROM public.gestori);");
  });

  it("non toglie la tabella di prima, e non nomina nessuna azienda", () => {
    expect(sqlMigrazione).not.toMatch(/DROP\s+TABLE/i);
    expect(sqlMigrazione).not.toMatch(/conerobus|atma/i);
  });
});
