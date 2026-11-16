/**
 * I turni nel programmato (tappa 4.3): la funzione che collega le corse della
 * giornata ai turni pubblicati, senza database.
 */
import { describe, it, expect } from "vitest";
import { collegaTurni, orario, CHIAVE_CANALE, type LetturaTurni, type RigaDelCanale, type CorsaDaCollegare } from "../lib/esercizio-turni";
import { CHIAVE_CANALE as CHIAVE_DELLA_PUBBLICAZIONE } from "../lib/roster-pubblicazione-db";

const riga = (x: Partial<RigaDelCanale> = {}): RigaDelCanale => ({
  udpId: "udp-1", udpNome: "Feriale", dssId: "dss-1", dssNome: "Turni guida", vssId: "vss-1", vssNome: "Turni macchina",
  progettoId: "prog-1", dssSuperato: false, dssDatiSuperati: false, vssSuperato: false, depositoId: null, deposito: null, ...x,
});
const corsa = (chiave: string, codice: string | null = null): CorsaDaCollegare => ({ chiave, codice, linea: "1", partenza: "07:00:00" });
const lettura = (x: Partial<LetturaTurni> = {}): LetturaTurni => ({
  istante: "2032-03-01T02:00:00.000Z", canale: [riga()], turniMacchina: [], corseGuida: [],
  scoperteDelCalcolo: new Map(), kmRiepilogo: new Map(), corseUdp: new Map(), codiceDi: new Map(), ...x,
});
const trip = (id: string, p: number, a: number) => ({ tipo: "trip", tripId: id, partenza: p, arrivo: a, km: null, da: null, a: null, lato: null });
const vuoto = (p: number, a: number, km: number, lato: string | null = null) => ({ tipo: "deadhead", tripId: null, partenza: p, arrivo: a, km, da: "Deposito", a: "Stazione", lato });

