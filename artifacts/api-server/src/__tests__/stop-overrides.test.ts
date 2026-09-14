/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Correzioni alla transcodifica e deduzione dai dati — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Tre cose pure: come le correzioni si sovrappongono al file, i suggerimenti
 * per nome, e la fermata dedotta dai passaggi dello StopMonitoring senza
 * guardare nessun nome. Il caso vero: 1122 ↔ 20045, con le corse C e CR3
 * del 14 settembre 2026.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import { applicaOverrides, suggerimentiPerNome, leggiTranscodificaCompleta, classificaAbbinamenti } from "../lib/stop-aliases";
import { deduciFermata } from "../lib/stop-deduction";
import { parseStopMonitoringResponse, type RigaOrario } from "../lib/siri-fermata";
import { namesCompatible } from "../lib/siri-vm";

const CSV = `mizar_ref,stop_id,nome
1122,20045,ANCONA (Via Marconi Gas)
200,20001,"Piazza Cavour (Conerobus Linee Nord)"
461,20928,OSIMO (Capolinea)
5102,new_CT,"FABRIANO (Via Dante, 39)"
`;

describe("applicaOverrides", () => {
  const { valide, scartate } = leggiTranscodificaCompleta(CSV);
  it("sostituisce, toglie, aggiunge; e marca la fonte", () => {
    const r = applicaOverrides(valide, scartate, [
      { mizarRef: "461", stopId: "20999", nome: null, nota: "banchina spostata", utente: "s@x.it" },   // sostituisce
      { mizarRef: "1122", stopId: null, nome: null, nota: "palina dismessa", utente: "s@x.it" },       // toglie
      { mizarRef: "5102", stopId: "20777", nome: null, nota: "codificata a mano", utente: "s@x.it" },  // codifica una senza codice
      { mizarRef: "9999", stopId: "20555", nome: "Nuova palina", nota: null, utente: null },            // aggiunge
    ]);
    const v = Object.fromEntries(r.valide.map(x => [x.mizarRef, x]));
    expect(v["461"]).toMatchObject({ stopId: "20999", nome: "OSIMO (Capolinea)", fonte: "manuale", nota: "banchina spostata", utente: "s@x.it" });
    expect(v["200"]).toMatchObject({ stopId: "20001", fonte: "file" });
    expect(v["5102"]).toMatchObject({ stopId: "20777", nome: "FABRIANO (Via Dante, 39)", fonte: "manuale" });
    expect(v["9999"]).toMatchObject({ stopId: "20555", nome: "Nuova palina", fonte: "manuale" });
    expect(v["1122"]).toBeUndefined();
    expect(r.scartate).toEqual([{ mizarRef: "1122", nome: "ANCONA (Via Marconi Gas)", stopIdGrezzo: "", fonte: "manuale", nota: "palina dismessa", utente: "s@x.it" }]);
  });
  it("senza correzioni restituisce il file com'è", () => {
    expect(applicaOverrides(valide, scartate, [])).toEqual({ valide, scartate });
  });
  it("la classificazione porta fonte e nota fino alla riga", () => {
    const r = applicaOverrides(valide, scartate, [{ mizarRef: "461", stopId: "20999", nome: null, nota: "spostata", utente: "s@x.it" }]);
    const a = classificaAbbinamenti(r.valide, r.scartate, { stops: new Set(["20999", "20045", "20001"]), stopNames: new Map([["20999", "OSIMO (CAPOLINEA)"]]) }, { refs: [] }, namesCompatible);
    expect(a.righe.find(x => x.mizarRef === "461")).toMatchObject({ stato: "abbinata", fonte: "manuale", nota: "spostata", utente: "s@x.it" });
    expect(a.righe.find(x => x.mizarRef === "200")).toMatchObject({ fonte: "file", nota: null });
  });
});

