import { describe, expect, it } from "vitest";
import { COLORE_SENZA_ZONA, COLORI_ZONE, coloriDelleZone } from "./traffico";

describe("i colori delle zone del traffico", () => {
  it("seguono l'ordine dei punti, non la classifica: una zona tiene il suo colore", () => {
    const zone = [
      { zone: "Tangenziale", ordine: 30 }, { zone: "Centro", ordine: 10 }, { zone: "Costa", ordine: 20 },
    ];
    expect(coloriDelleZone(zone)).toEqual({ Centro: COLORI_ZONE[0], Costa: COLORI_ZONE[1], Tangenziale: COLORI_ZONE[2] });
    expect(coloriDelleZone([...zone].reverse())).toEqual(coloriDelleZone(zone));
  });

  it("le cinque zone di prima, nell'ordine dei loro punti, hanno i colori di prima", () => {
    /* prima della tappa 6.15 nomi e colori erano scritti nella pagina */
    const diPrima = { "Centro storico": "#ef4444", "Porto / Lido": "#f97316", "Zona Ovest": "#eab308", "Nord / Falconara": "#22c55e", Entroterra: "#6b7280" };
    const zone = Object.keys(diPrima).map((zone, i) => ({ zone, ordine: 1000 + i * 30 }));
    expect(coloriDelleZone(zone)).toEqual(diPrima);
  });

  it("a parità d'ordine vale il nome; oltre i dieci colori si ricomincia", () => {
    expect(coloriDelleZone([{ zone: "B", ordine: 0 }, { zone: "A", ordine: 0 }])).toEqual({ A: COLORI_ZONE[0], B: COLORI_ZONE[1] });
    const tante = Array.from({ length: 12 }, (_, i) => ({ zone: `Z${String(i).padStart(2, "0")}`, ordine: i }));
    const colori = coloriDelleZone(tante);
    expect(colori.Z10).toBe(COLORI_ZONE[0]);
    expect(colori.Z11).toBe(COLORI_ZONE[1]);
    expect(new Set(COLORI_ZONE).size).toBe(COLORI_ZONE.length);
  });

  it("le rilevazioni senza zona sono grigie, e non tolgono un colore alle zone", () => {
    expect(coloriDelleZone([{ zone: "Senza zona", ordine: null }, { zone: "Centro", ordine: 5 }]))
      .toEqual({ "Senza zona": COLORE_SENZA_ZONA, Centro: COLORI_ZONE[0] });
    expect(coloriDelleZone([{ zone: "Senza zona" }])).toEqual({ "Senza zona": COLORE_SENZA_ZONA });
    expect(coloriDelleZone([])).toEqual({});
  });
});
