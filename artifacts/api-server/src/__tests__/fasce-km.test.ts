/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8): una tabella sola,
 * dato dell'azienda. Prima era scritta due volte nel codice.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  erroriFasce, fasceKm, fasceObbligate, fasciaNumero, fasciaPerDistanza, impostaFasce, primaFascia, SenzaFasce, ultimaFascia, type FasciaKm,
} from "../lib/fasce-km";
import { Fasce } from "../lib/fasce-km-store";
import { FASCE_DI_PROVA } from "./helpers/fasce-di-prova";

beforeEach(() => impostaFasce(FASCE_DI_PROVA));
afterAll(() => impostaFasce([]));

describe("la fascia di una distanza", () => {
  /** La funzione com'era nel codice fino alla tappa 6.7, con la sua tabella. */
  function comePrima(distKm: number): FasciaKm | undefined {
    return FASCE_DI_PROVA.find((b) => distKm > b.kmFrom && distKm <= b.kmTo)
      ?? (distKm <= 0 ? undefined : FASCE_DI_PROVA[FASCE_DI_PROVA.length - 1]);
  }

  it("una distanza sta nella fascia se è più di «da» e al più «a»", () => {
    expect([0.1, 6, 6.01, 12, 41.9, 42, 42.1, 199.9, 200].map((km) => fasciaPerDistanza(km)?.fascia)).toEqual([1, 1, 2, 2, 7, 7, 8, 23, 23]);
    expect(fasciaPerDistanza(19.8)).toEqual({ fascia: 4, kmFrom: 18, kmTo: 24, price: 2.85 });
  });

  it("oltre l'ultima vale l'ultima; a zero chilometri, o meno, nessuna", () => {
    expect([200.1, 350, 9999].map((km) => fasciaPerDistanza(km)?.fascia)).toEqual([23, 23, 23]);
    expect([0, -1, -0.0001].map((km) => fasciaPerDistanza(km))).toEqual([undefined, undefined, undefined]);
  });

  it("su ogni decimo di chilometro da -5 a 260 dà la fascia di prima", () => {
    for (let d = -50; d <= 2600; d++) {
      const km = d / 10;
      expect(fasciaPerDistanza(km), String(km)).toEqual(comePrima(km));
    }
    expect(fasciaPerDistanza(NaN)).toEqual(comePrima(NaN));
  });

  it("la prima, l'ultima e la fascia per numero", () => {
    expect([primaFascia().price, ultimaFascia().price, fasciaNumero(12).price]).toEqual([1.35, 8.75, 5.45]);
    expect(fasciaNumero(12)).toEqual({ fascia: 12, kmFrom: 80, kmTo: 90, price: 5.45 });
    expect(() => fasciaNumero(24)).toThrow("La fascia 24 non c'è");
  });

  it("le fasce in vigore non si cambiano da fuori, e stanno in ordine di numero", () => {
    expect(() => { (fasceKm() as any).push({}); }).toThrow();
    expect(() => { (fasceKm()[0] as any).price = 0; }).toThrow();
    impostaFasce([...FASCE_DI_PROVA].reverse());
    expect(fasceKm().map((f) => f.fascia)).toEqual(FASCE_DI_PROVA.map((f) => f.fascia));
  });
});

describe("un'azienda che non ha scritto le fasce", () => {
  it("non ha fasce, e chi ne chiede una riceve SenzaFasce col testo da mostrare", () => {
    impostaFasce([]);
    expect(fasceKm()).toEqual([]);
    for (const chiede of [() => fasceObbligate(), () => primaFascia(), () => ultimaFascia(), () => fasciaNumero(1), () => fasciaPerDistanza(10), () => fasciaPerDistanza(0)]) {
      expect(chiede).toThrow(SenzaFasce);
    }
    expect(new SenzaFasce().message).toBe("Mancano le fasce chilometriche dell'extraurbano: le scrive l'amministratore in Amministrazione › Azienda, scheda «Fasce chilometriche»");
  });
});

