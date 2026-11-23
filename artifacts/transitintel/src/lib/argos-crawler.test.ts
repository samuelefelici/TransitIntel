import { describe, it, expect } from "vitest";
import {
  candidatiInScena, chiaveParola, concettiInScena, costruisciScena, durataFase, evidenzia, filiDellaFase, motivoScarto, riepilogoScena, tintaParola,
  type TracciaRetrieval,
} from "./argos-crawler";
import { disponi, elencoTinte, raggio, tintaCategoria, vicini } from "./argos-grafo";
import { faseCaricamento } from "./argos-console";

describe("le parole, come le confronta Argos", () => {
  it("singolare e plurale, maschile e femminile, accenti, numeri", () => {
    expect(chiaveParola("turno")).toBe(chiaveParola("turni"));
    expect(chiaveParola("linea")).toBe(chiaveParola("Linee"));
    expect(chiaveParola("settimanale")).toBe(chiaveParola("settimanali"));
    expect(chiaveParola("Perché")).toBe("perch");
    expect(chiaveParola("2026")).toBe("2026");
    expect(chiaveParola("bus")).toBe("bus");
  });

  it("evidenzia i termini nel testo senza perdere niente", () => {
    const p = evidenzia("Le linee urbane e il turno 12.", ["linea", "turni"]);
    expect(p.map(x => x.testo).join("")).toBe("Le linee urbane e il turno 12.");
    expect(p.filter(x => x.termine).map(x => [x.testo, x.termine])).toEqual([["linee", "linea"], ["turno", "turni"]]);
    expect(evidenzia("", ["x"])).toEqual([]);
    expect(evidenzia("senza termini", [])).toEqual([{ testo: "senza termini", termine: null }]);
  });
});

const traccia: TracciaRetrieval = {
  kind: "retrieval",
  query: { text: "Quali turni coprono la linea 1?", terms: ["turni", "coprono", "linea"] },
  settings: { top_k: 6, min_score: 0.3, reranker: true, graph: true, deep: false, fast: false },
  timings_ms: { embed: 40, search: 12, rerank: 90 },
  pool: [
    { id: 11, document_id: 1, title: "Manuale turni", category: "Manuali", section: "Cap. 2", score: 0.81, rerank: 0.9, status: "kept", rank: 1, final_rank: 1, hits: { turni: 3, linea: 1 }, snippet: "I turni della linea 1…" },
    { id: 12, document_id: 2, title: "Contratto", category: "Norme", section: null, score: 0.52, rerank: 0.2, status: "dropped", rank: 2, final_rank: null, hits: { turni: 1 }, snippet: "…" },
    { id: 13, document_id: 1, title: "Manuale turni", category: "Manuali", section: "Cap. 2", score: 0.5, rerank: null, status: "dup", rank: 3, final_rank: null, hits: {}, snippet: "…" },
    { id: 14, document_id: 3, title: "Vecchio orario", category: null, section: null, score: 0.1, rerank: null, status: "below", rank: 4, final_rank: null, hits: {}, snippet: "" },
  ],
  context: [11, 21, null],
  bridges: [{ id: 21, document_id: 4, title: "Accordo aziendale", category: "Norme", section: "Art. 5", score: 0.6, via: "concept", from_id: null, final_rank: 2, snippet: "Il turno…" }],
  concepts: [{ id: 5, name: "Turno guida", category: "Manuali", weight: 0.8, chunk_ids: [11, 21] }],
  concept_edges: [],
  memory: true,
  categories: ["Manuali", "Norme"],
};

