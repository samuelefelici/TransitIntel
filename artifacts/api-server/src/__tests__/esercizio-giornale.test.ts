/**
 * Il giornale di esercizio (tappa 4.5), senza database: le richieste che si
 * accettano e quelle che no, e chi può leggere e scrivere il consuntivo.
 */
import { describe, it, expect } from "vitest";
import { leggiRichiesta } from "../lib/esercizio-giornale";
import { decidi } from "../lib/permessi-rotte";
import { utenteDiProva } from "./helpers/app-di-prova";

const ok = (x: unknown) => {
  const r = leggiRichiesta(x);
  if ("errore" in r) throw new Error(r.errore);
  return r.richiesta;
};
const errore = (x: unknown) => {
  const r = leggiRichiesta(x);
  return "errore" in r ? r.errore : null;
};

describe("le richieste del giornale", () => {
  it("un esito: la fonte è l'ufficio movimento se non la si dice", () => {
    expect(ok({ tipo: "esito", versione: 3, chiavi: ["a", "b"], esito: "effettuata" })).toMatchObject({ fonte: "movimento", versione: 3 });
    expect(ok({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "soppressa", causale: "GUASTO_MEZZO", fonte: "centrale" })).toMatchObject({ fonte: "centrale" });
  });

  it("soppressa e parziale vogliono la causale", () => {
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "soppressa" })).toBe("Una corsa soppressa vuole la causale");
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "parziale", kmEff: 3.2 })).toBe("Una corsa parziale vuole la causale");
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "da_verificare" })).toBeNull();
  });

  it("niente campi in più, niente valori fuori elenco, niente versione mancante", () => {
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "effettuata", autore: "qualcun altro" })).toMatch(/^richiesta: /);
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "inventata" })).toMatch(/^esito: /);
    expect(errore({ tipo: "esito", chiavi: ["a"], esito: "effettuata" })).toMatch(/^versione: /);
    expect(errore({ tipo: "esito", versione: 0, chiavi: [], esito: "effettuata" })).toMatch(/^chiavi: /);
    expect(errore({ tipo: "esito", versione: 0, chiavi: ["a"], esito: "effettuata", fonte: "avm" })).toMatch(/^fonte: /);
    expect(errore({ tipo: "cancella_tutto", versione: 0 })).toMatch(/^tipo: /);
  });

  it("al più 5000 corse per evento", () => {
    expect(errore({ tipo: "esito", versione: 0, chiavi: Array.from({ length: 5001 }, (_, i) => `c${i}`), esito: "effettuata" })).toMatch(/^chiavi: /);
  });

  it("la conferma di massa: solo le proposte che si confermano", () => {
    expect(ok({ tipo: "conferma", versione: 1, proposte: ["effettuata_avm", "continuita"] })).toMatchObject({ tipo: "conferma" });
    expect(errore({ tipo: "conferma", versione: 1, proposte: ["da_verificare"] })).toMatch(/^proposte\.0: /);
    // dalla 4.6 le non rilevate si confermano presunte
    expect(errore({ tipo: "conferma", versione: 1, proposte: ["non_rilevata"] })).toBeNull();
  });

  it("un'aggiunta: tipo, linea e partenza; orari veri", () => {
    expect(ok({ tipo: "aggiunta", versione: 2, tipoAggiunta: "bis", linea: "1/4", partenza: "07:15" })).toMatchObject({ tipoAggiunta: "bis" });
    expect(errore({ tipo: "aggiunta", versione: 2, tipoAggiunta: "bis", linea: "1/4", partenza: "7 e un quarto" })).toMatch(/^partenza: orario HH:MM/);
    expect(errore({ tipo: "aggiunta", versione: 2, tipoAggiunta: "regalo", linea: "1", partenza: "07:15" })).toMatch(/^tipoAggiunta: /);
  });

  it("annullamento e nota", () => {
    expect(ok({ tipo: "annullamento", versione: 4, evento: 12 })).toMatchObject({ evento: 12 });
    expect(errore({ tipo: "annullamento", versione: 4, evento: -1 })).toMatch(/^evento: /);
    expect(ok({ tipo: "nota", versione: 4, nota: "Deviazione per lavori in via Marconi" })).toMatchObject({ chiavi: [] });
    expect(errore({ tipo: "nota", versione: 4, nota: "x".repeat(501) })).toMatch(/^nota: /);
  });
});

describe("chi legge e chi scrive il consuntivo (area «Consuntivo»)", () => {
  const chi = (ruoli: any[]) => ({ admin: false, diritti: utenteDiProva("u", [], "user", { ruoli }).diritti });
  it("la Centrale operativa e l'Amministrazione scrivono; gli altri ruoli leggono", () => {
    for (const r of ["centrale_operativa", "amministrazione"]) {
      expect(decidi(chi([r]), "POST", "/esercizio/giornate/2026-04-07/eventi")).toEqual({ passa: true });
    }
    for (const r of ["pianificatore", "ufficio_turni", "capo_deposito"]) {
      expect(decidi(chi([r]), "GET", "/esercizio/giornate/2026-04-07")).toEqual({ passa: true });
      expect(decidi(chi([r]), "POST", "/esercizio/giornate/2026-04-07/eventi")).toMatchObject({ passa: false, solaLettura: true });
    }
  });
  it("l'officina non ha il consuntivo; il catalogo delle causali lo cambia solo l'amministratore", () => {
    expect(decidi(chi(["officina"]), "GET", "/esercizio/giornate")).toMatchObject({ passa: false });
    expect(decidi(chi(["centrale_operativa"]), "PUT", "/admin/esercizio/causali/SCIOPERO")).toEqual({ passa: false, errore: "Solo admin" });
  });
});
