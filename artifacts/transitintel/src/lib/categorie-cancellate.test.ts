import { describe, expect, it } from "vitest";
import {
  avvisoCategorieCancellate, contaCategorieCancellate, haCategoriaCancellata, nonValeMai, senzaCategoria, titoloCategoriaCancellata,
} from "./categorie-cancellate";

const libera = { lostCategories: 0, categories: [] };
const normale = { lostCategories: 0, categories: [{ id: "a" }] };
const soloCancellata = { lostCategories: 1, categories: [] };
const mista = { lostCategories: 1, categories: [{ id: "a" }] };

describe("corse con una categoria cancellata", () => {
  it("riconosce i tre casi", () => {
    expect([libera, normale, soloCancellata, mista].map(haCategoriaCancellata)).toEqual([false, false, true, true]);
    expect([libera, normale, soloCancellata, mista].map(nonValeMai)).toEqual([false, false, true, false]);
    // «senza categoria» è solo chi non ha nessuna riga: una corsa con la sola categoria cancellata non vale «in ogni periodo»
    expect([libera, normale, soloCancellata, mista].map(senzaCategoria)).toEqual([true, false, false, false]);
  });

  it("i campi che mancano (API di prima) non danno falsi allarmi", () => {
    expect(haCategoriaCancellata({})).toBe(false);
    expect(senzaCategoria({})).toBe(true);
    expect(contaCategorieCancellate([{}, { categories: null }])).toEqual({ corse: 0, nonValgonoMai: 0 });
  });

  it("conta", () => {
    expect(contaCategorieCancellate([libera, normale, soloCancellata, mista, soloCancellata])).toEqual({ corse: 3, nonValgonoMai: 2 });
  });

  it("l'avviso dice quante, e quante non valgono mai", () => {
    expect(avvisoCategorieCancellate({ corse: 0, nonValgonoMai: 0 })).toBe("");
    expect(avvisoCategorieCancellate({ corse: 1, nonValgonoMai: 1 }))
      .toBe("1 corsa è legata a una categoria che è stata cancellata. Non vale in nessun giorno: non esce in quadri orari, GTFS e turni.");
    expect(avvisoCategorieCancellate({ corse: 12, nonValgonoMai: 12 }))
      .toBe("12 corse sono legate a una categoria che è stata cancellata. Non valgono in nessun giorno: non escono in quadri orari, GTFS e turni.");
    expect(avvisoCategorieCancellate({ corse: 12, nonValgonoMai: 5 }))
      .toBe("12 corse sono legate a una categoria che è stata cancellata. 5 non valgono in nessun giorno: non escono in quadri orari, GTFS e turni.");
    expect(avvisoCategorieCancellate({ corse: 3, nonValgonoMai: 0 }))
      .toBe("3 corse sono legate a una categoria che è stata cancellata. Valgono solo nei giorni delle altre loro categorie.");
  });

  it("il suggerimento di riga distingue chi non vale mai", () => {
    expect(titoloCategoriaCancellata(soloCancellata)).toMatch(/non vale in nessun giorno/);
    expect(titoloCategoriaCancellata(mista)).toMatch(/solo nei giorni delle altre/);
  });
});
