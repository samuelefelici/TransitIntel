import { describe, expect, it } from "vitest";
import {
  citazioniEsplicite, corto, preparaRicerca, riepilogoDi, terminiDomanda, tracciaDalleFonti,
  type Passaggio, type TracciaRetrieval, type TracciaVerifica,
} from "./argos-sciame";

const p = (id: number, doc: number, cat: string | null, status: string, extra: Partial<Passaggio> = {}): Passaggio => ({
  id, document_id: doc, title: `Doc ${doc}`, category: cat, section: null, score: 0.6, rerank: null, status, final_rank: null, ...extra,
});

const TRACCIA: TracciaRetrieval = {
  kind: "retrieval",
  query: { text: "riposo fra turni", terms: ["riposo", "turni"] },
  settings: { min_score: 0.3 },
  pool: [
    p(1, 10, "Accordi", "kept", { final_rank: 1 }),
    p(2, 11, "Normativa", "kept", { final_rank: 2 }),
    p(3, 12, "Normativa", "dropped"),
    p(4, 10, "Accordi", "dup"),
    p(5, 13, "Ordini", "below", { score: 0.1 }),
    // tenuto, ma è anche un ponte: al rerank non l'ha tenuto il riranker
    p(6, 14, "Ordini", "kept", { final_rank: 3, score: 0.5 }),
  ],
  bridges: [
    { ...p(6, 14, "Ordini", "kept"), via: "cosine", from_id: 1, final_rank: 3 },
    { ...p(7, 15, "Accordi", "kept"), via: "concept", from_id: null, final_rank: null },
  ],
  context: [1, 2, 6, null],
  concepts: [
    { id: 31, name: "riposo giornaliero", category: "Accordi", weight: 2, chunk_ids: [1, 2] },
    { id: 32, name: "turno", category: "Ordini", weight: 1 },
  ],
  concept_edges: [{ a: 31, b: 32, rel: "applica", w: 0.7, from: 31 }, { a: 31, b: 99, rel: "correlato", w: 0.5, from: null }],
  categories: ["Accordi", "Normativa", "Ordini"],
  memory: true,
};

describe("i termini della domanda", () => {
  it("senza parole vuote, senza doppioni, al più otto", () => {
    expect(terminiDomanda("Quanto riposo spetta tra due turni di guida? Riposo!")).toEqual(["riposo", "spetta", "due", "turni", "guida"]);
    expect(terminiDomanda("uno due tre quattro cinque sei sette otto nove dieci undici")).toHaveLength(8);
    expect(terminiDomanda("")).toEqual([]);
  });
});

describe("la traccia normalizzata", () => {
  it("un candidato che è anche un ponte non risulta tenuto dal rerank: lo riprende il ponte", () => {
    const R = preparaRicerca(TRACCIA, "riposo fra turni");
    const sei = R.pool.find(c => c.id === 6)!;
    expect(sei).toMatchObject({ status: "dropped", final_rank: null, viaBridge: true });
    expect(R.brIds.has(6)).toBe(true);
    expect(R.byId.get(7)?.via).toBe("concept");
    expect(R.ctx).toEqual([1, 2, 6, null]);
    expect(R.terms).toEqual(["riposo", "turni"]);
    expect(R.memory).toBe(true);
  });

  it("le relazioni fra concetti solo fra concetti della traccia", () => {
    const R = preparaRicerca(TRACCIA, "x");
    expect(R.cedges).toEqual([{ a: 31, b: 32, rel: "applica", w: 0.7, from: 31 }]);
  });

  it("senza contesto né termini: i tenuti per rango e poi i ponti; i termini dalla domanda", () => {
    const R = preparaRicerca({ kind: "retrieval", pool: [p(1, 1, null, "kept", { final_rank: 2 }), p(2, 2, null, "kept", { final_rank: 1 })], bridges: [{ ...p(9, 3, null, "kept"), via: "cosine" }] }, "orari della linea notturna");
    expect(R.ctx).toEqual([2, 1, 9]);
    expect(R.terms).toEqual(["orari", "linea", "notturna"]);
  });

  it("una traccia malformata non rompe niente", () => {
    const R = preparaRicerca({ kind: "retrieval", pool: [null as unknown as Passaggio, { id: null } as unknown as Passaggio], bridges: "x" as unknown as Passaggio[] }, "domanda");
    expect(R.pool).toEqual([]);
    expect(R.bridges).toEqual([]);
  });
});

