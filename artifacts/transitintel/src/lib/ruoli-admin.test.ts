import { describe, expect, it } from "vitest";
import { AREE, MATRICE, RUOLI, dirittiDi, rigaDelRuolo, type Diritti } from "@workspace/permessi";
import {
  avvisiDelCambio, corpoDelSalvataggio, differenzaInParole, differenze, esitoInParole, livelloDi, matriceDaRuoli,
  riassuntoDeiDiritti, ruoliValidi, sceltaDi, uguali, type StatoRuolo,
} from "./ruoli-admin";

const CAPO = rigaDelRuolo(MATRICE, "capo_deposito");
const OFFICINA = rigaDelRuolo(MATRICE, "officina");
const stato = (codice: StatoRuolo["codice"], diritti: Diritti, utenti = 0): StatoRuolo =>
  ({ codice, utenti, diritti, diPartenza: rigaDelRuolo(MATRICE, codice), aggiornataIl: null, aggiornataDa: null });

describe("quello che arriva dal server", () => {
  it("i ruoli nell'ordine di sempre, con tutte le aree", () => {
    const r = ruoliValidi({ ruoli: [stato("officina", OFFICINA, 3), stato("capo_deposito", { ...CAPO, flotta: null }, 2)] });
    expect(r.map(x => x.codice)).toEqual(["capo_deposito", "officina"]);
    expect(r[0]).toMatchObject({ utenti: 2, diritti: { ...CAPO, flotta: null }, diPartenza: CAPO });
  });

  it("un ruolo o un livello che la web non conosce non passano", () => {
    expect(ruoliValidi(null)).toEqual([]);
    expect(ruoliValidi({ ruoli: "x" })).toEqual([]);
    const r = ruoliValidi({ ruoli: [null, { codice: "direttore", diritti: CAPO }, { codice: "officina", utenti: -4, diritti: { flotta: "X", roster: "S", magazzino: "S" }, diPartenza: null }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ codice: "officina", utenti: 0, diritti: { flotta: null, roster: "S" } });
    expect(Object.keys(r[0].diritti).sort()).toEqual([...AREE].sort());
    expect(Object.values(r[0].diPartenza).every(v => v === null)).toBe(true);
  });

  it("la matrice in vigore per l'anteprima degli utenti è quella dei ruoli ricevuti", () => {
    const m = matriceDaRuoli(RUOLI.map(r => stato(r, r === "capo_deposito" ? { ...CAPO, flotta: null, tariffe: "L" } : rigaDelRuolo(MATRICE, r))));
    const capo = { admin: false, ruoli: ["capo_deposito" as const], accessoDiPrima: {}, analisi: false, datiSanitari: false };
    expect(dirittiDi(capo, m)).toMatchObject({ flotta: null, tariffe: "L", roster: "S" });
    expect(dirittiDi({ ...capo, ruoli: ["officina"] }, m)).toEqual(dirittiDi({ ...capo, ruoli: ["officina"] }));
    // se il server non ha dato un ruolo, per quello vale la matrice di partenza
    expect(rigaDelRuolo(matriceDaRuoli([]), "capo_deposito")).toEqual(CAPO);
  });
});

describe("le scelte e le differenze", () => {
  it("tre scelte per cella", () => {
    expect([sceltaDi("S"), sceltaDi("L"), sceltaDi(null), sceltaDi(undefined)]).toEqual(["S", "L", "N", "N"]);
    expect([livelloDi("S"), livelloDi("L"), livelloDi("N")]).toEqual(["S", "L", null]);
  });

  it("le differenze, nell'ordine del menu e in parole", () => {
    const dopo = { ...CAPO, esercizio: null, roster: "L" as const, tariffe: "S" as const };
    expect(uguali(CAPO, { ...CAPO })).toBe(true);
    expect(differenze(CAPO, dopo).map(differenzaInParole)).toEqual([
      "Roster: Scrittura → Lettura", "Esercizio: Lettura → Niente", "Tariffe: Niente → Scrittura",
    ]);
  });

  it("il riassunto di un ruolo dice quello che dà adesso", () => {
    expect(riassuntoDeiDiritti(OFFICINA)).toBe("Scrive: Flotta · Legge: Esercizio");
    expect(riassuntoDeiDiritti({ ...OFFICINA, flotta: null, esercizio: null })).toBe("Non apre nessuna area");
    expect(riassuntoDeiDiritti({ ...OFFICINA, esercizio: null })).toBe("Scrive: Flotta");
  });

  it("il corpo del salvataggio ha tutte le aree, con null dove non c'è niente", () => {
    const c = corpoDelSalvataggio({ ...OFFICINA, roster: "L" });
    expect(Object.keys(c.diritti).sort()).toEqual([...AREE].sort());
    expect(c.diritti).toMatchObject({ flotta: "S", esercizio: "L", roster: "L", personale: null });
  });
});

describe("gli avvisi prima di salvare", () => {
  const testi = (prima: Diritti, dopo: Diritti, n = 3) => avvisiDelCambio(prima, dopo, n).map(a => a.testo).join(" | ");

  it("dare il Personale: i dati dei lavoratori e la verifica in due passaggi", () => {
    const t = testi(OFFICINA, { ...OFFICINA, personale: "L" });
    expect(t).toMatch(/dati personali di tutti i dipendenti/);
    expect(t).toMatch(/verifica in due passaggi/);
    // chi il roster lo aveva già la verifica ce l'ha: non si ripete
    expect(testi(CAPO, { ...CAPO, personale: "L" })).not.toMatch(/verifica in due passaggi/);
    expect(testi({ ...CAPO, personale: "L" }, { ...CAPO, personale: "S" })).toMatch(/modificare i dati personali/);
  });

  it("togliere il Roster spegne i dati sanitari; togliere o dare la Flotta cambia FleetCare", () => {
    expect(testi(CAPO, { ...CAPO, roster: null })).toMatch(/si spengono i dati sanitari/);
    expect(testi(CAPO, { ...CAPO, roster: "L" })).toBe("");
    expect(testi(CAPO, { ...CAPO, flotta: null })).toMatch(/non si entra più in FleetCare/);
    expect(testi({ ...CAPO, flotta: null }, CAPO)).toMatch(/si entra in FleetCare/);
  });

  it("un ruolo svuotato lo dice; un cambio qualunque fra lettura e scrittura non avvisa di niente", () => {
    const vuoto = Object.fromEntries(AREE.map(a => [a, null])) as Diritti;
    expect(testi(OFFICINA, vuoto)).toMatch(/non apre più nessuna area/);
    expect(testi(CAPO, { ...CAPO, rete: "S", turni: null })).toBe("");
    expect(avvisiDelCambio(OFFICINA, { ...OFFICINA, personale: "L" }, 1)[0].testo).toMatch(/la persona che ha questo ruolo vede/);
  });
});

describe("l'esito in parole", () => {
  it("per quanti vale, e che cosa è successo a chi", () => {
    expect(esitoInParole({ celle: 2, utentiAggiornati: 0, datiSanitariSpenti: 0, daVerificare: 0 }, 0)).toBe("Nessun utente ha questo ruolo, per ora.");
    expect(esitoInParole({ celle: 2, utentiAggiornati: 4, datiSanitariSpenti: 1, daVerificare: 2 }, 4))
      .toBe("Vale da subito per le 4 persone con questo ruolo. Dati sanitari spenti a una persona. 2 persone devono attivare la verifica in due passaggi.");
    expect(esitoInParole({ celle: 1, utentiAggiornati: 1, datiSanitariSpenti: 0, daVerificare: 1 }, 1))
      .toBe("Vale da subito per la persona con questo ruolo. Una persona deve attivare la verifica in due passaggi.");
    expect(esitoInParole(undefined, 3)).toBe("");
  });
});
