/**
 * Il catalogo dei titoli di viaggio (tappa 6.9): i biglietti e gli
 * abbonamenti con cui si riempie un feed sono un dato dell'azienda. Prima
 * erano tre elenchi nel codice.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bigliettiDelleFasce, differenze, difettoDelTitolo, ModificaTitolo, NuovoTitolo, regoleUrbane, titoliDaCopiare, titoloNelFeed,
  type ProdottoDelFeed, type TitoloCatalogo, type TitoloNelFeed,
} from "../lib/titoli-catalogo";
import { SenzaFasce } from "../lib/fasce-km";
import { retiUrbane } from "../lib/reti-linee";
import { FASCE_DI_PROVA } from "./helpers/fasce-di-prova";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";
import { TITOLI_DI_PRIMA, TITOLI_DI_PROVA } from "./helpers/titoli-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

const perId = (titoli: readonly TitoloNelFeed[]) => new Map(titoli.map((t) => [t.id, t]));
/** I nove biglietti che nel catalogo hanno una durata; prima, dall'elenco grande, uscivano senza. */
const CON_DURATA = ["ancona_60min", "ancona_100min", "jesi_60min", "jesi_ar", "falc_60min", "falc_ar", "cfd_60min", "sasso_60min", "senigallia_60min"];
const DI_RIFERIMENTO = ["ancona_60min", "jesi_60min", "falc_60min", "cfd_60min", "sasso_60min", "senigallia_60min"];

describe("il catalogo di prova", () => {
  it("ha i 159 titoli degli elenchi di prima, ognuno una volta", () => {
    expect(TITOLI_DI_PROVA.length).toBe(159);
    expect(new Set(TITOLI_DI_PROVA.map((t) => t.titolo)).size).toBe(159);
    expect(TITOLI_DI_PROVA.filter((t) => t.fascia !== null).length).toBe(96);
    expect(TITOLI_DI_PROVA.filter((t) => t.diRiferimento).map((t) => t.titolo).sort()).toEqual([...DI_RIFERIMENTO].sort());
    expect(TITOLI_DI_PROVA.map((t) => t.ordine)).toEqual(Array.from({ length: 159 }, (_, i) => i + 1));
  });

  it("ogni rete urbana ha il suo biglietto di riferimento, e uno solo", () => {
    const perRete = new Map<string, string[]>();
    for (const t of TITOLI_DI_PROVA.filter((x) => x.diRiferimento)) perRete.set(t.rete, [...(perRete.get(t.rete) ?? []), t.titolo]);
    expect([...perRete.keys()].sort()).toEqual(retiUrbane().map((r) => r.rete).sort());
    expect([...perRete.values()].every((v) => v.length === 1)).toBe(true);
  });
});