describe("la scena", () => {
  const s = costruisciScena(traccia);

  it("termini, candidati in ordine, scartati per motivo", () => {
    expect(s.termini).toEqual(["turni", "coprono", "linea"]);
    expect(s.candidati.map(c => c.id)).toEqual([11, 12, 13, 14]);
    expect(s.tenuti.map(c => c.id)).toEqual([11]);
    expect(s.scartati).toEqual({ sottoSoglia: 1, doppioni: 1, esclusi: 1 });
  });

  it("le fonti nell'ordine dato al modello, ponti compresi, la memoria no", () => {
    expect(s.fonti.map(f => [f.n, f.id, f.daPonte])).toEqual([[1, 11, false], [2, 21, true]]);
    expect(s.memoria).toBe(true);
  });

  it("per ogni termine i passaggi che lo contengono", () => {
    expect(s.dove).toEqual({ turni: [11, 12], coprono: [], linea: [11] });
  });

  it("durate e riepilogo", () => {
    expect(durataFase("domanda", s)).toBe(900 + 3 * 220);
    expect(durataFase("legami", s)).toBe(1600);
    expect(durataFase("risposta", s)).toBe(0);
    expect(riepilogoScena(s, { kind: "verify", claims: [], traced: 3, total: 4, tools_used: [] }))
      .toEqual({ letti: 4, tenuti: 2, ponti: 1, concetti: 1, frasi: 4, verificate: 3 });
  });

  it("una traccia vuota non rompe niente", () => {
    const v = costruisciScena({ ...traccia, pool: [], context: [], bridges: [], concepts: [], query: { text: "", terms: [] } });
    expect(v.fonti).toEqual([]);
    expect(v.candidati).toEqual([]);
  });
});

describe("il layout della mappa", () => {
  const nodi = [
    { id: 1, title: "A", category: "Norme", chunks: 10 },
    { id: 2, title: "B", category: "Norme", chunks: 40 },
    { id: 3, title: "C", category: "Manuali", chunks: 5 },
    { id: 4, title: "D", category: null, chunks: 0 },
  ];
  const archi = [{ source: 1, target: 2, weight: 0.9 }, { source: 2, target: 3, weight: 0.4 }, { source: 9, target: 1, weight: 1 }];

  it("deterministico e dentro i bordi", () => {
    const a = disponi(nodi, archi, { larghezza: 800, altezza: 600, passi: 150 });
    const b = disponi(nodi, archi, { larghezza: 800, altezza: 600, passi: 150 });
    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const p of a.values()) {
      expect(p.x).toBeGreaterThanOrEqual(20); expect(p.x).toBeLessThanOrEqual(780);
      expect(p.y).toBeGreaterThanOrEqual(20); expect(p.y).toBeLessThanOrEqual(580);
    }
  });

  it("gli archi forti avvicinano", () => {
    const p = disponi(nodi, archi, { larghezza: 800, altezza: 600, passi: 200 });
    const d = (x: number, y: number) => Math.hypot(p.get(x)!.x - p.get(y)!.x, p.get(x)!.y - p.get(y)!.y);
    expect(d(1, 2)).toBeLessThan(d(1, 4));
  });

  it("raggio e vicini", () => {
    expect(raggio(40, 40)).toBe(22);
    expect(raggio(0, 40)).toBe(5);
    expect([...vicini(2, archi)].sort()).toEqual([1, 2, 3]);
    expect(disponi([], [], { larghezza: 10, altezza: 10 }).size).toBe(0);
  });
});

describe("tinte e fasi", () => {
  it("la tinta segue la categoria, la nona e le senza categoria sono «altre»", () => {
    const cat = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    expect(tintaCategoria("a", cat)).toBe(1);
    expect(tintaCategoria("h", cat)).toBe(8);
    expect(tintaCategoria("i", cat)).toBe(0);
    expect(tintaCategoria(null, cat)).toBe(0);
    expect(tintaCategoria("zz", cat)).toBe(0);
  });

  it("l'elenco delle tinte è quello della mappa: ufficiali, poi le altre in ordine, senza «Senza categoria»", () => {
    expect(elencoTinte(["Norme", "Manuali"], ["zeta", null, "Norme", "alfa", "zeta"])).toEqual(["Norme", "Manuali", "alfa", "zeta"]);
    expect(elencoTinte(["Norme", "Senza categoria"], [])).toEqual(["Norme"]);
  });

  it("la fase di un caricamento dallo stato e dallo stadio", () => {
    expect(faseCaricamento({ status: "queued", stage: "in coda", progress: 0 })).toBe(0);
    expect(faseCaricamento({ status: "running", stage: "conversione", progress: 5 })).toBe(1);
    expect(faseCaricamento({ status: "running", stage: "chunking", progress: 10 })).toBe(2);
    expect(faseCaricamento({ status: "running", stage: "embedding", progress: 40 })).toBe(3);
    expect(faseCaricamento({ status: "running", stage: "scrittura", progress: 98 })).toBe(4);
    expect(faseCaricamento({ status: "done", stage: "completato", progress: 100 })).toBe(5);
    expect(faseCaricamento({ status: "error", stage: "embedding", progress: 30 })).toBe(3);
  });
});

