/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Le correzioni della riverifica SIRI + GTFS — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni caso qui sotto è uno scenario che, prima, produceva un numero
 * plausibile e sbagliato senza nessun errore. Si fissa il caso, non la riga.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  parseDate, splitInService, lineCodeCandidates, buildTripStartIndex,
  parseVehicleMonitoringResponse, type SiriVehicle,
} from "../lib/siri-vm";
import { scegliFraVicine } from "../lib/siri-ingest";
import { verificaAggancio } from "../lib/trip-match-audit";
import {
  giornataDiIstante, giornataOggi, dataLocale, TAGLIO_GIORNATA_ORE, comeGiorno,
} from "../lib/service-day";

const TZ = "Europe/Rome";

const vettura = (p: Partial<SiriVehicle>): SiriVehicle => ({
  recordedAt: null, itemIdentifier: null, vehicleRef: "V1", lineRef: null, directionRef: null,
  datedVehicleJourneyRef: null, courseOfJourneyRef: null, journeyRef: null, routeRef: null,
  outOfService: false, originRef: null, originName: null, destinationRef: null,
  destinationAimedArrival: null, dataFrameRef: null, journeyPatternRef: null,
  publishedLineName: null, destinationName: null, originAimedDeparture: null,
  lat: null, lon: null, bearing: null, delaySeconds: null, blockRef: null, monitored: true,
  inCongestion: false, inPanic: false, progressRate: null, progressPercent: null,
  occupancy: null, previousCalls: [], monitoredCall: null, onwardCalls: [],
  progressStatus: null, inDepot: false, expiredLocalization: false, withoutService: false,
  withoutTarget: false, monitoringError: null, linkDistance: null,
  ...p,
});

describe("la giornata di esercizio", () => {
  it("prima dell'ora di taglio si è ancora nella giornata precedente", () => {
    expect(TAGLIO_GIORNATA_ORE).toBe(3);
    expect(giornataDiIstante(new Date("2026-09-13T01:30:00+02:00"), TZ)).toBe("2026-09-12");
    expect(giornataDiIstante(new Date("2026-09-13T02:59:59+02:00"), TZ)).toBe("2026-09-12");
    expect(giornataDiIstante(new Date("2026-09-13T03:00:00+02:00"), TZ)).toBe("2026-09-13");
  });

  /* Il server è in UTC: alle 00:30 italiane `toISOString()` dice ancora
   * ieri, ed è da lì che nascevano i "transiti di ieri" nelle prime ore. */
  it("la data locale è quella dell'azienda, non del server", () => {
    expect(dataLocale(new Date("2026-09-12T22:30:00Z"), TZ)).toBe("2026-09-13");
    expect(new Date("2026-09-12T22:30:00Z").toISOString().slice(0, 10)).toBe("2026-09-12");
  });

  it("giornataOggi è coerente con giornataDiIstante", () => {
    const ora = new Date("2026-09-13T00:10:00+02:00");
    expect(giornataOggi(ora, TZ)).toBe(giornataDiIstante(ora, TZ));
  });

  it("una colonna date del driver diventa YYYY-MM-DD senza spostarsi di un giorno", () => {
    expect(comeGiorno("2026-09-12")).toBe("2026-09-12");
    expect(comeGiorno("2026-09-12T00:00:00.000Z")).toBe("2026-09-12");
    expect(comeGiorno(new Date(2026, 8, 12))).toBe("2026-09-12");
  });
});

describe("il parsing delle date SIRI", () => {
  it("con l'offset è un istante e basta", () => {
    expect(parseDate("2026-09-10T08:00:00+02:00", TZ)!.toISOString()).toBe("2026-09-10T06:00:00.000Z");
    expect(parseDate("2026-09-10T06:00:00Z", TZ)!.toISOString()).toBe("2026-09-10T06:00:00.000Z");
  });

  /* xsd:dateTime ammette l'assenza di offset, e nel flusso vero compare:
   * letto nel fuso del processo (UTC) spostava ogni orario di due ore. */
  it("senza offset è ora di parete dell'azienda, non del server", () => {
    expect(parseDate("2026-09-10T08:00:00", TZ)!.toISOString()).toBe("2026-09-10T06:00:00.000Z");
    // in inverno l'offset è +1
    expect(parseDate("2026-12-10T08:00:00", TZ)!.toISOString()).toBe("2026-12-10T07:00:00.000Z");
  });

  it("un valore malformato resta nullo", () => {
    expect(parseDate("boh", TZ)).toBeNull();
    expect(parseDate(null, TZ)).toBeNull();
  });
});

