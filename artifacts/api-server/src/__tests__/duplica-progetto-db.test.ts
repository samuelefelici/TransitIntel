/**
 * La duplicazione di un progetto di Planning Studio su un database vero
 * (TEST_DATABASE_URL, migrato; in CI come cerbero_app).
 *
 * Le mappe id vecchio→nuovo erano sette tabelle temporanee, l'ultimo DDL
 * dell'API. Dalla PR 2.16b l'app non ne esegue più: le mappe sono CTE, e l'id
 * nuovo si deriva da progetto nuovo + id vecchio. Qui un progetto con ogni
 * tabella copiata e ogni chiave esterna rimappata: la copia è uguale
 * all'originale a meno degli id, e non tocca né l'originale né i dati globali.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../lib/planning-studio";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "d1000000-0000-4000-8000-000000000001";
const SRC = "d1000000-0000-4000-8000-0000000000a0";
const u = (n: number) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [N1, N2, F1, F2, F3, F4, L1, L2, V1, V2, CAL, TG, TG_GLOBALE, C1, C2, CAT] = Array.from({ length: 16 }, (_, i) => u(i + 10));
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const app = appDiProva(router, utenteDiProva(UTENTE));

/* Il progetto «a meno degli id»: ogni riga con le sue chiavi naturali e quelle
 * delle righe a cui punta, cercate DENTRO lo stesso progetto. Una chiave
 * esterna rimappata male darebbe un null o una riga in meno. */
