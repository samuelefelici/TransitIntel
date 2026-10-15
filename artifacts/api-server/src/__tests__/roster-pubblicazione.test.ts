import { describe, it, expect } from "vitest";
import {
  doppieCoperture, firmaTurno, giorniDelPeriodo, normData, pianoCanale, ricollega, rimappaCoppie,
  type DaRicollegare, type RigaCanale,
} from "../lib/roster-pubblicazione";

const corsa = (linea: string, parte: number, arriva: number, da = "A", a = "B", tripId = `${linea}-${parte}`) =>
  ({ type: "trip", tripId, routeName: linea, departureMin: parte, arrivalMin: arriva, firstStopName: da, lastStopName: a });
const turno = (codice: string, s: number, e: number, corse: any[] = [], residenzaName = "Ancona") =>
  ({ driverId: codice, nastroStartMin: s, nastroEndMin: e, residenzaName, riprese: [{ trips: corse }] });

describe("date e periodi", () => {
  it("date delle UDP in due formati; giorni del periodo", () => {
    expect(normData("2026-11-03")).toBe("2026-11-03");
    expect(normData("20261103")).toBe("2026-11-03");
    expect(normData("3/11/2026")).toBeNull();
    expect(giorniDelPeriodo("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("il piano del canale", () => {
  const udp = [
    { id: "feriale", nome: "Feriale", date: ["2026-11-02", "2026-11-03", "20261104"] },
    { id: "festivo", nome: "Festivo", date: ["2026-11-08"] },
    { id: "extra", nome: "Extraurbano feriale", date: ["2026-11-02", "2026-11-03"] },
  ];
  const attuali: RigaCanale[] = [
    { day: "2026-11-02", udpId: "feriale", dssId: "vecchio", psProjectId: "P" },
    { day: "2026-11-05", udpId: "feriale", dssId: "vecchio", psProjectId: "P" },
    { day: "2026-11-03", udpId: "altra", dssId: "altro", psProjectId: "Q" },
  ];

  it("nei giorni con almeno un'UDP scelta il canale diventa quelle righe; gli altri restano", () => {
    const p = pianoCanale({ psProjectId: "P", udp, scelte: { feriale: "nuovo", festivo: "fest", extra: null }, dal: "2026-11-02", al: "2026-11-08", attuali });
    expect(p.giorniToccati).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-08"]);
    expect(p.nuove.map(r => `${r.day}:${r.udpId}:${r.dssId}`)).toEqual([
      "2026-11-02:feriale:nuovo", "2026-11-03:feriale:nuovo", "2026-11-04:feriale:nuovo", "2026-11-08:festivo:fest",
    ]);
    /* si sostituiscono anche le righe di un altro programma, nei giorni toccati */
    expect(p.tolte.map(r => `${r.day}:${r.dssId}`).sort()).toEqual(["2026-11-02:vecchio", "2026-11-03:altro"]);
    expect(p.giorniSenzaUdp).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
    /* il 5 era pubblicato e nessuna UDP scelta ha la data: resta com'è */
    expect(p.giorniSenzaUdpPubblicati).toEqual(["2026-11-05"]);
  });

  it("due UDP lo stesso giorno (urbano ed extraurbano) stanno insieme", () => {
    const p = pianoCanale({ psProjectId: "P", udp, scelte: { feriale: "u", extra: "e" }, dal: "2026-11-02", al: "2026-11-02", attuali: [] });
    expect(p.nuove.map(r => r.udpId).sort()).toEqual(["extra", "feriale"]);
  });
});

describe("la firma di un turno", () => {
  it("contano linee, orari e capolinea, non gli id delle corse né il codice", () => {
    const a = firmaTurno(turno("A001", 300, 700, [corsa("1", 320, 360, "X", "Y", "id-vecchio"), corsa("2", 400, 450)]));
    const b = firmaTurno({ ...turno("A007", 300, 700, [corsa("2", 400, 450), corsa("1", 320, 360, "X", "Y", "id-nuovo")]), driverId: "A007" });
    expect(a.firma).toBe(b.firma);
    expect(a.corse).toHaveLength(2);
    expect(firmaTurno(turno("A001", 300, 710, [corsa("1", 320, 360, "X", "Y")])).firma).not.toBe(a.firma);
  });

  it("senza corse: orari e residenza; senza orari: niente firma", () => {
    expect(firmaTurno(turno("R1", 300, 700, [], "Ancona")).firma).toBe("R|Ancona|300|700");
    expect(firmaTurno(turno("R1", 300, 700, [], "Jesi")).firma).not.toBe(firmaTurno(turno("R1", 300, 700, [], "Ancona")).firma);
    expect(firmaTurno({ driverId: "X" }).firma).toBeNull();
  });
});

describe("il ricollegamento", () => {
  const f = (s: string) => `C|${s}`;
  const turni = new Map([
    ["nuovo", [
      { dssId: "nuovo", codice: "A001", firma: f("mattina") },
      { dssId: "nuovo", codice: "A002", firma: f("pomeriggio") },
      { dssId: "nuovo", codice: "A003", firma: f("pomeriggio") },
      { dssId: "nuovo", codice: "R01", firma: "R|Ancona|300|700" },
    ]],
    ["extra", [{ dssId: "extra", codice: "E001", firma: f("mattina") }]],
  ]);
  const ass = (id: string, codice: string, firma: string | null, udpPrima: string | null = "feriale"): DaRicollegare =>
    ({ id, day: "2026-11-02", dssId: "vecchio", codice, firma, udpPrima });

  it("stesso contenuto con un altro codice: passa al turno nuovo; prima la stessa UDP", () => {
    const e = ricollega({
      assegnazioni: [ass("a1", "A005", f("mattina"))],
      pubblicati: new Map([["2026-11-02", [{ udpId: "extra", dssId: "extra" }, { udpId: "feriale", dssId: "nuovo" }]]]),
      turni, occupati: new Set(),
    });
    expect(e.spostamenti).toEqual([{ id: "a1", day: "2026-11-02", dssId: "nuovo", codice: "A001", udpId: "feriale", daDss: "vecchio", daCodice: "A005" }]);
    expect(e.restano).toEqual([]);
  });

  it("due candidati uguali: a parità, lo stesso codice; altrimenti ambiguo", () => {
    const pubblicati = new Map([["2026-11-02", [{ udpId: "feriale", dssId: "nuovo" }]]]);
    const stesso = ricollega({ assegnazioni: [ass("a1", "A003", f("pomeriggio"))], pubblicati, turni, occupati: new Set() });
    expect(stesso.spostamenti[0]!.codice).toBe("A003");
    const ambiguo = ricollega({ assegnazioni: [ass("a1", "A009", f("pomeriggio"))], pubblicati, turni, occupati: new Set() });
    expect(ambiguo.restano).toEqual([{ id: "a1", day: "2026-11-02", motivo: "ambiguo" }]);
  });

  it("un turno già assegnato non si usa due volte; senza turno uguale si resta da riassegnare", () => {
    const pubblicati = new Map([["2026-11-02", [{ udpId: "feriale", dssId: "nuovo" }]]]);
    const e = ricollega({
      assegnazioni: [ass("a1", "A001", f("mattina")), ass("a2", "Z", f("sera")), ass("a3", "Y", null)],
      pubblicati, turni, occupati: new Set(["nuovo|2026-11-02|A001"]),
    });
    expect(e.spostamenti).toEqual([]);
    expect(e.restano.map(r => `${r.id}:${r.motivo}`).sort()).toEqual(["a1:nessun turno uguale", "a2:nessun turno uguale", "a3:turno illeggibile"]);
  });

  it("l'esito non dipende dall'ordine dei codici: chi era ambiguo prende il turno rimasto", () => {
    /* prima R1 e R2 uguali; dopo R2 e R3 (R1 rinumerato): R2 resta a chi l'aveva, R3 all'altro */
    const turni2 = new Map([["nuovo", [
      { dssId: "nuovo", codice: "R2", firma: "R|Ancona|300|700" },
      { dssId: "nuovo", codice: "R3", firma: "R|Ancona|300|700" },
    ]]]);
    const e = ricollega({
      assegnazioni: [ass("x", "R1", "R|Ancona|300|700"), ass("y", "R2", "R|Ancona|300|700")],
      pubblicati: new Map([["2026-11-02", [{ udpId: "feriale", dssId: "nuovo" }]]]),
      turni: turni2, occupati: new Set(),
    });
    expect(e.spostamenti.map(s => `${s.id}:${s.codice}`).sort()).toEqual(["x:R3", "y:R2"]);
    expect(e.restano).toEqual([]);
  });

  it("i turni senza corse si ricollegano solo nella stessa UDP", () => {
    const pubblicati = new Map([["2026-11-02", [{ udpId: "feriale", dssId: "nuovo" }]]]);
    expect(ricollega({ assegnazioni: [ass("r", "R09", "R|Ancona|300|700", "feriale")], pubblicati, turni, occupati: new Set() }).spostamenti[0]!.codice).toBe("R01");
    expect(ricollega({ assegnazioni: [ass("r", "R09", "R|Ancona|300|700", "altra")], pubblicati, turni, occupati: new Set() }).restano[0]!.motivo).toBe("nessun turno uguale");
    expect(ricollega({ assegnazioni: [ass("r", "R09", "R|Ancona|300|700", null)], pubblicati, turni, occupati: new Set() }).restano).toHaveLength(1);
  });
});

describe("forzature e doppie coperture", () => {
  it("le coppie forzate seguono i turni spostati", () => {
    const mappa = new Map([["vecchio|2026-11-02|A005", "nuovo|2026-11-02|A001"]]);
    expect(rimappaCoppie([
      "riposo|vecchio|2026-11-01|A004|vecchio|2026-11-02|A005",
      "sovrapposizione|x|2026-11-02|B1|y|2026-11-02|B2",
      "rotta",
    ], mappa)).toEqual([
      "riposo|vecchio|2026-11-01|A004|nuovo|2026-11-02|A001",
      "sovrapposizione|x|2026-11-02|B1|y|2026-11-02|B2",
      "rotta",
    ]);
  });

  it("le corse in due turni pubblicati lo stesso giorno si segnalano, raggruppando i giorni", () => {
    const corse = new Map([
      ["u", [["1|300|330|A|B", "1|400|430|B|A"], ["2|500|530|A|C"]]],
      ["misto", [["1|300|330|A|B"]]],
      ["e", [["X|600|700|D|E"]]],
    ]);
    const d = doppieCoperture(new Map([
      ["2026-11-02", ["u", "misto"]], ["2026-11-03", ["misto", "u"]], ["2026-11-04", ["u", "e"]],
    ]), corse);
    expect(d).toEqual([{ giorni: ["2026-11-02", "2026-11-03"], dss: ["misto", "u"], corse: 1, esempio: "1|300|330|A|B" }]);
  });
});
