/**
 * Le fermate del progetto rispetto a quelle disegnate sulla mappa — collaudo.
 * Il caso vero: Samuele vede le fermate importate della Domenica Ancona non
 * centrate sui simboli della cartografia. Prima di spostarle bisogna sapere
 * di quanto, in che direzione, e se lo scarto è uguale per tutte (errore di
 * conversione a monte) o sparso (posizioni rilevate una per una).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  abbina, riepiloga, fermateDaTilequery, verificaAllineamento, raggioValido, senzaToken, aGruppi,
  vettore, direzioneDa, svuotaCache, GIA_CENTRATA_M, RAGGIO_MAX_M, RAGGIO_MIN_M, RAGGIO_DEFAULT_M,
  type FermataMappa, type Abbinamento,
} from "../lib/allineamento-fermate";

// Piazza Cavour, Ancona: a questa latitudine 1e-5° di lat ≈ 1,11 m, di lon ≈ 0,80 m
const LAT = 43.6167, LON = 13.5180;
const aNord = (m: number) => m / 111_195;
const aEst = (m: number) => m / (111_195 * Math.cos(LAT * Math.PI / 180));
const mappa = (nordM: number, estM: number, nome: string | null = "Cavour"): FermataMappa =>
  ({ lat: LAT + aNord(nordM), lon: LON + aEst(estM), nome });

describe("vettore e direzione", () => {
  it("misura i metri verso est e verso nord", () => {
    const v = vettore(LAT, LON, LAT + aNord(10), LON + aEst(-5));
    expect(v.nordM).toBeCloseTo(10, 1);
    expect(v.estM).toBeCloseTo(-5, 1);
  });
  it("i punti cardinali", () => {
    expect(direzioneDa(0)).toBe("nord");
    expect(direzioneDa(90)).toBe("est");
    expect(direzioneDa(225)).toBe("sud-ovest");
    expect(direzioneDa(359)).toBe("nord");
    expect(direzioneDa(-90)).toBe("ovest");
  });
});

describe("abbina", () => {
  it("prende la fermata della mappa più vicina e dice di quanto e dove", () => {
    const a = abbina(LAT, LON, [mappa(0, 30, "lontana"), mappa(8, 6, "vicina")], 40)!;
    expect(a.mappa.nome).toBe("vicina");
    expect(a.distanzaM).toBeCloseTo(10, 0);
    expect(a.direzione).toBe("nord-est");
    expect(a.ambigua).toBe(false);
    expect(a.alternativa?.nome).toBe("lontana");
  });

  it("fuori dal raggio non c'è abbinamento: niente spostamenti inventati", () => {
    expect(abbina(LAT, LON, [mappa(60, 0)], 40)).toBeNull();
    expect(abbina(LAT, LON, [], 40)).toBeNull();
  });

  it("due fermate quasi alla stessa distanza (i due lati della strada): ambigua", () => {
    const a = abbina(LAT, LON, [mappa(0, 12, "lato est"), mappa(0, -14, "lato ovest")], 40)!;
    expect(a.ambigua).toBe(true);
  });

  it("già sul simbolo non è ambigua anche se dall'altra parte ce n'è un'altra", () => {
    const a = abbina(LAT, LON, [mappa(0, 1), mappa(0, -4)], 40)!;
    expect(a.distanzaM).toBeLessThanOrEqual(GIA_CENTRATA_M);
    expect(a.ambigua).toBe(false);
  });

  it("scarta le candidate con coordinate non numeriche", () => {
    const a = abbina(LAT, LON, [{ lat: NaN, lon: LON, nome: "x" }, mappa(5, 0)], 40)!;
    expect(a.distanzaM).toBeCloseTo(5, 0);
  });
});

describe("riepiloga", () => {
  const ab = (nordM: number, estM: number, ambigua = false): Abbinamento => {
    const a = abbina(LAT, LON, [mappa(nordM, estM)], 80)!;
    return { ...a, ambigua };
  };

  it("tutte spostate uguale: scarto sistematico, con la media", () => {
    const r = riepiloga(6, [ab(10, 4), ab(11, 5), ab(9, 4), ab(10, 3), ab(10.5, 4.5), ab(9.5, 4)]);
    expect(r.sistematico).toBe(true);
    expect(r.medio!.m).toBeGreaterThan(9);
    expect(r.medio!.direzione).toBe("nord");
    expect(r.nota).toMatch(/SISTEMATICO/);
  });

  it("direzioni diverse: scarto sparso, da vedere una per una", () => {
    const r = riepiloga(6, [ab(10, 0), ab(-10, 0), ab(0, 10), ab(0, -10), ab(7, 7), ab(-7, -7)]);
    expect(r.sistematico).toBe(false);
    expect(r.nota).toMatch(/SPARSO/);
    expect(r.medianaM).toBeGreaterThan(9);
  });

  it("con poche fermate non si dichiara sistematico", () => {
    expect(riepiloga(3, [ab(10, 4), ab(10, 4), ab(10, 4)]).sistematico).toBe(false);
  });

  it("le ambigue non entrano nella media e si contano a parte", () => {
    const r = riepiloga(3, [ab(10, 0), ab(-30, 0, true), null]);
    expect(r.ambigue).toBe(1);
    expect(r.abbinate).toBe(2);
    expect(r.medio!.nordM).toBeCloseTo(10, 0);
  });

  it("nessuna abbinata: lo dice invece di dare numeri", () => {
    const r = riepiloga(4, [null, null, null, null]);
    expect(r.abbinate).toBe(0);
    expect(r.medianaM).toBeNull();
    expect(r.nota).toMatch(/Nessuna fermata della mappa/);
  });
});

describe("fermateDaTilequery", () => {
  it("tiene solo le fermate bus (e tram), non stazioni dei treni né ingressi", () => {
    const j = {
      features: [
        { geometry: { coordinates: [13.518, 43.6167] }, properties: { mode: "bus", stop_type: "stop", name: "Cavour" } },
        { geometry: { coordinates: [13.519, 43.6168] }, properties: { maki: "bus", name: "Stamira" } },
        { geometry: { coordinates: [13.50, 43.61] }, properties: { mode: "rail", stop_type: "station", name: "Ancona" } },
        { geometry: { coordinates: [13.51, 43.61] }, properties: { mode: "bus", stop_type: "entrance" } },
        { geometry: { coordinates: ["x", 43.61] }, properties: { mode: "bus" } },
        null,
      ],
    };
    expect(fermateDaTilequery(j)).toEqual([
      { lat: 43.6167, lon: 13.518, nome: "Cavour" },
      { lat: 43.6168, lon: 13.519, nome: "Stamira" },
    ]);
  });
  it("una risposta strana vale come nessuna fermata", () => {
    expect(fermateDaTilequery(null)).toEqual([]);
    expect(fermateDaTilequery({ features: "no" })).toEqual([]);
  });
});

describe("raggioValido", () => {
  it("default, minimo e massimo", () => {
    expect(raggioValido(undefined)).toBe(RAGGIO_DEFAULT_M);
    expect(raggioValido("")).toBe(RAGGIO_DEFAULT_M);
    expect(raggioValido("abc")).toBe(RAGGIO_DEFAULT_M);
    expect(raggioValido(2)).toBe(RAGGIO_MIN_M);
    expect(raggioValido(5000)).toBe(RAGGIO_MAX_M);
    expect(raggioValido("25")).toBe(25);
  });
});

describe("senzaToken", () => {
  it("il token non esce mai in un messaggio", () => {
    expect(senzaToken("GET https://api.mapbox.com/x.json?radius=40&access_token=pk.SEGRETO&y=1 failed"))
      .toBe("GET https://api.mapbox.com/x.json?radius=40&access_token=***&y=1 failed");
  });
});

describe("aGruppi", () => {
  it("rispetta l'ordine e il numero di lavori insieme", async () => {
    let insieme = 0, massimo = 0;
    const out = await aGruppi([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      insieme++; massimo = Math.max(massimo, insieme);
      await new Promise(r => setTimeout(r, 5 - (x % 3)));
      insieme--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(massimo).toBeLessThanOrEqual(3);
  });
});

describe("verificaAllineamento", () => {
  beforeEach(() => svuotaCache());
  const tq = (features: FermataMappa[]) => ({
    features: features.map(f => ({ geometry: { coordinates: [f.lon, f.lat] }, properties: { mode: "bus", name: f.nome } })),
  });

  it("una fermata per esito, e la chiamata a Mapbox giusta", async () => {
    const urls: string[] = [];
    const risposte: Record<string, FermataMappa[]> = {
      a: [mappa(10, 0)],                       // da spostare
      b: [mappa(1, 0)],                        // centrata
      c: [],                                   // nessuna sulla mappa
      d: [mappa(0, 12), mappa(0, -14)],        // ambigua
    };
    const fermate = Object.keys(risposte).map((k, i) => ({ id: k, codice: null, nome: k, lat: LAT, lon: LON + i * 1e-7 }));
    const r = await verificaAllineamento(fermate, 40, "pk.prova", async (url) => {
      urls.push(url);
      const i = fermate.findIndex(f => url.includes(`${f.lon},${f.lat}.json`));
      return tq(risposte[fermate[i].id]);
    });
    expect(r.fermate.map(f => f.esito)).toEqual(["da_spostare", "centrata", "nessuna_sulla_mappa", "ambigua"]);
    expect(urls[0]).toMatch(/mapbox\.mapbox-streets-v8\/tilequery\//);
    expect(urls[0]).toMatch(/layers=transit_stop_label/);
    expect(r.riepilogo.controllate).toBe(4);
  });

  it("un errore su una fermata non ferma le altre e non mostra il token", async () => {
    const fermate = [
      { id: "a", codice: null, nome: "a", lat: LAT, lon: LON },
      { id: "b", codice: null, nome: "b", lat: LAT + 0.001, lon: LON },
    ];
    const r = await verificaAllineamento(fermate, 40, "pk.SEGRETO", async (url) => {
      if (url.includes(`${LAT + 0.001}`)) throw new Error(`fallita ${url}`);
      return tq([mappa(5, 0)]);
    });
    expect(r.fermate[0].esito).toBe("da_spostare");
    expect(r.fermate[1].esito).toBe("errore");
    expect(r.fermate[1].errore).not.toMatch(/SEGRETO/);
  });

  it("se la cartografia non risponde per nessuna, la verifica fallisce invece di dire «nessuna sulla mappa»", async () => {
    const fermate = [{ id: "a", codice: null, nome: "a", lat: LAT, lon: LON }];
    await expect(verificaAllineamento(fermate, 40, "pk.x", async () => { throw new Error("Mapbox ha risposto 401"); }))
      .rejects.toThrow(/cartografia non raggiungibile.*401/);
  });
});
