import { describe, it, expect } from "vitest";
import {
  chiaveTurno, durata, intervalloDaSnapshot, intervalloTurno, istante, minutiDa, quando,
  riposoMinimo, violazioniDelConducente, violazioniDeiTurni, perIlClient, type TurnoNelTempo,
} from "../lib/roster-normativa";
import { propostaServizio } from "../lib/udp-servizio";
import { servizioDellaLinea } from "../lib/reti-linee";
import type { Servizio } from "../lib/udp-servizio";

/** Un turno di prova: giorno, «HH:MM» di inizio e fine (anche oltre le 24), tipo di servizio. */
function turno(codice: string, giorno: string, dalle: string, alle: string, servizio: Servizio | null = "urbano", conducenteId = "c1"): TurnoNelTempo {
  return {
    chiave: chiaveTurno("dss", giorno, codice), assegnazioneId: codice, conducenteId, giorno, codice, dssId: "dss",
    inizio: istante(giorno, minutiDa(dalle)!), fine: istante(giorno, minutiDa(alle)!), servizio, servizioDa: servizio ? "udp" : null, coppieForzate: [],
  };
}

describe("tempi dei turni", () => {
  it("legge minuti e orari, anche oltre la mezzanotte e negativi", () => {
    expect(minutiDa(345)).toBe(345);
    expect(minutiDa("05:45")).toBe(345);
    expect(minutiDa("7:05")).toBe(425);
    expect(minutiDa("25:10")).toBe(1510);
    expect(minutiDa("25:10:30")).toBe(1510);
    expect(minutiDa("-1:50")).toBe(-110);
    expect(minutiDa("12:75")).toBeNull();
    expect(minutiDa("ieri")).toBeNull();
    expect(minutiDa(null)).toBeNull();
  });

  it("intervallo del turno: prima i minuti del nastro, poi riprese, stringhe, corse; le attività allargano", () => {
    expect(intervalloTurno({ nastroStartMin: -10, nastroStart: "00:00", nastroEndMin: 700, nastroEnd: "11:40" })).toEqual({ inizio: -10, fine: 700 });
    expect(intervalloTurno({ nastroStartMin: 1080, nastroEndMin: 1510, nastroEnd: "25:10" })).toEqual({ inizio: 1080, fine: 1510 });
    /* più di 24 ore non è un turno: non si controlla */
    expect(intervalloTurno({ nastroStartMin: -10, nastroEndMin: 1510 })).toBeNull();
    expect(intervalloTurno({ riprese: [{ startMin: 300, endMin: 600 }, { startMin: 900, endMin: 1200 }] })).toEqual({ inizio: 300, fine: 1200 });
    expect(intervalloTurno({ nastroStart: "06:05", nastroEnd: "12:40" })).toEqual({ inizio: 365, fine: 760 });
    expect(intervalloTurno({ riprese: [{ trips: [{ departureTime: "07:00:00", arrivalTime: "07:40:00" }, { departureMin: 500, arrivalMin: 560 }] }] }))
      .toEqual({ inizio: 420, fine: 560 });
    expect(intervalloTurno({ nastroStartMin: 400, nastroEndMin: 700, activities: [{ startMin: 380, endMin: 720 }] })).toEqual({ inizio: 380, fine: 720 });
    /* vecchi orari riportati sotto le 24h: finisce il giorno dopo */
    expect(intervalloTurno({ nastroStart: "23:30", nastroEnd: "01:10" })).toEqual({ inizio: 1410, fine: 1510 });
    expect(intervalloTurno({ nastroStart: "06:00" })).toBeNull();
    expect(intervalloTurno(null)).toBeNull();
  });

  it("dallo snapshot: i minuti se ci sono, altrimenti le stringhe di allora", () => {
    expect(intervalloDaSnapshot({ start: "05:20", end: "11:58", startMin: 320, endMin: 718 })).toEqual({ inizio: 320, fine: 718 });
    expect(intervalloDaSnapshot({ start: "22:10", end: "25:05" })).toEqual({ inizio: 1330, fine: 1505 });
    expect(intervalloDaSnapshot({ start: null, end: "11:58" })).toBeNull();
  });

  it("testi: giorno e ora leggibili, durate in ore e minuti", () => {
    expect(quando(istante("2026-10-13", 1300))).toBe("mar 13/10 21:40");
    /* 25:10 del 13 è l'01:10 del 14 */
    expect(quando(istante("2026-10-13", 1510))).toBe("mer 14/10 01:10");
    /* d'inverno e d'estate l'ora è quella di Roma */
    expect(quando(istante("2027-01-15", 360))).toBe("ven 15/01 06:00");
    /* le domeniche del cambio d'ora: le 00:30 sono le 00:30 */
    expect(quando(istante("2026-10-25", 30))).toBe("dom 25/10 00:30");
    expect(quando(istante("2027-03-28", 30))).toBe("dom 28/03 00:30");
    expect(quando(istante("2026-10-24", 1470))).toBe("dom 25/10 00:30");
    expect(durata(485)).toBe("8h05");
    expect(durata(45)).toBe("45 min");
  });
});

