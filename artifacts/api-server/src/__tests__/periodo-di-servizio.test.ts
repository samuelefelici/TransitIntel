/**
 * Fino a quando ha corse un GTFS (tappa 6.45, lib/periodo-di-servizio.ts):
 * l'ultimo giorno di servizio dai calendari delle corse, se è già passato, e
 * il motivo per cui i dati aperti non lo pubblicano. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { giornoItaliano, motivoScaduto, oggiDiRoma, scadutoIl, ultimoGiornoDiServizio } from "../lib/periodo-di-servizio";
import type { Gtfs } from "../lib/gtfs-verifica";

const file = (colonne: string[], righe: Array<Record<string, string | number>>) => ({ colonne, righe });
const settimana = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0 };

/** Un feriale fino a venerdì 11/12/2026, un festivo solo con le date, e un servizio che nessuna corsa usa. */
const GTFS: Gtfs = {
  "trips.txt": file(["trip_id", "service_id"], [{ trip_id: "T1", service_id: "FER" }, { trip_id: "T2", service_id: "FES" }]),
  "calendar.txt": file(["service_id", "start_date", "end_date"], [
    { service_id: "FER", ...settimana, start_date: "20261102", end_date: "20261211" },
    { service_id: "NESSUNO", ...settimana, start_date: "20261102", end_date: "20271231" },
  ]),
  "calendar_dates.txt": file(["service_id", "date", "exception_type"], [
    { service_id: "FES", date: "20261108", exception_type: 1 },
    { service_id: "FES", date: "20261206", exception_type: 1 },
  ]),
};

describe("Il periodo di servizio", () => {
  it("l'ultimo giorno con una corsa, dai calendari delle sole corse", () => {
    expect(ultimoGiornoDiServizio(GTFS)).toBe("2026-12-11");
    /* un'eccezione che toglie l'ultimo venerdì sposta l'ultimo giorno al giovedì */
    const senzaVenerdi: Gtfs = { ...GTFS, "calendar_dates.txt": file(["service_id", "date", "exception_type"], [
      ...(GTFS["calendar_dates.txt"]!.righe as Array<Record<string, string | number>>), { service_id: "FER", date: "20261211", exception_type: 2 }]) };
    expect(ultimoGiornoDiServizio(senzaVenerdi)).toBe("2026-12-10");
    /* e una aggiunta lo porta più in là */
    const conAggiunta: Gtfs = { ...GTFS, "calendar_dates.txt": file(["service_id", "date", "exception_type"], [
      ...(GTFS["calendar_dates.txt"]!.righe as Array<Record<string, string | number>>), { service_id: "FES", date: "20261227", exception_type: 1 }]) };
    expect(ultimoGiornoDiServizio(conAggiunta)).toBe("2026-12-27");
    expect(ultimoGiornoDiServizio({ "trips.txt": file(["trip_id", "service_id"], [{ trip_id: "T1", service_id: "X" }]) })).toBeNull();
  });

  it("scaduto solo se l'ultimo giorno è già passato: il giorno stesso no", () => {
    expect(scadutoIl(GTFS, "2026-12-11")).toBeNull();
    expect(scadutoIl(GTFS, "2026-12-12")).toBe("2026-12-11");
    expect(scadutoIl({}, "2030-01-01")).toBeNull();
  });

  it("oggi a Roma, non in UTC", () => {
    expect(oggiDiRoma(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(oggiDiRoma(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
  });

  it("il motivo dice fino a quando, perché non si pubblica e dove si corregge", () => {
    expect(giornoItaliano("2025-12-05")).toBe("05/12/2025");
    const m = motivoScaduto("2025-12-05");
    expect(m).toContain("solo fino al 05/12/2025");
    expect(m).toContain("non si pubblica");
    expect(m).toContain("si duplica quello in esercizio");
    expect(m).toContain("controllo di salute della messa in esercizio");
  });
});
