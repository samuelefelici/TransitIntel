import { describe, it, expect } from "vitest";
import { CATEGORIE_DIMOSTRAZIONE, FASI_DIMOSTRAZIONE, QUANTE_CORSE, corsaDimostrativa, mappaDimostrazione } from "./argos-dimostrazione";
import { FASI_SCIAME, preparaRicerca } from "./argos-sciame";

describe("la dimostrazione di Argos sulla pagina di accesso", () => {
  it("una biblioteca d'esempio: ogni documento ha una categoria nota e dei passaggi", () => {
    for (const l of ["it", "en"] as const) {
      const m = mappaDimostrazione(l);
      expect(m.nodes.length).toBeGreaterThanOrEqual(30);
      expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length);
      for (const n of m.nodes) {
        expect(CATEGORIE_DIMOSTRAZIONE as readonly string[]).toContain(n.category);
        expect(n.chunks).toBeGreaterThan(0);
      }
    }
  });

  it("ogni corsa ha una traccia coerente: i passaggi vengono dalla biblioteca, il contesto dai tenuti, le fonti dal contesto", () => {
    for (const l of ["it", "en"] as const) {
      const doc = new Set(mappaDimostrazione(l).nodes.map((n) => n.id));
      for (let n = 0; n < QUANTE_CORSE; n++) {
        const c = corsaDimostrativa(n, l);
        const pool = c.traccia.pool ?? [];
        for (const p of [...pool, ...(c.traccia.bridges ?? [])]) expect(doc.has(p.document_id as number)).toBe(true);
        const tenuti = pool.filter((p) => p.status === "kept").map((p) => p.id);
        expect(tenuti).toHaveLength(4);
        expect(c.traccia.context?.slice(0, 4)).toEqual([...tenuti].sort((a, b) => {
          const ra = pool.find((p) => p.id === a)!.final_rank!, rb = pool.find((p) => p.id === b)!.final_rank!;
          return ra - rb;
        }));
        expect(c.fonti.every((f) => doc.has(f.document_id))).toBe(true);
        /* le frasi verificate rimandano alle fonti della risposta */
        for (const cl of c.verifica.claims ?? []) expect(cl.source).toBeGreaterThanOrEqual(1);
        expect(c.risposta).toMatch(/\[1\]/);
        /* le parole chiave sono nella domanda */
        for (const t of c.traccia.query?.terms ?? []) expect(c.domanda.toLowerCase()).toContain(t.slice(0, 5));
        /* il motore della console la legge senza scartare niente */
        const R = preparaRicerca(c.traccia, c.domanda);
        expect(R.pool.length).toBe(pool.length);
        expect(R.concepts.length).toBeGreaterThan(0);
      }
    }
  });

  it("le corse si alternano e le due lingue raccontano la stessa cosa", () => {
    expect(corsaDimostrativa(0, "it").domanda).not.toBe(corsaDimostrativa(1, "it").domanda);
    expect(corsaDimostrativa(QUANTE_CORSE, "it").domanda).toBe(corsaDimostrativa(0, "it").domanda);
    expect(corsaDimostrativa(0, "en").traccia.pool?.map((p) => p.document_id)).toEqual(corsaDimostrativa(0, "it").traccia.pool?.map((p) => p.document_id));
  });

  it("le fasi sono quelle del crawler della console, una per una", () => {
    expect(FASI_DIMOSTRAZIONE).toHaveLength(FASI_SCIAME.length);
  });
});