describe("il percorso dalle fonti finali, senza traccia", () => {
  it("le fonti collegate diventano ponti, le altre candidati tenuti, nell'ordine", () => {
    const tr = tracciaDalleFonti(
      [{ document_id: 10, document_title: "CCNL", score: 0.8 }, { document_id: 11, document_title: "Accordo", linked: true }, "rotta"],
      "riposo", d => (d === 10 ? "Accordi" : null), ["Accordi"],
    );
    expect(tr.synthetic).toBe(true);
    expect(tr.pool!.map(c => [c.id, c.title, c.category])).toEqual([["s0", "CCNL", "Accordi"], ["s2", "Documento 3", null]]);
    expect(tr.bridges!.map(c => c.id)).toEqual(["s1"]);
    expect(tr.context).toEqual(["s0", "s1", "s2"]);
    expect(tr.categories).toEqual(["Accordi"]);
  });
});

describe("le citazioni esplicite, quando manca la verifica", () => {
  it("una frase con «Fonte N» è tracciata; una frase corta con la citazione la dà alla precedente", () => {
    const md = [
      "Tra due turni spettano almeno undici ore di riposo consecutivo (Fonte 1).",
      "- Il riposo settimanale è di ventiquattro ore consecutive di norma. (Fonte 2)",
      "```",
      "codice che non conta Fonte 9 per niente",
      "```",
      "Le eccezioni vanno concordate con le rappresentanze sindacali aziendali.",
    ].join("\n");
    const c = citazioniEsplicite(md);
    expect(c.map(x => [x.source, x.traced])).toEqual([[1, true], [2, true], [null, false]]);
    expect(c[2]!.unk).toBe(true);
  });
});

describe("il riepilogo per la dashboard", () => {
  const colore = (c: string) => `#${c.length}`;
  const verifica: TracciaVerifica = {
    kind: "verify",
    claims: [
      { text: "a", source: 1, traced: true }, { text: "b", source: 2, traced: true },
      { text: "c", source: null, traced: false }, { text: "d", source: null, traced: false, unk: true },
    ],
  };

  it("conta passaggi, fonti, ponti, concetti, strumenti e frasi con fonte", () => {
    const R = preparaRicerca(TRACCIA, "riposo");
    const r = riepilogoDi(R, verifica, ["ti_roster_coverage", "web_search"], colore, { secondi: 12.5, tokens: 2400 });
    expect(r).toMatchObject({
      candidati: 7, // 6 del pool + il ponte 7 (il 6 una volta sola)
      tenuti: 2, // 1 e 2: il 6 è un ponte
      fonti: 4, // 1, 2, 6 e la memoria
      ponti: 1, // il 6 è nel contesto, il 7 no
      concetti: 2, relazioni: 1,
      strumenti: ["ti_roster_coverage", "web_search"],
      affermazioni: 4, tracciate: 2, senzaFonte: 1, nonVerificabili: 1, verificaDisponibile: true,
      ricostruita: false, memoria: true, secondi: 12.5, tokens: 2400,
    });
    expect(r.categorie.map(c => [c.nome, c.candidati, c.tenuti])).toEqual([["Accordi", 3, 1], ["Normativa", 2, 1], ["Ordini", 2, 1]]);
    expect(r.categorie[0]!.colore).toBe("#7");
  });

  it("senza traccia né verifica: tutto a zero, la verifica non disponibile", () => {
    const r = riepilogoDi(null, null, ["tpl_live_operations"], colore);
    expect(r).toMatchObject({ candidati: 0, fonti: 0, verificaDisponibile: false, strumenti: ["tpl_live_operations"], secondi: null, tokens: null });
  });
});

describe("i testi corti", () => {
  it("taglia con i puntini e comprime gli spazi", () => {
    expect(corto("  riposo   giornaliero  ", 40)).toBe("riposo giornaliero");
    expect(corto("abcdefghij", 5)).toBe("abcd…");
    expect(corto(null, 5)).toBe("");
  });
});
