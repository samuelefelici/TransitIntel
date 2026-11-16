/**
 * Il controllo del GTFS prima della consegna (PR 3.4, lib/gtfs-verifica.ts),
 * e l'azienda che finisce in agency.txt.
 */
import { describe, it, expect } from "vitest";
import { verificaGtfs, type Gtfs } from "../lib/gtfs-verifica";
import { aziendaDelGtfs, gtfsInCsv } from "../lib/planning-studio-export";
import { AZIENDA_DA_COMPILARE, type Azienda } from "../lib/azienda";

/** Un GTFS piccolo e in regola: una linea, due fermate, una corsa. */
function buono(): Gtfs {
  return {
    "agency.txt": { colonne: ["agency_id", "agency_name", "agency_url", "agency_timezone"], righe: [{ agency_id: "az", agency_name: "Azienda", agency_url: "https://esempio.it", agency_timezone: "Europe/Rome" }] },
    "stops.txt": { colonne: ["stop_id", "stop_name", "stop_lat", "stop_lon"], righe: [
      { stop_id: "10", stop_name: "Stazione", stop_lat: 43.6075, stop_lon: 13.4977 },
      { stop_id: "11", stop_name: "Torrette", stop_lat: 43.6040, stop_lon: 13.4510 },
    ] },
    "routes.txt": { colonne: ["route_id", "agency_id", "route_short_name", "route_type"], righe: [{ route_id: "1/3", agency_id: "az", route_short_name: "1", route_type: 3 }] },
    "calendar.txt": { colonne: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
      righe: [{ service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20260914", end_date: "20270610" }] },
    "calendar_dates.txt": { colonne: ["service_id", "date", "exception_type"], righe: [] },
    "trips.txt": { colonne: ["route_id", "service_id", "trip_id", "shape_id"], righe: [{ route_id: "1/3", service_id: "FER", trip_id: "C1", shape_id: "" }] },
    "stop_times.txt": { colonne: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], righe: [
      { trip_id: "C1", arrival_time: "07:00:00", departure_time: "07:00:00", stop_id: "10", stop_sequence: 1 },
      { trip_id: "C1", arrival_time: "07:10:00", departure_time: "07:10:00", stop_id: "11", stop_sequence: 2 },
    ] },
    "shapes.txt": { colonne: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], righe: [] },
    "feed_info.txt": { colonne: ["feed_publisher_name", "feed_start_date", "feed_end_date"], righe: [{ feed_publisher_name: "Azienda", feed_start_date: "20260914", feed_end_date: "20270610" }] },
  };
}
const codici = (p: { codice: string }[]) => p.map((x) => x.codice).sort();
const OGGI = "20261115";

describe("il controllo del GTFS", () => {
  it("un file in regola: niente errori né avvisi", () => {
    expect(verificaGtfs(buono(), OGGI)).toEqual({ errori: [], avvisi: [] });
  });

  it("l'azienda senza sito: errore, con il posto dove si imposta", () => {
    const g = buono();
    g["agency.txt"]!.righe[0]!.agency_url = "";
    const { errori } = verificaGtfs(g, OGGI);
    expect(codici(errori)).toEqual(["agency_url_non_valido"]);
    expect(errori[0]!.messaggio).toContain("Amministrazione › Azienda");
  });

  it("riferimenti che non tornano: linea, calendario, fermata, corsa, percorso", () => {
    const g = buono();
    g["trips.txt"]!.righe.push({ route_id: "9", service_id: "NON", trip_id: "C2", shape_id: "S9" });
    g["stop_times.txt"]!.righe.push(
      { trip_id: "C2", arrival_time: "08:00:00", departure_time: "08:00:00", stop_id: "99", stop_sequence: 1 },
      { trip_id: "C2", arrival_time: "08:10:00", departure_time: "08:10:00", stop_id: "11", stop_sequence: 2 },
      { trip_id: "CX", arrival_time: "09:00:00", departure_time: "09:00:00", stop_id: "10", stop_sequence: 1 },
    );
    expect(codici(verificaGtfs(g, OGGI).errori)).toEqual([
      "route_id_sconosciuto", "service_id_sconosciuto", "shape_id_sconosciuto", "stop_id_sconosciuto", "trip_id_sconosciuto",
    ]);
  });

  it("gli orari di una corsa: almeno due fermate, sequenza che cresce, tempo che non torna indietro, partenza dopo l'arrivo", () => {
    const g = buono();
    const st = g["stop_times.txt"]!.righe;
    st[1]!.arrival_time = "06:50:00"; st[1]!.departure_time = "06:50:00";
    g["trips.txt"]!.righe.push({ route_id: "1/3", service_id: "FER", trip_id: "C2", shape_id: "" }, { route_id: "1/3", service_id: "FER", trip_id: "C3", shape_id: "" });
    st.push(
      { trip_id: "C2", arrival_time: "08:00:00", departure_time: "08:00:00", stop_id: "10", stop_sequence: 1 },
      { trip_id: "C3", arrival_time: "09:05:00", departure_time: "09:00:00", stop_id: "10", stop_sequence: 1 },
      { trip_id: "C3", arrival_time: "9:30", departure_time: "09:30:00", stop_id: "11", stop_sequence: 1 },
    );
    const { errori } = verificaGtfs(g, OGGI);
    expect(codici(errori)).toEqual(["corsa_senza_orari", "orari_all_indietro", "orario_non_valido", "partenza_prima_dell_arrivo", "stop_sequence_non_crescente"]);
    expect(errori.find((e) => e.codice === "corsa_senza_orari")!.esempi).toEqual(["C2"]);
  });

  it("id doppi, coordinate mancanti, tipo di linea e date non valide, fuso orario sbagliato", () => {
    const g = buono();
    g["stops.txt"]!.righe.push({ stop_id: "10", stop_name: "Doppia", stop_lat: 0, stop_lon: 0 });
    g["routes.txt"]!.righe[0]!.route_type = 42;
    g["calendar.txt"]!.righe[0]!.end_date = "20270230";
    g["agency.txt"]!.righe[0]!.agency_timezone = "Europa/Ancona";
    expect(codici(verificaGtfs(g, OGGI).errori)).toEqual([
      "agency_timezone_non_valido", "coordinate_zero", "data_non_valida", "route_type_non_valido", "stop_id_doppio",
    ]);
  });

  it("gli avvisi: velocità impossibile, fermata e linea senza corse, file scaduto, calendario senza giorni", () => {
    const g = buono();
    g["stop_times.txt"]!.righe[1]!.arrival_time = "07:01:00"; // 3,8 km in un minuto
    g["stops.txt"]!.righe.push({ stop_id: "12", stop_name: "Capolinea", stop_lat: 43.63, stop_lon: 13.53 });
    g["routes.txt"]!.righe.push({ route_id: "9", agency_id: "az", route_short_name: "9", route_type: 3 });
    g["feed_info.txt"]!.righe[0]!.feed_end_date = "20250101";
    g["feed_info.txt"]!.righe[0]!.feed_start_date = "20240101";
    g["calendar.txt"]!.righe[0]!.monday = 0; g["calendar.txt"]!.righe[0]!.tuesday = 0; g["calendar.txt"]!.righe[0]!.wednesday = 0;
    g["calendar.txt"]!.righe[0]!.thursday = 0; g["calendar.txt"]!.righe[0]!.friday = 0;
    const { errori, avvisi } = verificaGtfs(g, OGGI);
    expect(errori).toEqual([]);
    expect(codici(avvisi)).toEqual(["fermata_non_usata", "file_scaduto", "linea_senza_corse", "servizio_senza_giorni", "velocita_impossibile"]);
  });

  it("i file obbligatori che mancano o sono vuoti, e nessun calendario", () => {
    const g = buono();
    delete g["routes.txt"];
    g["stops.txt"]!.righe = [];
    g["calendar.txt"]!.righe = [];
    const { errori } = verificaGtfs(g, OGGI);
    expect(codici(errori)).toEqual(expect.arrayContaining(["file_mancante", "file_vuoto", "nessun_calendario"]));
  });

  it("i problemi uguali si contano in una riga sola, con al più cinque esempi", () => {
    const g = buono();
    for (let i = 0; i < 8; i++) g["trips.txt"]!.righe.push({ route_id: "1/3", service_id: "FER", trip_id: `V${i}`, shape_id: "" });
    const p = verificaGtfs(g, OGGI).errori.find((e) => e.codice === "corsa_senza_orari")!;
    expect(p.quante).toBe(8);
    expect(p.esempi).toHaveLength(5);
  });
});

describe("l'azienda in agency.txt", () => {
  const compilata: Azienda = { ...AZIENDA_DA_COMPILARE, ragioneSociale: "Trasporti Esempio S.p.A.", nome: "Esempio", gtfsAgencyId: "esempio", sito: "https://www.esempio.it", telefono: "+39 071 000000", citta: "Ancona", compilata: true };
  const progetto = { name: "Programma invernale", agency_name: "Consorzio", agency_url: "https://consorzio.it", agency_timezone: "Europe/Rome" };

  it("con i dati dell'azienda compilati: quelli, non il progetto", () => {
    expect(aziendaDelGtfs(compilata, progetto)).toEqual({
      agency_id: "esempio", agency_name: "Trasporti Esempio S.p.A.", agency_url: "https://www.esempio.it",
      agency_timezone: "Europe/Rome", agency_lang: "it", agency_phone: "+39 071 000000",
    });
  });
  it("senza: quelli del progetto, come prima; senza sito nessun indirizzo inventato", () => {
    expect(aziendaDelGtfs(AZIENDA_DA_COMPILARE, progetto)).toMatchObject({ agency_id: "1", agency_name: "Consorzio", agency_url: "https://consorzio.it", agency_phone: "" });
    expect(aziendaDelGtfs(AZIENDA_DA_COMPILARE, { name: "P" }).agency_url).toBe("");
  });
  it("i CSV: virgolette, virgole e a capo protetti", () => {
    const csv = gtfsInCsv({ "agency.txt": { colonne: ["agency_id", "agency_name"], righe: [{ agency_id: "a", agency_name: 'Trasporti "Esempio", S.p.A.\nAncona' }] } });
    expect(csv["agency.txt"]).toBe('agency_id,agency_name\na,"Trasporti ""Esempio"", S.p.A.\nAncona"\n');
  });
});
