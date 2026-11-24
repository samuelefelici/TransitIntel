import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CONFINI_INCLUSI, confiniInclusi, coordinate, corpoComune, corpoLuogo, erroriComune, erroriLuogo, MODULO_COMUNE_VUOTO, moduloComuneDa, moduloLuogoDa, moduloLuogoVuoto, numeroScritto,
  richiesteDelTraffico, USI, zoneDeiPunti,
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
    expect(corpoLuogo(m)).toEqual({ nome: "Jesi", uso: "punti_interesse", lat: 43.5222, lng: 13.2436, raggioM: 3000, zona: null, ordine: 0 });
    expect(erroriLuogo({ ...m, raggioM: "50" })).toEqual(["Raggio: da 100 a 50.000 metri"]);
    expect(erroriLuogo({ ...m, lat: "" })).toEqual(["Latitudine: un numero fra -90 e 90"]);
    expect(corpoLuogo({ ...m, uso: "meteo" }).raggioM).toBeNull();
    expect(moduloLuogoDa({ id: "x", nome: "Jesi", uso: "meteo", lat: 43.5, lng: 13.2, raggioM: null, zona: null, ordine: 20 })).toMatchObject({ raggioM: "", zona: "", ordine: "20" });
  });

  it("le coordinate in breve", () => {
    expect(coordinate(43.61661, 13.5185)).toBe("43.6166, 13.5185");
    expect(coordinate(null, null)).toBe("—");
  });
});

describe("i punti stradali del traffico e i centri urbani", () => {
  it("sono due usi dei luoghi, dopo quelli che c'erano", () => {
    expect(USI.map(([uso]) => uso)).toEqual(["punti_interesse", "meteo", "polo_lavoro", "traffico", "centro_urbano"]);
  });

  it("la zona è del solo punto stradale: facoltativa, senza spazi ai lati, al più 60 caratteri", () => {
    const m = { ...moduloLuogoVuoto("traffico"), nome: "A14 nord", lat: "43,64", lng: "13.43", zona: "  Tangenziale " };
    expect(erroriLuogo(m)).toEqual([]);
    expect(corpoLuogo(m)).toEqual({ nome: "A14 nord", uso: "traffico", lat: 43.64, lng: 13.43, raggioM: null, zona: "Tangenziale", ordine: 0 });
    expect(corpoLuogo({ ...m, zona: "   " }).zona).toBeNull();
    expect(erroriLuogo({ ...m, zona: "z".repeat(61) })).toEqual(["Zona: al più 60 caratteri"]);
    /* a un luogo di un altro uso la zona non si manda, nemmeno se è rimasta scritta nella casella */
    expect(corpoLuogo({ ...m, uso: "meteo" }).zona).toBeNull();
    expect(corpoLuogo({ ...m, uso: "centro_urbano" })).toMatchObject({ zona: null, raggioM: null });
    expect(moduloLuogoDa({ id: "x", nome: "A14 nord", uso: "traffico", lat: 43.64, lng: 13.43, raggioM: null, zona: "Tangenziale", ordine: 1000 }).zona).toBe("Tangenziale");
  });

  it("quante richieste costano i punti: le letture dell'API dentro la quota del mese", () => {
    /* i numeri come nel resto delle pagine: in italiano il punto delle migliaia comincia da 10.000 */
    const letture = { quotaMese: 19_000, ogniMin: 87, attivo: true };
    expect(richiesteDelTraffico(37, letture)).toBe("37 punti: una lettura ogni 87 minuti, circa 18.981 richieste in un mese al fornitore del traffico (quota 19.000)");
    expect(richiesteDelTraffico(1, { quotaMese: 19_000, ogniMin: 30, attivo: true })).toBe("1 punto: una lettura ogni 30 minuti, circa 1488 richieste in un mese al fornitore del traffico (quota 19.000)");
    expect(richiesteDelTraffico(37, { ...letture, attivo: false })).toBe("37 punti: le letture sono spente, manca la chiave del fornitore del traffico");
    /* un'API che non dice ancora ogni quanto legge */
    expect(richiesteDelTraffico(37)).toBe("37 punti: ogni lettura è una richiesta per punto al fornitore del traffico");
    expect(richiesteDelTraffico(0, letture)).toBeNull();
  });

  it("le zone già scritte, una volta sola e in ordine: si propongono a chi ne scrive una", () => {
    expect(zoneDeiPunti([
      { uso: "traffico", zona: "Tangenziale" }, { uso: "traffico", zona: "Centro" }, { uso: "traffico", zona: null },
      { uso: "traffico", zona: "Centro" }, { uso: "meteo", zona: null },
    ])).toEqual(["Centro", "Tangenziale"]);
    expect(zoneDeiPunti([])).toEqual([]);
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