describe("suggerimentiPerNome", () => {
  const feed = {
    stops: new Set(["1", "2", "3", "4"]),
    stopNames: new Map([["1", "OSIMO (CAPOLINEA)"], ["2", "Osimo Capolinea Nord"], ["3", "ANCONA STAZIONE"], ["4", "Osimo"]]),
  };
  it("prima lo stesso nome, poi i nomi che lo contengono; esclude la fermata già abbinata", () => {
    const s = suggerimentiPerNome("OSIMO (Capolinea)", feed);
    expect(s.map(x => [x.stopId, x.motivo])).toEqual([["1", "stesso_nome"], ["2", "nome_contenuto"]]);
    expect(suggerimentiPerNome("OSIMO (Capolinea)", feed, "1").map(x => x.stopId)).toEqual(["2"]);
  });
  it("niente da nomi troppo corti o vuoti", () => {
    expect(suggerimentiPerNome("Osi", feed)).toEqual([]);
    expect(suggerimentiPerNome(null, feed)).toEqual([]);
  });
});

const SM = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<GetStopMonitoringResponse xmlns="http://www.siri.org.uk/siri"><Answer xmlns="">
<StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri" version="1.4"><Status>true</Status>
${[["C", "369662", "11:12:00"], ["N", "455471", "11:13:00"], ["CR3", "454461", "11:48:08"], ["FSRV", "FRSRV1", "11:20:00"]].map(([l, c, t]) => `
<MonitoredStopVisit><RecordedAtTime>2026-09-14T00:00:00</RecordedAtTime><MonitoringRef>1122</MonitoringRef>
 <MonitoredVehicleJourney><LineRef>${l}</LineRef><CourseOfJourneyRef>${c}</CourseOfJourneyRef><Monitored>false</Monitored>
  <MonitoredCall><StopPointRef>1122</StopPointRef><AimedDepartureTime>2026-09-14T${t}+02:00</AimedDepartureTime></MonitoredCall>
 </MonitoredVehicleJourney></MonitoredStopVisit>`).join("")}
</StopMonitoringDelivery></Answer></GetStopMonitoringResponse></s:Body></s:Envelope>`;

describe("deduciFermata", () => {
  const visite = parseStopMonitoringResponse(SM).visite;
  const tripByCode = new Map([["369662", "T_C"], ["455471", "T_N"], ["454461", "T_CR3"]]);
  const orari = (): Map<string, RigaOrario[]> => new Map([
    ["T_C",   [{ stopId: "20001", seq: 1, scheduled: "10:30:00" }, { stopId: "20045", seq: 39, scheduled: "11:12:00" }]],
    ["T_N",   [{ stopId: "20928", seq: 1, scheduled: "10:30:00" }, { stopId: "20045", seq: 31, scheduled: "11:13:00" }]],
    ["T_CR3", [{ stopId: "323", seq: 1, scheduled: "11:00:00" }, { stopId: "20045", seq: 26, scheduled: "11:48:09" }, { stopId: "20046", seq: 27, scheduled: "11:48:40" }]],
  ]);
  it("trova lo stop_id che tutte le corse servono a quell'orario, senza nomi", () => {
    const d = deduciFermata(visite, tripByCode, orari(), "Europe/Rome");
    expect(d.passaggiUtili).toBe(3);   // il fuori servizio non conta
    expect(d.candidati[0]).toMatchObject({ stopId: "20045", prove: 3 });
    expect(d.candidati[1]).toMatchObject({ stopId: "20046", prove: 1 });   // 32 s dopo: entro la tolleranza, ma una prova sola
    expect(d.suggerito).toBe("20045");
    expect(d.lettura).toMatch(/3 passaggi su 3 coincidono con lo stop_id 20045/);
  });
  it("con due candidati alla pari non suggerisce", () => {
    const o = orari();
    o.set("T_N", [{ stopId: "20046", seq: 31, scheduled: "11:13:00" }]);
    /* due banchine servite entro un minuto dalla stessa corsa: 2 prove a testa */
    o.set("T_CR3", [{ stopId: "20045", seq: 26, scheduled: "11:48:09" }, { stopId: "20046", seq: 27, scheduled: "11:48:20" }]);
    const d = deduciFermata(visite, tripByCode, o, "Europe/Rome");
    expect(d.suggerito).toBeNull();
    expect(d.lettura).toMatch(/Candidati con prove simili/);
  });
  it("senza corse agganciate lo dice", () => {
    const d = deduciFermata(visite, new Map(), orari(), "Europe/Rome");
    expect(d.passaggiUtili).toBe(0);
    expect(d.suggerito).toBeNull();
    expect(d.lettura).toMatch(/Nessun passaggio di linea agganciato/);
  });
});