describe("riposo minimo", () => {
  it("8h fra due urbani; 9h se uno è extraurbano; 9h presunte se uno è ignoto", () => {
    expect(riposoMinimo({ servizio: "urbano" }, { servizio: "urbano" })).toEqual({ minimo: 480, presunto: false });
    expect(riposoMinimo({ servizio: "urbano" }, { servizio: "extraurbano" })).toEqual({ minimo: 540, presunto: false });
    expect(riposoMinimo({ servizio: "extraurbano" }, { servizio: null })).toEqual({ minimo: 540, presunto: false });
    expect(riposoMinimo({ servizio: "urbano" }, { servizio: null })).toEqual({ minimo: 540, presunto: true });
  });
});

describe("violazioni fra i turni di un conducente", () => {
  it("urbani: 7h59 di riposo è troppo poco, 8h basta", () => {
    const sera = turno("AN04", "2026-10-13", "13:00", "21:40");
    expect(violazioniDelConducente([sera, turno("AN01", "2026-10-14", "05:39", "12:00")])).toHaveLength(1);
    expect(violazioniDelConducente([sera, turno("AN01", "2026-10-14", "05:40", "12:00")])).toHaveLength(0);
    const [v] = violazioniDelConducente([sera, turno("AN01", "2026-10-14", "05:39", "12:00")]);
    expect(v).toMatchObject({ regola: "riposo", minuti: 479, minimo: 480, presunto: false });
    expect(v!.testo).toBe("Riposo di 7h59 fra AN04 (fine mar 13/10 21:40) e AN01 (inizio mer 14/10 05:39): fra due turni urbani servono almeno 8h00");
  });

  it("un turno extraurbano porta il minimo a 9h; il tipo ignoto anche, con l'avviso", () => {
    const sera = turno("AN04", "2026-10-13", "13:00", "21:40");
    const mattina = (s: Servizio | null) => turno("OS01", "2026-10-14", "06:00", "12:30", s);
    expect(violazioniDelConducente([sera, mattina("urbano")])).toHaveLength(0);
    const [extra] = violazioniDelConducente([sera, mattina("extraurbano")]);
    expect(extra).toMatchObject({ minuti: 500, minimo: 540, presunto: false });
    expect(extra!.testo).toContain("OS01 è extraurbano: servono almeno 9h00");
    const [ignoto] = violazioniDelConducente([sera, mattina(null)]);
    expect(ignoto).toMatchObject({ minimo: 540, presunto: true });
    expect(ignoto!.testo).toContain("di OS01 non si sa se è urbano o extraurbano");
  });

  it("vale anche fra due turni dello stesso giorno", () => {
    const v = violazioniDelConducente([turno("A", "2026-10-13", "05:00", "09:00"), turno("B", "2026-10-13", "15:00", "20:00")]);
    expect(v).toHaveLength(1);
    expect(v[0]!.minuti).toBe(360);
  });

  it("sovrapposizioni: anche oltre la mezzanotte e con un turno dentro l'altro", () => {
    /* finisce alle 01:10 del giorno dopo, l'altro inizia alle 00:30 */
    const notte = turno("N1", "2026-10-13", "18:00", "25:10");
    const presto = turno("P1", "2026-10-14", "00:30", "06:00");
    const sov = violazioniDelConducente([presto, notte]);
    expect(sov.map(v => v.regola)).toEqual(["sovrapposizione"]);
    expect(sov[0]).toMatchObject({ minuti: 40 });
    expect(sov[0]!.turni.map(t => t.codice)).toEqual(["N1", "P1"]);
    expect(sov[0]!.testo).toBe("N1 (mar 13/10 18:00–mer 14/10 01:10) e P1 (mer 14/10 00:30–06:00) si sovrappongono per 40 min");

    /* B sta dentro A: sovrapposizione; C dopo A con poco riposo: si misura dalla fine di A, non di B */
    const a = turno("A", "2026-10-13", "05:00", "14:00"), b = turno("B", "2026-10-13", "06:00", "08:00");
    const c = turno("C", "2026-10-13", "20:00", "23:00");
    const v = violazioniDelConducente([c, b, a]);
    expect(v.filter(x => x.regola === "sovrapposizione")).toHaveLength(1);
    const riposo = v.find(x => x.regola === "riposo")!;
    expect(riposo.turni.map(t => t.codice)).toEqual(["A", "C"]);
    expect(riposo.minuti).toBe(360);
  });

  it("turni lontani non dicono niente; ogni conducente fa per sé", () => {
    expect(violazioniDelConducente([turno("A", "2026-10-13", "05:00", "12:00"), turno("B", "2026-10-15", "05:00", "12:00")])).toEqual([]);
    const v = violazioniDeiTurni([
      turno("A", "2026-10-13", "13:00", "21:40", "urbano", "c1"), turno("B", "2026-10-14", "05:00", "12:00", "urbano", "c2"),
    ]);
    expect(v).toEqual([]);
  });

  it("il riposo è fra blocchi di lavoro: un turno extraurbano nel blocco, prima o dopo, vuole 9h", () => {
    /* P urbano e Q extraurbano si sovrappongono: un blocco che finisce alle 21:40; C alle 05:50 → 8h10 */
    const P = turno("P", "2026-10-13", "13:00", "21:40", "urbano"), Q = turno("Q", "2026-10-13", "13:30", "21:35", "extraurbano");
    const C = turno("C", "2026-10-14", "05:50", "12:00", "urbano");
    const v = violazioniDelConducente([P, Q, C]);
    expect(v.map(x => `${x.regola}:${x.turni[0].codice}>${x.turni[1].codice}`).sort()).toEqual(["riposo:P>C", "sovrapposizione:P>Q"]);
    expect(v.find(x => x.regola === "riposo")!.testo).toContain("Q è extraurbano: servono almeno 9h00");
    /* dopo il riposo: W urbano e X extraurbano si sovrappongono, il riposo prima vale 9h */
    const S = turno("S", "2026-10-13", "14:00", "22:00", "urbano");
    const W = turno("W", "2026-10-14", "06:00", "06:40", "urbano"), X = turno("X", "2026-10-14", "06:30", "14:00", "extraurbano");
    const dopo = violazioniDelConducente([S, W, X]).find(x => x.regola === "riposo");
    expect(dopo).toMatchObject({ minuti: 480, minimo: 540 });
    expect(dopo!.testo).toContain("X è extraurbano");
    /* con un turno in mezzo, staccato, il riposo si conta da quello */
    const A = turno("A", "2026-10-13", "13:00", "21:00", "extraurbano"), B = turno("B", "2026-10-13", "21:10", "21:50", "urbano");
    const D = turno("D", "2026-10-14", "05:55", "12:00", "urbano");
    expect(violazioniDelConducente([A, B, D]).map(x => `${x.turni[0].codice}>${x.turni[1].codice}`)).toEqual(["A>B"]);
  });

  it("niente riposo finto mentre si lavora a un altro turno; niente turni lunghi zero", () => {
    /* W copre tutto lo spazio fra U e T: sovrapposizioni sì, riposo no */
    const U = turno("U", "2026-10-13", "13:00", "20:00", "extraurbano"), W = turno("W", "2026-10-13", "19:00", "23:00");
    const T = turno("T", "2026-10-13", "22:00", "23:30");
    expect(violazioniDelConducente([U, W, T]).map(x => x.regola)).toEqual(["sovrapposizione", "sovrapposizione"]);
    expect(intervalloTurno({ nastroStartMin: 600, nastroEndMin: 600 })).toBeNull();
  });

  it("la notte del cambio d'ora il riposo è quello vero", () => {
    /* marzo: l'orologio salta un'ora, 22:00 → 06:00 sono 7h */
    const marzo = violazioniDelConducente([turno("S", "2027-03-27", "14:00", "22:00"), turno("D", "2027-03-28", "06:00", "12:00")]);
    expect(marzo).toHaveLength(1);
    expect(marzo[0]).toMatchObject({ minuti: 420 });
    expect(marzo[0]!.testo).toContain("fine sab 27/03 22:00");
    expect(marzo[0]!.testo).toContain("inizio dom 28/03 06:00");
    /* ottobre: l'orologio torna indietro, 21:40 → 06:00 sono 9h20 */
    expect(violazioniDelConducente([
      turno("S", "2026-10-24", "14:00", "21:40", "extraurbano"), turno("D", "2026-10-25", "06:00", "12:00", "extraurbano"),
    ])).toEqual([]);
    /* un turno di domenica che inizia prima delle 3: 16:00 → 00:30 sono 8h30, d'autunno come in primavera */
    const autunno = violazioniDelConducente([
      turno("S", "2026-10-24", "08:00", "16:00", "extraurbano"), turno("N", "2026-10-25", "00:30", "06:00", "extraurbano"),
    ]);
    expect(autunno).toHaveLength(1);
    expect(autunno[0]).toMatchObject({ minuti: 510, minimo: 540 });
    expect(violazioniDelConducente([turno("S", "2027-03-27", "08:00", "16:00"), turno("N", "2027-03-28", "00:30", "06:00")])).toEqual([]);
  });

  it("per il client: niente minuti assoluti; forzata solo la coppia che è stata forzata", () => {
    const a = turno("AN04", "2026-10-13", "13:00", "21:40");
    const b0 = turno("AN01", "2026-10-14", "05:00", "12:00");
    const [grezza] = violazioniDelConducente([a, b0]);
    /* forzato per un'altra coppia: questa resta da controllare */
    expect(perIlClient(violazioniDelConducente([a, { ...b0, coppieForzate: ["riposo|altro|altro"] }])[0]!).forzata).toBe(false);
    const b = { ...b0, coppieForzate: [grezza!.chiave] };
    const [v] = violazioniDelConducente([a, b]).map(perIlClient);
    expect(v).toMatchObject({ regola: "riposo", forzata: true, minimo: 480, chiave: "riposo|dss|2026-10-13|AN04|dss|2026-10-14|AN01" });
    expect(v!.turni.map(t => t.codice)).toEqual(["AN04", "AN01"]);
    expect(Object.keys(v!.turni[0]!)).not.toContain("inizio");
    expect(Object.keys(v!.turni[0]!)).not.toContain("fine");
  });
});

describe("urbana o extraurbana dalle linee", () => {
  it("le reti urbane delle Marche sono urbane, il resto extraurbano", () => {
    for (const l of ["1", "41", "JE1", "Y", "BUS5", "BUSS2", "CIRCA", "C.D."]) expect(servizioDellaLinea(l)).toBe("urbano");
    for (const l of ["A", "B12", "CIRCX", "", null]) expect(servizioDellaLinea(l)).toBe("extraurbano");
  });

  it("la proposta: urbana solo se tutte le corse sono urbane", () => {
    expect(propostaServizio(40, 0)).toBe("urbano");
    expect(propostaServizio(40, 1)).toBe("extraurbano");
    expect(propostaServizio(0, 0)).toBeNull();
  });
});
