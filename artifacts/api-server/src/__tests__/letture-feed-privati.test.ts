/**
 * Le letture condivise (LETTURE_CONDIVISE in auth.ts) aprono linee, fermate,
 * forme e zone anche a chi non ha Analisi: Tariffe, Turni, Esercizio. Un feed
 * caricato da un altro utente e le zone di un progetto PS altrui restano suoi.
 *
 * Niente database: drizzle vero sopra un client pg finto, che registra ogni
 * query e risponde guardando il testo. Così si prova che la query porta il
 * filtro, e che davanti a un feed o a un progetto che l'utente non vede la
 * tabella dei dati non viene nemmeno letta.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const F = vi.hoisted(() => {
  const UTENTE_A = "a0000000-0000-4000-8000-00000000000a";
  const UTENTE_B = "b0000000-0000-4000-8000-00000000000b";
  const FEED_A = "fa000000-0000-4000-8000-0000000000fa";
  const FEED_B = "fb000000-0000-4000-8000-0000000000fb";
  const PROGETTO_A = "9a000000-0000-4000-8000-00000000009a";
  const query: Array<{ testo: string; valori: unknown[] }> = [];

  /* il feed di cui ciascuno è proprietario; gli altri non lo vedono */
  const feedDi: Record<string, string> = { [UTENTE_A]: FEED_A, [UTENTE_B]: FEED_B };

  function rispondi(testo: string, valori: unknown[]): Record<string, unknown>[] {
    const t = testo.replace(/\s+/g, " ").trim().toLowerCase();
    /* feedVisibile: l'admin ha "AND TRUE", gli altri vedono solo il proprio */
    if (t.startsWith("select 1 from gtfs_feeds where id = $1")) {
      const id = valori[0];
      const visto = t.includes("and true limit") || Object.entries(feedDi).some(([u, f]) => f === id && t.includes(u));
      return visto ? [{ uno: 1 }] : [];
    }
    /* getLatestFeedId: il feed corrente di chi chiede (l'id è nel testo) */
    if (t.startsWith("select id from gtfs_feeds where is_active = true")) {
      const chi = Object.keys(feedDi).find(u => t.includes(u));
      return chi ? [{ id: feedDi[chi] }] : [];
    }
    /* hasProjectAccess: A è membro solo di PROGETTO_A */
    if (t.startsWith("select p.id from ps_projects p")) {
      return valori[0] === UTENTE_A && valori[1] === PROGETTO_A ? [{ id: PROGETTO_A }] : [];
    }
    return [];
  }

  const client = {
    async query(cfg: any, valori?: unknown[]) {
      const testo: string = typeof cfg === "string" ? cfg : cfg.text;
      const v = valori ?? cfg?.values ?? [];
      query.push({ testo, valori: v });
      const righe = rispondi(testo, v);
      return { rows: cfg?.rowMode === "array" ? righe.map(r => Object.values(r)) : righe, rowCount: righe.length, fields: [] };
    },
  };

  return { UTENTE_A, UTENTE_B, FEED_A, FEED_B, PROGETTO_A, query, client };
});

vi.mock("@workspace/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  return { db: drizzle(F.client as any, { schema }), pool: F.client };
});

import request from "supertest";
import gtfsQueries from "../routes/gtfs-queries";
import gtfsAnalysis from "../routes/gtfs-analysis";
import clusters from "../routes/clusters";
import timetables from "../routes/timetables";
import coincidenceZones from "../routes/coincidence-zones";
import { feedVisibile } from "../lib/tenant";
import { clearCache } from "../middlewares/cache";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import type { IRouter } from "express";

const ADMIN = "ad000000-0000-4000-8000-0000000000ad";
const SENZA_FEED = "c0000000-0000-4000-8000-00000000000c";
const PROGETTO_ALTRUI = "9b000000-0000-4000-8000-00000000009b";

const tariffeA = utenteDiProva(F.UTENTE_A, ["fares"]);
const tariffeB = utenteDiProva(F.UTENTE_B, ["fares"]);
const admin = utenteDiProva(ADMIN, [], "admin");

/** Le query su una tabella (drizzle la scrive fra virgolette, l'SQL a mano no). */
const su = (tabella: string) => F.query.filter(q => new RegExp(`\\bfrom "?${tabella}"?\\b`, "i").test(q.testo));
const piatto = (s: string) => s.replace(/\s+/g, " ");

