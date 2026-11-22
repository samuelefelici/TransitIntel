/**
 * «Copri gli scoperti» (PR 7.6): la scelta, senza database.
 */
import { describe, it, expect } from "vitest";
import { copri, chiaveTurno, type CandidatoCopertura, type DaCoprire } from "../lib/roster-copertura";

const turno = (codice: string, inizio: string | null): DaCoprire =>
  ({ dssId: "d", codice, inizio, fine: null, deposito: "Nord", titolare: null });
const cand = (id: string, gruppo: CandidatoCopertura["gruppo"], carico = 0, nome = id): CandidatoCopertura => ({ id, nome, gruppo, carico });
const per = (voci: Array<[DaCoprire, CandidatoCopertura[]]>) => new Map(voci.map(([t, c]) => [chiaveTurno(t), c]));

describe("copri", () => {
  it("prima i liberi, poi a disposizione; a parità chi ha meno turni intorno, poi per nome", () => {
    const t = turno("G1", "06:00");
    const r = copri([t], per([[t, [cand("d", "disposizione"), cand("b", "libero", 2, "Rossi"), cand("a", "libero", 2, "Verdi"), cand("c", "libero", 2, "Bianchi")]]]));
    expect(r.coperture.map((c) => c.driverId)).toEqual(["c"]);
    const s = copri([t], per([[t, [cand("d", "disposizione"), cand("b", "libero", 3), cand("a", "libero", 1)]]]));
    expect(s.coperture[0]).toMatchObject({ driverId: "a", gruppo: "libero" });
    const u = copri([t], per([[t, [cand("d", "disposizione", 0)]]]));
    expect(u.coperture[0]).toMatchObject({ driverId: "d", gruppo: "disposizione" });
  });

  it("i turni in ordine di inizio, quelli senza orario in fondo; un turno a testa", () => {
    const sera = turno("G10", "20:00"), mattina = turno("G2", "05:30"), senza = turno("G1", null);
    const tutti = [cand("x", "libero"), cand("y", "libero", 1)];
    const r = copri([sera, senza, mattina], per([[sera, tutti], [mattina, tutti], [senza, tutti]]));
    expect(r.coperture.map((c) => [c.turno.codice, c.driverId])).toEqual([["G2", "x"], ["G10", "y"]]);
    expect(r.scoperti).toEqual([{ turno: senza, motivo: "candidati_finiti" }]);
  });

  it("a parità d'orario per codice, coi numeri in ordine; senza candidati il motivo lo dice", () => {
    const a = turno("G10", "06:00"), b = turno("G9", "06:00"), c = turno("G11", "07:00");
    const r = copri([a, b, c], per([[a, [cand("x", "libero")]], [b, [cand("x", "libero")]]]));
    expect(r.coperture.map((x) => x.turno.codice)).toEqual(["G9"]);
    expect(r.scoperti.map((x) => [x.turno.codice, x.motivo])).toEqual([["G10", "candidati_finiti"], ["G11", "nessun_candidato"]]);
  });

  it("non cambia gli elenchi che riceve", () => {
    const t = turno("G1", "06:00");
    const elenco = [cand("b", "disposizione"), cand("a", "libero")];
    const turni = [t];
    copri(turni, per([[t, elenco]]));
    expect(elenco.map((c) => c.id)).toEqual(["b", "a"]);
    expect(turni).toEqual([t]);
  });
});
