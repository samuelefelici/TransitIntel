import { describe, it, expect } from "vitest";
import { DEPOSITI_INIZIALI } from "../lib/anagrafica-campi";
import { abbinaColori, depositoDelNome, nomeEssenziale, TAVOLOZZA_DEPOSITI } from "../lib/roster-colori-depositi";

const cat = DEPOSITI_INIZIALI;
const codice = (nome: string) => depositoDelNome(nome, cat)?.codice ?? null;

describe("il deposito del personale che corrisponde a un deposito di Planner Studio", () => {
  it("toglie le parole che non identificano il deposito", () => {
    expect(nomeEssenziale("Deposito di Ancona")).toBe("ancona");
    expect(nomeEssenziale("Autorimessa  Jesi Urbano")).toBe("jesi urbano");
  });

  it("nome, codice e alias, senza badare a maiuscole e accenti", () => {
    expect(codice("ANCONA")).toBe("ancona");
    expect(codice("Deposito Jesi Urbano")).toBe("jesi-urbano");
    expect(codice("jesi-urbano")).toBe("jesi-urbano");
    expect(codice("Rimessa di Polverigi")).toBe("ancona");
    expect(codice("Belvedere Ostrense")).toBe("marina");
  });

  it("un nome del catalogo dentro un nome più lungo: vince il più lungo", () => {
    expect(codice("Jesi zona industriale")).toBe("jesi");
    expect(codice("Deposito Jesi Urbano via Roma")).toBe("jesi-urbano");
    expect(codice("Osimo Stazione")).toBe("osimo");
  });

  it("niente corrispondenze inventate", () => {
    expect(codice("Deposito")).toBeNull();
    expect(codice("Fabriano")).toBeNull();
    /* «osimo» non sta dentro «osimoX»: si confrontano parole intere */
    expect(codice("Osimoxyz")).toBeNull();
    /* due depositi diversi con lo stesso peso: nessuno dei due */
    expect(codice("Osimo Filottrano")).toBeNull();
  });
});

describe("il colore di ogni deposito", () => {
  it("prima i turni, poi Planner Studio, poi la tavolozza", () => {
    const colori = abbinaColori(cat, [
      { da: "turni", depositi: [{ name: "Deposito Ancona", color: "#ec4899" }] },
      { da: "planner", depositi: [
        { name: "Ancona", color: "#111111" },
        { name: "Jesi", color: "#22aa22" },
        { name: "Marina", color: "non un colore" },
      ] },
    ]);
    const di = (c: string) => colori.find(x => x.codice === c)!;
    expect(colori.map(x => x.codice)).toEqual(cat.map(d => d.codice));
    expect(di("ancona")).toMatchObject({ colore: "#ec4899", da: "turni", depositoPlanner: "Deposito Ancona" });
    expect(di("jesi")).toMatchObject({ colore: "#22aa22", da: "planner" });
    /* un colore non valido non conta: Marina prende la tavolozza */
    expect(di("marina").da).toBe("predefinito");
    /* la tavolozza salta i colori già presi dai depositi abbinati */
    const predefiniti = colori.filter(x => x.da === "predefinito").map(x => x.colore);
    expect(predefiniti).not.toContain("#ec4899");
    expect(new Set(predefiniti).size).toBe(predefiniti.length);
    expect(predefiniti.every(c => TAVOLOZZA_DEPOSITI.includes(c))).toBe(true);
  });

  it("la tavolozza evita le tinte vicine a quelle già prese: niente due verdi", () => {
    const colori = abbinaColori(cat, [{ da: "planner", depositi: [
      { name: "Jesi", color: "#22c55e" }, { name: "Osimo", color: "#f59e0b" }, { name: "Marina", color: "#06b6d4" },
    ] }]);
    const predefiniti = colori.filter(x => x.da === "predefinito").map(x => x.colore);
    /* smeraldo vicino al verde, arancio vicino all'ambra, verde acqua vicino al ciano */
    for (const vicino of ["#10b981", "#f97316", "#14b8a6"]) expect(predefiniti).not.toContain(vicino);
  });

  it("dentro una fonte il nome esatto vince su quello che lo contiene, anche se arriva dopo", () => {
    const colori = abbinaColori(cat, [{ da: "planner", depositi: [
      { name: "Jesi Zona Industriale", color: "#ef4444" }, { name: "Jesi", color: "#10B981" },
    ] }]);
    expect(colori.find(x => x.codice === "jesi")).toMatchObject({ colore: "#10b981", depositoPlanner: "Jesi" });
  });

  it("la tavolozza non ripete un colore finché ce ne sono di liberi", () => {
    /* tinte che lasciano «lontano» un solo colore della tavolozza */
    const colori = abbinaColori(cat, [{ da: "planner", depositi: [
      { name: "Ancona", color: "#2dd4bf" }, { name: "Jesi", color: "#e11d48" },
      { name: "Osimo", color: "#6366f1" }, { name: "Marina", color: "#f97316" },
    ] }]);
    const predefiniti = colori.filter(x => x.da === "predefinito").map(x => x.colore);
    expect(predefiniti).toHaveLength(3);
    expect(new Set(predefiniti).size).toBe(3);
  });

  it("migliaia di turni con pochi depositi: ogni coppia nome-colore si abbina una volta", () => {
    const turni = Array.from({ length: 5000 }, (_, i) => ({ name: i % 2 ? "Deposito Conerobus Ancona Via Bocconi" : "Autorimessa Osimo Campocavallo", color: i % 2 ? "#ec4899" : "#f59e0b" }));
    const t0 = performance.now();
    const colori = abbinaColori(cat, [{ da: "turni", depositi: turni }]);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(colori.find(x => x.codice === "ancona")?.colore).toBe("#ec4899");
    expect(colori.find(x => x.codice === "osimo")?.colore).toBe("#f59e0b");
  });

  it("senza nessuna fonte, ogni deposito ha comunque un colore e tutti diversi", () => {
    const colori = abbinaColori(cat, []);
    expect(colori.every(c => c.da === "predefinito" && /^#[0-9a-f]{6}$/.test(c.colore))).toBe(true);
    expect(new Set(colori.map(c => c.colore)).size).toBe(cat.length);
  });
});
