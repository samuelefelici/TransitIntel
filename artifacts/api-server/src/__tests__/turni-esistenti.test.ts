/**
 * Import dei turni esistenti (tappa 7.38): lettura del file, abbinamento delle
 * corse, turni macchina e turni guida nella forma di Fucina. Il file qui è
 * inventato (nodi, linee e codici di prova), con la stessa struttura
 * dell'esportazione vera.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import {
  FileTurniNonValido, dataIso, giorniDelFile, leggiFileTurni, testoDelFile, tipiDiGiorno, turniDelGiorno,
} from "../lib/turni-esistenti/file";
import { abbinaCorse, corseDelFile, numeroDellaCorsa, type CorsaGtfs } from "../lib/turni-esistenti/abbina";
import { costruisciTurni, kmStimati, residenzaAiTurniGuida, tipoDelMezzo, tipoDelTurno } from "../lib/turni-esistenti/costruisci";
import type { TripBlock } from "../lib/ottimizza-veicoli/modello";

const T = "\t";
const riga = (...c: (string | number)[]) => c.join(T);
/* un pezzo: tipo, linea, tm, da, partenza, a, arrivo, ripresa, verso, metri, id, idTm, percorso, corsa */
function pezzo(tipo: number, linea: string, tm: string, da: string, p: number, a: string, ar: number,
  ripresa: number, verso: string, metri: string, id: string, idTm: string, perc: string, corsa: string): string {
  return riga(tipo, linea, tm, da, p, p, a, ar, ar, ripresa, 1, "fl", verso, "NULLA", metri, id, idTm, perc, corsa, "NULLA") + "\n0";
}

const FILE = [
  "#{", "0001 BDROP InputBDROP", "#}",
  riga("01/12/2026", "31/12/2026", "1"),
  "{#TIPOPEZZI", "4",
  riga("Inlinea", 1, "TRUE"), riga("Fuorilinea", 2, "TRUE"), riga("Pre_Turno", 60, "FALSE"), riga("Riserva", 105, "FALSE"),
  "#END}",
  "{#SUPERLIVELLI", "2",
  "{#SUPERLIVELLO", riga("900", "01/12/2026", "900", "FALSE", "NULL", "Feriale   di prova"), "2",
  "{#TGUIDA", "T001", "1",
  "{#GIORNATA", riga("RESIDENZA1", "DEPX", "FALSE", 0, 98, 98, "Interi", 80, "FALSE"),
  "{#PEZZI", "4",
  pezzo(60, "fl", "-1", "DepX", 360, "DepX", 372, 0, "n", "0", "p1", "-1", "NULLA", "NULLA"),
  pezzo(2, "fl", "501", "DepX", 372, "NodoA", 380, 0, "n", "0", "p2", "9001", "NULLA", "NULLA"),
  pezzo(1, "L1", "501", "NodoA", 380, "NodoB", 410, 0, "a", "8000,5", "p3", "9001", "L1A", "700001"),
  pezzo(1, "L1", "501", "NodoB", 415, "NodoA", 445, 0, "d", "8000,5", "p4", "9001", "L1R", "700002"),
  "#END}", riga(0, "FALSE", 0), "{#INDENNITA' AGGIUNTIVE", "0", "#END}", "#END}", "#END}",
  "{#TGUIDA", "T002", "1",
  "{#GIORNATA", riga("RESIDENZA1", "DEPX", "FALSE", 0, 150, 200, "Semiunici", 90, "FALSE"),
  "{#PEZZI", "4",
  pezzo(1, "L1", "501", "NodoA", 450, "NodoB", 480, 0, "a", "8000,5", "p5", "9001", "L1A", "700003"),
  pezzo(1, "L2", "502", "NodoA", 490, "NodoC", 520, 0, "a", "5000", "p6", "9002", "L2A", "700004"),
  pezzo(105, "fl", "-1", "NodoC", 520, "NodoC", 540, 0, "n", "0", "p7", "-1", "NULLA", "NULLA"),
  pezzo(1, "L1", "501", "NodoB", 600, "NodoA", 630, 1, "d", "8000,5", "p8", "9001", "L1R", "700005"),
  "#END}", riga(0, "FALSE", 0), "{#INDENNITA' AGGIUNTIVE", "0", "#END}", "#END}", "#END}",
  "#END}",
  "{#SUPERLIVELLO", riga("901", "01/12/2026", "901", "FALSE", "NULL", "Festivo di prova"), "0", "#END}",
  "#END}",
  "{#CALENDARIO", "3", "01/12/2026 900 01/12/2026", "02/12/2026 900 02/12/2026", "06/12/2026 901 06/12/2026", "#END}",
  "{#NODI", "4", riga("DepX", "NULLA"), "Deposito di prova", riga("NodoA", "NULLA"), "Piazza A", riga("NodoB", "NULLA"), "Stazione B", riga("NodoC", "NULLA"), "Capolinea C", "#END}",
  "{#TURNI MACCHINA", "2", riga("9001", "18mi"), riga("9002", "10m"), "#END}",
].join("\r\n");

