/**
 * Le linee extraurbane dell'import delle polimetriche (tappa 6.28): le dicono
 * le reti dell'azienda, non più «il codice comincia con una lettera».
 *
 * Con la regola di prima le urbane con un nome di lettere (JE1, BUS3, CIRCA, Y,
 * C.D.) entravano fra le extraurbane, e le loro polimetriche si mescolavano a
 * quelle vere. È lo stesso resto tolto dall'ottimizzazione dei mezzi nella 6.23.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { lineeExtraurbane } from "../routes/fares-polimetriche";
import { impostaReti, RETI_NEUTRE } from "../lib/reti-linee";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

const route = (route_id: string, route_short_name: string, route_long_name = "") => ({ route_id, route_short_name, route_long_name });

describe("le linee extraurbane delle polimetriche", () => {
  it("le urbane con un nome di lettere restano fuori, le extraurbane entrano", () => {
    const { routeMeta, lineRouteIds } = lineeExtraurbane([
      route("r1", "JE1"), route("r2", "BUS3"), route("r3", "CIRCA"), route("r4", "Y"), route("r5", "C.D."),
      route("r6", "1/4"), route("r7", "30"),
      route("r8", "A", "Capolinea Nord - Capolinea Sud"), route("r9", "BV"), route("r10", "Z"),
    ]);
    expect([...lineRouteIds.keys()].sort()).toEqual(["A", "BV", "Z"]);
    expect(routeMeta.get("r8")).toEqual({ lineCode: "A", lineName: "Capolinea Nord - Capolinea Sud" });
    for (const urbana of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) expect(routeMeta.has(urbana), urbana).toBe(false);
  });

  it("più route_id con lo stesso codice sono una linea; senza codice vale il route_id", () => {
    const { routeMeta, lineRouteIds } = lineeExtraurbane([
      route("a1", "A"), route("a2", " A "), { route_id: "X9", route_short_name: "", route_long_name: "" }, { route_id: "", route_short_name: "B", route_long_name: "" },
    ]);
    expect([...(lineRouteIds.get("A") ?? [])]).toEqual(["a1", "a2"]);
    expect(routeMeta.get("X9")?.lineCode).toBe("X9");
    expect(routeMeta.size).toBe(3);
  });

  it("un'azienda senza reti urbane: tutte le linee sono extraurbane", () => {
    impostaReti(RETI_NEUTRE);
    const { lineRouteIds } = lineeExtraurbane([route("r1", "JE1"), route("r6", "1/4"), route("r8", "A")]);
    expect([...lineRouteIds.keys()].sort()).toEqual(["1/4", "A", "JE1"]);
  });
});
