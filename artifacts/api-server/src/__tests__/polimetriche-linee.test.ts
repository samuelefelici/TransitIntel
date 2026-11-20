/**
 * Le linee extraurbane delle polimetriche (tappa 6.28): le dicono le reti
 * dell'azienda, non più «il codice comincia con una lettera».
 *
 * Con la regola di prima le urbane con un nome di lettere (JE1, BUS3, CIRCA, Y,
 * C.D.) entravano fra le extraurbane, e le loro polimetriche si mescolavano a
 * quelle vere. È lo stesso resto tolto dall'ottimizzazione dei mezzi nella 6.23.
 *
 * Dalla 6.36 le linee vengono da un programma di Planning Studio, non più da
 * un GTFS: la regola è la stessa.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { lineeExtraurbane, type LineaDelProgramma } from "../lib/polimetrica-programma";
import { impostaReti, RETI_NEUTRE } from "../lib/reti-linee";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

const linea = (id: string, nomeCorto: string, nomeLungo = "", codice = id): LineaDelProgramma => ({ id, codice, nomeCorto, nomeLungo });
const codici = (m: Map<string, LineaDelProgramma[]>) => [...m.keys()].sort();

describe("le linee extraurbane delle polimetriche", () => {
  it("le urbane con un nome di lettere restano fuori, le extraurbane entrano", () => {
    const m = lineeExtraurbane([
      linea("r1", "JE1"), linea("r2", "BUS3"), linea("r3", "CIRCA"), linea("r4", "Y"), linea("r5", "C.D."),
      linea("r6", "1/4"), linea("r7", "30"),
      linea("r8", "A", "Capolinea Nord - Capolinea Sud"), linea("r9", "BV"), linea("r10", "Z"),
    ]);
    expect(codici(m)).toEqual(["A", "BV", "Z"]);
    expect(m.get("A")).toEqual([linea("r8", "A", "Capolinea Nord - Capolinea Sud")]);
  });

  it("più linee col nome uguale sono una linea; senza nome vale il codice", () => {
    const m = lineeExtraurbane([linea("a1", "A"), linea("a2", " A "), { id: "x", codice: "X9", nomeCorto: null, nomeLungo: null }, { id: "y", codice: "", nomeCorto: "", nomeLungo: null }]);
    expect(m.get("A")?.map((l) => l.id)).toEqual(["a1", "a2"]);
    expect(m.get("X9")?.map((l) => l.id)).toEqual(["x"]);
    expect(m.size).toBe(2);
  });

  it("un'azienda senza reti urbane: tutte le linee sono extraurbane", () => {
    impostaReti(RETI_NEUTRE);
    expect(codici(lineeExtraurbane([linea("r1", "JE1"), linea("r6", "1/4"), linea("r8", "A")]))).toEqual(["1/4", "A", "JE1"]);
  });
});