describe("il ritardo dichiarato a una fermata", () => {
  const xml = (call: string) => `<?xml version="1.0"?>
<Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery>
<VehicleMonitoringDelivery><VehicleActivity>
<MonitoredVehicleJourney><VehicleRef>V1</VehicleRef>
<MonitoredCall>${call}</MonitoredCall>
</MonitoredVehicleJourney></VehicleActivity></VehicleMonitoringDelivery>
</ServiceDelivery></Siri>`;

  /* Capolinea con cinque minuti di sosta: arrivo alle 08:01 su un arrivo
   * programmato alle 08:00 è +60 s. Prima usciva −240 s, perché l'arrivo
   * effettivo veniva confrontato con la PARTENZA programmata. */
  it("l'arrivo effettivo si confronta con l'arrivo programmato", () => {
    const r = parseVehicleMonitoringResponse(xml(`
      <StopPointRef>S1</StopPointRef>
      <AimedArrivalTime>2026-09-10T08:00:00+02:00</AimedArrivalTime>
      <AimedDepartureTime>2026-09-10T08:05:00+02:00</AimedDepartureTime>
      <ActualArrivalTime>2026-09-10T08:01:00+02:00</ActualArrivalTime>
      <ExpectedDepartureTime>2026-09-10T08:05:00+02:00</ExpectedDepartureTime>`));
    expect(r.vehicles[0].monitoredCall!.delaySeconds).toBe(60);
  });

  it("la partenza effettiva si confronta con la partenza programmata", () => {
    const r = parseVehicleMonitoringResponse(xml(`
      <StopPointRef>S1</StopPointRef>
      <AimedArrivalTime>2026-09-10T08:00:00+02:00</AimedArrivalTime>
      <AimedDepartureTime>2026-09-10T08:05:00+02:00</AimedDepartureTime>
      <ActualDepartureTime>2026-09-10T08:07:00+02:00</ActualDepartureTime>`));
    expect(r.vehicles[0].monitoredCall!.delaySeconds).toBe(120);
  });
});

describe("il parco fermo di notte", () => {
  const inServizio = vettura({ vehicleRef: "A", journeyRef: "J1", progressStatus: "Localized" });
  const inRimessa = vettura({ vehicleRef: "B", journeyRef: "J2", progressStatus: "InDepot/WithoutService", inDepot: true, withoutService: true });

  it("quando il produttore non dice nulla, nessuno viene filtrato", () => {
    const s = splitInService([vettura({ vehicleRef: "A" }), vettura({ vehicleRef: "B" })]);
    expect(s.nonDistinguibile).toBe(true);
    expect(s.inServizio).toHaveLength(2);
  });

  /* Alle due di notte tutto il parco è dichiarato in rimessa: prima il
   * ripiego lo promuoveva per intero a "in esercizio". */
  it("quando il produttore dichiara tutti fermi, sono tutti fermi", () => {
    const s = splitInService([inRimessa, { ...inRimessa, vehicleRef: "C" }]);
    expect(s.nonDistinguibile).toBe(false);
    expect(s.inServizio).toHaveLength(0);
    expect(s.ferme).toHaveLength(2);
  });

  it("di giorno separa come prima", () => {
    const s = splitInService([inServizio, inRimessa]);
    expect(s.inServizio.map(v => v.vehicleRef)).toEqual(["A"]);
    expect(s.ferme.map(v => v.vehicleRef)).toEqual(["B"]);
  });
});

describe("il codice di linea dal nome pubblicato", () => {
  it("il trattino fra numero e percorso non è una linea accoppiata", () => {
    expect(lineCodeCandidates("Linea 4 - Tavernelle - Stazione")).toEqual(["4"]);
  });

  it("le linee accoppiate restano accoppiate", () => {
    expect(lineCodeCandidates("Linea 1-4 P.zza IV Novembre")).toEqual(["1-4", "1/4"]);
    expect(lineCodeCandidates("Linea 1/4 Tavernelle")).toEqual(["1/4", "1-4"]);
  });

  /* "Jesi" è corto e a confine di parola, quindi la regex lo prende: il
   * codice da solo deve comunque essere tentato, per ultimo. Ma per una
   * coppia numerica ("1-4") NON si tenta "1": sarebbe un'altra linea. */
  it("con una parola dopo il trattino prova anche il numero da solo, per ultimo", () => {
    const c = lineCodeCandidates("Linea 4 - Jesi");
    expect(c[c.length - 1]).toBe("4");
    expect(lineCodeCandidates("Linea 1-4 Stazione")).not.toContain("1");
  });

  it("i codici alfanumerici corti del feed passano", () => {
    expect(lineCodeCandidates("Linea UJ2A Jesi")).toEqual(["UJ2A"]);
    expect(lineCodeCandidates("Linea JECN - Ancona")).toEqual(["JECN"]);
  });

  it("un nome senza codice non ne inventa uno", () => {
    expect(lineCodeCandidates("Linea Ancona - Jesi")).toEqual([]);
  });
});

