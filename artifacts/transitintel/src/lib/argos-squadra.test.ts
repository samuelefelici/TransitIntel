import { describe, expect, it } from "vitest";
import { membroDa, nomiAttesi, squadraDa, unisciSquadra, type MembroSquadra } from "./argos-squadra";

const m = (id: string, stato: MembroSquadra["stato"], extra: Partial<MembroSquadra> = {}): MembroSquadra =>
  ({ id, agente: "turnista", nome: "Turnista", stato, strumenti: 0, ...extra });

describe("la squadra di Argos", () => {
  it("un avviso valido si legge; uno storto no", () => {
    expect(membroDa({ id: "1.1", agente: "officina", nome: "Officina", stato: "fatto", strumenti: 3, ms: 4200, run_id: 7 }))
      .toEqual({ id: "1.1", agente: "officina", nome: "Officina", stato: "fatto", run_id: 7, strumenti: 3, ultimo: null, ms: 4200, errore: null, dopo: [] });
    expect(membroDa({ id: "1.1", agente: "officina", stato: "boh" })).toBeNull();
    expect(membroDa({ agente: "officina", stato: "fatto" })).toBeNull();
    expect(membroDa("officina")).toBeNull();
    expect(membroDa({ id: "1.2", agente: "officina", stato: "al_lavoro", strumenti: -3, ms: Number.NaN })?.strumenti).toBe(0);
  });

  it("il lavoro in catena: chi aspetta chi, coi nomi dei colleghi", () => {
    const turni = membroDa({ id: "turni", agente: "turnista", nome: "Turnista", stato: "al_lavoro" })!;
    const analisi = membroDa({ id: "analisi", agente: "analista", nome: "Analista", stato: "in_attesa", dopo: ["turni", 3, "fuori"] })!;
    expect(analisi.stato).toBe("in_attesa");
    expect(analisi.dopo).toEqual(["turni", "fuori"]);
    expect(nomiAttesi(analisi, [turni, analisi])).toEqual(["Turnista", "fuori"]);
    expect(membroDa({ id: "x", agente: "a", stato: "fatto" })!.dopo).toEqual([]);
  });

  it("gli avvisi dello stesso incarico si fondono, nell'ordine d'arrivo", () => {
    let l = unisciSquadra(undefined, m("1.1", "al_lavoro"));
    l = unisciSquadra(l, { ...m("1.2", "al_lavoro"), agente: "officina", nome: "Officina" });
    l = unisciSquadra(l, m("1.1", "fatto", { strumenti: 4, ms: 3000 }));
    expect(l.map(x => [x.id, x.stato])).toEqual([["1.1", "fatto"], ["1.2", "al_lavoro"]]);
    expect(l[0]!.strumenti).toBe(4);
  });

  it("lo stesso agente con due compiti resta due volte", () => {
    const l = unisciSquadra(unisciSquadra([], m("1.1", "fatto")), m("2.1", "al_lavoro"));
    expect(l).toHaveLength(2);
  });

  it("dalla storia: solo le righe buone, al più dodici", () => {
    const righe = [...Array.from({ length: 15 }, (_, i) => ({ id: `1.${i}`, agente: "analista", stato: "fatto" })), { id: "x" }];
    expect(squadraDa(righe)).toHaveLength(12);
    expect(squadraDa([{ id: "1.1", agente: "officina", stato: "fatto" }, null, 3])).toHaveLength(1);
    expect(squadraDa("niente")).toEqual([]);
  });
});
