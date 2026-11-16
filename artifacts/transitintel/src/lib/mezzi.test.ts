import { describe, it, expect } from "vitest";
import { mancanze, mezziDi, type MezziDelGiorno } from "./mezzi";

const m: MezziDelGiorno = {
  giorno: "2026-11-17", giornata: true,
  officina: { disponibile: true, motivo: null, lettoAlle: "x", statoDiAdesso: true },
  depositi: [
    { codice: "jesi", deposito: "Jesi", fabbisogno: { totale: 4, perTipo: [] }, disponibili: { totale: 3, inServizio: 2, riserva: 1, perModello: [] },
      inOfficina: [{ matricola: "304", modello: null, fermoDal: null, motivo: null, commessa: null }], margine: -1, perTipo: [] },
    { codice: "ancona", deposito: "Ancona", fabbisogno: { totale: 2, perTipo: [] }, disponibili: { totale: 3, inServizio: 3, riserva: 0, perModello: [] },
      inOfficina: [], margine: 1, perTipo: [] },
  ],
};

describe("mezzi per deposito", () => {
  it("dove mancano mezzi", () => {
    expect(mancanze(m)).toEqual([{ deposito: "Jesi", mancano: 1 }]);
  });
  it("un deposito, o tutti sommati", () => {
    expect(mezziDi(m, "ancona")?.margine).toBe(1);
    expect(mezziDi(m, "osimo")).toBeNull();
    const tutti = mezziDi(m, null)!;
    expect(tutti).toMatchObject({ deposito: "Tutti i depositi", fabbisogno: { totale: 6 }, disponibili: { totale: 6, inServizio: 5, riserva: 1 }, margine: 0 });
    expect(tutti.inOfficina).toHaveLength(1);
    // senza officina, niente margine
    expect(mezziDi({ ...m, officina: { ...m.officina, disponibile: false }, depositi: m.depositi.map((d) => ({ ...d, disponibili: null, margine: null })) }, null)!.margine).toBeNull();
  });
});
