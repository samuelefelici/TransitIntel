/**
 * Gli orari impossibili fra due fermate, tratta per tratta (tappa 6.44,
 * lib/orari-impossibili.ts): lo stesso conto dell'avviso del controllo del
 * GTFS, la corsa sana dello stesso percorso come riferimento, e il CSV per
 * Excel. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { csvOrariImpossibili, orariImpossibili, INTESTAZIONE_ORARI_IMPOSSIBILI } from "../lib/orari-impossibili";
import { verificaGtfs, type Gtfs } from "../lib/gtfs-verifica";

const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });
const LAT = 45, LON = 9;
const KM_LAT = 6371 * Math.PI / 180;
/** Una fermata a tanti km a est del punto di partenza. */
const est = (km: number) => LON + km / (KM_LAT * Math.cos(LAT * Math.PI / 180));

/**
 * Quattro fermate su una strada verso est, a 0, 2, 4 e 10 km. La linea L1 ha
 * tre corse sullo stesso percorso: T1 alle 07:00 e T3 alle 09:00 sane, T2 alle
 * 08:00 che fa gli ultimi 6 km in un minuto. La linea L2 ha una corsa sola, T4,
 * coi primi 2 km in 30 secondi: nessuna corsa sana da prendere a riferimento.
 */
function rete(): Gtfs {
  const corsa = (t: string, orari: string[], fermate = ["A", "B", "C", "D"]) =>
    fermate.map((s, i) => ({ trip_id: t, arrival_time: orari[i]!, departure_time: orari[i]!, stop_id: s, stop_sequence: i + 1 }));
  return {
    "agency.txt": file(["agency_id", "agency_name", "agency_url", "agency_timezone"], [{ agency_id: "az", agency_name: "Azienda", agency_url: "https://esempio.it", agency_timezone: "Europe/Rome" }]),
    "stops.txt": file(["stop_id", "stop_name", "stop_lat", "stop_lon"], [
      { stop_id: "A", stop_name: "Piazza A", stop_lat: LAT, stop_lon: est(0) },
      { stop_id: "B", stop_name: "=Bivio; \"vecchio\"", stop_lat: LAT, stop_lon: est(2) },
      { stop_id: "C", stop_name: "Borgo C", stop_lat: LAT, stop_lon: est(4) },
      { stop_id: "D", stop_name: "-Deposito", stop_lat: LAT, stop_lon: est(10) },
    ]),
    "routes.txt": file(["route_id", "route_short_name", "route_type"], [
      { route_id: "L1", route_short_name: "1", route_type: 3 },
      { route_id: "L2", route_short_name: "2", route_type: 3 },
    ]),
    "calendar.txt": file(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
      [{ service_id: "FER", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: "20261102", end_date: "20261231" }]),
    "trips.txt": file(["route_id", "service_id", "trip_id"], [
      { route_id: "L1", service_id: "FER", trip_id: "T1" }, { route_id: "L1", service_id: "FER", trip_id: "T2" },
      { route_id: "L1", service_id: "FER", trip_id: "T3" }, { route_id: "L2", service_id: "FER", trip_id: "T4" },
    ]),
    "stop_times.txt": file(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], [
      ...corsa("T1", ["07:00:00", "07:04:00", "07:08:00", "07:18:00"]),
      ...corsa("T2", ["08:00:00", "08:04:00", "08:08:00", "08:09:00"]),
      ...corsa("T3", ["09:00:00", "09:04:00", "09:08:00", "09:18:00"]),
      ...corsa("T4", ["10:00:00", "10:00:30", "10:05:00"], ["A", "B", "C"]),
    ]),
  };
}

describe("Gli orari impossibili, tratta per tratta", () => {
  const tratte = orariImpossibili(rete());

  it("una riga per tratta: linea, corsa, partenza, fermate, orari, secondi, km e km/h", () => {
    expect(tratte).toHaveLength(2);
    const [l1, l2] = tratte;
    expect(l1).toMatchObject({
      linea: "1", corsa: "T2", partenza: "08:00:00",
      da: { fermata: "C", nome: "Borgo C", orario: "08:08:00" }, a: { fermata: "D", nome: "-Deposito", orario: "08:09:00" },
      secondi: 60, kmh: 360,
    });
    expect(l1!.km).toBeCloseTo(6, 2);
    expect(l2).toMatchObject({ linea: "2", corsa: "T4", secondi: 30, kmh: 240 });
  });

  it("il riferimento: la corsa sana dello stesso percorso con la partenza più vicina; senza, nessuno", () => {
    /* T1 (07:00) e T3 (09:00) sono a un'ora da T2: a parità, la prima */
    expect(tratte[0]!.riferimento).toEqual({ corsa: "T1", partenza: "07:00:00" });
    const g = rete();
    g["stop_times.txt"]!.righe = g["stop_times.txt"]!.righe.map((r) => (r.trip_id === "T3" ? { ...r, arrival_time: String(r.arrival_time).replace(/^09/, "08"), departure_time: String(r.departure_time).replace(/^09/, "08") } : r));
    /* ora T3 parte alle 08:00 come T2: è lei */
    expect(orariImpossibili(g)[0]!.riferimento).toEqual({ corsa: "T3", partenza: "08:00:00" });
    expect(tratte[1]!.riferimento).toBeNull();
  });

  it("lo stesso conto dell'avviso del controllo del GTFS", () => {
    const avviso = verificaGtfs(rete(), "20261121").avvisi.find((a) => a.codice === "velocita_impossibile");
    expect(avviso?.quante).toBe(tratte.length);
    const sano = rete();
    sano["stop_times.txt"]!.righe = sano["stop_times.txt"]!.righe.filter((r) => r.trip_id === "T1");
    expect(orariImpossibili(sano)).toEqual([]);
  });

  it("il CSV per Excel in italiano: BOM, «;», virgola decimale, virgolette, e nessuna formula", () => {
    const csv = csvOrariImpossibili(tratte);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const righe = csv.slice(1).split("\r\n");
    expect(righe[0]).toBe(INTESTAZIONE_ORARI_IMPOSSIBILI.join(";"));
    expect(righe[1]).toBe("1;T2;08:00:00;C;Borgo C;08:08:00;D;'-Deposito;08:09:00;60;6;360;T1;07:00:00");
    /* il nome che comincia con «=» diventa testo, e quello con «;» e virgolette resta una cella sola */
    expect(righe[2]).toContain(`;"'=Bivio; ""vecchio""";`);
    expect(righe[2]!.endsWith(";;")).toBe(true);
    expect(righe[3]).toBe("");
    expect(csvOrariImpossibili([])).toBe("\uFEFF" + INTESTAZIONE_ORARI_IMPOSSIBILI.join(";") + "\r\n");
  });
});