describe("dal catalogo a un feed: lo stesso risultato di prima", () => {
  it("tutto il catalogo dà i 159 titoli che scriveva «seed-abbonamenti», con gli stessi nomi e prezzi", () => {
    const ora = titoliDaCopiare(TITOLI_DI_PROVA, FASCE_DI_PROVA, "catalogo");
    expect(ora.map((t) => t.id)).toEqual(TITOLI_DI_PRIMA.abbonamenti.map((t) => t.id));
    const prima = perId(TITOLI_DI_PRIMA.abbonamenti);
    for (const t of ora) {
      const p = prima.get(t.id)!;
      /* la sola differenza voluta: nove biglietti ora hanno la durata, e sei sono di riferimento */
      const atteso = CON_DURATA.includes(t.id) ? { ...p, durata: t.id === "ancona_100min" ? 100 : 60, orario: DI_RIFERIMENTO.includes(t.id) } : p;
      expect(t, t.id).toEqual(atteso);
    }
  });

  it("i biglietti: uno per fascia, uguali a prima, e quelli del catalogo", () => {
    const ora = titoliDaCopiare(TITOLI_DI_PROVA, FASCE_DI_PROVA, "biglietti");
    const prima = perId(TITOLI_DI_PRIMA.base);
    const perFascia = ora.filter((t) => t.tipo === "zone");
    expect(perFascia).toEqual(TITOLI_DI_PRIMA.base.filter((t) => t.tipo === "zone"));
    expect(perFascia.length).toBe(23);
    const urbani = perId(ora.filter((t) => t.tipo !== "zone"));
    expect(urbani.size).toBe(20);
    /* i quattro che c'erano anche nel seed di base sono identici */
    for (const id of ["ancona_60min", "ancona_100min", "jesi_60min", "jesi_ar"]) expect(urbani.get(id), id).toEqual(prima.get(id));
    /* i due di Falconara hanno un identificativo solo, quello dell'elenco grande: il resto è uguale */
    expect({ ...urbani.get("falc_60min")!, id: "falconara_60min" }).toEqual(prima.get("falconara_60min"));
    expect({ ...urbani.get("falc_ar")!, id: "falconara_ar" }).toEqual(prima.get("falconara_ar"));
    expect([urbani.has("falconara_60min"), urbani.has("falconara_ar")]).toEqual([false, false]);
  });

  it("un titolo per fascia prende nel nome la fascia e i suoi chilometri", () => {
    const t = TITOLI_DI_PROVA.find((x) => x.titolo === "extra_mens_ord_fascia_6")!;
    expect(t).toMatchObject({ nome: "Extraurbano Mensile Ordinario", fascia: 6, prezzo: 75.6 });
    expect(titoloNelFeed(t, FASCE_DI_PROVA)).toEqual({
      id: "extra_mens_ord_fascia_6", nome: "Extraurbano Mensile Ordinario — Fascia 6 (30–36 km)", rete: "extraurbano", tipo: "abbonamento_mensile",
      categoria: "ordinario", prezzo: 75.6, durata: 43200, orario: false,
    });
    expect(titoloNelFeed(t, [{ fascia: 6, kmFrom: 31.5, kmTo: 40, price: 3 }])!.nome).toBe("Extraurbano Mensile Ordinario — Fascia 6 (31.5–40 km)");
  });

  it("con meno fasce si copiano solo i titoli delle fasce che ci sono", () => {
    const tre = FASCE_DI_PROVA.slice(0, 3);
    const ora = titoliDaCopiare(TITOLI_DI_PROVA, tre, "catalogo");
    expect(ora.length).toBe(63 + 8 * 3);
    expect(ora.some((t) => t.id === "extra_sett_ord_fascia_4")).toBe(false);
    expect(titoliDaCopiare(TITOLI_DI_PROVA, tre, "biglietti").filter((t) => t.tipo === "zone").map((t) => t.id)).toEqual(["extra_fascia_1", "extra_fascia_2", "extra_fascia_3"]);
  });

  it("senza fasce: un catalogo con titoli per fascia non si può copiare; uno solo urbano sì", () => {
    expect(() => titoliDaCopiare(TITOLI_DI_PROVA, [], "catalogo")).toThrow(SenzaFasce);
    const soloUrbano = TITOLI_DI_PROVA.filter((t) => t.rete !== "extraurbano");
    expect(titoliDaCopiare(soloUrbano, [], "catalogo").length).toBe(soloUrbano.length);
    /* i biglietti di un'azienda solo urbana: nessuno per fascia */
    expect(titoliDaCopiare(TITOLI_DI_PROVA, [], "biglietti").every((t) => t.tipo !== "zone")).toBe(true);
    expect(bigliettiDelleFasce([])).toEqual([]);
  });
});