beforeEach(() => {
  F.query.length = 0;
  clearCache();
});

describe("Tariffe senza Analisi: le linee", () => {
  const app = appDiProva(gtfsQueries, tariffeA);

  it("il feed privato di un altro utente: 404, e le linee non si leggono", async () => {
    const r = await request(app).get(`/api/gtfs/routes?feedId=${F.FEED_B}`);
    expect(r.status).toBe(404);
    expect(su("gtfs_routes")).toHaveLength(0);
  });

  it("un feedId storto: 404 senza toccare il database", async () => {
    expect((await request(app).get("/api/gtfs/routes?feedId=1;drop")).status).toBe(404);
    expect(F.query.filter(q => /gtfs_/.test(q.testo))).toHaveLength(0);
  });

  it("il proprio feed si legge", async () => {
    const r = await request(app).get(`/api/gtfs/routes?feedId=${F.FEED_A}`);
    expect(r.status).toBe(200);
    expect(su("gtfs_routes")[0].valori).toContain(F.FEED_A);
  });

  it("senza feedId: solo le linee dei feed che l'utente vede", async () => {
    expect((await request(app).get("/api/gtfs/routes")).status).toBe(200);
    const [q] = su("gtfs_routes");
    expect(piatto(q.testo)).toMatch(/"feed_id" IN \(SELECT id FROM gtfs_feeds WHERE \( owner_user_id = 'a0000000-0000-4000-8000-00000000000a'::uuid/);
  });

  it("l'admin vede tutti i feed", async () => {
    expect((await request(appDiProva(gtfsQueries, admin)).get("/api/gtfs/routes")).status).toBe(200);
    expect(piatto(su("gtfs_routes")[0].testo)).toContain("IN (SELECT id FROM gtfs_feeds WHERE TRUE)");
  });

  it("la cache non passa l'elenco di un utente a un altro", async () => {
    expect((await request(app).get("/api/gtfs/routes")).headers["x-cache"]).toBe("MISS");
    expect((await request(appDiProva(gtfsQueries, tariffeB)).get("/api/gtfs/routes")).headers["x-cache"]).toBe("MISS");
    expect((await request(app).get("/api/gtfs/routes")).headers["x-cache"]).toBe("HIT");
    expect(su("gtfs_routes")).toHaveLength(2);
  });
});

describe("Tariffe e Turni: fermate e fermate per linea", () => {
  it("le fermate di tutti i feed (Fucina, zone di coincidenza): solo quelli visibili", async () => {
    const turni = appDiProva(clusters, utenteDiProva(F.UTENTE_A, ["scheduling"]));
    expect((await request(turni).get("/api/gtfs/stops/all")).status).toBe(200);
    const [q] = su("gtfs_stops");
    expect(piatto(q.testo)).toContain(`WHERE feed_id IN (SELECT id FROM gtfs_feeds WHERE ( owner_user_id = '${F.UTENTE_A}'::uuid`);
  });

  it("le fermate per linea della mappa delle Tariffe: solo i feed visibili", async () => {
    const app = appDiProva(clusters, tariffeA);
    expect((await request(app).get("/api/gtfs/route-stop-ids?routeIds=1,2")).status).toBe(200);
    const [q] = su("gtfs_trips");
    expect(piatto(q.testo)).toContain(`AND t.feed_id IN (SELECT id FROM gtfs_feeds WHERE ( owner_user_id = '${F.UTENTE_A}'::uuid`);
  });
});

describe("Tariffe: le forme delle linee", () => {
  const app = (u = tariffeA) => appDiProva(gtfsAnalysis, u);

  it("il feed privato di un altro utente: 404, e le forme non si leggono", async () => {
    expect((await request(app()).get(`/api/gtfs/shapes/geojson?feedId=${F.FEED_B}`)).status).toBe(404);
    expect(su("gtfs_shapes")).toHaveLength(0);
  });

  it("chi non ha feed riceve una collezione vuota, non le forme di tutti", async () => {
    const r = await request(app(utenteDiProva(SENZA_FEED, ["fares"]))).get("/api/gtfs/shapes/geojson?routeIds=1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ type: "FeatureCollection", features: [] });
    expect(su("gtfs_shapes")).toHaveLength(0);
  });

  it("senza feedId le forme sono del feed corrente di chi chiede", async () => {
    expect((await request(app()).get("/api/gtfs/shapes/geojson?routeIds=1")).status).toBe(200);
    expect(su("gtfs_shapes")[0].valori).toContain(F.FEED_A);
  });

  it("la cache non passa le forme calcolate sul feed di un altro", async () => {
    const url = "/api/gtfs/shapes/geojson?routeIds=1&segmented=true";
    expect((await request(app()).get(url)).headers["x-cache"]).toBe("MISS");
    const b = await request(app(tariffeB)).get(url);
    expect(b.headers["x-cache"]).toBe("MISS");
    expect(su("gtfs_shapes").map(q => q.valori[0])).toEqual([F.FEED_A, F.FEED_B]);
    expect((await request(app()).get(url)).headers["x-cache"]).toBe("HIT");
  });
});

describe("Esercizio senza Analisi: le linee per i Tempi osservati", () => {
  const app = appDiProva(timetables, utenteDiProva(F.UTENTE_A, ["centrale"]));

  it("il feed privato di un altro utente: 404", async () => {
    expect((await request(app).get(`/api/timetables/routes?feedId=${F.FEED_B}`)).status).toBe(404);
    expect(su("gtfs_routes")).toHaveLength(0);
  });

  it("senza feedId: le linee del proprio feed corrente", async () => {
    const r = await request(app).get("/api/timetables/routes");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ feedId: F.FEED_A, routes: [] });
    expect(su("gtfs_routes")[0].valori).toContain(F.FEED_A);
  });

  it("chi non ha feed riceve l'elenco vuoto, come prima", async () => {
    const r = await request(appDiProva(timetables, utenteDiProva(SENZA_FEED, ["centrale"]))).get("/api/timetables/routes");
    expect(r.body).toEqual({ feedId: null, routes: [] });
  });
});

describe("Zone di coincidenza: i progetti PS", () => {
  const leggeZone = () => su("coincidence_zones").filter(q => /^\s*select/i.test(q.testo));
  const turni = appDiProva(coincidenceZones as IRouter, utenteDiProva(F.UTENTE_A, ["scheduling"]));

  it("il progetto di un altro: 404, e le zone non si leggono", async () => {
    const r = await request(turni).get(`/api/coincidence-zones?psProjectId=${PROGETTO_ALTRUI}`);
    expect(r.status).toBe(404);
    expect(leggeZone()).toHaveLength(0);
  });

  it("il proprio progetto: globali e zone del progetto", async () => {
    expect((await request(turni).get(`/api/coincidence-zones?psProjectId=${F.PROGETTO_A}`)).status).toBe(200);
    const [q] = leggeZone();
    expect(piatto(q.testo)).toContain("(ps_project_id IS NULL OR ps_project_id = $");
    expect(q.valori).toContain(F.PROGETTO_A);
  });

  it("senza progetto: le globali e quelle dei progetti che l'utente vede, non tutte", async () => {
    const analisi = appDiProva(coincidenceZones as IRouter, utenteDiProva(F.UTENTE_A, ["analytics"]));
    expect((await request(analisi).get("/api/coincidence-zones")).status).toBe(200);
    const [q] = leggeZone();
    expect(piatto(q.testo)).toContain("(ps_project_id IS NULL OR ps_project_id IN ( SELECT p.id FROM ps_projects p");
    expect(q.valori).toContain(F.UTENTE_A);
  });

  it("l'admin le vede tutte, anche con il progetto di un altro", async () => {
    const app = appDiProva(coincidenceZones as IRouter, admin);
    expect((await request(app).get(`/api/coincidence-zones?psProjectId=${PROGETTO_ALTRUI}`)).status).toBe(200);
    expect(piatto(leggeZone()[0].testo)).not.toContain("ps_projects");
  });
});

describe("feedVisibile", () => {
  it("un id che non è un uuid è un no, senza query", async () => {
    expect(await feedVisibile({ user: tariffeA } as any, "abc")).toBe(false);
    expect(await feedVisibile({ user: tariffeA } as any, [F.FEED_A])).toBe(false);
    expect(F.query).toHaveLength(0);
  });

  it("il proprio feed sì, quello di un altro no", async () => {
    expect(await feedVisibile({ user: tariffeA } as any, F.FEED_A)).toBe(true);
    expect(await feedVisibile({ user: tariffeA } as any, F.FEED_B)).toBe(false);
  });
});