function blocco(tripId: string, linea: string, p: number, a: number, cat: "urbano" | "extraurbano" = "urbano"): TripBlock {
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  return {
    tripId, routeId: `r-${linea}`, routeName: linea, headsign: `verso ${linea}`, directionId: 0,
    departureTime: hh(p), arrivalTime: hh(a), departureMin: p, arrivalMin: a, stopCount: 10,
    firstStopId: "s1", lastStopId: "s2", firstStopLat: 1, firstStopLon: 1, lastStopLat: 1.01, lastStopLon: 1.01,
    firstStopName: "Prima", lastStopName: "Ultima", requiredVehicle: "12m", category: cat, forced: false, onDemand: false,
  };
}

/* il GTFS del progetto: 700001 e 700002 per numero, 700003 solo per linea e orario, 700004 e 700005 non ci sono; g9 senza turno */
const GTFS_BLOCCHI = [blocco("g1", "L1", 380, 410), blocco("g2", "L1", 415, 445), blocco("g3", "L1", 450, 481), blocco("g9", "L3", 700, 730)];
const GTFS: CorsaGtfs[] = [
  { tripId: "g1", codice: "X_Ab:Z1_700001", linea: "L1", partenza: 380, arrivo: 410 },
  { tripId: "g2", codice: "X_700002", linea: "L1", partenza: 415, arrivo: 445 },
  { tripId: "g3", codice: "Y_123", linea: "L1", partenza: 450, arrivo: 481 },
  { tripId: "g9", codice: "Y_124", linea: "L3", partenza: 700, arrivo: 730 },
];

