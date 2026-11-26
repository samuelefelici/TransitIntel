/**
 * Eliminare un progetto di scheduling (DELETE /api/scheduling/projects/:id),
 * su un database vero (TEST_DATABASE_URL, migrato: in CI il job
 * migrazioni-postgres).
 *
 * Prima si toglieva solo la riga del progetto e i turni restavano orfani.
 * Ora se ne va tutto ciò che è suo, in una transazione: relazioni, turni
 * guida, turni macchina (con i loro membri), calcoli e registro; il progetto
 * Planning Studio perde il legame. Gli altri progetti non si toccano, chi non
 * è il proprietario riceve 404 e i turni pubblicati nel roster fermano tutto.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import progettiRouter from "../lib/scheduling-projects";

const U = "e1000000-0000-0000-0000-0000000000a1";
const ALTRO = "e1000000-0000-0000-0000-0000000000a2";
const PS = "e1000000-0000-0000-0000-0000000000c1";
const SP = "e1000000-0000-0000-0000-0000000000b1";       // quello da eliminare
const SP_RESTA = "e1000000-0000-0000-0000-0000000000b2"; // un altro progetto dello stesso utente
const TM = (n: number) => `e1000000-0000-0000-0000-00000000001${n}`;
const TG = (n: number) => `e1000000-0000-0000-0000-00000000002${n}`;
const REL = (n: number) => `e1000000-0000-0000-0000-00000000003${n}`;
const PUB = "e1000000-0000-0000-0000-0000000000f1";

const io = appDiProva(progettiRouter, utenteDiProva(U, ["scheduling"]));
const intruso = appDiProva(progettiRouter, utenteDiProva(ALTRO, ["scheduling"]));
const conta = async (q: ReturnType<typeof sql>) => Number(((await db.execute<any>(q)).rows ?? [])[0]?.n ?? 0);

async function pulisci(): Promise<void> {
  await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE pubblicazione_id = ${PUB}::uuid`);
  await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id = ${PUB}::uuid`);
  await db.execute(sql`DELETE FROM process_reports WHERE owner_user_id = ${U}::uuid`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE owner_user_id = ${U}::uuid`);
  await db.execute(sql`DELETE FROM scheduling_projects WHERE owner_user_id = ${U}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${U}::uuid, ${ALTRO}::uuid)`);
}

async function semina(): Promise<void> {
  await pulisci();
  await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES
    (${U}::uuid, 'elimina-progetto@prova.local', 'x'), (${ALTRO}::uuid, 'intruso@prova.local', 'x')`);
  await db.execute(sql`INSERT INTO scheduling_projects (id, owner_user_id, name) VALUES
    (${SP}::uuid, ${U}::uuid, 'Domenica vecchia'), (${SP_RESTA}::uuid, ${U}::uuid, 'Feriale')`);
  await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name, scheduling_project_id)
                       VALUES (${PS}::uuid, ${U}::uuid, 'Domenica', 'Conerobus prova', ${SP}::uuid)`);
  // turni macchina: due del progetto, uno dell'altro
  for (const [n, p] of [[1, SP], [2, SP], [3, SP_RESTA]] as Array<[number, string]>) {
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result, project_id, owner_user_id)
                         VALUES (${TM(n)}::uuid, ${`TM ${n}`}, '20260920', '{}', '{}', ${p}::uuid, ${U}::uuid)`);
  }
  // turni guida: uno per turno macchina, più uno del progetto appeso a un turno macchina dell'altro
  for (const [n, tm, p] of [[1, TM(1), SP], [2, TM(2), null], [3, TM(3), SP_RESTA], [4, TM(3), SP]] as Array<[number, string, string | null]>) {
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result, owner_user_id, project_id)
                         VALUES (${TG(n)}::uuid, ${tm}::uuid, ${`TG ${n}`}, '{}', ${U}::uuid, ${p}::uuid)`);
  }
  // relazioni: per progetto, per scenario (senza progetto), per turni guida; una dell'altro progetto
  for (const [n, p, s, d] of [[1, SP, null, null], [2, null, TM(2), null], [3, null, null, TG(4)], [4, SP_RESTA, TM(3), null]] as Array<[number, string | null, string | null, string | null]>) {
    await db.execute(sql`INSERT INTO process_reports (id, scenario_id, dss_id, project_id, owner_user_id, title, dossier, html)
                         VALUES (${REL(n)}::uuid, ${s}::uuid, ${d}::uuid, ${p}::uuid, ${U}::uuid, ${`R ${n}`}, '{}', '<p></p>')`);
  }
}

const stato = async () => ({
  progetti: await conta(sql`SELECT count(*)::int AS n FROM scheduling_projects WHERE owner_user_id = ${U}::uuid`),
  turniMacchina: await conta(sql`SELECT count(*)::int AS n FROM service_program_scenarios WHERE owner_user_id = ${U}::uuid`),
  turniGuida: await conta(sql`SELECT count(*)::int AS n FROM driver_shift_scenarios WHERE owner_user_id = ${U}::uuid`),
  relazioni: await conta(sql`SELECT count(*)::int AS n FROM process_reports WHERE owner_user_id = ${U}::uuid`),
  legame: await conta(sql`SELECT count(*)::int AS n FROM ps_projects WHERE id = ${PS}::uuid AND scheduling_project_id IS NOT NULL`),
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("eliminare un progetto di scheduling, sul database", () => {
  beforeEach(semina);
  afterAll(pulisci);

  it("se ne va tutto ciò che è suo; l'altro progetto resta intatto", async () => {
    expect(await stato()).toEqual({ progetti: 2, turniMacchina: 3, turniGuida: 4, relazioni: 4, legame: 1 });
    const r = await request(io).delete(`/api/scheduling/projects/${SP}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, eliminati: { turniMacchina: 2, turniGuida: 3, relazioni: 3 } });
    expect(await stato()).toEqual({ progetti: 1, turniMacchina: 1, turniGuida: 1, relazioni: 1, legame: 0 });
    // resta proprio quello dell'altro progetto
    expect(await conta(sql`SELECT count(*)::int AS n FROM driver_shift_scenarios WHERE id = ${TG(3)}::uuid`)).toBe(1);
    expect(await conta(sql`SELECT count(*)::int AS n FROM process_reports WHERE id = ${REL(4)}::uuid`)).toBe(1);
    expect(await conta(sql`SELECT count(*)::int AS n FROM scheduling_projects WHERE id = ${SP_RESTA}::uuid`)).toBe(1);
  });

  it("chi non è il proprietario: 404 e niente si tocca", async () => {
    expect((await request(intruso).delete(`/api/scheduling/projects/${SP}`)).status).toBe(404);
    expect((await request(io).delete("/api/scheduling/projects/non-un-id")).status).toBe(400);
    expect(await stato()).toEqual({ progetti: 2, turniMacchina: 3, turniGuida: 4, relazioni: 4, legame: 1 });
  });

  it("turni guida pubblicati nel roster: 409 e niente si tocca", async () => {
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al)
                         VALUES (${PUB}::uuid, 'pubblica', ${PS}::uuid, '2026-09-20'::date, '2026-09-20'::date)`);
    await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, pubblicazione_id)
                         VALUES ('2026-09-20'::date, ${PS}::uuid, ${TG(1)}::uuid, ${TM(1)}::uuid, ${PS}::uuid, ${PUB}::uuid)`);
    const r = await request(io).delete(`/api/scheduling/projects/${SP}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("pubblicati nel roster");
    expect(await stato()).toEqual({ progetti: 2, turniMacchina: 3, turniGuida: 4, relazioni: 4, legame: 1 });
  });
});
