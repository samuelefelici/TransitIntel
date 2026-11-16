/**
 * Chiusura e blocco del consuntivo (tappa 4.6), senza database: chi chiude,
 * che cosa manca per chiudere, i mesi.
 */
import { describe, it, expect } from "vitest";
import { chiudeLeGiornate } from "@workspace/permessi";
import { giorniDelMese, meseValido, perchéNonSiChiude } from "../lib/esercizio-chiusura";
import { leggiRichiesta } from "../lib/esercizio-giornale";

describe("chi chiude le giornate", () => {
  it("il ruolo Amministrazione e l'amministratore; la Centrale no", () => {
    expect(chiudeLeGiornate({ admin: false, ruoli: ["amministrazione"] })).toBe(true);
    expect(chiudeLeGiornate({ admin: true, ruoli: [] })).toBe(true);
    expect(chiudeLeGiornate({ admin: false, ruoli: ["centrale_operativa", "capo_deposito"] })).toBe(false);
    expect(chiudeLeGiornate({ admin: false, ruoli: [] })).toBe(false);
  });
});

describe("che cosa manca per chiudere", () => {
  const tutto = { daDecidere: 0, daVerificare: 0, parzialiSenzaKm: 0, finita: true };
  it("niente: si chiude", () => expect(perchéNonSiChiude(tutto)).toBeNull());
  it("una giornata non finita non si chiude, qualunque cosa manchi", () => {
    expect(perchéNonSiChiude({ ...tutto, finita: false })).toMatch(/non è ancora finita/);
  });
  it("le corse da decidere, da verificare e le parziali senza km, tutte insieme", () => {
    expect(perchéNonSiChiude({ ...tutto, daDecidere: 3, daVerificare: 1, parzialiSenzaKm: 2 }))
      .toBe("Non si chiude: 3 corse da decidere, 1 corse da verificare, 2 parziali senza i km fatti");
  });
});

describe("i mesi", () => {
  it("AAAA-MM vero", () => {
    expect(meseValido("2026-05")).toBe(true);
    for (const m of ["2026-13", "2026-00", "2026-5", "26-05", "2026-05-01", 202605, null]) expect(meseValido(m)).toBe(false);
  });
  it("i giorni del mese, anche di febbraio bisestile", () => {
    expect(giorniDelMese("2026-05")).toHaveLength(31);
    expect(giorniDelMese("2028-02").at(-1)).toBe("2028-02-29");
    expect(giorniDelMese("2026-02").at(-1)).toBe("2026-02-28");
  });
});

describe("la presunzione nella conferma di massa", () => {
  it("le non rilevate si confermano, presunte", () => {
    const r = leggiRichiesta({ tipo: "conferma", versione: 0, proposte: ["non_rilevata"] });
    expect("richiesta" in r && r.richiesta).toMatchObject({ proposte: ["non_rilevata"] });
    expect("errore" in leggiRichiesta({ tipo: "conferma", versione: 0, proposte: ["da_verificare"] })).toBe(true);
  });
});
