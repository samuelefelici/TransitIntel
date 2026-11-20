import { describe, it, expect } from "vitest";
import {
  conPuntoScelto, confiniDalleFasce, fasciaDeiKm, matriceDelleFasce, nodiSalvati, puntiDelleTratte, trattaDelleFermate,
} from "./polimetrica";
import type { FasciaKm } from "./fasce-km";

/** Fasce da 6 km fino a 42, poi una da 8 e poi da 10: più lunghe in fondo, come capita nelle tariffe regionali. */
const limiti = [6, 12, 18, 24, 30, 36, 42, 50, 60, 70];
const FASCE: FasciaKm[] = limiti.map((a, i) => ({ fascia: i + 1, kmFrom: i === 0 ? 0 : limiti[i - 1]!, kmTo: a, price: 1 + i * 0.5 }));

/** Un'azienda con fasce tutte sue: 5 km, poi 10, poi 25. */
const ALTRE: FasciaKm[] = [
  { fascia: 1, kmFrom: 0, kmTo: 5, price: 1 },
  { fascia: 2, kmFrom: 5, kmTo: 15, price: 2 },
  { fascia: 3, kmFrom: 15, kmTo: 40, price: 3 },
];

const fermate = (...km: number[]) => km.map((k) => ({ km: k }));