describe("chi va in scena e i fili", () => {
  const s = costruisciScena(traccia);

  it("candidati: prima nell'ordine della ricerca, poi i tenuti in testa", () => {
    expect(candidatiInScena(s, false).map(c => c.id)).toEqual([11, 12, 13, 14]);
    expect(candidatiInScena(s, true).map(c => c.id)).toEqual([11, 12, 13, 14]);
    // con un tetto basso i tenuti restano sempre
    const pochi = candidatiInScena({ ...s, candidati: [...s.candidati].reverse() }, false, 2);
    expect(pochi.map(c => c.id)).toContain(11);
    expect(pochi).toHaveLength(2);
  });

  it("dopo la selezione: tenuti per ordine finale, poi gli altri per rank", () => {
    const c = (id: number, rank: number, status: "kept" | "below", final_rank: number | null) =>
      ({ ...traccia.pool[0]!, id, rank, status, final_rank });
    const t: TracciaRetrieval = { ...traccia, pool: [c(1, 1, "below", null), c(2, 2, "kept", 2), c(3, 3, "kept", 1), c(4, 4, "below", null)], context: [3, 2], bridges: [] };
    expect(candidatiInScena(costruisciScena(t), true).map(x => x.id)).toEqual([3, 2, 1, 4]);
  });

  it("le tinte delle parole seguono l'ordine della domanda", () => {
    expect(tintaParola("turni", s)).toBe(1);
    expect(tintaParola("linea", s)).toBe(3);
    expect(tintaParola("assente", s)).toBe(0);
  });

  it("ricerca: ogni parola ai passaggi visibili che la contengono", () => {
    const f = filiDellaFase(s, "ricerca", new Set([11, 12, 13, 14]));
    expect(f.map(x => [x.da, x.a])).toEqual([["t:turni", "c:11"], ["t:turni", "c:12"], ["t:linea", "c:11"]]);
    expect(f.every(x => !x.debole)).toBe(true);
    expect(filiDellaFase(s, "ricerca", new Set([11])).map(x => x.a)).toEqual(["c:11", "c:11"]);
  });

  it("selezione: i fili verso gli scartati si affievoliscono", () => {
    const f = filiDellaFase(s, "selezione", new Set([11, 12]));
    expect(f.find(x => x.a === "c:12")?.debole).toBe(true);
    expect(f.find(x => x.a === "c:11")?.debole).toBe(false);
  });

  it("legami: concetti ai passaggi (ponti compresi)", () => {
    const f = filiDellaFase(s, "legami", new Set([11]));
    expect(f.map(x => [x.da, x.a, x.etichetta])).toEqual([["k:5", "c:11", "Turno guida"], ["k:5", "c:21", "Turno guida"]]);
    expect(concettiInScena(s)).toHaveLength(1);
  });

  it("risposta: la frase alla sua fonte; niente filo senza fonte o verso la memoria", () => {
    expect(filiDellaFase(s, "risposta", new Set(), { indice: 0, fonte: 2, parole: ["turno", "accordo", "x"] }))
      .toEqual([{ id: "c:21>f:0", da: "c:21", a: "f:0", tipo: "frase", etichetta: "turno · accordo" }]);
    expect(filiDellaFase(s, "risposta", new Set(), { indice: 0, fonte: null, parole: [] })).toEqual([]);
    expect(filiDellaFase(s, "risposta", new Set(), { indice: 0, fonte: 3, parole: [] })).toEqual([]);
    expect(filiDellaFase(s, "fonti", new Set([11]))).toEqual([]);
  });

  it("i motivi in parole", () => {
    expect(motivoScarto("below")).toBe("sotto la soglia");
    expect(motivoScarto("kept")).toBeNull();
  });
});