describe("lettura del file dei turni", () => {
  const f = leggiFileTurni(FILE);

  it("legge periodo, insiemi, turni, pezzi, calendario, nodi e mezzi", () => {
    expect(f.dal).toBe("2026-12-01");
    expect(f.al).toBe("2026-12-31");
    expect(f.superlivelli.map((s) => [s.id, s.nome, s.turni.length])).toEqual([["900", "Feriale di prova", 2], ["901", "Festivo di prova", 0]]);
    const t1 = f.superlivelli[0]!.turni[0]!;
    expect(t1).toMatchObject({ codice: "T001", residenza: "RESIDENZA1", lavoroMin: 98, nastroMin: 98, tipo: "Interi" });
    expect(t1.pezzi).toHaveLength(4);
    expect(t1.pezzi[2]).toMatchObject({ tipo: 1, linea: "L1", turnoMacchina: "501", idTurnoMacchina: "9001", partenza: 380, arrivo: 410, metri: 8000.5, corsa: "700001", verso: "a" });
    expect(t1.pezzi[0]).toMatchObject({ tipo: 60, linea: null, turnoMacchina: null, idTurnoMacchina: null, corsa: null });
    expect(f.calendario.get("2026-12-02")).toEqual(["900"]);
    expect(f.nodi.get("NodoB")).toBe("Stazione B");
    expect(f.mezzi.get("9001")).toBe("18mi");
    expect(f.tipiPezzo.get(105)).toBe("Riserva");
  });

  it("i giorni e i tipi di giorno vengono dal calendario", () => {
    const giorni = giorniDelFile(f);
    expect(giorni.map((g) => [g.data, g.turniGuida, g.turniMacchina])).toEqual([
      ["2026-12-01", 2, 2], ["2026-12-02", 2, 2], ["2026-12-06", 0, 0],
    ]);
    const tipi = tipiDiGiorno(giorni);
    expect(tipi[0]).toMatchObject({ nomi: ["Feriale di prova"], date: ["2026-12-01", "2026-12-02"] });
    expect(turniDelGiorno(f, "2026-12-06")).toEqual([]);
  });

  it("rifiuta un file che non è dei turni o che non torna, senza mostrare il contenuto", () => {
    expect(() => leggiFileTurni("nome;cognome\nmario;rossi")).toThrow(FileTurniNonValido);
    const sbagliato = FILE.replace("{#PEZZI\r\n4\r\n", "{#PEZZI\r\n5\r\n");
    expect(() => leggiFileTurni(sbagliato)).toThrow(/attesi 5 pezzi, trovati 4/);
    const senzaCalendario = FILE.replace(/\{#CALENDARIO[\s\S]*?#END\}/, "");
    expect(() => leggiFileTurni(senzaCalendario)).toThrow(/calendario/);
    const orario = FILE.replace(riga(1, "L1", "501", "NodoA", 380, 380), riga(1, "L1", "501", "NodoA", "otto", 380));
    expect(() => leggiFileTurni(orario)).toThrow(/riga \d+: l'orario di partenza non è un numero/);
  });

  it("le date vere e basta", () => {
    expect(dataIso("29/02/2028")).toBe("2028-02-29");
    expect(dataIso("31/02/2027")).toBeNull();
    expect(dataIso("2027-01-01")).toBeNull();
  });

  it("il testo in UTF-8 o nella codifica di Windows", () => {
    expect(testoDelFile(new TextEncoder().encode("1° Maggio"))).toBe("1° Maggio");
    expect(testoDelFile(Uint8Array.from([0x31, 0xb0, 0x20, 0x4d]))).toBe("1° M");
  });
});

describe("abbinamento delle corse", () => {
  const f = leggiFileTurni(FILE);
  const turni = turniDelGiorno(f, "2026-12-01");

  it("il numero che chiude il codice", () => {
    expect(numeroDellaCorsa("9_Ab:Z1_700123")).toBe("700123");
    expect(numeroDellaCorsa("000123")).toBe("123");
    expect(numeroDellaCorsa("abc")).toBeNull();
  });

  it("prima per numero, poi per linea e orario; il resto non trovato", () => {
    const corse = corseDelFile(turni);
    expect(corse.map((c) => c.corsa).sort()).toEqual(["700001", "700002", "700003", "700004", "700005"]);
    const a = abbinaCorse(corse, GTFS);
    expect(a.perCorsa.get("700001")).toEqual({ tripId: "g1", come: "numero" });
    expect(a.perCorsa.get("700002")).toEqual({ tripId: "g2", come: "numero" });
    expect(a.perCorsa.get("700003")).toEqual({ tripId: "g3", come: "orario" });
    expect(a.nonTrovate.map((c) => c.corsa)).toEqual(["700005", "700004"]); // per linea, poi per orario
    expect([a.perNumero, a.perOrario, a.nonTrovate.length]).toEqual([2, 1, 2]);
  });

  it("una corsa del GTFS va a una sola corsa del file", () => {
    const corse = corseDelFile(turni);
    const doppio = [{ ...corse.find((c) => c.corsa === "700003")!, corsa: "800003" }, ...corse];
    const a = abbinaCorse(doppio, GTFS);
    const g3 = [...a.perCorsa.values()].filter((v) => v.tripId === "g3");
    expect(g3).toHaveLength(1);
  });
});

describe("turni macchina e turni guida", () => {
  const f = leggiFileTurni(FILE);
  const turni = turniDelGiorno(f, "2026-12-01");
  const a = abbinaCorse(corseDelFile(turni), GTFS);
  const esito = costruisciTurni({ file: f, data: "2026-12-01", turni, abbinamento: a, corseDelGiorno: GTFS_BLOCCHI, serviziAttivi: 1 });

  it("un turno macchina per mezzo con corse riconosciute, nella forma di Fucina", () => {
    const { shifts, unassigned, summary } = esito.veicoli;
    expect(shifts).toHaveLength(1); // il 502 non ha corse riconosciute
    const s = shifts[0]!;
    expect(s).toMatchObject({ vehicleId: "501", vehicleType: "autosnodato", category: "urbano", tripCount: 3, tipoOrigine: "18mi" });
    expect(s.trips.map((t) => t.type === "trip" ? t.tripId : `vuoto:${(t as any).depotLeg ?? ""}`)).toEqual(["vuoto:out", "g1", "g2", "g3"]);
    // il file non dà i km dei fuori linea: stima dalla durata (8 minuti a 20 km/h in città)
    expect(s.trips[0]).toMatchObject({ routeName: "Uscita Deposito di prova (~2.7 km)", firstStopName: "Deposito di prova", lastStopName: "Piazza A", deadheadMin: 8, deadheadKm: 2.7, kmStimati: true });
    expect(s.trips[1]).toMatchObject({ departureTime: "06:20:00", requiredVehicle: "autosnodato" });
    expect([s.startMin, s.endMin, s.totalServiceMin, s.totalDeadheadMin]).toEqual([372, 481, 91, 8]);
    expect(unassigned.map((u) => u.tripId)).toEqual(["g9"]);
    expect(summary).toMatchObject({ date: "20261201", totalVehicles: 1, totalTrips: 3, totalDeadheadKm: 2.7, byType: { autosnodato: 1 } });
    expect(esito.veicoli.costs.totalDailyCost).toBeGreaterThan(0);
  });

  it("i turni guida con riprese, cambi, attività e corse del GTFS", () => {
    const [t1, t2] = esito.guida.driverShifts;
    expect(t1).toMatchObject({ driverId: "T001", type: "intero", nastroStart: "06:00", nastroEnd: "07:25", workMin: 98, nastroMin: 98, preTurnoMin: 12, verifyState: "da_verificare", tipoOrigine: "Interi" });
    expect(t1!.riprese).toHaveLength(1);
    expect(t1!.riprese[0]!.trips.map((x: any) => [x.tripId, x.vehicleId, x.vehicleType])).toEqual([["g1", "501", "autosnodato"], ["g2", "501", "autosnodato"]]);
    expect(t1!.riprese[0]!.deadheads[0]).toMatchObject({ kind: "pullout", fromStop: "Deposito di prova", toStop: "Piazza A", minutes: 8, km: 2.7 });
    expect(t1!.riprese[0]!.preTurnoKind).toBe("bus");

    expect(t2).toMatchObject({ driverId: "T002", type: "semiunico", interruptionMin: 60, cambiCount: 1 });
    expect(t2!.riprese).toHaveLength(2);
    expect(t2!.riprese[0]!.cambi[0]).toMatchObject({ clusterName: "Piazza A", fromVehicle: "501", toVehicle: "502", atTime: "08:10" });
    expect(t2!.riprese[0]!.trips.map((x: any) => x.tripId)).toEqual(["g3"]);
    expect(t2!.activities).toEqual([{ id: "file-p7", type: "riserva", startMin: 520, endMin: 540, note: "Riserva" }]);
    expect(esito.guida.summary).toMatchObject({ totalShifts: 2, totalDriverShifts: 2, byType: { intero: 1, semiunico: 1 } });
  });

  it("il resoconto dice che cosa resta fuori", () => {
    expect(esito.resoconto).toEqual({
      turniGuida: 2, turniMacchina: 1, corseNelFile: 5, riconosciutePerNumero: 2, riconosciutePerOrario: 1,
      nonTrovate: 2, corseDelGtfsSenzaTurno: 1, turniMacchinaVuoti: 1, pezziSenzaCorsa: 2,
    });
  });

  it("la residenza del turno macchina passa al turno guida", () => {
    const shifts = esito.veicoli.shifts.map((s) => ({ ...s, residenzaDepotId: "d1", residenzaName: "Deposito 1", residenzaColor: "#123456" }));
    const guida = structuredClone(esito.guida);
    residenzaAiTurniGuida(guida, shifts);
    expect(guida.driverShifts.map((d: any) => d.residenzaName)).toEqual(["Deposito 1", "Deposito 1"]);
  });
});

describe("tipi di mezzo e di turno", () => {
  it("il mezzo dalla lunghezza scritta nel codice", () => {
    expect(["18mi", "18m", "12m", "12mi", "12ms", "10m", "9ms", "Filobus", "Pollicino", "Alè", null].map(tipoDelMezzo))
      .toEqual(["autosnodato", "autosnodato", "12m", "12m", "12m", "10m", "pollicino", "12m", "pollicino", "pollicino", "12m"]);
  });

  it("i km stimati di un fuori linea", () => {
    expect(kmStimati(30, "urbano")).toBe(10);
    expect(kmStimati(30, "extraurbano")).toBe(20);
    expect(kmStimati(0, "urbano")).toBe(0);
  });

  it("il turno dal nome del file, o dalla sua forma", () => {
    expect(tipoDelTurno("Interi", 1, 0)).toBe("intero");
    expect(tipoDelTurno("Semiunici", 2, 100)).toBe("semiunico");
    expect(tipoDelTurno("Spezzati3h", 2, 200)).toBe("spezzato");
    expect(tipoDelTurno("Supplement", 1, 0)).toBe("supplemento");
    expect(tipoDelTurno("PartTime", 1, 0)).toBe("intero");
    expect(tipoDelTurno("Altri", 2, 240)).toBe("spezzato");
    expect(tipoDelTurno(null, 2, 60)).toBe("semiunico");
  });
});