describe("un elenco di fasce che sta in piedi", () => {
  const f = (fascia: number, kmFrom: number, kmTo: number, price: number): FasciaKm => ({ fascia, kmFrom, kmTo, price });

  it("le fasce di prova, e nessuna fascia, vanno bene", () => {
    expect(erroriFasce(FASCE_DI_PROVA)).toEqual([]);
    expect(erroriFasce([])).toEqual([]);
    expect(erroriFasce([f(1, 0, 7.5, 1.2), f(2, 7.5, 15, 1.9)])).toEqual([]);
  });

  it("dice che cosa non va: numeri saltati, buchi, sovrapposizioni, prezzi", () => {
    expect(erroriFasce([f(1, 0, 6, 1.35), f(3, 6, 12, 1.85)])).toEqual(["Fascia 2: le fasce si numerano da 1 senza saltare (qui c'è 3)."]);
    expect(erroriFasce([f(1, 2, 6, 1.35)])).toEqual(["Fascia 1: la prima fascia parte da 0 km (qui da 2)."]);
    expect(erroriFasce([f(1, 0, 6, 1.35), f(2, 8, 12, 1.85)])).toEqual(["Fascia 2: resta un buco fra 6 e 8 km."]);
    expect(erroriFasce([f(1, 0, 6, 1.35), f(2, 5, 12, 1.85)])).toEqual(["Fascia 2: si sovrappone alla 1 (comincia a 5 km, l'altra finisce a 6)."]);
    expect(erroriFasce([f(1, 0, 6, 1.35), f(2, 6, 6, 1.85)])).toEqual(["Fascia 2: finisce a 6 km, prima di dove comincia (6 km)."]);
    expect(erroriFasce([f(1, 0, 6, 0)])).toEqual(["Fascia 1: il prezzo è maggiore di zero."]);
    expect(erroriFasce([f(1, 0, 2500, 1)])).toEqual(["Fascia 1: al più 2000 km."]);
    expect(erroriFasce([f(1, 0, 6, 1000)])).toEqual(["Fascia 1: il prezzo è al più 999.99 €."]);
    expect(erroriFasce(Array.from({ length: 61 }, (_, i) => f(i + 1, i, i + 1, 1)))).toEqual(["Le fasce sono al più 60."]);
  });

  it("l'API accetta chilometri con un decimale e prezzi con due, e niente campi in più", () => {
    const una = (parte: object) => Fasce.safeParse({ fasce: [{ fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35, ...parte }] }).success;
    expect(una({})).toBe(true);
    expect(una({ kmTo: 6.5, price: 1.3 })).toBe(true);
    expect([una({ kmTo: 6.25 }), una({ price: 1.355 }), una({ price: 0 }), una({ price: "1.35" }), una({ kmFrom: -1 }), una({ note: "x" }), una({ fascia: 0 })])
      .toEqual([false, false, false, false, false, false, false]);
    expect(Fasce.safeParse({ fasce: [], altro: 1 }).success).toBe(false);
    expect(Fasce.safeParse({ fasce: [] }).success).toBe(true);
  });
});

describe("la migrazione 0041 carica nell'installazione di Conerobus le fasce di prima", () => {
  const sqlMigrazione = readFileSync(join(__dirname, "../../../../lib/db/migrations/0041_le_fasce_chilometriche.sql"), "utf8");

  it("le 23 fasce, una per una", () => {
    const blocco = sqlMigrazione.slice(sqlMigrazione.indexOf("(VALUES") + 7, sqlMigrazione.indexOf(") AS f("));
    const righe = blocco.split("\n").map((r) => r.trim()).filter((r) => r.startsWith("(")).map((r) => r.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
    expect(righe).toEqual(FASCE_DI_PROVA.map((x) => [x.fascia, x.kmFrom, x.kmTo, x.price]));
  });

  it("solo dove l'azienda è Conerobus, e solo se la tabella è vuota", () => {
    expect(sqlMigrazione).toContain("WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')\n   AND NOT EXISTS (SELECT 1 FROM public.fasce_km);");
  });
});

describe("una tabella sola nel codice", () => {
  const SRC = join(__dirname, "..");
  const sorgenti = (cartella: string): string[] => readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sorgenti(join(cartella, e.name)) : e.name.endsWith(".ts") ? [join(cartella, e.name)] : []);

  it("nessuna tabella di fasce scritta nel codice", () => {
    /* il segno di una tabella ricopiata: una riga con fascia, chilometri e prezzo */
    const copie = [...sorgenti("lib"), ...sorgenti("routes")]
      .filter((f) => /fascia:\s*\d+,\s*kmFrom:\s*\d+,\s*kmTo:\s*\d+,\s*price:/.test(readFileSync(join(SRC, f), "utf8")));
    expect(copie).toEqual([]);
  });
});
