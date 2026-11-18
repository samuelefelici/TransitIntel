/**
 * Le vetture dell'azienda nel canale dell'AVM (tappa 6.5): la regola è un
 * dato dell'azienda, sta in un punto solo, e tutto quello che prima la
 * ripeteva la legge da lì.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  eDellAzienda, espressioneVetture, impostaRegolaVetture, nomeAzienda, perimetroAzienda, REGOLA_NEUTRA, regolaVetture, siglaAzienda,
} from "../lib/vetture-azienda";
import { aziendaDaSiri, codiceDaSiri, siriDaCodice, impostaParco } from "../lib/parco-anagrafica";
import { PARCO_DI_PRIMA } from "./helpers/parco-di-prima";

/* i prefissi delle consorziate sono dati dell'azienda (tappa 6.21): quelli del primo cliente */
impostaParco(PARCO_DI_PRIMA);
import { parcoCredibile, type ParcoOfficina } from "../lib/officina";
import { esclusioneOfficina } from "../lib/avm-diario";
import { richiestaTogliere } from "../lib/avm-storia";

afterEach(() => impostaRegolaVetture(REGOLA_NEUTRA));

describe("la regola delle vetture dell'azienda", () => {
  it("finché nessuno la dice, tutte le vetture del canale sono dell'azienda", () => {
    expect(regolaVetture()).toEqual({ cifre: null, nome: "Azienda" });
    for (const ref of ["305", "1372", "11096", "AB12", ""]) expect(eDellAzienda(ref), ref).toBe(true);
    expect(espressioneVetture()).toBeNull();
  });

  it("con le cifre: solo le matricole numeriche fino a quel numero di cifre", () => {
    impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
    for (const ref of ["5", "305", "1372", " 305 "]) expect(eDellAzienda(ref), ref).toBe(true);
    for (const ref of ["11096", "13050", "AB12", "30S", "", null, undefined]) expect(eDellAzienda(ref), String(ref)).toBe(false);
    expect(espressioneVetture()).toBe("^[0-9]{1,4}$");
    impostaRegolaVetture({ cifre: 6, nome: "Altra" });
    expect(eDellAzienda("110960")).toBe(true);
    expect(eDellAzienda("1109600")).toBe(false);
    expect(espressioneVetture()).toBe("^[0-9]{1,6}$");
  });

  it("un numero di cifre che non sta fra 1 e 9 non vale: resta «tutte»", () => {
    for (const cifre of [0, 10, 2.5, -1, Number.NaN]) {
      impostaRegolaVetture({ cifre, nome: "X" });
      expect(regolaVetture().cifre, String(cifre)).toBeNull();
      expect(eDellAzienda("11096")).toBe(true);
    }
  });

  it("il nome nei testi e nei nomi dei file", () => {
    impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
    expect([nomeAzienda(), siglaAzienda()]).toEqual(["Conerobus", "conerobus"]);
    impostaRegolaVetture({ cifre: null, nome: "  Autolinee dell'Àdige S.r.l. " });
    expect([nomeAzienda(), siglaAzienda()]).toEqual(["Autolinee dell'Àdige S.r.l.", "autolinee-dell-adige-s-r-l"]);
    impostaRegolaVetture({ cifre: null, nome: " " });
    expect([nomeAzienda(), siglaAzienda()]).toEqual(["Azienda", "azienda"]);
  });

  it("il perimetro chiesto da una pagina: «azienda», e «conerobus» per i link di prima", () => {
    expect([perimetroAzienda("azienda"), perimetroAzienda("conerobus")]).toEqual([true, true]);
    for (const v of ["", "tutte", undefined, null, ["azienda"], "AZIENDA"]) expect(perimetroAzienda(v), String(v)).toBe(false);
  });
});

describe("chi la usa la legge da lì", () => {
  const parco = (matricole: string[]): ParcoOfficina => ({
    disponibile: true, tenant: "prova", letto: "2026-11-17T08:00:00.000Z",
    mezzi: matricole.map((matricola) => ({ matricola, targa: `T${matricola}`, modello: null, deposito: null, stato: "attivo" })),
  } as unknown as ParcoOfficina);

  it("l'azienda di una vettura: il nome dell'azienda, o la sigla della consorziata", () => {
    impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
    expect(aziendaDaSiri("305")).toBe("Conerobus");
    expect(aziendaDaSiri("11096")).toBe("CJ");
    expect(codiceDaSiri("11096")).toBe("CJ096");
    impostaRegolaVetture({ cifre: 4, nome: "Autolinee Prova" });
    expect(aziendaDaSiri("305")).toBe("Autolinee Prova");
    // senza consorziate ogni vettura è dell'azienda, e il suo codice è la matricola
    impostaRegolaVetture({ cifre: null, nome: "Autolinee Prova" });
    expect(aziendaDaSiri("11096")).toBe("Autolinee Prova");
    expect(codiceDaSiri("11096")).toBe("11096");
    expect(siriDaCodice("AB12")).toBe("AB12");
  });

  it("il parco dell'officina si confronta solo con le vetture dell'azienda", () => {
    const visteDallAvm = ["101", "102", "103", "104", "11001", "11002", "11003", "11004", "11005", "11006"];
    // con le consorziate fuori dal conto, 4 su 4 sono nel parco: credibile
    impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
    expect(parcoCredibile(parco(["101", "102", "103", "104"]), visteDallAvm).disponibile).toBe(true);
    // se tutte sono dell'azienda, 4 su 10 non bastano, e il motivo la nomina
    impostaRegolaVetture({ cifre: null, nome: "Autolinee Prova" });
    const r = parcoCredibile(parco(["101", "102", "103", "104"]), visteDallAvm);
    expect(r.disponibile).toBe(false);
    expect(r.motivo).toMatch(/solo 4 delle 10 matricole Autolinee Prova/);
  });

  it("l'officina non dice niente di una consorziata; di una vettura dell'azienda fuori parco sì", () => {
    impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
    expect(esclusioneOfficina("11096", "muta" as any, undefined)).toBeNull();
    expect(esclusioneOfficina("305", "muta" as any, undefined)).toMatchObject({ motivo: "fuori_parco" });
    impostaRegolaVetture({ cifre: null, nome: "Autolinee Prova" });
    expect(esclusioneOfficina("11096", "muta" as any, undefined)).toMatchObject({ motivo: "fuori_parco" });
  });

  it("le email al centro portano il nome dell'azienda", () => {
    impostaRegolaVetture({ cifre: 4, nome: "Autolinee Prova" });
    const r = richiestaTogliere(["305"]);
    expect(r.oggetto).toBe("AVM Autolinee Prova — vetture da togliere dall'anagrafica del centro (1)");
    expect(r.testo).toContain("1 matricola Autolinee Prova che il parco dell'officina non ha più");
  });
});
