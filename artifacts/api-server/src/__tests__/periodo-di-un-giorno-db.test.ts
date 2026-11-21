/**
 * Il periodo dei calendari importati nella matrice di validità, su un database
 * vero (TEST_DATABASE_URL, migrato; in CI come cerbero_app). Tappa 6.46: un
 * calendario di un giorno solo (il giorno di un'esportazione) non diventa più
 * il periodo delle sue corse; un orario stagionale sì, come prima.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runValidityAutoImportFromCalendars } from "../lib/planning-studio-validity";
import { corseConPeriodoDiUnGiorno } from "../lib/km-programmati";

const u = (n: number) => `e6460000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [UTENTE, P, LINEA, PERCORSO, CAL_GIORNO, CAL_ESTATE, T_GIORNO, T_ESTATE] = Array.from({ length: 8 }, (_, i) => u(i + 1));

async function pulisci() {
  await db.execute(sql`DELETE FROM ps_trip_exceptions WHERE trip_id IN (${T_GIORNO}::uuid, ${T_ESTATE}::uuid)`);
  await db.execute(sql`DELETE FROM ps_trip_day_validity WHERE trip_id IN (${T_GIORNO}::uuid, ${T_ESTATE}::uuid)`);
  await db.execute(sql`DELETE FROM ps_trip_category_validity WHERE trip_id IN (${T_GIORNO}::uuid, ${T_ESTATE}::uuid)`);
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_validity_category_calendar WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_calendar_dates WHERE calendar_id IN (${CAL_GIORNO}::uuid, ${CAL_ESTATE}::uuid)`);
  await db.execute(sql`DELETE FROM ps_calendars WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("il periodo dei calendari importati (database vero)", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${UTENTE}::uuid, 'Periodo di un giorno 6.46')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, 'P1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'a')`);
    /* l'esportazione di una giornata (venerdì 5/12/2025, solo date) e un orario estivo feriale */
    await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${CAL_GIORNO}::uuid, ${P}::uuid, 'G', 'Una giornata', false, false, false, false, false, false, false, '2025-12-05', '2025-12-05'),
      (${CAL_ESTATE}::uuid, ${P}::uuid, 'E', 'Estate', true, true, true, true, true, false, false, '2026-06-15', '2026-09-15')`);
    await db.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date, exception_type) VALUES (${CAL_GIORNO}::uuid, '2025-12-05', 1)`);
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id) VALUES
      (${T_GIORNO}::uuid, ${P}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${CAL_GIORNO}::uuid),
      (${T_ESTATE}::uuid, ${P}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${CAL_ESTATE}::uuid)`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("un calendario di un giorno non chiude le corse in quel giorno; un orario estivo resta estivo", async () => {
    await runValidityAutoImportFromCalendars(P, { dryRun: false });
    const periodo = async (corsa: string) => (await db.execute<any>(sql`
      SELECT to_char(valid_from, 'YYYY-MM-DD') AS dal, to_char(valid_to, 'YYYY-MM-DD') AS al FROM ps_trips WHERE id = ${corsa}::uuid`)).rows[0];
    expect(await periodo(T_GIORNO)).toEqual({ dal: null, al: null });
    expect(await periodo(T_ESTATE)).toEqual({ dal: "2026-06-15", al: "2026-09-15" });
    /* la corsa della giornata entra comunque nella matrice: il venerdì è un feriale */
    const giorni = (await db.execute<any>(sql`
      SELECT dt.code FROM ps_trip_day_validity v JOIN ps_day_types dt ON dt.id = v.day_type_id WHERE v.trip_id = ${T_GIORNO}::uuid AND v.is_valid`)).rows.map((r) => r.code);
    expect(giorni).toEqual(["feriale"]);
    expect(await corseConPeriodoDiUnGiorno(P)).toEqual({ quante: 0, giorno: null });
  });
});