describe("collegaTurni", () => {
  it("ogni corsa col suo turno macchina, turno guida e deposito; i vuoti del turno con i km del calcolo", () => {
    const e = collegaTurni([corsa("t1"), corsa("t2"), corsa("t3")], lettura({
      turniMacchina: [{
        vssId: "vss-1", codice: "M1", tipoMezzo: "12m", depositoId: "dep-1", deposito: "Tavernelle", kmVuoto: 7.5, inizio: 400, fine: 600,
        voci: [vuoto(400, 415, 3.2, "out"), trip("t1", 420, 450), { tipo: "depot", tripId: null, partenza: 460, arrivo: 500, km: null, da: "Stazione", a: "Stazione", lato: null }, trip("t2", 510, 540), vuoto(540, 560, 2.1, "in")],
      }],
      corseGuida: [{ dssId: "dss-1", codice: "G7", tripId: "t1", vettura: "M1" }, { dssId: "dss-1", codice: "G8", tripId: "t2", vettura: "M1" }],
      kmRiepilogo: new Map([["vss-1", 7.5]]),
      corseUdp: new Map([["udp-1", ["t1", "t2", "t3"]]]),
    }), "prog-1");
    expect(e.perCorsa.get("t1")).toEqual({ udpId: "udp-1", dssId: "dss-1", vssId: "vss-1", turnoMacchina: "M1", turnoGuida: "G7", deposito: "Tavernelle", depositoId: "dep-1" });
    expect(e.perCorsa.get("t2")).toMatchObject({ turnoMacchina: "M1", turnoGuida: "G8" });
    expect(e.perCorsa.get("t3")).toBeUndefined();
    expect(e.turniMacchina).toEqual([expect.objectContaining({
      vssId: "vss-1", turnoMacchina: "M1", dssId: "dss-1", udpId: "udp-1", deposito: "Tavernelle", tipoMezzo: "12m",
      uscita: "06:40", rientro: "09:20", corse: 2, corseNelGiorno: 2, kmVuotoProg: 7.5,
    })]);
    // il rientro intermedio in deposito non ha km sulla voce: i km del turno vengono dal suo totale
    expect(e.turniMacchina[0]!.vuoti.map((v) => [v.tipo, v.km])).toEqual([["uscita", 3.2], ["deposito", null], ["rientro", 2.1]]);
    expect(e.riepilogo).toMatchObject({
      pubblicato: true, altroProgramma: 0, corse: 3, conTurnoMacchina: 2, conTurnoGuida: 2, turniMacchina: 1, turniGuida: 2,
      scoperte: { senzaTurnoMacchina: 1, fuoriUdp: 0, scoperteNelCalcolo: 0, nonNelCalcolo: 1, senzaTurnoGuida: 0 },
      kmVuoto: { turni: 7.5, riepilogo: 7.5 },
    });
    expect(e.avvisi).toEqual(["1 corse senza turno macchina (1 non comprese nel calcolo)."]);
  });

  it("le corse si riconoscono anche per codice stabile, con turni calcolati su un feed precedente", () => {
    const e = collegaTurni([corsa("nuovo-1", "689_A_1"), corsa("nuovo-2", "689_A_1"), corsa("nuovo-3", "689_A_3")], lettura({
      turniMacchina: [{ vssId: "vss-1", codice: "M1", tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: 0, inizio: null, fine: null,
        voci: [trip("vecchio-1", 420, 450), trip("vecchio-3", 500, 530), trip("altrove", 600, 630)] }],
      codiceDi: new Map([["vecchio-1", "689_A_1"], ["vecchio-3", "689_A_3"]]),
    }), "prog-1");
    // un codice ripetuto nella giornata non riconosce niente: meglio scoperta che sulla corsa sbagliata
    expect(e.perCorsa.get("nuovo-1")).toBeUndefined();
    expect(e.perCorsa.get("nuovo-3")).toMatchObject({ turnoMacchina: "M1" });
    expect(e.riepilogo.corseDeiTurniFuoriProgramma).toEqual({ quante: 2, esempi: ["vecchio-1", "altrove"] });
    expect(e.turniMacchina[0]).toMatchObject({ corse: 3, corseNelGiorno: 1 });
  });

  it("le scoperte e perché: fuori UDP, lasciate scoperte dal calcolo, senza turno guida", () => {
    const e = collegaTurni([corsa("a"), corsa("b"), corsa("c"), corsa("d")], lettura({
      turniMacchina: [{ vssId: "vss-1", codice: "M1", tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: 0, inizio: null, fine: null, voci: [trip("a", 1, 2)] }],
      scoperteDelCalcolo: new Map([["vss-1", ["b"]]]),
      corseUdp: new Map([["udp-1", ["a", "b", "c"]]]),
    }), "prog-1");
    expect(e.riepilogo.scoperte).toMatchObject({ senzaTurnoMacchina: 3, fuoriUdp: 1, scoperteNelCalcolo: 1, nonNelCalcolo: 1, senzaTurnoGuida: 1 });
    expect(e.riepilogo.scoperte.esempi.map((x) => [x.trip, x.motivo])).toEqual([
      ["b", "scoperta_nel_calcolo"], ["c", "non_nel_calcolo"], ["d", "fuori_udp"], ["a", "senza_turno_guida"]]);
    expect(e.avvisi.join(" ")).toMatch(/3 corse senza turno macchina \(1 fuori dalle UDP pubblicate, 1 lasciate scoperte dal calcolo dei turni macchina, 1 non comprese nel calcolo\)/);
    expect(e.avvisi.join(" ")).toMatch(/1 corse con il turno macchina ma senza turno guida/);
  });

  it("un'UDP che non c'è più: fuori UDP non si sa, non si inventa", () => {
    const e = collegaTurni([corsa("a")], lettura({ corseUdp: new Map([["udp-1", null]]) }), "prog-1");
    expect(e.riepilogo.scoperte).toMatchObject({ senzaTurnoMacchina: 1, fuoriUdp: null, nonNelCalcolo: 1 });
  });

  it("niente pubblicato: nessun turno, un avviso; turni superati, programma diverso e km che non tornano si dicono", () => {
    const vuota = collegaTurni([corsa("a")], lettura({ canale: [] }), "prog-1");
    expect(vuota.riepilogo).toMatchObject({ pubblicato: false, corse: 1, conTurnoMacchina: 0, scoperte: { senzaTurnoMacchina: 1, fuoriUdp: null, esempi: [] } });
    expect(vuota.avvisi).toEqual(["Nessun turno pubblicato per la giornata: le corse non hanno turno macchina né turno guida."]);
    expect(collegaTurni([], lettura({ canale: [] }), null).avvisi).toEqual([]);

    const e = collegaTurni([corsa("a")], lettura({
      canale: [riga({ dssSuperato: true, dssDatiSuperati: true, vssSuperato: true, progettoId: "altro" })],
      turniMacchina: [{ vssId: "vss-1", codice: "M1", tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: 10, inizio: null, fine: null, voci: [trip("a", 1, 2)] }],
      corseGuida: [{ dssId: "dss-1", codice: "G1", tripId: "a", vettura: "M9" }],
      kmRiepilogo: new Map([["vss-1", 12]]),
    }), "prog-1");
    expect(e.riepilogo).toMatchObject({ altroProgramma: 1, vettureDiverse: 1, kmVuoto: { turni: 10, riepilogo: 12 } });
    const testo = e.avvisi.join(" ");
    expect(testo).toMatch(/turni guida pubblicati di 1 UDP hanno una versione più nuova/);
    expect(testo).toMatch(/calcolati su dati poi cambiati/);
    expect(testo).toMatch(/turni macchina pubblicati di 1 UDP hanno una versione più nuova/);
    expect(testo).toMatch(/programma diverso da quello in esercizio/);
    expect(testo).toMatch(/vettura diversa dal loro turno macchina/);
    expect(testo).toMatch(/km a vuoto dei turni macchina \(10\) non tornano col riepilogo salvato del calcolo \(12\)/);
  });

  it("i km salvati arrotondati al decimo per turno non fanno scattare l'avviso", () => {
    const tm = (codice: string, km: number) => ({ vssId: "vss-1", codice, tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: km, inizio: null, fine: null, voci: [] });
    const e = collegaTurni([], lettura({ turniMacchina: [tm("M1", 1.1), tm("M2", 1.1), tm("M3", 1.1)], kmRiepilogo: new Map([["vss-1", 3.2]]) }), "prog-1");
    expect(e.riepilogo.kmVuoto).toEqual({ turni: 3.3, riepilogo: 3.2 });
    expect(e.avvisi).toEqual([]);
  });

  it("doppie coperture e codici ripetuti: vale il primo, nessun turno si perde", () => {
    const tm = (vss: string, codice: string, ids: string[]) => ({ vssId: vss, codice, tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: 0, inizio: null, fine: null, voci: ids.map((id, i) => trip(id, i, i + 1)) });
    const e = collegaTurni([corsa("a"), corsa("b")], lettura({
      canale: [riga(), riga({ udpId: "udp-2", dssId: "dss-2", vssId: "vss-2" })],
      turniMacchina: [tm("vss-1", "M1", ["a"]), tm("vss-1", "M1", ["b"]), tm("vss-2", "X1", ["a"])],
      corseGuida: [{ dssId: "dss-1", codice: "G1", tripId: "a", vettura: null }, { dssId: "dss-2", codice: "G2", tripId: "a", vettura: null }],
    }), "prog-1");
    expect(e.turniMacchina.map((t) => t.turnoMacchina)).toEqual(["M1", "M1#2", "X1"]);
    expect(e.perCorsa.get("a")).toMatchObject({ vssId: "vss-1", turnoMacchina: "M1", turnoGuida: "G1", dssId: "dss-1" });
    expect(e.perCorsa.get("b")).toMatchObject({ turnoMacchina: "M1#2" });
    expect(e.riepilogo).toMatchObject({ doppie: { macchina: 1, guida: 1 }, codiciRipetuti: 1 });
  });

  it("il deposito dei turni macchina vale per i turni che non ne dicono uno", () => {
    const e = collegaTurni([corsa("a")], lettura({
      canale: [riga({ depositoId: "dep-9", deposito: "Torrette" })],
      turniMacchina: [{ vssId: "vss-1", codice: "M1", tipoMezzo: null, depositoId: null, deposito: null, kmVuoto: 0, inizio: null, fine: null, voci: [trip("a", 1, 2)] }],
    }), null);
    expect(e.perCorsa.get("a")).toMatchObject({ deposito: "Torrette", depositoId: "dep-9" });
    expect(e.riepilogo.altroProgramma).toBeNull();
  });

  it("orari oltre le 24 e valori che non sono orari", () => {
    expect(orario(1450)).toBe("24:10");
    expect(orario(0)).toBe("00:00");
    expect(orario(null)).toBeNull();
    expect(orario(-5)).toBeNull();
  });

  it("il lucchetto del canale è lo stesso della pubblicazione", () => {
    expect(CHIAVE_CANALE).toBe(CHIAVE_DELLA_PUBBLICAZIONE);
  });
});
