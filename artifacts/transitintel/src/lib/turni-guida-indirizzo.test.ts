import { describe, expect, it } from "vitest";
import { ELENCO_PROGETTI, eUuid, paginaTurniGuida, salvataggioDelLink } from "./turni-guida-indirizzo";

const P = "a0000000-0000-4000-8000-00000000a001";
const S = "b0000000-0000-4000-8000-00000000b001";
const D = "2ae42e73-2855-4122-aef9-6050072f2e28";

describe("paginaTurniGuida", () => {
  it("porta alla pagina della Fucina", () => {
    expect(paginaTurniGuida(P, S)).toBe(`/fucina/${P}/drivers/${S}`);
    expect(paginaTurniGuida(P, S, D)).toBe(`/fucina/${P}/drivers/${S}?dss=${D}`);
  });
  it("senza progetto, o con id che non sono uuid, va all'elenco dei progetti", () => {
    expect(paginaTurniGuida(null, S)).toBe(ELENCO_PROGETTI);
    expect(paginaTurniGuida(undefined, S, D)).toBe(ELENCO_PROGETTI);
    expect(paginaTurniGuida(P, "../admin")).toBe(ELENCO_PROGETTI);
    expect(paginaTurniGuida("x/../../admin/users?", S)).toBe(ELENCO_PROGETTI);
    expect(paginaTurniGuida({ id: P }, S)).toBe(ELENCO_PROGETTI);
  });
  it("un salvataggio che non è un uuid non entra nell'indirizzo", () => {
    expect(paginaTurniGuida(P, S, "1&x=<script>")).toBe(`/fucina/${P}/drivers/${S}`);
    expect(paginaTurniGuida(P, S, null)).toBe(`/fucina/${P}/drivers/${S}`);
  });
});

describe("salvataggioDelLink", () => {
  it("legge ?dss= solo se è un uuid", () => {
    expect(salvataggioDelLink(`?dss=${D}`)).toBe(D);
    expect(salvataggioDelLink(`dss=${D}&altro=1`)).toBe(D);
    expect(salvataggioDelLink("?dss=//evil.example")).toBeNull();
    expect(salvataggioDelLink("")).toBeNull();
  });
});

describe("eUuid", () => {
  it("riconosce un uuid e nient'altro", () => {
    expect(eUuid(P)).toBe(true);
    expect(eUuid(P.toUpperCase())).toBe(true);
    expect(eUuid(`${P} `)).toBe(false);
    expect(eUuid(`${P}/x`)).toBe(false);
    expect(eUuid(42)).toBe(false);
  });
});
