/**
 * La stima rapida di Planning Studio sul database (TEST_DATABASE_URL; in CI
 * come cerbero_app): filtri per linee e per tipo di giorno, con l'SQL a
 * parametri (PR 7.11: prima i valori erano scritti dentro il testo SQL).
 *
 * Tre corse: C1 della linea 1 e C2 della linea 2 valgono nel tipo di giorno
 * TG; C3 della linea 1 no.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import planningStudioEstimateRouter from "../routes/planning-studio-estimate";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7b00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, P, F1, F2, L1, L2, V1, V2, TG, C1, C2, C3] = Array.from({ length: 12 }, (_, i) => u(i + 1));

const router = Router();
router.use(planningStudioEstimateRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
const stima = (corpo: Record<string, unknown>) => admin.post(`/api/planning-studio/projects/${P}/quick-estimate`).send(corpo);

async function pulisci() {
  /* prima le corse (con orari e validità), poi il resto del progetto */
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("stima rapida sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'stima@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Stima 7.11')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, code, name, lat, lon) VALUES
      (${F1}::uuid, ${P}::uuid, 'F1', 'Piazza', 45 + 1 / 100.0, 12 + 1 / 100.0),
      (${F2}::uuid, ${P}::uuid, 'F2', 'Borgo', 45 + 2 / 100.0, 12 + 2 / 100.0)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${L1}::uuid, ${P}::uuid, '1'), (${L2}::uuid, ${P}::uuid, '2')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES
      (${V1}::uuid, ${P}::uuid, ${L1}::uuid, 'Andata 1'), (${V2}::uuid, ${P}::uuid, ${L2}::uuid, 'Andata 2')`);
    await db.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES (${TG}::uuid, ${P}::uuid, 'FER', 'Feriale', '#335577')`);
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, short_name, headsign) VALUES
      (${C1}::uuid, ${P}::uuid, ${L1}::uuid, ${V1}::uuid, 'C1', 'Borgo'),
      (${C2}::uuid, ${P}::uuid, ${L2}::uuid, ${V2}::uuid, 'C2', 'Borgo'),
      (${C3}::uuid, ${P}::uuid, ${L1}::uuid, ${V1}::uuid, 'C3', 'Borgo')`);
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${C1}::uuid, 1, ${F1}::uuid, '07:00:00', '07:00:00'), (${C1}::uuid, 2, ${F2}::uuid, '07:30:00', '07:30:00'),
      (${C2}::uuid, 1, ${F1}::uuid, '08:00:00', '08:00:00'), (${C2}::uuid, 2, ${F2}::uuid, '08:30:00', '08:30:00'),
      (${C3}::uuid, 1, ${F1}::uuid, '09:00:00', '09:00:00'), (${C3}::uuid, 2, ${F2}::uuid, '09:30:00', '09:30:00')`);
    await db.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES
      (${C1}::uuid, ${TG}::uuid, true), (${C2}::uuid, ${TG}::uuid, true), (${C3}::uuid, ${TG}::uuid, false)`);
  });
  afterAll(pulisci);

  it("senza filtri tutte le corse attive; per linee, per tipo di giorno, e tutti e due", async () => {
    const tutte = await stima({});
    expect(tutte.status).toBe(200);
    expect(tutte.body.corseReali).toBe(3);
    expect((await stima({ routeIds: [L1] })).body.corseReali).toBe(2);
    expect((await stima({ dayTypeId: TG })).body.corseReali).toBe(2);
    expect((await stima({ routeIds: [L1], dayTypeId: TG })).body.corseReali).toBe(1);
    expect((await stima({ routeIds: [L1, L2], dayTypeId: TG })).body.corseReali).toBe(2);
  });

  it("valori che non sono uuid non entrano nella query: si ignorano", async () => {
    const r = await stima({ routeIds: ["' OR 1=1 --", L2], dayTypeId: "x' OR '1'='1" });
    expect(r.status).toBe(200);
    expect(r.body.corseReali).toBe(1);
    expect((await admin.post("/api/planning-studio/projects/non-un-uuid/quick-estimate").send({})).status).toBe(400);
  });
});