async function impronta(p: string): Promise<Record<string, unknown>> {
  const r = await db.execute<any>(sql`
    SELECT jsonb_build_object(
      'nodi', (SELECT jsonb_agg(jsonb_build_array(code, name, kind) ORDER BY code) FROM ps_stop_clusters WHERE project_id = ${p}::uuid),
      'fermate', (SELECT jsonb_agg(jsonb_build_array(s.code, s.name, n.code, m.code) ORDER BY s.code)
                    FROM ps_stops s
                    LEFT JOIN ps_stop_clusters n ON n.id = s.cluster_id AND n.project_id = s.project_id
                    LEFT JOIN ps_stops m ON m.id = s.parent_station AND m.project_id = s.project_id
                   WHERE s.project_id = ${p}::uuid),
      'linee', (SELECT jsonb_agg(short_name ORDER BY short_name) FROM ps_routes WHERE project_id = ${p}::uuid),
      'percorsi', (SELECT jsonb_agg(jsonb_build_array(v.name, l.short_name) ORDER BY v.name)
                     FROM ps_route_variants v JOIN ps_routes l ON l.id = v.route_id AND l.project_id = v.project_id
                    WHERE v.project_id = ${p}::uuid),
      'fermate_dei_percorsi', (SELECT jsonb_agg(jsonb_build_array(v.name, x.seq, s.code) ORDER BY v.name, x.seq)
                                 FROM ps_variant_stops x
                                 JOIN ps_route_variants v ON v.id = x.variant_id
                                 JOIN ps_stops s ON s.id = x.stop_id AND s.project_id = v.project_id
                                WHERE v.project_id = ${p}::uuid),
      'forme', (SELECT jsonb_agg(jsonb_build_array(v.name, f.geometry) ORDER BY v.name)
                  FROM ps_shapes f JOIN ps_route_variants v ON v.id = f.variant_id AND v.project_id = f.project_id
                 WHERE f.project_id = ${p}::uuid),
      'calendari', (SELECT jsonb_agg(jsonb_build_array(c.code, (SELECT jsonb_agg(d.date ORDER BY d.date) FROM ps_calendar_dates d WHERE d.calendar_id = c.id)) ORDER BY c.code)
                      FROM ps_calendars c WHERE c.project_id = ${p}::uuid),
      'tipi_giorno', (SELECT jsonb_agg(jsonb_build_array(code, name) ORDER BY code) FROM ps_day_types WHERE project_id = ${p}::uuid),
      'corse', (SELECT jsonb_agg(jsonb_build_array(t.short_name, l.short_name, v.name, c.code) ORDER BY t.short_name)
                  FROM ps_trips t
                  JOIN ps_routes l ON l.id = t.route_id AND l.project_id = t.project_id
                  JOIN ps_route_variants v ON v.id = t.variant_id AND v.project_id = t.project_id
                  LEFT JOIN ps_calendars c ON c.id = t.calendar_id AND c.project_id = t.project_id
                 WHERE t.project_id = ${p}::uuid),
      'orari', (SELECT jsonb_agg(jsonb_build_array(t.short_name, o.stop_seq, s.code, o.arrival_time, o.departure_time) ORDER BY t.short_name, o.stop_seq)
                  FROM ps_stop_times o
                  JOIN ps_trips t ON t.id = o.trip_id
                  JOIN ps_stops s ON s.id = o.stop_id AND s.project_id = t.project_id
                 WHERE t.project_id = ${p}::uuid),
      'validita', (SELECT jsonb_agg(jsonb_build_array(t.short_name, g.code, CASE WHEN g.project_id IS NULL THEN 'globale:' || g.id WHEN g.project_id = t.project_id THEN 'del progetto' ELSE 'di un altro' END, x.is_valid)
                                    ORDER BY t.short_name, g.code)
                     FROM ps_trip_day_validity x JOIN ps_trips t ON t.id = x.trip_id JOIN ps_day_types g ON g.id = x.day_type_id
                    WHERE t.project_id = ${p}::uuid),
      'categorie', (SELECT jsonb_agg(jsonb_build_array(t.short_name, x.category_id) ORDER BY t.short_name)
                      FROM ps_trip_category_validity x JOIN ps_trips t ON t.id = x.trip_id WHERE t.project_id = ${p}::uuid),
      'eccezioni', (SELECT jsonb_agg(jsonb_build_array(t.short_name, x.date) ORDER BY t.short_name, x.date)
                      FROM ps_trip_exceptions x JOIN ps_trips t ON t.id = x.trip_id WHERE t.project_id = ${p}::uuid),
      'zone', (SELECT jsonb_agg(jsonb_build_array(name, polygon, active) ORDER BY name) FROM ps_no_go_zones WHERE project_id = ${p}::uuid),
      'periodi', (SELECT jsonb_agg(jsonb_build_array(code, name, start_date, end_date, is_default) ORDER BY code) FROM ps_service_periods WHERE project_id = ${p}::uuid),
      'profilo', (SELECT jsonb_agg(jsonb_build_array(closed_periods, summer_period, extra_holidays)) FROM ps_calendar_profiles WHERE project_id = ${p}::uuid),
      'giorni', (SELECT jsonb_agg(jsonb_build_array(x.date, g.code, CASE WHEN g.project_id IS NULL THEN 'globale:' || g.id WHEN g.project_id = x.project_id THEN 'del progetto' ELSE 'di un altro' END, x.source, x.note) ORDER BY x.date)
                   FROM ps_day_calendar x JOIN ps_day_types g ON g.id = x.day_type_id WHERE x.project_id = ${p}::uuid),
      'giorni_per_categoria', (SELECT jsonb_agg(jsonb_build_array(date, category_id) ORDER BY date) FROM ps_validity_category_calendar WHERE project_id = ${p}::uuid)
    ) AS i`);
  return r.rows[0].i;
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("duplicazione di un progetto di Planning Studio, sul database", () => {
  const copie: string[] = [];
  const pulisci = async () => {
    // prima corse e percorsi: gli orari e le fermate dei percorsi puntano alle fermate senza cascata
    const miei = sql`(SELECT id FROM ps_projects WHERE id = ${SRC}::uuid OR owner_user_id = ${UTENTE}::uuid)`;
    // ps_trip_category_validity non ha chiavi esterne: le sue righe non seguono le corse
    await db.execute(sql`DELETE FROM ps_trip_category_validity WHERE category_id = ${CAT}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id IN ${miei}`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id IN ${miei}`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${SRC}::uuid OR owner_user_id = ${UTENTE}::uuid`);
    await db.execute(sql`DELETE FROM ps_day_types WHERE id = ${TG_GLOBALE}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_categories WHERE id = ${CAT}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, description, agency_name, status, is_shared)
                           VALUES (${SRC}::uuid, ${UTENTE}::uuid, 'Rete di prova', 'da duplicare', 'Azienda', 'published', true)`);
      await tx.execute(sql`INSERT INTO ps_stop_clusters (id, project_id, code, name, kind) VALUES
                           (${N1}::uuid, ${SRC}::uuid, 'N1', 'Stazione', 'interchange'), (${N2}::uuid, ${SRC}::uuid, 'N2', 'Capolinea', 'rest')`);
      // F2 ha un nodo e una stazione madre; F3 e F4 né l'uno né l'altra
      await tx.execute(sql`INSERT INTO ps_stops (id, project_id, code, name, lat, lon, cluster_id, parent_station) VALUES
                           (${F1}::uuid, ${SRC}::uuid, 'F1', 'Stazione', 43.61, 13.51, ${N1}::uuid, NULL),
                           (${F2}::uuid, ${SRC}::uuid, 'F2', 'Stazione lato mare', 43.62, 13.52, ${N1}::uuid, ${F1}::uuid),
                           (${F3}::uuid, ${SRC}::uuid, 'F3', 'Via Roma', 43.63, 13.53, NULL, NULL),
                           (${F4}::uuid, ${SRC}::uuid, 'F4', 'Capolinea', 43.64, 13.54, ${N2}::uuid, NULL)`);
      await tx.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${L1}::uuid, ${SRC}::uuid, '1'), (${L2}::uuid, ${SRC}::uuid, '2')`);
      await tx.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES
                           (${V1}::uuid, ${SRC}::uuid, ${L1}::uuid, 'Andata 1'), (${V2}::uuid, ${SRC}::uuid, ${L2}::uuid, 'Andata 2')`);
      await tx.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES
                           (${V1}::uuid, 1, ${F1}::uuid), (${V1}::uuid, 2, ${F2}::uuid), (${V1}::uuid, 3, ${F3}::uuid),
                           (${V2}::uuid, 1, ${F3}::uuid), (${V2}::uuid, 2, ${F4}::uuid)`);
      await tx.execute(sql`INSERT INTO ps_shapes (project_id, variant_id, geometry) VALUES (${SRC}::uuid, ${V1}::uuid, '[[13.51,43.61],[13.53,43.63]]')`);
      await tx.execute(sql`INSERT INTO ps_calendars (id, project_id, code, start_date, end_date) VALUES (${CAL}::uuid, ${SRC}::uuid, 'FER', '2026-09-15', '2027-06-10')`);
      await tx.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date) VALUES (${CAL}::uuid, '2026-12-08'), (${CAL}::uuid, '2026-12-25')`);
      // un tipo di giorno del progetto (si copia) e uno globale (resta lo stesso)
      await tx.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES
                           (${TG}::uuid, ${SRC}::uuid, 'MERC', 'Mercato', '#aa5500'), (${TG_GLOBALE}::uuid, NULL, 'CI_DUPLICA', 'Globale di prova', '#000000')`);
      // C2 non ha calendario
      await tx.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id, short_name, headsign) VALUES
                           (${C1}::uuid, ${SRC}::uuid, ${L1}::uuid, ${V1}::uuid, ${CAL}::uuid, 'C1', 'Via Roma'),
                           (${C2}::uuid, ${SRC}::uuid, ${L2}::uuid, ${V2}::uuid, NULL, 'C2', 'Capolinea')`);
      await tx.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
                           (${C1}::uuid, 1, ${F1}::uuid, '07:00:00', '07:00:00'), (${C1}::uuid, 2, ${F2}::uuid, '07:03:00', '07:04:00'),
                           (${C1}::uuid, 3, ${F3}::uuid, '07:10:00', '07:10:00'),
                           (${C2}::uuid, 1, ${F3}::uuid, '08:00:00', '08:00:00'), (${C2}::uuid, 2, ${F4}::uuid, '08:12:00', '08:12:00')`);
      await tx.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES
                           (${C1}::uuid, ${TG}::uuid, true), (${C1}::uuid, ${TG_GLOBALE}::uuid, false), (${C2}::uuid, ${TG_GLOBALE}::uuid, true)`);
      await tx.execute(sql`INSERT INTO ps_validity_categories (id, code, name, color) VALUES (${CAT}::uuid, 'CI_DUPLICA', 'Categoria di prova', '#111111')`);
      await tx.execute(sql`INSERT INTO ps_trip_category_validity (trip_id, category_id) VALUES (${C1}::uuid, ${CAT}::uuid)`);
      await tx.execute(sql`INSERT INTO ps_trip_exceptions (trip_id, date) VALUES (${C2}::uuid, '2026-12-24')`);
      await tx.execute(sql`INSERT INTO ps_no_go_zones (project_id, name, polygon, active) VALUES (${SRC}::uuid, 'Centro', '[[13.5,43.6],[13.6,43.6],[13.5,43.7]]', true)`);
      await tx.execute(sql`INSERT INTO ps_service_periods (project_id, code, name, start_date, end_date, is_default) VALUES (${SRC}::uuid, 'INV', 'Invernale', '2026-09-15', '2027-06-10', true)`);
      await tx.execute(sql`INSERT INTO ps_calendar_profiles (project_id, closed_periods, summer_period, extra_holidays)
                           VALUES (${SRC}::uuid, '[{"from":"2026-12-24","to":"2027-01-06"}]', '{"from":"2027-06-11","to":"2027-09-14"}', '["2027-05-04"]')`);
      await tx.execute(sql`INSERT INTO ps_day_calendar (project_id, date, day_type_id, source, note) VALUES
                           (${SRC}::uuid, '2026-12-01', ${TG}::uuid, 'manuale', 'del progetto'), (${SRC}::uuid, '2026-12-02', ${TG_GLOBALE}::uuid, 'manuale', 'globale')`);
      await tx.execute(sql`INSERT INTO ps_validity_category_calendar (project_id, date, category_id) VALUES (${SRC}::uuid, '2026-12-03', ${CAT}::uuid)`);
    });
  });

  afterAll(async () => { await pulisci(); await pool.end(); });

  const duplica = async (nome?: string) => {
    const r = await request(app).post(`/api/planning-studio/projects/${SRC}/duplicate`).send(nome ? { name: nome } : {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    copie.push(r.body.project.id);
    return r.body.project as { id: string; name: string; status: string; isShared?: boolean };
  };

  it("la copia è uguale all'originale a meno degli id, e nasce in bozza, non condivisa, di chi la fa", async () => {
    const prima = await impronta(SRC);
    // l'impronta guarda davvero dentro: niente è vuoto
    for (const [k, v] of Object.entries(prima)) expect(v, k).not.toBeNull();
    const copia = await duplica("Copia di prova");
    expect(copia).toMatchObject({ name: "Copia di prova", status: "draft" });
    expect(copia.id).not.toBe(SRC);
    expect(await impronta(copia.id)).toEqual(prima);
    // l'originale non è cambiato
    expect(await impronta(SRC)).toEqual(prima);
    const p = (await db.execute<any>(sql`SELECT owner_user_id, is_shared, status FROM ps_projects WHERE id = ${copia.id}::uuid`)).rows[0];
    expect(p).toEqual({ owner_user_id: UTENTE, is_shared: false, status: "draft" });
  });

  it("gli id nuovi sono UUID, tutti diversi da quelli dell'originale; il tipo di giorno globale resta quello", async () => {
    const copia = copie[0]!;
    const ids = (await db.execute<any>(sql`
      SELECT 'ps_stops' AS t, id::text FROM ps_stops WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_stop_clusters', id::text FROM ps_stop_clusters WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_routes', id::text FROM ps_routes WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_route_variants', id::text FROM ps_route_variants WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_calendars', id::text FROM ps_calendars WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_day_types', id::text FROM ps_day_types WHERE project_id = ${copia}::uuid
      UNION ALL SELECT 'ps_trips', id::text FROM ps_trips WHERE project_id = ${copia}::uuid`)).rows;
    expect(ids).toHaveLength(4 + 2 + 2 + 2 + 1 + 1 + 2);
    for (const r of ids) expect(r.id, r.t).toMatch(V4);
    const originali = new Set([N1, N2, F1, F2, F3, F4, L1, L2, V1, V2, CAL, TG, C1, C2]);
    expect(ids.filter((r: any) => originali.has(r.id))).toEqual([]);
    expect(new Set(ids.map((r: any) => r.id)).size).toBe(ids.length);
    const globale = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_day_types WHERE code = 'CI_DUPLICA'`)).rows[0].n;
    expect(globale).toBe(1);
  });

  it("una seconda copia, e la copia di una copia: uguali anche quelle, con id loro", async () => {
    const prima = await impronta(SRC);
    const seconda = await duplica();
    expect(seconda.name).toBe("Rete di prova (copia)");
    expect(await impronta(seconda.id)).toEqual(prima);
    const r = await request(app).post(`/api/planning-studio/projects/${copie[0]}/duplicate`).send({ name: "Copia della copia" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await impronta(r.body.project.id)).toEqual(prima);
    const corse = (await db.execute<any>(sql`SELECT count(DISTINCT id)::int AS distinte, count(*)::int AS tutte FROM ps_trips
                                             WHERE project_id IN (SELECT id FROM ps_projects WHERE owner_user_id = ${UTENTE}::uuid)`)).rows[0];
    expect(corse).toEqual({ distinte: 8, tutte: 8 });
  });

  it("senza DDL: nessuna tabella temporanea resta nella sessione, e come cerbero_app crearne una è vietato", async (ctx) => {
    const io = (await pool.query("SELECT session_user AS s")).rows[0].s;
    if (io !== "cerbero_app") { ctx.skip(); return; }
    await expect(pool.query("CREATE TEMP TABLE m_trp ON COMMIT DROP AS SELECT 1 AS old_id")).rejects.toMatchObject({ code: "42501" });
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_class WHERE relpersistence = 't'")).rows[0].n).toBe(0);
  });

  it("un progetto che non è tuo o che non c'è: 404, e non nasce niente", async () => {
    const altro = appDiProva(router, utenteDiProva("d1000000-0000-4000-8000-0000000000ff"));
    const quanti = async () => (await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_projects`)).rows[0].n;
    const prima = await quanti();
    expect((await request(altro).post(`/api/planning-studio/projects/${SRC}/duplicate`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/planning-studio/projects/${u(999)}/duplicate`).send({})).status).toBe(404);
    expect(await quanti()).toBe(prima);
  });
});
