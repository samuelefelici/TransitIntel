/**
 * «Bilancia i carichi» (PR 7.7): la scelta, senza database.
 */
import { describe, it, expect } from "vitest";
import { bilancia, scarto, type ConducenteBilancio, type TurnoBilancio } from "../lib/roster-bilancia";
import { istante, type TurnoNelTempo } from "../lib/roster-normativa";

const GIORNI = ["2032-07-05", "2032-07-06", "2032-07-07"];
const periodo = new Set(GIORNI);

/** un turno: giorno, codice, conducente, ore come "HH:MM" */
let n = 0;
function turno(giorno: string, codice: string, chi: string, inizio: string, fine: string, spostabile = true): TurnoBilancio {
  const m = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
  const t: TurnoNelTempo = {
    chiave: `d|${giorno}|${codice}`, assegnazioneId: `a${++n}`, conducenteId: chi, giorno, codice, dssId: "d",
    inizio: istante(giorno, m(inizio)), fine: istante(giorno, m(fine)),
    servizio: "urbano", servizioDa: "linee", coppieForzate: [],
  };
  return { turno: t, spostabile };
}
const cond = (id: string, liberi = GIORNI, presente = GIORNI): ConducenteBilancio => ({ id, nome: id, liberi: new Set(liberi), presente: new Set(presente) });

describe("bilancia", () => {
  it("cede un turno a chi è libero, il più vicino a metà della distanza", () => {
    const turni = [
      turno(GIORNI[0]!, "G1", "pieno", "06:00", "14:00"),
      turno(GIORNI[1]!, "G2", "pieno", "06:00", "10:00"),
      turno(GIORNI[2]!, "G3", "pieno", "06:00", "14:00"),
    ];
    const r = bilancia([cond("pieno"), cond("vuoto")], turni, periodo);
    // distanza 20h: il turno di 8h la porta a 4h, quello di 4h a 12h; poi 4h a 4h non scende più
    expect(r.mosse.map((m) => [m.tipo, m.turno.codice, m.da.id, m.a.id])).toEqual([["cede", "G1", "pieno", "vuoto"]]);
    expect(Object.fromEntries(r.carichi.map((c) => [c.id, [c.prima, c.dopo, c.turniDopo]]))).toEqual({ pieno: [1200, 720, 2], vuoto: [0, 480, 1] });
    expect(scarto(r.carichi, "prima")).toBe(1200);
    expect(scarto(r.carichi, "dopo")).toBe(240);
  });

  it("scambia due turni dello stesso giorno quando chi è meno carico non è libero", () => {
    const turni = [
      turno(GIORNI[0]!, "LUNGO", "a", "05:00", "15:00"),
      turno(GIORNI[0]!, "CORTO", "b", "06:00", "10:00"),
      turno(GIORNI[1]!, "X", "a", "06:00", "12:00"),
      turno(GIORNI[1]!, "Y", "b", "06:00", "11:00"),
    ];
    const r = bilancia([cond("a", []), cond("b", [])], turni, periodo);
    expect(r.mosse).toHaveLength(1);
    expect(r.mosse[0]).toMatchObject({ tipo: "scambio", giorno: GIORNI[0], turno: { codice: "LUNGO", minuti: 600 }, inCambio: { codice: "CORTO", minuti: 240 } });
    // 16h contro 9h: dopo lo scambio 10h contro 15h
    expect(scarto(r.carichi, "prima")).toBe(420);
    expect(scarto(r.carichi, "dopo")).toBe(300);
  });

  it("non sposta le sostituzioni o i forzati, né sotto la soglia, né verso chi è assente", () => {
    const fissi = [turno(GIORNI[0]!, "G1", "pieno", "06:00", "14:00", false), turno(GIORNI[1]!, "G2", "pieno", "06:00", "14:00", false)];
    expect(bilancia([cond("pieno"), cond("vuoto")], fissi, periodo).mosse).toEqual([]);
    const vicini = [turno(GIORNI[0]!, "G1", "a", "06:00", "06:20")];
    expect(bilancia([cond("a"), cond("b")], vicini, periodo).mosse).toEqual([]);
    const pieni = [turno(GIORNI[0]!, "G1", "pieno", "06:00", "14:00"), turno(GIORNI[1]!, "G2", "pieno", "06:00", "14:00")];
    expect(bilancia([cond("pieno"), cond("vuoto", [])], pieni, periodo).mosse).toEqual([]);
  });

  it("non crea violazioni di riposo: chi riceve deve avere le ore di riposo", () => {
    // «sera» lavora fino a mezzanotte il giorno prima del periodo: il turno delle 5 non gli va, quello delle 14 sì
    const turni = [
      turno("2032-07-04", "S", "sera", "16:00", "23:59"),
      turno(GIORNI[0]!, "ALBA", "pieno", "05:00", "11:00"),
      turno(GIORNI[0]!, "POM", "pieno", "14:00", "20:00"),
      turno(GIORNI[1]!, "G2", "pieno", "06:00", "14:00", false),
    ];
    const r = bilancia([cond("pieno"), cond("sera")], turni, periodo);
    expect(r.mosse[0]).toMatchObject({ tipo: "cede", turno: { codice: "POM" }, a: { id: "sera" } });
    expect(r.mosse.some((m) => m.turno.codice === "ALBA")).toBe(false);
  });

  it("finisce, e lascia i conducenti senza turni nel periodo col carico zero", () => {
    const turni = GIORNI.flatMap((g, i) => [turno(g, `A${i}`, "a", "06:00", "14:00"), turno(g, `B${i}`, "b", "06:00", "14:00")]);
    const r = bilancia([cond("a", []), cond("b", []), cond("c")], turni, periodo, { massimo: 50 });
    expect(r.mosse.length).toBeLessThan(50);
    expect(r.carichi.find((c) => c.id === "c")!.dopo).toBeGreaterThan(0);
    expect(scarto(r.carichi, "dopo")).toBeLessThan(scarto(r.carichi, "prima"));
  });
});
