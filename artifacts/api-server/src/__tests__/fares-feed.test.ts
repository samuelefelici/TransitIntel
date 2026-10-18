import { describe, it, expect, vi, beforeEach } from "vitest";

/* getLatestFeedId legge il feed corrente dal database: qui il database
 * risponde con il feed A, oppure con niente */
const FEED_A = "aaaaaaaa-0000-0000-0000-000000000001";
let feedCorrente: string | null = FEED_A;
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: feedCorrente ? [{ id: feedCorrente }] : [] })) },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { gtfsCalendarDates } from "@workspace/db/schema";
import { idNelFeed, nelFeed } from "../routes/gtfs-helpers";

const risposta = () => {
  const r: any = { codice: 0, corpo: null };
  r.status = (c: number) => { r.codice = c; return r; };
  r.json = (b: unknown) => { r.corpo = b; return r; };
  return r;
};

describe("modifiche per id: solo nel feed corrente", () => {
  beforeEach(() => { feedCorrente = FEED_A; });

  it("il WHERE porta sia l'id sia il feed", () => {
    const q = new PgDialect().sqlToQuery(nelFeed(gtfsCalendarDates, { id: "bbbbbbbb-0000-0000-0000-000000000002", feedId: FEED_A }));
    expect(q.sql).toContain('"feed_id"');
    expect(q.sql).toContain('"id"');
    expect(q.params).toEqual([FEED_A, "bbbbbbbb-0000-0000-0000-000000000002"]);
  });

  it("un id storto: 400 senza toccare il database", async () => {
    const res = risposta();
    expect(await idNelFeed({ params: { id: "1; drop table" }, user: { id: "u", role: "user" } }, res)).toBeNull();
    expect(res.codice).toBe(400);
  });

  it("nessun feed per l'utente: 404", async () => {
    feedCorrente = null;
    const res = risposta();
    expect(await idNelFeed({ params: { id: "bbbbbbbb-0000-0000-0000-000000000002" }, user: { id: "u", role: "user" } }, res)).toBeNull();
    expect(res.codice).toBe(404);
  });

  it("id buono: l'id e il feed corrente, anche da un altro parametro", async () => {
    const res = risposta();
    expect(await idNelFeed({ params: { overrideId: "bbbbbbbb-0000-0000-0000-000000000002" }, user: { id: "u", role: "user" } }, res, "overrideId"))
      .toEqual({ id: "bbbbbbbb-0000-0000-0000-000000000002", feedId: FEED_A });
  });
});