describe("le regole di tratta delle reti urbane", () => {
  const prodotto = (t: TitoloNelFeed): ProdottoDelFeed => ({
    fareProductId: t.id, fareProductName: t.nome, networkId: t.rete, fareType: t.tipo, amount: t.prezzo, durationMinutes: t.durata, isUrbanHourly: t.orario,
  });

  it("da un feed riempito come prima escono le sei regole di prima, con gli stessi nomi", () => {
    expect(regoleUrbane(TITOLI_DI_PRIMA.base.map(prodotto), retiUrbane())).toEqual([
      { legGroupId: "lg_ancona_60", networkId: "urbano_ancona", fareProductId: "ancona_60min" },
      { legGroupId: "lg_ancona_100", networkId: "urbano_ancona", fareProductId: "ancona_100min" },
      { legGroupId: "lg_jesi_60", networkId: "urbano_jesi", fareProductId: "jesi_60min" },
      { legGroupId: "lg_jesi_ar", networkId: "urbano_jesi", fareProductId: "jesi_ar" },
      { legGroupId: "lg_falconara_60", networkId: "urbano_falconara", fareProductId: "falconara_60min" },
      { legGroupId: "lg_falconara_ar", networkId: "urbano_falconara", fareProductId: "falconara_ar" },
    ]);
  });

  it("da un feed riempito dal catalogo: tutte le reti urbane, e verso titoli che nel feed ci sono", () => {
    const feed = titoliDaCopiare(TITOLI_DI_PROVA, FASCE_DI_PROVA, "catalogo").map(prodotto);
    const regole = regoleUrbane(feed, retiUrbane());
    expect(regole.map((r) => r.fareProductId)).toEqual([
      "ancona_60min", "ancona_100min", "jesi_60min", "jesi_ar", "falc_60min", "falc_ar", "senigallia_60min", "cfd_60min", "sasso_60min",
    ]);
    expect(regole.map((r) => r.legGroupId)).toEqual([
      "lg_ancona_60", "lg_ancona_100", "lg_jesi_60", "lg_jesi_ar", "lg_falc_60", "lg_falc_ar", "lg_senigallia_60", "lg_cfd_60", "lg_sasso_60",
    ]);
    const ids = new Set(feed.map((p) => p.fareProductId));
    expect(regole.every((r) => ids.has(r.fareProductId))).toBe(true);
  });

  it("niente regola per un biglietto senza durata, per un abbonamento, per l'extraurbano o per un doppione", () => {
    const p = (id: string, rete: string, tipo: string, durata: number | null): ProdottoDelFeed =>
      ({ fareProductId: id, fareProductName: id, networkId: rete, fareType: tipo, amount: 1, durationMinutes: durata, isUrbanHourly: false });
    expect(regoleUrbane([
      p("ancona_24h", "urbano_ancona", "single", null), p("ancona_mens_ord", "urbano_ancona", "abbonamento_mensile", 43200),
      p("extra_fascia_1", "extraurbano", "zone", null), p("jesi_60min", "urbano_jesi", "single", 60), p("jesi_60min", "urbano_jesi", "single", 60),
      p("altrove_60min", "urbano_altrove", "single", 60),
    ], retiUrbane())).toEqual([{ legGroupId: "lg_jesi_60", networkId: "urbano_jesi", fareProductId: "jesi_60min" }]);
    expect(regoleUrbane([p("jesi_60min", "urbano_jesi", "single", 60)], [])).toEqual([]);
  });
});

