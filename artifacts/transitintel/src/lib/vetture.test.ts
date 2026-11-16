import { describe, it, expect } from "vitest";
import { MATRICOLA, mezziPer, riepilogoVetture, turniDi, type TurnoConVettura, type VettureDelGiorno } from "./vetture";

const turno = (turnoMacchina: string, depositoCodice: string | null, vettura: string | null, extra: Partial<TurnoConVettura> = {}): TurnoConVettura => ({
  vssId: "v", turnoMacchina, udp: null, deposito: depositoCodice, depositoCodice, tipoMezzo: "12m",
  uscita: "05:00", rientro: "09:00", corse: 3, vettura, assegnataDa: null, assegnataIl: null, vistaDallAvm: [], avvisi: [], ...extra,
});
const giorno = (turni: TurnoConVettura[]): VettureDelGiorno => ({
  giorno: "2032-06-22", giornata: { stato: "preparata" }, turni, daRiassegnare: [],
  officina: { disponibile: true, motivo: null },
  mezzi: [
    { matricola: "310", modello: "12m", stato: "riserva", depositoCodice: "jesi" },
    { matricola: "302", modello: "18m", stato: "in_servizio", depositoCodice: "jesi" },
    { matricola: "301", modello: "12m", stato: "in_servizio", depositoCodice: "jesi" },
    { matricola: "305", modello: "12m", stato: "in_servizio", depositoCodice: "jesi" },
    { matricola: "401", modello: "12m", stato: "in_servizio", depositoCodice: "ancona" },
  ],
});

describe("vetture sui turni macchina", () => {
  it("i turni del deposito scelto, o tutti", () => {
    const v = giorno([turno("M1", "jesi", null), turno("M2", "ancona", null), turno("M3", null, null)]);
    expect(turniDi(v, "jesi").map((t) => t.turnoMacchina)).toEqual(["M1"]);
    expect(turniDi(v, null)).toHaveLength(3);
  });

  it("i mezzi proposti: del deposito, prima i liberi del tipo giusto, la riserva dopo, quelli già usati in fondo", () => {
    const m1 = turno("M1", "jesi", "305");
    const m2 = turno("M2", "jesi", null);
    const v = giorno([m1, m2]);
    expect(mezziPer(v, m2).map((m) => [m.matricola, m.su])).toEqual([
      ["301", null], ["310", null], ["302", null], ["305", "M1"],
    ]);
    // per il turno che ha già la vettura, la sua non conta come «già usata»
    expect(mezziPer(v, m1).find((m) => m.matricola === "305")!.su).toBeNull();
    // senza deposito: tutti i mezzi
    expect(mezziPer(v, turno("M9", null, null))).toHaveLength(5);
  });

  it("il riepilogo: quanti senza vettura e quanti con avvisi", () => {
    expect(riepilogoVetture([turno("M1", "jesi", "301", { avvisi: ["x"] }), turno("M2", "jesi", null)])).toEqual({ turni: 2, senza: 1, conAvvisi: 1 });
  });

  it("la matricola come la vuole l'API", () => {
    expect(MATRICOLA.test("FR-12.3/A")).toBe(true);
    expect(MATRICOLA.test("<b>")).toBe(false);
  });
});
