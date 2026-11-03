/**
 * La materializzazione di un progetto Planning Studio in un feed GTFS, su un
 * database vero (TEST_DATABASE_URL, migrato: in CI il job migrazioni-postgres).
 *
 * È il metro del «stesso feed» della PR 2.7a, che sposta la materializzazione
 * nel lavoratore: su un piccolo progetto fisso si fissano con istantanee le
 * righe gtfs_* prodotte (esercizio e UDP), i puntatori, la sorte del feed
 * vecchio, il rispecchiamento dei nodi di cambio e le risposte delle rotte di
 * sincronizzazione.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import router, { materializePsToFeed } from "../lib/planning-studio-materialize";
import progettiRouter from "../lib/scheduling-projects";
import { sincronizzaProgetto } from "../lib/materializzazione/sincronizza";
import { creaEsecutore } from "../lib/lavori/esecutore";
import { GESTORI } from "../lib/lavori/gestori";

const U = "f0000000-0000-0000-0000-0000000000a0";
const PS = "f0000000-0000-0000-0000-0000000000c1";
const S = (n: number) => `f0000000-0000-0000-0000-00000000005${n}`;
const R1 = "f0000000-0000-0000-0000-0000000000e1";
const V1 = "f0000000-0000-0000-0000-0000000000e2";
const CAL = "f0000000-0000-0000-0000-0000000000ca";
const NODO = "f0000000-0000-0000-0000-0000000000cc";
const T = (n: number) => `f0000000-0000-0000-0000-00000000007${n}`;
const UDP = "f0000000-0000-0000-0000-0000000000d1";
const SP_TUTTO = "f0000000-0000-0000-0000-0000000000b1";
const SP_UDP = "f0000000-0000-0000-0000-0000000000b2";
const SCENARIO = "f0000000-0000-0000-0000-0000000000b3";

const app = appDiProva(router, utenteDiProva(U, ["scheduling"]));

async function semina(): Promise<void> {
  await pulisci();
  await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${U}::uuid, 'feed-ps@prova.local', 'x')`);
  await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name) VALUES (${PS}::uuid, ${U}::uuid, 'Rete PS di prova', 'Conerobus prova')`);
  await db.execute(sql`INSERT INTO ps_stop_clusters (id, project_id, code, name, kind, attributes)
                       VALUES (${NODO}::uuid, ${PS}::uuid, 'N1', 'Piazza Cavour', 'interchange', '{"transferFromDepotMin": 12, "color": "#ff0000"}')`);
  await db.execute(sql`INSERT INTO ps_stops (id, project_id, code, name, lat, lon, cluster_id, wheelchair_boarding) VALUES
    (${S(1)}::uuid, ${PS}::uuid, '1001', 'Stazione FS', 43.6075, 13.4977, NULL, 1),
    (${S(2)}::uuid, ${PS}::uuid, '1002', 'Piazza Cavour', 43.6167, 13.5189, ${NODO}::uuid, 2),
    (${S(3)}::uuid, ${PS}::uuid, '1003', 'Torrette', 43.6040, 13.4510, NULL, 0)`);
  await db.execute(sql`INSERT INTO ps_routes (id, project_id, code, short_name, long_name, route_type, color)
                       VALUES (${R1}::uuid, ${PS}::uuid, 'L1', '1', 'Stazione - Torrette', 3, '00AA00')`);
  await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, code)
                       VALUES (${V1}::uuid, ${PS}::uuid, ${R1}::uuid, 'Andata', '1A')`);
  await db.execute(sql`INSERT INTO ps_shapes (project_id, variant_id, geometry)
                       VALUES (${PS}::uuid, ${V1}::uuid, '{"type":"LineString","coordinates":[[13.4977,43.6075],[13.5189,43.6167],[13.4510,43.6040]]}')`);
  await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
                       VALUES (${CAL}::uuid, ${PS}::uuid, 'FER', 'Feriale', true, true, true, true, true, false, false, '2026-09-14', '2027-06-10')`);
  await db.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date, exception_type) VALUES (${CAL}::uuid, '2026-12-08', 2)`);
  const corse: Array<[number, string | null, boolean, string]> = [
    [1, CAL, true, "07:00:00"], [2, CAL, true, "08:00:00"], [3, null, true, "09:00:00"], [4, CAL, false, "10:00:00"],
  ];
  for (const [n, cal, attiva, parte] of corse) {
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id, headsign, direction, is_active, block_id, attributes)
                         VALUES (${T(n)}::uuid, ${PS}::uuid, ${R1}::uuid, ${V1}::uuid, ${cal}::uuid, 'Torrette', 0, ${attiva}, ${n === 1 ? "B1" : ""},
                                 ${n === 2 ? '{"onDemand": true}' : "{}"}::jsonb)`);
    const h = Number(parte.slice(0, 2));
    for (const [seq, stop, min] of [[1, S(1), 0], [2, S(2), 10], [3, S(3), 25]] as Array<[number, string, number]>) {
      const t = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
      await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
                           VALUES (${T(n)}::uuid, ${seq}, ${stop}::uuid, ${t}, ${t})`);
    }
  }
  await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids, trip_count)
                       VALUES (${UDP}::uuid, ${PS}::uuid, 'FER-1', 'Feriale scolastico', ${JSON.stringify([T(1), T(2)])}::jsonb, 2)`);
  await db.execute(sql`INSERT INTO scheduling_projects (id, owner_user_id, name, planning_studio_project_id)
                       VALUES (${SP_TUTTO}::uuid, ${U}::uuid, 'Esercizio intero', ${PS}::uuid)`);
  await db.execute(sql`INSERT INTO scheduling_projects (id, owner_user_id, name, planning_studio_project_id, validity_unit_id)
                       VALUES (${SP_UDP}::uuid, ${U}::uuid, 'Feriale scolastico', ${PS}::uuid, ${UDP}::uuid)`);
  await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result, project_id)
                       VALUES (${SCENARIO}::uuid, 'Turni di prova', '20261104', '{}', '{}', ${SP_UDP}::uuid)`);
}

async function pulisci(): Promise<void> {
  const feed = await db.execute<any>(sql`SELECT id FROM gtfs_feeds WHERE filename = ${`ps-${PS.slice(0, 8)}.synthetic`}`);
  for (const f of feed.rows) await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${f.id}::uuid`);
  await db.execute(sql`DELETE FROM coda.lavori WHERE oggetto_id IN (${SP_TUTTO}::uuid, ${SP_UDP}::uuid)`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${SCENARIO}::uuid`);
  await db.execute(sql`DELETE FROM scheduling_projects WHERE id IN (${SP_TUTTO}::uuid, ${SP_UDP}::uuid)`);
  await db.execute(sql`DELETE FROM stop_clusters WHERE source_ps_project_id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id IN (SELECT id FROM ps_trips WHERE project_id = ${PS}::uuid)`);
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${U}::uuid`);
}

/** Le righe gtfs_* di un feed, ordinate e senza id e feed_id: l'impronta del feed. */
async function impronta(feedId: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const tabelle: Array<[string, string]> = [
    ["gtfs_stops", "stop_id"], ["gtfs_routes", "route_id"], ["gtfs_calendar", "service_id"],
    ["gtfs_calendar_dates", "service_id, date"], ["gtfs_trips", "trip_id"],
    ["gtfs_stop_times", "trip_id, stop_sequence"], ["gtfs_shapes", "shape_id"],
  ];
  for (const [t, ordine] of tabelle) {
    const r = await db.execute<any>(sql`SELECT * FROM ${sql.identifier(t)} WHERE feed_id = ${feedId}::uuid ORDER BY ${sql.raw(ordine)}`);
    out[t] = r.rows.map(({ id: _id, feed_id: _f, ...resto }: any) =>
      Object.fromEntries(Object.entries(resto).map(([k, v]) => [k, typeof v === "string" ? v.replaceAll(feedId.slice(0, 8), "FEED") : v])));
  }
  const f = (await db.execute<any>(sql`
    SELECT filename, agency_name, feed_start_date, feed_end_date, stops_count, routes_count, trips_count, shapes_count,
           is_active, is_default, archived_at IS NOT NULL AS archiviato, owner_user_id
      FROM gtfs_feeds WHERE id = ${feedId}::uuid`)).rows[0];
  out.gtfs_feeds = [f];
  return out;
}

