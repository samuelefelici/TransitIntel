/**
 * La sosta minima al capolinea come dato, e il ritardo vero delle corse per
 * la robustezza del giro: le regole (senza database).
 */
import { describe, it, expect } from "vitest";
import { leggiModificheSoste, minutiSosta, sostaEffettiva, sostePerFermate, type SosteDelProgetto } from "../lib/soste-minime";
import { ritardiDagliEsiti, RITARDO_MAX_MIN } from "../lib/ritardi-siri";

const u = (n: number) => `b7c00000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("i valori", () => {
  it("interi da 0 a 60; null toglie; il resto non vale", () => {
    expect([0, 5, 60].map(minutiSosta)).toEqual([0, 5, 60]);
    expect(minutiSosta(null)).toBeNull();
    for (const x of [-1, 61, 2.5, "5", true, undefined, NaN]) expect(minutiSosta(x)).toBeUndefined();
  });

  it("le modifiche: fail closed su id e valori, niente doppi, qualcosa da cambiare", () => {
    expect(leggiModificheSoste({ predefinitaMin: 3, nodi: [{ id: u(1), minuti: 5 }], fermate: [{ id: u(2).toUpperCase(), minuti: null }] }))
      .toEqual({ ok: true, m: { predefinitaMin: 3, nodi: [{ id: u(1), minuti: 5 }], fermate: [{ id: u(2), minuti: null }] } });
    expect(leggiModificheSoste({ predefinitaMin: null })).toMatchObject({ ok: true, m: { predefinitaMin: null } });
    expect(leggiModificheSoste({})).toMatchObject({ ok: false, errore: "niente da cambiare" });
    expect(leggiModificheSoste({ predefinitaMin: 90 })).toMatchObject({ ok: false });
    expect(leggiModificheSoste({ nodi: [{ id: "Cavour", minuti: 5 }] })).toMatchObject({ ok: false, errore: expect.stringMatching(/id non valido/) });
    expect(leggiModificheSoste({ nodi: [{ id: u(1), minuti: "5" }] })).toMatchObject({ ok: false });
    expect(leggiModificheSoste({ fermate: [{ id: u(1), minuti: 1 }, { id: u(1), minuti: 2 }] })).toMatchObject({ ok: false, errore: expect.stringMatching(/ripetuto/) });
    expect(leggiModificheSoste({ nodi: "tutti" })).toMatchObject({ ok: false });
  });
});

describe("quale sosta vale", () => {
  const s: SosteDelProgetto = {
    predefinita: 2,
    perFermata: new Map([[u(10), 0], [u(11), 4]]),
    perNodo: new Map([[u(20), 6]]),
    nodoDi: new Map([[u(10), u(20)], [u(12), u(20)]]),
  };

  it("la fermata, poi il nodo, poi il progetto", () => {
    expect(sostaEffettiva(u(10), s)).toEqual({ minuti: 0, fonte: "fermata" });   // la fermata vince sul nodo
    expect(sostaEffettiva(u(12), s)).toEqual({ minuti: 6, fonte: "nodo" });
    expect(sostaEffettiva(u(11), s)).toEqual({ minuti: 4, fonte: "fermata" });
    expect(sostaEffettiva(u(99), s)).toEqual({ minuti: 2, fonte: "progetto" });
    expect(sostaEffettiva(u(99), { ...s, predefinita: null })).toBeNull();
  });

  it("per il giro: solo le fermate che hanno un valore", () => {
    expect(sostePerFermate([u(10), u(12), u(99)], { ...s, predefinita: null })).toEqual({ [u(10)]: 0, [u(12)]: 6 });
  });
});

describe("il ritardo vero delle corse", () => {
  it("dal ritardo all'85°: intero, da 0 al tetto, solo con metà del tempo osservato", () => {
    expect(ritardiDagliEsiti([
      { tripId: "a", ritardoP85Min: 3.4, coperturaPct: 90 },
      { tripId: "b", ritardoP85Min: -2, coperturaPct: 90 },        // in anticipo: nessun margine regalato
      { tripId: "c", ritardoP85Min: 40, coperturaPct: 60 },        // il tetto
      { tripId: "d", ritardoP85Min: 5, coperturaPct: 30 },         // troppo poco osservato
      { tripId: "e", ritardoP85Min: null, coperturaPct: 0 },
    ])).toEqual({ a: 3, b: 0, c: RITARDO_MAX_MIN });
  });
});