describe("un titolo che sta in piedi", () => {
  it("la fascia solo sull'extraurbano; di riferimento solo un biglietto di corsa semplice urbano", () => {
    const t = (parte: Partial<TitoloCatalogo>) => ({ rete: "urbano_ancona", tipo: "single" as const, fascia: null, diRiferimento: false, ...parte });
    expect(difettoDelTitolo(t({}), "urbano")).toBeNull();
    expect(difettoDelTitolo(t({ diRiferimento: true }), "urbano")).toBeNull();
    expect(difettoDelTitolo(t({ fascia: 3 }), "urbano")).toMatch(/^fascia:/);
    expect(difettoDelTitolo(t({ diRiferimento: true, tipo: "return" }), "urbano")).toMatch(/^biglietto di riferimento:/);
    expect(difettoDelTitolo(t({ rete: "extraurbano", diRiferimento: true }), "extraurbano")).toMatch(/^biglietto di riferimento:/);
    expect(difettoDelTitolo(t({ rete: "extraurbano", fascia: 3, tipo: "abbonamento_mensile" }), "extraurbano")).toBeNull();
  });

  it("l'API vuole identificativo, nome, rete, tipo e prezzo in forma, e niente campi in più", () => {
    const buono = { titolo: "pesaro_60min", nome: "Biglietto Urbano Pesaro 60 min", rete: "urbano_pesaro", tipo: "single", prezzo: 1.5 };
    expect(NuovoTitolo.parse(buono)).toEqual({ ...buono, categoria: "ordinario", durataMinuti: null, fascia: null, diRiferimento: false });
    for (const parte of [
      { titolo: "Pesaro 60" }, { titolo: "" }, { nome: "" }, { nome: 'Biglietto "speciale"' }, { nome: "a\nb" }, { rete: "Urbano Pesaro" },
      { tipo: "zone" }, { prezzo: -1 }, { prezzo: 1.555 }, { prezzo: "1,50" }, { durataMinuti: 0 }, { durataMinuti: 1.5 }, { fascia: 0 }, { altro: 1 },
    ]) expect(NuovoTitolo.safeParse({ ...buono, ...parte }).success, JSON.stringify(parte)).toBe(false);
    expect(NuovoTitolo.safeParse({ ...buono, nome: "Abbonamento ISEE < 18.000 (ott–giu), quota ≤ 36 km + urbano" }).success).toBe(true);
    expect(ModificaTitolo.safeParse({ prezzo: 2, durataMinuti: null }).success).toBe(true);
    expect(ModificaTitolo.safeParse({ titolo: "altro" }).success).toBe(false);
  });

  it("le differenze fra un titolo del feed e il catalogo, a parole", () => {
    const t: TitoloNelFeed = { id: "jesi_60min", nome: "Biglietto Urbano Jesi 60 min", rete: "urbano_jesi", tipo: "single", categoria: "ordinario", prezzo: 1.5, durata: 60, orario: true };
    const uguale = { nome: t.nome, rete: t.rete, tipo: t.tipo, categoria: t.categoria, prezzo: 1.5, durata: 60 };
    expect(differenze(uguale, t)).toEqual([]);
    expect(differenze({ ...uguale, prezzo: 1.5000001 }, t)).toEqual([]);
    expect(differenze({ ...uguale, prezzo: 1.35, durata: null, nome: "Jesi 60" }, t))
      .toEqual(["prezzo 1,35 → 1,50", "nome «Jesi 60» → «Biglietto Urbano Jesi 60 min»", "durata nessuna → 60"]);
    expect(differenze({ ...uguale, tipo: "return", rete: null, categoria: null }, t)).toEqual(["tipo return → single", "rete nessuna → urbano_jesi", "categoria nessuna → ordinario"]);
  });
});

describe("la migrazione 0042 carica nell'installazione di Conerobus il catalogo di prima", () => {
  const sqlMigrazione = readFileSync(join(__dirname, "../../../../lib/db/migrations/0042_il_catalogo_dei_titoli.sql"), "utf8");

  it("i 159 titoli, uno per uno", () => {
    const blocco = sqlMigrazione.slice(sqlMigrazione.indexOf("  FROM (VALUES") + 14, sqlMigrazione.indexOf("  ) AS t("));
    const righe = blocco.split("\n").map((r) => r.trim()).filter((r) => r.startsWith("(")).map((r) =>
      [...r.matchAll(/'((?:[^']|'')*)'|\b(NULL|true|false)\b|(-?\d+(?:\.\d+)?)/g)].map((m) =>
        m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] === "NULL" ? null : m[2] === "true" ? true : m[2] === "false" ? false : Number(m[3])));
    expect(righe).toEqual(TITOLI_DI_PROVA.map((t) => [t.titolo, t.nome, t.rete, t.tipo, t.categoria, t.prezzo, t.durataMinuti, t.fascia, t.diRiferimento, t.ordine]));
  });

  it("solo dove l'azienda è Conerobus, solo se il catalogo è vuoto, e solo per le reti che ci sono", () => {
    expect(sqlMigrazione).toContain(" WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')\n   AND NOT EXISTS (SELECT 1 FROM public.titoli_catalogo)\n   AND EXISTS (SELECT 1 FROM public.reti r WHERE r.rete = t.rete);");
  });
});

describe("nessun elenco di titoli nel codice", () => {
  const SRC = join(__dirname, "..");
  const sorgenti = (cartella: string): string[] => readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sorgenti(join(cartella, e.name)) : e.name.endsWith(".ts") ? [join(cartella, e.name)] : []);

  it("né identificativi né prezzi dei titoli di un'azienda", () => {
    /* i segni degli elenchi di prima: un titolo col suo identificativo, e i listini per fascia */
    const segni = /"(ancona|jesi|falc|falconara|cfd|sasso|senigallia)_[a-z0-9_]+"|EXTRA_(SETT|MENS|ANN)_/;
    expect([...sorgenti("lib"), ...sorgenti("routes")].filter((f) => segni.test(readFileSync(join(SRC, f), "utf8")))).toEqual([]);
  });
});
