import { describe, it, expect } from "vitest";
import { ricorda, richiama, dimentica, dimenticaSe, chiaveFucina, chiaveTurniGuida, VALIDITA_MS, type Deposito } from "./memoria-calcoli";

const J = "11111111-2222-3333-4444-555555555555";
function deposito(): Deposito & { dati: Map<string, string> } {
  const dati = new Map<string, string>();
  return { dati, getItem: k => dati.get(k) ?? null, setItem: (k, v) => { dati.set(k, v); }, removeItem: k => { dati.delete(k); } };
}

describe("la memoria dei calcoli aperti", () => {
  it("ricorda, richiama e dimentica per chiave", () => {
    const d = deposito();
    ricorda(chiaveFucina("p1"), { jobId: J, avviatoIl: 1000 }, d);
    expect(richiama(chiaveFucina("p1"), 2000, d)).toEqual({ jobId: J, avviatoIl: 1000 });
    expect(richiama(chiaveFucina("p2"), 2000, d)).toBeNull();
    expect(richiama(chiaveTurniGuida("p1"), 2000, d)).toBeNull();
    dimentica(chiaveFucina("p1"), d);
    expect(richiama(chiaveFucina("p1"), 2000, d)).toBeNull();
  });

  it("dimenticaSe cancella solo se ricorda ancora quel calcolo; la sonda applicata si conserva", () => {
    const d = deposito();
    const altro = "99999999-2222-3333-4444-555555555555";
    const t = Date.now();
    ricorda("k", { jobId: J, avviatoIl: t, sondaApplicata: true }, d);
    expect(richiama("k", t + 1, d)).toEqual({ jobId: J, avviatoIl: t, sondaApplicata: true });
    dimenticaSe("k", altro, d);
    expect(richiama("k", t + 1, d)?.jobId).toBe(J);
    dimenticaSe("k", J, d);
    expect(richiama("k", t + 1, d)).toBeNull();
  });

  it("oltre 7 giorni, o rovinata, non vale e si cancella", () => {
    const d = deposito();
    ricorda("x", { jobId: J, avviatoIl: 0 }, d);
    expect(richiama("x", VALIDITA_MS + 1, d)).toBeNull();
    expect(d.dati.size).toBe(0);
    d.setItem("cerbero:calcolo:y", "{non json");
    expect(richiama("y", 0, d)).toBeNull();
    d.setItem("cerbero:calcolo:z", JSON.stringify({ jobId: "../../altro", avviatoIl: 0 }));
    expect(richiama("z", 0, d)).toBeNull();
    expect(d.dati.size).toBe(0);
  });

  it("senza localStorage (o se lancia) la pagina va avanti senza memoria", () => {
    const rotto: Deposito = { getItem: () => { throw new Error("bloccato"); }, setItem: () => { throw new Error("pieno"); }, removeItem: () => { throw new Error("no"); } };
    expect(() => ricorda("x", { jobId: J, avviatoIl: 0 }, rotto)).not.toThrow();
    expect(richiama("x", 0, rotto)).toBeNull();
    expect(() => dimentica("x", rotto)).not.toThrow();
    expect(richiama("x", 0, null)).toBeNull();
  });
});
