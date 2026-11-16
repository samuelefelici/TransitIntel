/**
 * Il report mensile (tappa 4.7), senza database: gli indicatori.
 */
import { describe, it, expect } from "vitest";
import { indicatori, PUNTUALITA, type Conteggi } from "../lib/esercizio-report";

const base: Conteggi = {
  programmate: 100, effettuate: 30, presunte: 60, parziali: 4, soppresse: 6, aggiunte: 2,
  kmProgrammati: 1000, kmEffettiviProgrammate: 920, kmEffettiviAggiunte: 15, kmPersi: 80,
  soppresseNonImputabili: 4, parzialiNonImputabili: 0, kmProgrammatiNonImputabili: 40, kmPersiNonImputabili: 40,
  campione: 30, inOrario: 24,
};

describe("indicatori", () => {
  it("regolarità lorda: effettuate e presunte sulle programmate; km effettivi sui programmati", () => {
    const i = indicatori(base);
    expect(i.regolaritaCorse.lorda).toBe(90);
    expect(i.regolaritaKm.lorda).toBe(92);
  });
  it("regolarità netta: senza le soppressioni non imputabili all'azienda, né i loro km", () => {
    const i = indicatori(base);
    expect(i.regolaritaCorse.netta).toBe(93.8); // 90 / 96
    expect(i.regolaritaKm.netta).toBe(95.8); // 920 / 960
  });
  it("una parziale non imputabile toglie i suoi km programmati e quello che ne è stato fatto", () => {
    const i = indicatori({ ...base, soppresseNonImputabili: 0, parzialiNonImputabili: 1, kmProgrammatiNonImputabili: 10, kmPersiNonImputabili: 4 });
    expect(i.regolaritaCorse.netta).toBe(90.9); // 90 / 99
    expect(i.regolaritaKm.netta).toBe(92.3); // (920 - 6) / 990
  });
  it("quota provata e puntualità sul campione, con la copertura accanto", () => {
    const i = indicatori(base);
    expect(i.quotaProvata).toBe(30);
    expect(i.puntualita).toEqual({ campione: 30, inOrario: 24, quota: 80, copertura: 30 });
    expect(PUNTUALITA).toEqual({ anticipoS: -60, ritardoS: 300 });
  });
  it("senza denominatore niente percentuali inventate", () => {
    const i = indicatori({ ...base, programmate: 0, kmProgrammati: 0, campione: 0 });
    expect(i.regolaritaCorse.lorda).toBeNull();
    expect(i.regolaritaKm.lorda).toBeNull();
    expect(i.puntualita.quota).toBeNull();
  });
});
