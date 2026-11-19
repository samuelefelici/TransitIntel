/**
 * Urbana o extraurbana nell'ottimizzazione dei mezzi (tappa 6.23): lo dicono
 * le reti dell'azienda, non più la prima lettera del nome della linea.
 *
 * Con la regola di prima le urbane con un nome di lettere (JE1, BUS3, CIRCA,
 * Y, C.D.) finivano fra le extraurbane: sulla copia dei dati veri erano 30
 * linee su 128, 452 corse su 3.502, e un mezzo poteva mescolarle con le
 * extraurbane. Le flotte restano separate (un turno è tutto urbano o tutto
 * extraurbano); qui si prova solo la categoria.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getServiceCategory } from "../lib/ottimizza-veicoli/modello";
import { impostaReti, RETI_NEUTRE } from "../lib/reti-linee";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

describe("la categoria di una linea nell'ottimizzazione dei mezzi", () => {
  it("le urbane con un nome di lettere sono urbane", () => {
    for (const nome of ["JE1", "JE51", "JESp", "BUS3", "BUSS2", "CIRCA", "CIRCB", "Y", "C.D.", "C.S."]) {
      expect(getServiceCategory(nome), nome).toBe("urbano");
    }
  });

  it("le urbane con un numero restano urbane, le extraurbane restano extraurbane", () => {
    expect(getServiceCategory("1/4")).toBe("urbano");
    expect(getServiceCategory("30")).toBe("urbano");
    for (const nome of ["A", "O", "BV", "Z"]) expect(getServiceCategory(nome), nome).toBe("extraurbano");
  });

  it("segue le reti in vigore: un'azienda senza regole ha tutto extraurbano", () => {
    impostaReti(RETI_NEUTRE);
    expect(getServiceCategory("1/4")).toBe("extraurbano");
    expect(getServiceCategory("JE1")).toBe("extraurbano");
  });
});
