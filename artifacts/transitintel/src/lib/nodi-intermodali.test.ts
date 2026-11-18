import { describe, expect, it } from "vitest";
import { nomeCortoDelNodo } from "./nodi-intermodali";

describe("il nome corto di un nodo di scambio", () => {
  it("i sei nodi di oggi si accorciano come prima, quando i loro nomi erano scritti nella regola", () => {
    expect([
      "Stazione FS Ancona", "Stazione FS Falconara Marittima", "Stazione Palombina Nuova",
      "Porto di Ancona (Terminal Passeggeri)", "Aeroporto Raffaello Sanzio (Falconara)", "Stazione di Ancona Torrette",
    ].map(nomeCortoDelNodo)).toEqual(["Ancona", "Falconara Marittima", "Palombina Nuova", "Porto Ancona", "Aeroporto", "Torrette"]);
  });

  it("vale per i nodi di qualunque città", () => {
    expect(nomeCortoDelNodo("Stazione di Pesaro")).toBe("Pesaro");
    expect(nomeCortoDelNodo("Stazione di Bologna Borgo Panigale")).toBe("Borgo Panigale");
    expect(nomeCortoDelNodo("Stazione FS Rimini")).toBe("Rimini");
    expect(nomeCortoDelNodo("Porto di Bari")).toBe("Porto Bari");
    expect(nomeCortoDelNodo("Aeroporto Guglielmo Marconi")).toBe("Aeroporto");
  });

  it("un nome che non comincia come una stazione, un porto o un aeroporto resta com'è", () => {
    expect(nomeCortoDelNodo("Centro urbano (riferimento)")).toBe("Centro urbano (riferimento)");
    expect(nomeCortoDelNodo("Autostazione")).toBe("Autostazione");
    expect(nomeCortoDelNodo("")).toBe("");
  });
});