const cluster = async () => (await db.execute<any>(sql`
  SELECT c.id, c.name, c.transfer_from_depot_min, c.color, s.gtfs_stop_id, s.stop_name
    FROM stop_clusters c LEFT JOIN stop_cluster_stops s ON s.cluster_id = c.id
   WHERE c.source_ps_project_id = ${PS}::uuid ORDER BY c.id, s.gtfs_stop_id`)).rows;

const senzaFeed = (r: any, feedId: string) => ({ ...r, feedId: r.feedId === feedId ? "FEED" : r.feedId });

describe.runIf(!!process.env.TEST_DATABASE_URL)("materializzazione Planning Studio → feed, sul database", () => {
  beforeAll(semina);
  afterAll(pulisci);
  beforeEach(() => { process.env.LAVORI_FEED_IN_CODA = "0"; });

  it("il feed d'esercizio: righe, conteggi, puntatore, nodi di cambio; il secondo archivia il primo", async () => {
    const a = await materializePsToFeed(PS, U);
    expect(senzaFeed(a, a.feedId)).toMatchSnapshot("risultato");
    expect(await impronta(a.feedId)).toMatchSnapshot("righe del feed d'esercizio");
    expect(await cluster()).toMatchSnapshot("nodi di cambio rispecchiati");
    const p = (await db.execute<any>(sql`SELECT materialized_feed_id FROM ps_projects WHERE id = ${PS}::uuid`)).rows[0];
    expect(p.materialized_feed_id).toBe(a.feedId);

    const b = await materializePsToFeed(PS, U);
    expect(b.feedId).not.toBe(a.feedId);
    const vecchio = (await db.execute<any>(sql`SELECT is_active, is_default, archived_at IS NOT NULL AS archiviato FROM gtfs_feeds WHERE id = ${a.feedId}::uuid`)).rows[0];
    expect(vecchio).toEqual({ is_active: false, is_default: false, archiviato: true });
    expect((await db.execute<any>(sql`SELECT materialized_feed_id FROM ps_projects WHERE id = ${PS}::uuid`)).rows[0].materialized_feed_id).toBe(b.feedId);
    expect(await impronta(b.feedId)).toEqual(await impronta(a.feedId).then(x => ({ ...x, gtfs_feeds: [{ ...(x.gtfs_feeds[0] as any), archiviato: false }] })));
  });

  it("la sincronizzazione di un'UDP: solo le sue corse, puntatore, feed vecchio cancellato, scenari superati, stato", async () => {
    const prima = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps?wait=1`).send({});
    expect(prima.status, JSON.stringify(prima.body)).toBe(200);
    const f1 = prima.body.feedId as string;
    expect(senzaFeed(prima.body, f1)).toMatchSnapshot("risposta di sync-from-ps?wait=1");
    expect(await impronta(f1)).toMatchSnapshot("righe del feed dell'UDP");
    const sp = (await db.execute<any>(sql`SELECT feed_id, feed_label FROM scheduling_projects WHERE id = ${SP_UDP}::uuid`)).rows[0];
    expect(sp).toEqual({ feed_id: f1, feed_label: "PS · Rete PS di prova" });
    const sc = (await db.execute<any>(sql`SELECT stale_since IS NOT NULL AS superato FROM service_program_scenarios WHERE id = ${SCENARIO}::uuid`)).rows[0];
    expect(sc.superato).toBe(true);

    const stato = await request(app).get(`/api/scheduling/projects/${SP_UDP}/sync-status`);
    expect(stato.status).toBe(200);
    const { durationMs, ...restoStato } = stato.body;
    expect(typeof durationMs === "number" || durationMs === undefined).toBe(true);
    expect(senzaFeed(restoStato, f1)).toMatchSnapshot("sync-status a sincronizzazione finita");

    const dopo = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps?wait=1`).send({});
    expect(dopo.status).toBe(200);
    expect(dopo.body.feedId).not.toBe(f1);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE id = ${f1}::uuid`)).rows[0].n).toBe(0);
    expect((await db.execute<any>(sql`SELECT feed_id FROM scheduling_projects WHERE id = ${SP_UDP}::uuid`)).rows[0].feed_id).toBe(dopo.body.feedId);
  });

  it("le rotte: progetto senza permesso 404, id storto 400, senza sincronizzazioni lo stato viene dal database", async () => {
    const altro = appDiProva(router, utenteDiProva("f0000000-0000-0000-0000-0000000000a9", ["scheduling"]));
    expect((await request(altro).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps`).send({})).status).toBe(404);
    expect((await request(app).get(`/api/scheduling/projects/non-un-uuid/sync-status`)).status).toBe(400);
    const vuoto = await request(app).get(`/api/scheduling/projects/${SP_TUTTO}/sync-status`);
    expect(vuoto.body).toEqual({ status: "idle" });
  });

  it("uno stop (o un errore) a metà non lascia un feed parziale", async () => {
    const conta = async () => (await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE filename = ${`ps-${PS.slice(0, 8)}.synthetic`}`)).rows[0].n;
    const prima = await conta();
    const fermo = new AbortController();
    fermo.abort();
    await expect(materializePsToFeed(PS, U, { tripIds: [T(1)], replaceFeedId: null, updateProjectPointer: false, segnale: fermo.signal }))
      .rejects.toThrow("Materializzazione fermata");
    expect(await conta()).toBe(prima);
  });

  it("si cancella solo un feed vecchio sintetico: un GTFS caricato e agganciato a mano resta", async () => {
    const vero = (await db.execute<any>(sql`INSERT INTO gtfs_feeds (filename) VALUES ('orari-veri.zip') RETURNING id`)).rows[0].id as string;
    try {
      await db.execute(sql`UPDATE scheduling_projects SET feed_id = ${vero}::uuid WHERE id = ${SP_UDP}::uuid`);
      const r = await sincronizzaProgetto(SP_UDP, PS, U);
      expect((await db.execute<any>(sql`SELECT feed_id FROM scheduling_projects WHERE id = ${SP_UDP}::uuid`)).rows[0].feed_id).toBe(r.feedId);
      expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE id = ${vero}::uuid`)).rows[0].n).toBe(1);
    } finally {
      await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${vero}::uuid`);
    }
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("sincronizzazione nella coda dei lavori, sul database", () => {
  const log = { info() {}, warn() {}, error() {} };
  const esecutore = creaEsecutore({ chi: "prova:feed", slot: { veloce: 1, lunga: 0 }, gestori: GESTORI, log, pollingMs: 50, battitoMs: 100 });
  const lavori = async () => (await db.execute<any>(sql`
    SELECT tipo, corsia, stato, utente_id, oggetto_id, chiave_unicita, metadati->>'ambito' AS ambito, risultato->>'feedId' AS feed
      FROM coda.lavori WHERE oggetto_id IN (${SP_TUTTO}::uuid, ${SP_UDP}::uuid) ORDER BY creato_il`)).rows;
  beforeAll(async () => {
    await semina();
    await db.execute(sql`DELETE FROM coda.lavori WHERE stato IN ('in_coda', 'in_corso')`);
  });
  afterAll(async () => { await esecutore.ferma(1_000); await pulisci(); });
  beforeEach(() => { process.env.LAVORI_FEED_IN_CODA = "1"; });

  it("senza nessuno che la esegue resta in coda: sync-status dice «running», una seconda richiesta si aggancia alla stessa", async () => {
    const a = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps`).send({});
    expect(a.status).toBe(202);
    expect(a.body).toMatchObject({ ok: true, status: "running" });
    const b = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps`).send({});
    expect(b.status).toBe(202);
    const r = await lavori();
    expect(r).toEqual([{ tipo: "materializza_feed", corsia: "veloce", stato: "in_coda", utente_id: U, oggetto_id: SP_UDP,
                         chiave_unicita: `sync:${SP_UDP}`, ambito: "materializzazione", feed: null }]);
    // dopo un riavvio dell'API non c'è più niente in memoria: lo stato viene dalla coda
    const st = await request(app).get(`/api/scheduling/projects/${SP_UDP}/sync-status`);
    expect(st.body).toMatchObject({ status: "running" });
  });

  it("la creazione di un progetto accoda la sincronizzazione prima di rispondere: sync-status dice subito «running»", async () => {
    const progetti = appDiProva(progettiRouter, utenteDiProva(U, ["scheduling"]));
    const c = await request(progetti).post("/api/scheduling/projects").send({ name: "Nuovo dalla coda", planningStudioProjectId: PS, validityUnitId: UDP });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const id = c.body.project.id as string;
    try {
      expect((await request(app).get(`/api/scheduling/projects/${id}/sync-status`)).body).toMatchObject({ status: "running" });
      const l = (await db.execute<any>(sql`SELECT stato, chiave_unicita FROM coda.lavori WHERE oggetto_id = ${id}::uuid`)).rows;
      expect(l).toEqual([{ stato: "in_coda", chiave_unicita: `sync:${id}` }]);
    } finally {
      await db.execute(sql`DELETE FROM coda.lavori WHERE oggetto_id = ${id}::uuid`);
      await db.execute(sql`DELETE FROM scheduling_projects WHERE id = ${id}::uuid`);
    }
  });

  it("il lavoratore la esegue: stesso feed e stesse risposte del percorso dentro l'API", async () => {
    esecutore.avvia();
    const inCoda = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps?wait=1`).send({});
    expect(inCoda.status, JSON.stringify(inCoda.body)).toBe(200);
    const fq = inCoda.body.feedId as string;
    const st = await request(app).get(`/api/scheduling/projects/${SP_UDP}/sync-status`);
    const { durationMs, ...restoSt } = st.body;
    expect(typeof durationMs).toBe("number");
    const iq = await impronta(fq);

    process.env.LAVORI_FEED_IN_CODA = "0";
    const dentro = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps?wait=1`).send({});
    const fd = dentro.body.feedId as string;
    expect(senzaFeed(inCoda.body, fq)).toEqual(senzaFeed(dentro.body, fd));
    expect(senzaFeed(restoSt, fq)).toEqual({ ...senzaFeed(dentro.body, fd), ok: undefined, status: "done" });
    expect(iq).toEqual(await impronta(fd));
    expect((await lavori()).map((x: any) => x.stato)).toEqual(["completato"]);
    // il feed della sincronizzazione in coda, sostituito da quella dentro l'API, è stato cancellato
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE id = ${fq}::uuid`)).rows[0].n).toBe(0);
  });

  it("se il progetto è stato agganciato ad altro feed dopo la sincronizzazione, sync-status non ripete il risultato vecchio", async () => {
    process.env.LAVORI_FEED_IN_CODA = "1";
    const r = await request(app).post(`/api/scheduling/projects/${SP_UDP}/sync-from-ps?wait=1`).send({});
    expect(r.status).toBe(200);
    await db.execute(sql`UPDATE scheduling_projects SET feed_id = NULL WHERE id = ${SP_UDP}::uuid`);
    expect((await request(app).get(`/api/scheduling/projects/${SP_UDP}/sync-status`)).body).toEqual({ status: "idle" });
    await db.execute(sql`UPDATE scheduling_projects SET feed_id = ${r.body.feedId}::uuid WHERE id = ${SP_UDP}::uuid`);
  });
});

