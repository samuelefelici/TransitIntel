import { describe, expect, it } from "vitest";
import { caso, corteccia, rgba, suCervello, suTronco } from "./argos-cervello3d";

describe("il campo 2D sul cervello", () => {
  const griglia: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 400; i++) griglia.push([caso(i, 1) * 2.4 - 1.2, caso(i, 2) * 2.4 - 1.2, caso(i, 3), caso(i, 4)]);

  it("sempre lo stesso punto per gli stessi numeri (la forma non cambia a ogni ricostruzione)", () => {
    expect(suCervello(0.3, -0.2, 0.7, 0.1)).toEqual(suCervello(0.3, -0.2, 0.7, 0.1));
    expect(caso(17, 5)).toBe(caso(17, 5));
    expect(caso(17, 5)).not.toBe(caso(18, 5));
  });

  it("la scissura: nessun punto in mezzo ai due emisferi, la sinistra del campo a sinistra", () => {
    for (const [u, v, a, b] of griglia) {
      const [X] = suCervello(u, v, a, b);
      expect(Math.abs(X)).toBeGreaterThan(0.06);
      if (u < -0.02) expect(X).toBeLessThan(0);
      if (u > 0.02) expect(X).toBeGreaterThan(0);
    }
  });

  it("dentro la sagoma del cervello, l'alto del campo in alto, la profondità dal terzo numero", () => {
    for (const [u, v, a, b] of griglia) {
      const [X, Y, Z] = suCervello(u, v, a, b);
      expect(Math.abs(X)).toBeLessThan(1.2);
      expect(Y).toBeLessThan(0.92);
      expect(Y).toBeGreaterThan(-0.85); // la base, schiacciata
      expect(Math.abs(Z)).toBeLessThan(1.45);
      for (const k of [X, Y, Z]) expect(Number.isFinite(k)).toBe(true);
    }
    expect(suCervello(0.2, -0.8, 0.5, 0.5)[1]).toBeGreaterThan(0.5);
    expect(suCervello(0.2, 0.8, 0.5, 0.5)[1]).toBeLessThan(-0.4);
    expect(suCervello(0.5, 0.1, 0, 0.5)[2]).toBeLessThan(-0.8);
    expect(suCervello(0.5, 0.1, 1, 0.5)[2]).toBeGreaterThan(0.8);
    // il bordo del campo è il lato esterno dell'emisfero, il centro del campo la scissura
    expect(Math.abs(suCervello(0.98, 0, 0.5, 0.5)[0])).toBeGreaterThan(1);
    expect(Math.abs(suCervello(0.03, 0, 0.5, 0.5)[0])).toBeLessThan(0.15);
  });

  it("gli strumenti nel tronco, sotto il cervello", () => {
    for (let i = 0; i < 50; i++) {
      const [X, Y] = suTronco(caso(i, 1), caso(i, 2), caso(i, 3));
      expect(Y).toBeLessThanOrEqual(-0.72);
      expect(Y).toBeGreaterThan(-1.5);
      expect(Math.abs(X)).toBeLessThan(0.15);
    }
  });
});

describe("la corteccia", () => {
  const C = corteccia(2000);

  it("sempre la stessa, con la luce fra 0 e 1", () => {
    expect(corteccia(2000).pos).toEqual(C.pos);
    expect(C.pos).toHaveLength(6000);
    for (const l of C.luce) { expect(l).toBeGreaterThanOrEqual(0); expect(l).toBeLessThanOrEqual(1); }
  });

  it("due emisferi separati dalla scissura, più lunghi che larghi; il cervelletto dietro, in basso", () => {
    const nCer = Math.round(2000 * 0.14);
    let sx = 0, dx = 0, maxX = 0, maxZ = 0;
    for (let i = nCer; i < 2000; i++) {
      const X = C.pos[i * 3]!, Z = C.pos[i * 3 + 2]!;
      if (X < 0) sx++; else dx++;
      expect(Math.abs(X)).toBeGreaterThan(0.45 * 0.18); // la parete piatta resta dal suo lato
      maxX = Math.max(maxX, Math.abs(X)); maxZ = Math.max(maxZ, Math.abs(Z));
    }
    expect(Math.min(sx, dx) / Math.max(sx, dx)).toBeGreaterThan(0.85);
    expect(maxZ).toBeGreaterThan(maxX);
    for (let i = 0; i < nCer; i++) {
      expect(C.pos[i * 3 + 1]!).toBeLessThan(-0.3);
      expect(C.pos[i * 3 + 2]!).toBeLessThan(-0.5);
    }
  });
});

describe("i colori della tavolozza per WebGL", () => {
  it("esadecimali corti e lunghi, rgb e rgba", () => {
    expect(rgba("#fff")).toEqual([1, 1, 1, 1]);
    expect(rgba("#14b8a6").map(x => Math.round(x * 255))).toEqual([20, 184, 166, 255]);
    expect(rgba("rgba(51, 65, 85, 0.13)")).toEqual([51 / 255, 65 / 255, 85 / 255, 0.13]);
    expect(rgba("rgb(255,0,0)")).toEqual([1, 0, 0, 1]);
  });
  it("un colore che non conosce diventa bianco, senza errori", () => {
    expect(rgba("violetto")).toEqual([1, 1, 1, 1]);
  });
});
