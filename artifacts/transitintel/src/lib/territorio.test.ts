import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CONFINI_INCLUSI, confiniInclusi, coordinate, corpoComune, corpoLuogo, erroriComune, erroriLuogo, MODULO_COMUNE_VUOTO, moduloComuneDa, moduloLuogoDa, moduloLuogoVuoto, numeroScritto,
} from "./territorio";

describe("il territorio nella pagina Azienda", () => {
  it("i numeri scritti: virgola o punto, vuoto = niente, il resto non è un numero", () => {
    expect(numeroScritto(" 43,6 ")).toBe(43.6);
    expect(numeroScritto("13.5185")).toBe(13.5185);
    expect(numeroScritto("")).toBeNull();
    expect(numeroScritto("12a")).toBeNaN();
  });

  it("un comune: codice a sei cifre, nome, centroide intero o niente", () => {
    expect(erroriComune({ ...MODULO_COMUNE_VUOTO, codiceIstat: "042002", nome: "Ancona" })).toEqual([]);
    expect(erroriComune({ ...MODULO_COMUNE_VUOTO, codiceIstat: "42002", nome: "" })).toEqual(["Codice ISTAT: sei cifre, come 042002", "Il nome va scritto"]);
    expect(erroriComune({ ...MODULO_COMUNE_VUOTO, codiceIstat: "042002", nome: "Ancona", lat: "43.6" })).toEqual(["Latitudine e longitudine vanno insieme"]);
    expect(erroriComune({ ...MODULO_COMUNE_VUOTO, codiceIstat: "042002", nome: "Ancona", popolazione: "12,5" })).toEqual(["Popolazione: un numero intero"]);
    const c = { codiceIstat: "042002", nome: "Ancona", soppresso: false, lat: 43.6166, lng: 13.5185, areaKm2: 124.2, popolazione: 99470, sezioneCensimento: "AN001" };
    expect(corpoComune(moduloComuneDa(c))).toEqual({ nome: "Ancona", soppresso: false, lat: 43.6166, lng: 13.5185, areaKm2: 124.2, popolazione: 99470 });
  });

  it("un luogo: coordinate obbligatorie; il raggio solo per i punti d'interesse", () => {
    expect(moduloLuogoVuoto("punti_interesse").raggioM).toBe("3000");
    expect(moduloLuogoVuoto("meteo").raggioM).toBe("");
    const m = { ...moduloLuogoVuoto("punti_interesse"), nome: "Jesi", lat: "43,5222", lng: "13.2436" };
    expect(erroriLuogo(m)).toEqual([]);
    expect(corpoLuogo(m)).toEqual({ nome: "Jesi", uso: "punti_interesse", lat: 43.5222, lng: 13.2436, raggioM: 3000, ordine: 0 });
    expect(erroriLuogo({ ...m, raggioM: "50" })).toEqual(["Raggio: da 100 a 50.000 metri"]);
    expect(erroriLuogo({ ...m, lat: "" })).toEqual(["Latitudine: un numero fra -90 e 90"]);
    expect(corpoLuogo({ ...m, uso: "meteo" }).raggioM).toBeNull();
    expect(moduloLuogoDa({ id: "x", nome: "Jesi", uso: "meteo", lat: 43.5, lng: 13.2, raggioM: null, ordine: 20 })).toMatchObject({ raggioM: "", ordine: "20" });
  });

  it("le coordinate in breve", () => {
    expect(coordinate(43.61661, 13.5185)).toBe("43.6166, 13.5185");
    expect(coordinate(null, null)).toBe("—");
  });
});

describe("i confini dei comuni inclusi nell'app", () => {
  it("ci sono solo per la provincia che ha il suo file", () => {
    expect(confiniInclusi("042")).toMatchObject({ provincia: "Ancona", comuni: 47 });
    expect([confiniInclusi("041"), confiniInclusi(null), confiniInclusi(undefined), confiniInclusi("")]).toEqual([null, null, null, null]);
  });

  it("ogni file c'è, è di quella provincia e ha quel numero di comuni", () => {
    for (const c of CONFINI_INCLUSI) {
      const geo = JSON.parse(readFileSync(new URL(`../../public/data/${c.file}`, import.meta.url), "utf8")) as
        { features: Array<{ properties: { prov_istat_code: string; prov_name: string } }> };
      expect(geo.features.length, c.file).toBe(c.comuni);
      expect(new Set(geo.features.map((f) => f.properties.prov_istat_code)), c.file).toEqual(new Set([c.provinciaIstat]));
      expect(new Set(geo.features.map((f) => f.properties.prov_name)), c.file).toEqual(new Set([c.provincia]));
    }
    expect(new Set(CONFINI_INCLUSI.map((c) => c.provinciaIstat)).size).toBe(CONFINI_INCLUSI.length);
  });
});
