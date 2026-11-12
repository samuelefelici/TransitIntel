import { describe, expect, it } from "vitest";
import { AREE, MATRICE } from "@workspace/permessi";
import { dirittiDellUtente, puoSuUnaDi } from "./diritti";

describe("dirittiDellUtente", () => {
  it("senza utente non si ha niente", () => {
    for (const a of AREE) expect(dirittiDellUtente(null)[a]).toBeNull();
  });

  it("usa i diritti mandati dall'API, e non crede a livelli che non esistono", () => {
    const d = dirittiDellUtente({ role: "user", diritti: { rete: "S", turni: "L", roster: "X", tariffe: true, inventata: "S" }, permissions: { fares: true } });
    expect(d.rete).toBe("S");
    expect(d.turni).toBe("L");
    expect(d.roster).toBeNull();
    expect(d.tariffe).toBeNull();
    expect(Object.keys(d).sort()).toEqual([...AREE].sort());
  });

  it("l'amministratore scrive ovunque, comunque arrivi", () => {
    for (const u of [{ role: "admin" }, { role: "admin", diritti: {} }, { role: "admin", permissions: {} }]) {
      for (const a of AREE) expect(dirittiDellUtente(u)[a]).toBe("S");
    }
  });

  it("un utente in cache di prima dei ruoli: ogni interruttore acceso vale scrittura sulle sue aree", () => {
    const d = dirittiDellUtente({ role: "user", permissions: { network: true, scheduling: false, roster: true, analytics: true, fares: "true" } });
    expect(d).toMatchObject({ rete: "S", pubblicazione_orari: "S", turni: null, roster: "S", analisi: "S", tariffe: null, personale: null });
  });

  it("i diritti di un ruolo arrivano così come sono", () => {
    const d = dirittiDellUtente({ role: "user", diritti: { ...MATRICE.ufficio_turni } });
    expect(d).toMatchObject({ rete: "L", turni: "S", roster: "L", personale: null, tariffe: null });
  });
});

describe("puoSuUnaDi", () => {
  const d = dirittiDellUtente({ role: "user", diritti: { rete: "L", turni: "S" } });
  it("basta un'area; senza aree la pagina è di tutti", () => {
    expect(puoSuUnaDi(d, ["rete"], "L")).toBe(true);
    expect(puoSuUnaDi(d, ["rete"], "S")).toBe(false);
    expect(puoSuUnaDi(d, ["rete", "turni"], "S")).toBe(true);
    expect(puoSuUnaDi(d, ["roster", "personale"], "L")).toBe(false);
    expect(puoSuUnaDi(d, undefined, "S")).toBe(true);
    expect(puoSuUnaDi(d, [], "S")).toBe(true);
  });
});