describe("l'indice delle partenze", () => {
  /* La specifica GTFS ammette "7:15:00": la chiave "7:15:" non combaciava
   * mai con i candidati "07:15" e nessuna corsa prima delle dieci si
   * agganciava. */
  it("normalizza l'ora a una cifra nella chiave", () => {
    const idx = buildTripStartIndex([
      { tripId: "T1", routeId: "3", firstDeparture: "7:15:00", headsign: null },
      { tripId: "T2", routeId: "3", firstDeparture: "07:20:00", headsign: null },
    ]);
    expect(idx.byRouteAndStart.get("3|07:15")).toEqual(["T1"]);
    expect(idx.byRouteAndStart.get("3|07:20")).toEqual(["T2"]);
    expect(idx.byRouteAndStart.has("3|7:15:")).toBe(false);
  });
});

describe("la fermata giusta fra più fermate nel raggio", () => {
  const F = (seq: number, scheduled: string, distanceM: number) =>
    ({ stopId: "CAP", seq, lat: 43.6, lon: 13.5, scheduled, distanceM });

  /* Linea circolare: capolinea di partenza (08:00, seq 1) e di arrivo
   * (08:40, seq 9) sono lo stesso punto. Alle 08:42 il mezzo è all'arrivo. */
  it("a parità di distanza sceglie l'orario più vicino all'istante", () => {
    const alle0842 = new Date("2026-09-13T08:42:00+02:00");
    const scelta = scegliFraVicine([F(1, "08:00:00", 12), F(9, "08:40:00", 12)], alle0842, TZ);
    expect(scelta!.seq).toBe(9);
    const alle0759 = new Date("2026-09-13T07:59:00+02:00");
    expect(scegliFraVicine([F(1, "08:00:00", 12), F(9, "08:40:00", 12)], alle0759, TZ)!.seq).toBe(1);
  });

  it("se una è nettamente più vicina, vince la distanza", () => {
    const alle0842 = new Date("2026-09-13T08:42:00+02:00");
    expect(scegliFraVicine([F(1, "08:00:00", 5), F(9, "08:40:00", 40)], alle0842, TZ)!.seq).toBe(1);
  });

  it("gestisce gli orari oltre le 24 a cavallo della mezzanotte", () => {
    const alle0012 = new Date("2026-09-13T00:12:00+02:00");
    expect(scegliFraVicine([F(1, "23:30:00", 8), F(9, "24:10:00", 8)], alle0012, TZ)!.seq).toBe(9);
  });

  it("con una sola fermata non c'è niente da scegliere", () => {
    expect(scegliFraVicine([F(1, "08:00:00", 5)], new Date(), TZ)!.seq).toBe(1);
    expect(scegliFraVicine([], new Date(), TZ)).toBeUndefined();
  });
});

describe("la verifica dell'aggancio per orario", () => {
  /* La corsa è stata scelta fra quelle della linea 3 che partono alle 08:00:
   * linea e partenza coincidono PER COSTRUZIONE. Senza dati indipendenti il
   * verdetto deve restare "non verificabile", non "confermato da linea". */
  it("la linea non conferma un aggancio fatto sulla linea", () => {
    const e = verificaAggancio(
      { vehicleRef: "V1", journeyRef: "J", routeIdDichiarato: "3",
        originAimedDeparture: new Date("2026-09-13T08:00:00+02:00"),
        destinationAimedArrival: null, destinationName: null, lat: null, lon: null },
      { tripId: "T", routeId: "3", partenza: "08:00:00", arrivo: null, capolinea: null, fermate: [] },
      "orario", TZ,
    );
    const linea = e.riscontri.find(r => r.campo === "linea")!;
    expect(linea.tautologico).toBe(true);
    expect(e.verdetto).toBe("non_verificabile");
    expect(e.indipendenti).toBe(0);
  });

  it("per un aggancio per id la linea è un riscontro vero", () => {
    const e = verificaAggancio(
      { vehicleRef: "V1", journeyRef: "T", routeIdDichiarato: "3",
        originAimedDeparture: new Date("2026-09-13T08:00:00+02:00"),
        destinationAimedArrival: null, destinationName: null, lat: null, lon: null },
      { tripId: "T", routeId: "3", partenza: "08:00:00", arrivo: null, capolinea: null, fermate: [] },
      "id", TZ,
    );
    expect(e.riscontri.find(r => r.campo === "linea")!.tautologico).toBeUndefined();
    expect(e.verdetto).toBe("verificato");
  });
});
