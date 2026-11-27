/**
 * La sosta minima al capolinea, sul database vero (TEST_DATABASE_URL; in CI
 * come cerbero_app): le rotte, chi può, la precedenza fermata → nodo →
 * progetto, gli altri attributi del nodo che restano, e il ritardo SIRI
 * delle corse senza transiti (nessun ritardo, si resta sul profilo).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../lib/soste-minime-rotte";
import { sosteMinimeDelProgetto } from "../lib/soste-minime-db";
import { sostaEffettiva } from "../lib/soste-minime";
import { ritardiP85DelleCorse } from "../lib/ritardi-siri";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `c8d00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = u(1), ALTRO = u(2), P = u(3), P2 = u(4), K = u(5), R = u(6), V = u(7), T = u(8);
const S1 = u(10), S2 = u(11), S9 = u(19);

const mio = request(appDiProva(router, utenteDiProva(OWNER)));
const estraneo = request(appDiProva(router, utenteDiProva(ALTRO)));

describe.runIf(!!process.env.TEST_DATABASE_URL)("la sosta minima al capolinea, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM ps_project_activity_log WHERE project_id IN (${P}::uuid, ${P2}::uuid)`);
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${T}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id IN (${P}::uuid, ${P2}::uuid)`);
    await db.execute(sql`DELETE FROM ps_stop_clusters WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id IN (${P}::uuid, ${P2}::uuid)`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER}::uuid, ${ALTRO}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${OWNER}::uuid, 'soste-owner@prova.local', 'x', 'user'), (${ALTRO}::uuid, 'soste-altro@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES
      (${P}::uuid, ${OWNER}::uuid, 'Soste minime'), (${P2}::uuid, ${OWNER}::uuid, 'Un altro progetto')`);
    await db.execute(sql`INSERT INTO ps_stop_clusters (id, project_id, name, kind, attributes)
      VALUES (${K}::uuid, ${P}::uuid, 'Cavour', 'interchange', '{"hasFacilities": true}'::jsonb)`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon, cluster_id) VALUES
      (${S1}::uuid, ${P}::uuid, 'Cavour 1', 43.6174, 13.5160, ${K}::uuid),
      (${S2}::uuid, ${P}::uuid, 'Brecce Bianche', 43.5823, 13.5170, NULL)`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES (${S9}::uuid, ${P2}::uuid, 'Altrove', 43.5, 13.4)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${R}::uuid, ${P}::uuid, '22/24')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, direction) VALUES (${V}::uuid, ${P}::uuid, ${R}::uuid, 'Andata', 0)`);
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, attributes) VALUES (${T}::uuid, ${P}::uuid, ${R}::uuid, ${V}::uuid, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${T}::uuid, 1, ${S1}::uuid, '07:45:00', '07:45:00'), (${T}::uuid, 2, ${S2}::uuid, '08:10:00', '08:10:00')`);
  });

  afterAll(pulisci);

  it("si scrivono progetto, nodo e fermata; si leggono coi capolinea e da dove viene il valore", async () => {
    const put = await mio.put(`/api/planning-studio/projects/${P}/soste-minime`)
      .send({ predefinitaMin: 3, nodi: [{ id: K, minuti: 5 }], fermate: [{ id: S2, minuti: 2 }] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, predefinitaMin: 3, nodi: 1, fermate: 1 });
    const get = await mio.get(`/api/planning-studio/projects/${P}/soste-minime`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ predefinitaMin: 3, nodi: [{ id: K, nome: "Cavour", minuti: 5 }], fermate: [{ id: S2, minuti: 2 }] });
    expect(get.body.capolinea).toEqual([{ stopId: S2, nome: "Brecce Bianche", arrivi: 1, minuti: 2, fonte: "fermata" }]);
    const s = await sosteMinimeDelProgetto(P);
    expect(sostaEffettiva(S1, s)).toEqual({ minuti: 5, fonte: "nodo" });
    expect(sostaEffettiva(u(77), s)).toEqual({ minuti: 3, fonte: "progetto" });
    // il nodo tiene i suoi altri attributi
    const attr = (await db.execute<any>(sql`SELECT attributes FROM ps_stop_clusters WHERE id = ${K}::uuid`)).rows[0].attributes;
    expect(attr).toEqual({ hasFacilities: true, sostaMinimaMin: 5 });
    // nel registro del progetto
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_project_activity_log
      WHERE project_id = ${P}::uuid AND action = 'soste_minime.update'`)).rows[0].n).toBe(1);
  });

  it("null toglie il dato", async () => {
    const put = await mio.put(`/api/planning-studio/projects/${P}/soste-minime`).send({ predefinitaMin: null, fermate: [{ id: S2, minuti: null }] });
    expect(put.body).toMatchObject({ ok: true, predefinitaMin: null, nodi: 1, fermate: 0 });
    const s = await sosteMinimeDelProgetto(P);
    expect(sostaEffettiva(S2, s)).toBeNull();
    expect((await db.execute<any>(sql`SELECT agency_settings ? 'sostaMinimaCapolineaMin' AS c FROM ps_projects WHERE id = ${P}::uuid`)).rows[0].c).toBe(false);
  });

  it("fail closed: id di un altro progetto, valori fuori misura, chi non è del progetto", async () => {
    const fuori = await mio.put(`/api/planning-studio/projects/${P}/soste-minime`).send({ fermate: [{ id: S9, minuti: 4 }], nodi: [{ id: K, minuti: 9 }] });
    expect(fuori.status).toBe(404);
    expect(sostaEffettiva(S1, await sosteMinimeDelProgetto(P))).toEqual({ minuti: 5, fonte: "nodo" });   // il nodo non è cambiato
    expect((await mio.put(`/api/planning-studio/projects/${P}/soste-minime`).send({ predefinitaMin: 90 })).status).toBe(400);
    expect((await estraneo.get(`/api/planning-studio/projects/${P}/soste-minime`)).status).toBe(404);
    expect((await estraneo.put(`/api/planning-studio/projects/${P}/soste-minime`).send({ predefinitaMin: 1 })).status).toBe(403);
    expect((await request(appDiProva(router, null)).get(`/api/planning-studio/projects/${P}/soste-minime`)).status).toBe(401);
  });

  it("il ritardo SIRI delle corse: senza transiti nessun ritardo, e il giro resta sul profilo", async () => {
    const r = await ritardiP85DelleCorse(P, [T, "non-un-id"], "20260301", null);
    expect(r).toMatchObject({ corse: 1, conDati: 0, ritardi: {}, tipoGiorno: "festivo" });
  });
});