describe("la fascia di una distanza", () => {
  it("il limite sta nella fascia che finisce lì, un metro oltre nella successiva", () => {
    expect([0, 2, 6, 6.001, 6.05, 12, 37.5, 42, 42.5, 50, 59.5].map((d) => fasciaDeiKm(d, FASCE)))
      .toEqual([1, 1, 1, 2, 2, 2, 7, 7, 8, 8, 9]);
  });

  it("oltre l'ultima vale l'ultima; una differenza di progressivi non scavalca il limite per la virgola mobile", () => {
    expect(fasciaDeiKm(500, FASCE)).toBe(10);
    expect(18.1 - 6.1).not.toBe(12);
    expect(fasciaDeiKm(18.1 - 6.1, FASCE)).toBe(2);
    expect(fasciaDeiKm(-3, FASCE)).toBe(1);
  });

  it("senza fasce non inventa un numero", () => {
    expect(fasciaDeiKm(10, [])).toBeNull();
    expect(fasciaDeiKm(Number.NaN, FASCE)).toBeNull();
  });

  it("vale con le fasce di chiunque", () => {
    expect([4, 5, 5.5, 15, 16, 90].map((d) => fasciaDeiKm(d, ALTRE))).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("le tratte fatte dal programma", () => {
  const percorso = fermate(0, 2.5, 5.9, 6, 6.3, 11, 13, 41.9, 42.4, 49, 51, 58);

  it("cominciano dove, dal capolinea, cambia la fascia: ogni 6 km finché le fasce sono da 6, poi più lunghe", () => {
    expect(confiniDalleFasce(percorso, FASCE)).toEqual([4, 6, 7, 8, 10]);
    const tratta = trattaDelleFermate(percorso.length, confiniDalleFasce(percorso, FASCE));
    expect(tratta).toEqual([0, 0, 0, 0, 1, 1, 2, 3, 4, 4, 5, 5]);
    /* fra 42 e 50 km una tratta sola, non due da 6 */
    expect(percorso.filter((_, i) => tratta[i] === 4).map((f) => f.km)).toEqual([42.4, 49]);
  });

  it("seguono le fasce dell'azienda, non un numero fisso", () => {
    expect(confiniDalleFasce(fermate(0, 4, 5, 6, 14, 15, 15.2, 39), ALTRE)).toEqual([3, 6]);
  });

  it("senza fasce il percorso resta una tratta sola", () => {
    expect(confiniDalleFasce(percorso, [])).toEqual([]);
    expect(trattaDelleFermate(3, [])).toEqual([0, 0, 0]);
  });

  it("i confini fuori dal percorso o ripetuti non contano", () => {
    expect(trattaDelleFermate(5, [3, 3, 0, 9, -1, 1.5])).toEqual([0, 0, 0, 1, 1]);
  });
});

describe("il punto tariffario di un nodo", () => {
  const tratta = [0, 0, 0, 1, 1, 2, 2, 2];

  it("è la prima fermata della tratta, finché non se ne sceglie un'altra", () => {
    expect(puntiDelleTratte(tratta, [])).toEqual([0, 3, 5]);
    expect(puntiDelleTratte(tratta, [4, 7])).toEqual([0, 4, 7]);
  });

  it("due scelte nella stessa tratta (dopo aver tolto un confine): vale la prima; una scelta fuori dal percorso non conta", () => {
    expect(puntiDelleTratte(tratta, [7, 6, 99])).toEqual([0, 3, 6]);
  });

  it("un clic sceglie la fermata al posto di quella di prima; un clic sulla scelta la toglie", () => {
    expect(conPuntoScelto([], 4, tratta)).toEqual([4]);
    expect(conPuntoScelto([4, 7], 3, tratta)).toEqual([3, 7]);
    expect(conPuntoScelto([3, 7], 7, tratta)).toEqual([3]);
    expect(conPuntoScelto([3], 99, tratta)).toEqual([3]);
  });
});

describe("la matrice a gradoni", () => {
  /* i km progressivi dei punti tariffari di una linea di 37,5 km: numeri di prova, fitti come in una polimetrica regionale */
  const linea = [0, 5, 6, 8, 10.5, 13, 16, 17.5, 19, 22, 24.5, 25.5, 26.5, 28.5, 29, 30, 32, 37.5];

  it("fra due nodi dà la fascia dei km fra i loro punti, non il numero di tratte attraversate", () => {
    const m = matriceDelleFasce(linea, FASCE);
    expect(m[0]).toEqual([]);
    expect(m[3]![2]).toBe(1);          // dal km 6 al km 8: 2 km. A tratte da 6 km contate dal capolinea erano due.
    expect(m[2]![1]).toBe(1);          // dal km 5 al km 6
    expect(m[16]![11]).toBe(2);        // dal km 25,5 al km 32: 6,5 km
    expect(m[17]![0]).toBe(7);         // da un capo all'altro: 37,5 km
    expect(m[17]).toEqual([7, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 2, 2, 2, 2, 2, 1]);
  });

  it("oltre i 42 km segue le fasce più lunghe", () => {
    const m = matriceDelleFasce([0, 6, 48.5, 54, 59.5], FASCE);
    expect(m[2]).toEqual([8, 8]);      // 48,5 e 42,5 km; a tratte da 6 km erano 9
    expect(m[4]).toEqual([9, 9, 2, 1]);
  });

  it("dove manca un km o mancano le fasce non scrive un numero", () => {
    expect(matriceDelleFasce([0, null, 12], FASCE)).toEqual([[], [null], [2, null]]);
    expect(matriceDelleFasce([0, 12], [])).toEqual([[], [null]]);
  });
});

describe("una polimetrica salvata", () => {
  it("di ogni tratta dice la prima fermata e il punto tariffario: quello scelto, o la prima", () => {
    const salvate = [
      { km: 0, tratta: 0 }, { km: 2, tratta: 0 },
      { km: 7, tratta: 1 }, { km: 9, tratta: 1, punto: true }, { km: 11, tratta: 1 },
      { km: 14, tratta: 2 },
    ];
    expect(nodiSalvati(salvate, 3)).toEqual([{ prima: 0, punto: 0 }, { prima: 2, punto: 3 }, { prima: 5, punto: 5 }]);
  });

  it("un salvataggio di prima, senza punti scelti, usa la prima fermata di ogni tratta", () => {
    expect(nodiSalvati([{ km: 0, tratta: 0 }, { km: 7, tratta: 1 }, { km: 8, tratta: 1 }], 2)).toEqual([{ prima: 0, punto: 0 }, { prima: 1, punto: 1 }]);
  });

  it("una tratta senza fermate resta vuota", () => {
    expect(nodiSalvati([{ km: 0, tratta: 0 }, { km: 7, tratta: 2 }], 3)).toEqual([{ prima: 0, punto: 0 }, null, { prima: 1, punto: 1 }]);
  });
});
