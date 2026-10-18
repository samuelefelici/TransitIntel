import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { numeroVettureSql } from "../lib/numero-vetture";

describe("il numero di vetture di uno scenario", () => {
  const testo = (q: ReturnType<typeof numeroVettureSql>) => new PgDialect().sqlToQuery(q);

  it("legge prima totalVehicles (quello che gli ottimizzatori scrivono), poi numVehicles, poi conta i turni", () => {
    const { sql: s, params } = testo(numeroVettureSql(sql`sps.result`));
    expect(params).toEqual([]);
    const tot = s.indexOf("'totalVehicles'"), num = s.indexOf("'numVehicles'"), turni = s.indexOf("jsonb_array_length(sps.result->'shifts')");
    expect(tot).toBeGreaterThan(-1);
    expect(num).toBeGreaterThan(tot);
    expect(turni).toBeGreaterThan(num);
    expect(s).toContain("jsonb_typeof(sps.result->'shifts') = 'array'");
  });
});
