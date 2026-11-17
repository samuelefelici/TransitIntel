import { describe, it, expect } from "vitest";
import {
  avvisiFasce, bozzaDa, corpoFasce, daDellaRiga, erroriFasce, euro, fasceCambiate, fasceDaBozza, km, numero, riassuntoFasce, rigaNuova,
  type FasciaKm, type RigaFascia,
} from "./fasce-km";

const SALVATE: FasciaKm[] = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
  { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 19.5, price: 2.4 },
];
const riga = (a: string, prezzo: string): RigaFascia => ({ a, prezzo });

describe("i numeri come si scrivono", () => {
  it("legge la virgola e il punto, e niente altro", () => {
    expect(["7,5", "7.5", " 12 ", "1,35"].map(numero)).toEqual([7.5, 7.5, 12, 1.35]);
    for (const s of ["", "abc", "1,2,3", "-1", "1e3", "7,"]) expect(Number.isNaN(numero(s)), s).toBe(true);
  });

  it("scrive i chilometri senza zeri inutili e i prezzi con due decimali", () => {
    expect([km(6), km(7.5), euro(1.35), euro(2.4), euro(3)]).toEqual(["6", "7,5", "1,35", "2,40", "3,00"]);
  });
});

describe("il modulo delle fasce", () => {
  it("di ogni fascia tiene dove finisce e quanto costa; comincia dove finisce quella prima", () => {
    const bozza = bozzaDa(SALVATE);
    expect(bozza).toEqual([riga("6", "1,35"), riga("12", "1,85"), riga("19,5", "2,40")]);
    expect([0, 1, 2].map((i) => daDellaRiga(bozza, i))).toEqual([0, 6, 12]);
    expect(fasceDaBozza(bozza)).toEqual(SALVATE);
    expect(corpoFasce(bozza)).toEqual({ fasce: SALVATE });
  });

  it("appena aperto è uguale alle fasce salvate; un numero riscritto uguale non conta", () => {
    const bozza = bozzaDa(SALVATE);
    expect(fasceCambiate(bozza, SALVATE)).toBe(false);
    expect(fasceCambiate([riga("6,0", "1.35"), bozza[1]!, bozza[2]!], SALVATE)).toBe(false);
    expect(fasceCambiate([riga("6", "1,40"), bozza[1]!, bozza[2]!], SALVATE)).toBe(true);
    expect(fasceCambiate(bozza.slice(0, 2), SALVATE)).toBe(true);
  });

  it("togliere una fascia in mezzo non lascia buchi: quella dopo comincia dove finisce quella prima", () => {
    const senzaLaSeconda = [bozzaDa(SALVATE)[0]!, bozzaDa(SALVATE)[2]!];
    expect(fasceDaBozza(senzaLaSeconda)).toEqual([
      { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
      { fascia: 2, kmFrom: 6, kmTo: 19.5, price: 2.4 },
    ]);
    expect(erroriFasce(senzaLaSeconda, 60)).toEqual([]);
  });

  it("dice che cosa non va, fascia per fascia", () => {
    expect(erroriFasce(bozzaDa(SALVATE), 60)).toEqual([]);
    expect(erroriFasce([], 60)).toEqual([]);
    expect(erroriFasce([riga("", ""), riga("5", "0"), riga("5", "1,234"), riga("7,25", "1000"), riga("3000", "abc")], 60)).toEqual([
      "Fascia 1: scrivi fino a quanti chilometri arriva.", "Fascia 1: scrivi il prezzo.",
      "Fascia 2: il prezzo è maggiore di zero.",
      "Fascia 3: deve finire dopo 5 km, dove comincia.", "Fascia 3: il prezzo ha al più due decimali.",
      "Fascia 4: i chilometri hanno al più un decimale.", "Fascia 4: il prezzo è al più 999,99 €.",
      "Fascia 5: al più 2000 km.", "Fascia 5: scrivi il prezzo.",
    ]);
    expect(erroriFasce(bozzaDa(SALVATE), 2)).toEqual(["Le fasce sono al più 2."]);
  });

  it("avvisa se una fascia più lunga costa meno di quella prima, ma lascia salvare", () => {
    const bozza = [riga("6", "1,35"), riga("12", "1,20"), riga("18", "2,00")];
    expect(avvisiFasce(bozza)).toEqual(["La fascia 2 costa meno della 1 (1,20 € contro 1,35 €)."]);
    expect(erroriFasce(bozza, 60)).toEqual([]);
    expect(avvisiFasce(bozzaDa(SALVATE))).toEqual([]);
    expect(avvisiFasce([riga("6", "1,35"), riga("12", "")])).toEqual([]);
  });

  it("la riga nuova è lunga come l'ultima fascia, col prezzo da scrivere", () => {
    expect(rigaNuova([])).toEqual(riga("6", ""));
    expect(rigaNuova(bozzaDa(SALVATE))).toEqual(riga("27", ""));
    expect(rigaNuova([riga("6", "1,35"), riga("12", "1,85")])).toEqual(riga("18", ""));
    expect(rigaNuova([riga("abc", "1")])).toEqual(riga("", ""));
  });

  it("il riassunto: quante fasce, fino a dove, da quanto a quanto", () => {
    expect(riassuntoFasce(SALVATE)).toBe("3 fasce fino a 19,5 km, da 1,35 € a 2,40 €.");
    expect(riassuntoFasce(SALVATE.slice(0, 1))).toBe("Una fascia fino a 6 km, da 1,35 € a 1,35 €.");
    expect(riassuntoFasce([])).toBe("Nessuna fascia: i prezzi dell'extraurbano non si possono calcolare.");
  });
});
